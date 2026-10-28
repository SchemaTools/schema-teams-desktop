import { BrowserWindow } from 'electron';
import { PARTITION } from './mainWindow';
import { isServerUrl } from './navigation';
export class LoginWindow {
  private win?: BrowserWindow;
  private pulse?: NodeJS.Timeout;
  constructor(
    private readonly server: URL,
    private readonly onReady: () => void,
  ) {}
  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    const win = new BrowserWindow({
      title: 'Вход — Schema Teams',
      width: 600,
      height: 700,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.win = win;
    this.pulse = setInterval(() => {
      if (
        this.win === win &&
        !win.isDestroyed() &&
        isServerUrl(win.webContents.getURL(), this.server)
      )
        this.onReady();
    }, 2000);
    win.webContents.on('did-finish-load', () => {
      if (this.win === win && isServerUrl(win.webContents.getURL(), this.server)) this.onReady();
    });
    win.webContents.on('did-navigate-in-page', (_e, url, mainFrame) => {
      if (mainFrame && this.win === win && isServerUrl(url, this.server)) this.onReady();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => {
      if (!isServerUrl(e.url, this.server)) e.preventDefault();
    });
    win.webContents.on('will-redirect', (e) => {
      if (!isServerUrl(e.url, this.server)) e.preventDefault();
    });
    win.webContents.on('will-attach-webview', (e) => e.preventDefault());
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    win.once('closed', () => {
      if (this.win === win) {
        clearInterval(this.pulse);
        this.pulse = undefined;
        this.win = undefined;
      }
    });
    void win.loadURL(new URL('/login', this.server).href).catch(() => {
      if (!win.isDestroyed()) win.close();
    });
  }
  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }
}
