import { BrowserWindow, ipcMain, screen, type Rectangle, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { menuPage } from './menuPage';
import type { DesktopState } from './state';
import type { DesktopCommandResult } from '../../bridge/protocol';

const ACTIONS = new Set([
  'hide',
  'open',
  'quit',
  'chat',
  'notifications',
  'start',
  'change',
  'pause',
  'resume',
  'stop',
  'timer-settings',
  'timer-review',
  'timer-dismiss',
  'focus-off',
  'focus-30',
  'focus-60',
  'focus-1500',
  'focus-end',
]);
export class TrayMenu {
  private win?: BrowserWindow;
  private url = '';
  constructor(
    private readonly o: {
      version: string;
      getState: () => DesktopState;
      onAction: (action: string) => Promise<DesktopCommandResult>;
    },
  ) {
    ipcMain.handle('desktop:menu', (event, action: unknown) => this.receive(event, action));
  }
  show(bounds: Rectangle): void {
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        width: 320,
        height: 480,
        show: false,
        frame: false,
        skipTaskbar: true,
        resizable: false,
        alwaysOnTop: true,
        backgroundColor: '#1f232b',
        webPreferences: {
          preload: join(__dirname, '../../preload/trayMenu.js'),
          partition: 'desktop-menu',
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.win.webContents.on('will-navigate', (event) => event.preventDefault());
      this.win.webContents.on('will-redirect', (event) => event.preventDefault());
      this.win.webContents.on('will-attach-webview', (event) => event.preventDefault());
      this.win.webContents.session.setPermissionRequestHandler((_wc, _p, answer) => answer(false));
      this.win.webContents.session.setPermissionCheckHandler(() => false);
      this.win.on('blur', () => this.hide());
    }
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(320, area.width),
      height = Math.min(480, area.height - 12);
    const x = Math.max(
      area.x,
      Math.min(bounds.x + bounds.width - width, area.x + area.width - width),
    );
    const y =
      bounds.y > area.y + area.height / 2
        ? Math.max(area.y, bounds.y - height - 6)
        : Math.min(area.y + area.height - height, bounds.y + bounds.height + 6);
    this.win.setBounds({ x, y, width, height });
    this.url = menuPage(this.o.getState(), this.o.version);
    const current = this.win;
    void current
      .loadURL(this.url)
      .then(() => {
        if (!current.isDestroyed()) {
          current.show();
          current.focus();
        }
      })
      .catch(() => {});
  }
  update(): void {
    if (this.win?.isVisible()) {
      this.url = menuPage(this.o.getState(), this.o.version);
      void this.win.loadURL(this.url).catch(() => {});
    }
  }
  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }
  private receive(event: IpcMainInvokeEvent, action: unknown): Promise<DesktopCommandResult> {
    if (
      !this.win ||
      this.win.isDestroyed() ||
      event.sender !== this.win.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== this.url ||
      typeof action !== 'string' ||
      !ACTIONS.has(action)
    )
      return Promise.resolve({ ok: false, error: '' });
    if (action === 'hide') {
      this.hide();
      return Promise.resolve({ ok: true });
    }
    return this.o.onAction(action).then((result) => {
      if (result.ok) this.hide();
      return result;
    });
  }
  destroy(): void {
    ipcMain.removeHandler('desktop:menu');
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }
}
