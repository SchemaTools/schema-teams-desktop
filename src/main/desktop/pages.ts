// Открываем готовые серверные страницы, без собственных API таймера.
import { BrowserWindow, screen, type Rectangle } from 'electron';
import { PARTITION } from '../mainWindow';
import { isServerUrl } from '../navigation';
import { S } from '../strings';

export class ServerPages {
  private win?: BrowserWindow;
  constructor(private readonly server: URL) {}
  open(kind: 'pick' | 'finish', tray: Rectangle): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    const area = screen.getDisplayMatching(tray).workArea;
    const width = Math.min(460, area.width - 24),
      height = Math.min(600, area.height - 24);
    const win = new BrowserWindow({
      title: S.appName,
      width,
      height,
      x: Math.max(area.x, Math.min(tray.x + tray.width - width, area.x + area.width - width)),
      y: Math.max(area.y, tray.y - height - 8),
      show: false,
      frame: false,
      skipTaskbar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.win = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => {
      if (!isServerUrl(event.url, this.server)) event.preventDefault();
    });
    win.webContents.on('will-redirect', (event) => {
      if (!isServerUrl(event.url, this.server)) event.preventDefault();
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
    win.once('closed', () => {
      if (this.win === win) this.win = undefined;
    });
    void win.loadURL(new URL(`/desktop/${kind}`, this.server).href).catch(() => {
      if (!win.isDestroyed()) win.close();
    });
  }
  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }
}
