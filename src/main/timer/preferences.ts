import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { windowImage } from '../icons';
import type { SettingsStore } from '../settings';
import { timerPreferencesPage } from './preferencesPage';
import { timerStrings as T } from './strings';

const CHANNEL = 'desktop:timer-preferences';
type Result = { ok: true } | { ok: false; error: string };

interface Options {
  settings: SettingsStore;
  onSaved: () => void;
}

export class TimerPreferences {
  private win?: BrowserWindow;
  private url = '';

  constructor(private readonly o: Options) {
    ipcMain.handle(CHANNEL, (event, raw: unknown) => this.receive(event, raw));
  }

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    const url = timerPreferencesPage(this.o.settings.get().timer);
    const win = new BrowserWindow({
      title: T.preferencesTitle,
      width: 530,
      height: 540,
      minWidth: 440,
      minHeight: 500,
      show: false,
      frame: false,
      icon: windowImage(),
      backgroundColor: '#fff',
      webPreferences: {
        preload: join(__dirname, '../../preload/timerPreferences.js'),
        partition: 'timer-preferences',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.win = win;
    this.url = url;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, answer) =>
      answer(false),
    );
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.once('closed', () => {
      if (this.win === win) {
        this.win = undefined;
        this.url = '';
      }
    });
    void win
      .loadURL(url)
      .then(() => {
        if (!win.isDestroyed()) {
          win.show();
          win.focus();
        }
      })
      .catch(() => {
        if (!win.isDestroyed()) win.close();
      });
  }

  private receive(event: IpcMainInvokeEvent, raw: unknown): Result {
    if (
      !this.win ||
      this.win.isDestroyed() ||
      event.sender !== this.win.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== this.url ||
      typeof raw !== 'object' ||
      raw === null ||
      Array.isArray(raw)
    )
      return { ok: false, error: T.saveFailed };
    const data = raw as Record<string, unknown>;
    if (data.action === 'close' && Object.keys(data).length === 1) {
      this.win.close();
      return { ok: true };
    }
    if (
      data.action !== 'save' ||
      Object.keys(data).length !== 2 ||
      typeof data.reminderTime !== 'string' ||
      !/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(data.reminderTime)
    )
      return { ok: false, error: T.invalidTime };
    try {
      this.o.settings.update({
        timer: { ...this.o.settings.get().timer, reminderTime: data.reminderTime },
      });
    } catch {
      return { ok: false, error: T.saveFailed };
    }
    this.o.onSaved();
    this.win.close();
    return { ok: true };
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
    ipcMain.removeHandler(CHANNEL);
  }
}
