import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  DESKTOP_PROTOCOL_VERSION,
  desktopProtocolMajor,
  type DesktopCommandName,
  type DesktopCommands,
  type DesktopCommandResult,
  type DesktopEventName,
  type DesktopEvents,
} from '../../bridge/protocol';
import { eventValid, record } from '../../bridge/validate';
import { isServerUrl } from '../navigation';
import { S } from '../strings';
import type { Logger } from '../logger';

type Incoming = IpcMainEvent | IpcMainInvokeEvent;
interface Options {
  win: BrowserWindow;
  server: URL;
  log: Logger;
  onEvent: <E extends DesktopEventName>(event: E, data: DesktopEvents[E]) => void;
  onReset: () => void;
}
interface Pending {
  finish: (result: DesktopCommandResult) => void;
  timer: NodeJS.Timeout;
}
const EVENTS = new Set([
  'hello',
  'signedOut',
  'counters',
  'notify',
  'timer',
  'focus',
  'connection',
  'openPath',
]);

export class ServerBridge {
  ready = false;
  online = false;
  private readonly pending = new Map<string, Pending>();
  private readonly result = (event: IpcMainEvent, raw: unknown) => this.acceptResult(event, raw);
  private readonly navigation = (
    event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ) => {
    if (event.isMainFrame && !event.isSameDocument) this.reset();
  };

  constructor(private readonly o: Options) {
    ipcMain.handle('desktop:event', (event, name: unknown, data: unknown) =>
      this.receive(event, name, data),
    );
    ipcMain.on('desktop:result', this.result);
    o.win.webContents.on('did-start-navigation', this.navigation);
    o.win.webContents.on('render-process-gone', this.reset);
  }

  private trusted(event: Incoming): boolean {
    return (
      !this.o.win.isDestroyed() &&
      !event.sender.isDestroyed() &&
      event.sender === this.o.win.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      isServerUrl(event.senderFrame?.url ?? '', this.o.server)
    );
  }

  private receive(event: IpcMainInvokeEvent, rawName: unknown, data: unknown): unknown {
    if (!this.trusted(event) || typeof rawName !== 'string' || !EVENTS.has(rawName))
      return undefined;
    const name = rawName as DesktopEventName;
    if (!eventValid(name, data)) {
      this.o.log.warn('данные моста отклонены', { event: name });
      return name === 'openPath' ? 'blocked' : undefined;
    }
    if (name === 'hello') {
      this.reset();
      const hello = data as DesktopEvents['hello'];
      if (desktopProtocolMajor(hello.protocol) !== desktopProtocolMajor(DESKTOP_PROTOCOL_VERSION)) {
        this.o.win.webContents.send('desktop:compatibility', S.bridgeOutdated);
        return undefined;
      }
      this.ready = true;
      this.online = true;
      this.o.win.webContents.send('desktop:compatibility', '');
    } else if (name === 'signedOut') {
      this.reset();
    } else if (name === 'connection') {
      this.online = data === 'online';
    } else if (!this.ready) return name === 'openPath' ? 'blocked' : undefined;
    // Сетевые пути — следующий этап Д4. Ни один путь не исполняется здесь.
    if (name === 'openPath') return 'blocked';
    this.o.onEvent(name, data as DesktopEvents[typeof name]);
    return undefined;
  }

  command<E extends DesktopCommandName>(
    name: E,
    data: Omit<DesktopCommands[E], 'requestId'>,
    requestId: string = randomUUID(),
  ): Promise<DesktopCommandResult> {
    return this.request(name, data, requestId);
  }

  // Серверный договор не меняется: локальный preload открывает существующий колокольчик.
  openNotifications(): Promise<DesktopCommandResult> {
    return this.request('openNotifications', {}, randomUUID());
  }

  private request(name: string, data: object, requestId: string): Promise<DesktopCommandResult> {
    if (
      !this.ready ||
      !this.online ||
      this.o.win.isDestroyed() ||
      !isServerUrl(this.o.win.webContents.getURL(), this.o.server)
    ) {
      return Promise.resolve({ ok: false, error: S.bridgeOffline });
    }
    const id = randomUUID();
    return new Promise((finish) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        finish({ ok: false, error: S.bridgeTimeout });
      }, 15000);
      this.pending.set(id, { finish, timer });
      this.o.log.info('команда моста', { command: name });
      this.o.win.webContents.send('desktop:command', { id, name, data: { ...data, requestId } });
    });
  }

  private acceptResult(event: IpcMainEvent, raw: unknown): void {
    if (!this.trusted(event) || !record(raw) || typeof raw.id !== 'string') return;
    const pending = this.pending.get(raw.id);
    if (!pending || !record(raw.result) || typeof raw.result.ok !== 'boolean') return;
    let result: DesktopCommandResult;
    if (raw.result.ok) result = { ok: true };
    else
      result = {
        ok: false,
        error:
          typeof raw.result.error === 'string' &&
          raw.result.error.length > 0 &&
          raw.result.error.length <= 2000
            ? raw.result.error
            : S.bridgeCommandFailed,
      };
    clearTimeout(pending.timer);
    this.pending.delete(raw.id);
    pending.finish(result);
  }

  private readonly reset = () => {
    this.ready = false;
    this.online = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.finish({ ok: false, error: S.bridgeOffline });
    }
    this.pending.clear();
    this.o.onReset();
  };

  destroy(): void {
    ipcMain.removeHandler('desktop:event');
    ipcMain.removeListener('desktop:result', this.result);
    if (!this.o.win.isDestroyed()) {
      this.o.win.webContents.removeListener('did-start-navigation', this.navigation);
      this.o.win.webContents.removeListener('render-process-gone', this.reset);
    }
    this.reset();
  }
}
