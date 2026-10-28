import { BrowserWindow, clipboard, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathDialogPage } from './dialogPage';
import { windowImage } from '../icons';

export class PathDialog {
  private win?: BrowserWindow;
  private path = '';
  private url = '';
  constructor() {
    ipcMain.handle('desktop:path-dialog', (event, action: unknown) => this.receive(event, action));
  }
  show(path: string): void {
    this.close();
    this.path = path;
    this.url = pathDialogPage(path);
    const win = new BrowserWindow({
      width: 460,
      height: 330,
      minWidth: 380,
      minHeight: 280,
      show: false,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      icon: windowImage(),
      backgroundColor: '#fff',
      webPreferences: {
        preload: join(__dirname, '../../preload/pathDialog.js'),
        partition: 'path-dialog',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.win = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _p, answer) => answer(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.on('closed', () => {
      if (this.win === win) {
        this.win = undefined;
        this.path = '';
        this.url = '';
      }
    });
    void win
      .loadURL(this.url)
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
  private async receive(event: IpcMainInvokeEvent, action: unknown): Promise<boolean> {
    if (
      !this.win ||
      this.win.isDestroyed() ||
      event.sender !== this.win.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== this.url
    )
      return false;
    if (action === 'copy') {
      try {
        await clipboard.writeText(this.path);
        return true;
      } catch {
        return false;
      }
    }
    if (action === 'close') {
      this.close();
      return true;
    }
    return false;
  }
  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }
  destroy(): void {
    this.close();
    ipcMain.removeHandler('desktop:path-dialog');
  }
}
