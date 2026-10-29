// Локальное окно клиента. Страница сервера открывается только в LoginWindow.
import { BrowserWindow, Notification, screen, type WebContents } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from './logger';
import { ZOOM_MAX, ZOOM_MIN, type SettingsStore } from './settings';
import { S } from './strings';
import { fitBounds, MIN_SIZE } from './windowState';
import { windowImage } from './icons';
export const PARTITION = 'persist:teams';
export const CLIENT_FILE = join(__dirname, '../renderer/index.html');
export const CLIENT_URL = pathToFileURL(CLIENT_FILE).href;
export function guardLocal(wc: WebContents): void {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  wc.session.setPermissionCheckHandler(() => false);
}
export interface MainWindowOptions {
  server: URL | null;
  settings: SettingsStore;
  log: Logger;
  isQuitting: () => boolean;
}
export class MainWindow {
  readonly win: BrowserWindow;
  private lastBlur = 0;
  private saveTimer?: NodeJS.Timeout;
  constructor(private readonly o: MainWindowOptions) {
    const st = o.settings.get().window;
    const bounds = fitBounds(
      st.bounds,
      screen.getAllDisplays().map((d) => d.workArea),
      screen.getPrimaryDisplay().workArea,
    );
    this.win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: S.appName,
      icon: windowImage(),
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#e9eefb',
      webPreferences: {
        preload: join(__dirname, '../preload/client.js'),
        partition: 'client-ui',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    if (st.maximized) this.win.maximize();
    this.win.on('page-title-updated', (e) => e.preventDefault());
    guardLocal(this.win.webContents);
    this.win.on('close', (e) => {
      if (!o.isQuitting()) {
        e.preventDefault();
        this.hide();
      } else this.saveState();
    });
    this.win.on('minimize', () => this.hide());
    this.win.on('blur', () => {
      this.lastBlur = Date.now();
    });
    const later = () => {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveState(), 1000);
    };
    this.win.on('resize', later);
    this.win.on('move', later);
    this.win.webContents.on('did-finish-load', () =>
      this.win.webContents.setZoomLevel(o.settings.get().zoomLevel),
    );
    this.win.webContents.on('zoom-changed', (_e, direction) => {
      const next = Math.min(
        ZOOM_MAX,
        Math.max(ZOOM_MIN, this.win.webContents.getZoomLevel() + (direction === 'in' ? 0.5 : -0.5)),
      );
      this.win.webContents.setZoomLevel(next);
      o.settings.update({ zoomLevel: next });
    });
    this.win.webContents.on('render-process-gone', () => {
      if (!o.isQuitting()) void this.win.loadFile(CLIENT_FILE);
    });
    void this.win.loadFile(CLIENT_FILE).catch(() => o.log.error('локальное окно не загружено'));
  }
  show(): void {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }
  destroy(): void {
    clearTimeout(this.saveTimer);
    this.win.destroy();
  }
  hide(): void {
    this.saveState();
    this.win.hide();
    this.trayHintOnce();
  }
  toggle(): void {
    if (
      this.win.isVisible() &&
      !this.win.isMinimized() &&
      (this.win.isFocused() || Date.now() - this.lastBlur < 300)
    )
      this.hide();
    else this.show();
  }
  private saveState(): void {
    clearTimeout(this.saveTimer);
    if (!this.win.isDestroyed())
      this.o.settings.update({
        window: { bounds: this.win.getNormalBounds(), maximized: this.win.isMaximized() },
      });
  }
  private trayHintOnce(): void {
    if (this.o.settings.get().trayHintShown) return;
    this.o.settings.update({ trayHintShown: true });
    if (Notification.isSupported())
      new Notification({
        title: S.trayHintTitle,
        body: S.trayHintBody,
        icon: windowImage(),
      }).show();
  }
}
