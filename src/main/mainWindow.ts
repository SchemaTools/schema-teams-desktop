// Главное окно (ТЗ, 2.2, 2.4, 4.3): веб Teams с сервера; ✕ и «Свернуть» прячут окно в трей.
import { BrowserWindow, Notification, screen, shell, type WebContents } from 'electron';
import type { Logger } from './logger';
import { decideNavigation, isExternalAllowed, isServerUrl } from './navigation';
import { noServerPage, offlinePage } from './pages';
import { ZOOM_MAX, ZOOM_MIN, type SettingsStore } from './settings';
import { S } from './strings';
import { fitBounds, MIN_SIZE } from './windowState';
import { windowImage } from './icons';

export const PARTITION = 'persist:teams';
const RETRY_MS = 10_000;
/** Ошибка «загрузка прервана» — не сбой связи, а переход на другую страницу */
const ERR_ABORTED = -3;

export interface MainWindowOptions {
  server: URL | null;
  settings: SettingsStore;
  log: Logger;
  isQuitting: () => boolean;
}

export class MainWindow {
  readonly win: BrowserWindow;
  private retryTimer: NodeJS.Timeout | undefined;
  private offline = false;
  private lastBlur = 0;
  private saveTimer: NodeJS.Timeout | undefined;

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
      backgroundColor: '#f2f4f5',
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // страница держит соединение реального времени и при спрятанном окне (ТЗ, 2.2)
        backgroundThrottling: false,
      },
    });
    if (st.maximized) this.win.maximize();
    // заголовок окна — всегда «Schema Teams», не заголовок страницы
    this.win.on('page-title-updated', (e) => e.preventDefault());
    this.guard(this.win.webContents);
    this.wireWindow();
    this.wireLoading();
    this.loadServer();
  }

  /** Показать и вывести на передний план. */
  show(): void {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
    if (this.offline) this.retryNow();
  }

  hide(): void {
    this.saveState();
    this.win.hide();
    this.trayHintOnce();
  }

  /** Щелчок по значку трея: видимое окно прячется, спрятанное — показывается. */
  toggle(): void {
    // щелчок по трею забирает фокус у окна раньше, чем приходит событие щелчка
    const focusedJustNow = this.win.isFocused() || Date.now() - this.lastBlur < 300;
    if (this.win.isVisible() && !this.win.isMinimized() && focusedJustNow) this.hide();
    else this.show();
  }

  private loadServer(): void {
    clearTimeout(this.retryTimer);
    if (!this.o.server) {
      this.o.log.error('адрес сервера не задан');
      void this.win.loadURL(noServerPage());
      return;
    }
    void this.win.loadURL(this.o.server.href).catch(() => {
      // ошибка разбирается в did-fail-load
    });
  }

  private retryNow(): void {
    this.o.log.info('повтор загрузки');
    this.loadServer();
  }

  private wireLoading(): void {
    const wc = this.win.webContents;
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED || !this.o.server) return;
      if (!isServerUrl(url, this.o.server)) return;
      this.o.log.warn('сервер не открылся', { code, desc });
      this.offline = true;
      void this.win.loadURL(offlinePage(desc));
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.retryNow(), RETRY_MS);
    });
    wc.on('did-finish-load', () => {
      const url = wc.getURL();
      if (this.o.server && isServerUrl(url, this.o.server)) {
        if (this.offline) this.o.log.info('сервер открылся');
        this.offline = false;
        wc.setZoomLevel(this.o.settings.get().zoomLevel);
      }
    });
    // Ctrl+колесо (ТЗ, 4.3): шаг 0,5, масштаб запоминается
    wc.on('zoom-changed', (_e, direction) => {
      const cur = wc.getZoomLevel();
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur + (direction === 'in' ? 0.5 : -0.5)));
      wc.setZoomLevel(next);
      this.o.settings.update({ zoomLevel: next });
    });
    wc.on('render-process-gone', (_e, d) => {
      this.o.log.error('страница упала', { reason: d.reason, exitCode: d.exitCode });
      if (d.reason !== 'clean-exit') this.loadServer();
    });
  }

  /** Переходы, новые окна и встроенные webview (ТЗ, 2.4). */
  private guard(wc: WebContents): void {
    const onNavigate = (e: { preventDefault: () => void }, url: string) => {
      if (!this.o.server) {
        e.preventDefault();
        return;
      }
      const d = decideNavigation(url, this.o.server);
      if (d === 'allow') return;
      e.preventDefault();
      if (d === 'external') void shell.openExternal(url);
      this.o.log.info('переход не в окне', { decision: d, scheme: safeScheme(url) });
    };
    wc.on('will-navigate', (e) => onNavigate(e, e.url));
    wc.on('will-redirect', (e) => {
      if (e.isMainFrame) onNavigate(e, e.url);
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (isExternalAllowed(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
  }

  private wireWindow(): void {
    this.win.on('close', (e) => {
      if (this.o.isQuitting()) {
        this.saveState();
        return;
      }
      e.preventDefault();
      this.hide();
    });
    this.win.on('minimize', () => this.hide());
    this.win.on('blur', () => (this.lastBlur = Date.now()));
    const later = () => {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveState(), 1000);
    };
    this.win.on('resize', later);
    this.win.on('move', later);
  }

  private saveState(): void {
    clearTimeout(this.saveTimer);
    if (this.win.isDestroyed()) return;
    this.o.settings.update({
      window: {
        // у свёрнутого и развёрнутого окна getBounds() не годится — берём обычное положение
        bounds: this.win.getNormalBounds(),
        maximized: this.win.isMaximized(),
      },
    });
  }

  /** При первом закрытии — подсказка, что приложение осталось в трее (Д-О-3). */
  private trayHintOnce(): void {
    if (this.o.settings.get().trayHintShown) return;
    this.o.settings.update({ trayHintShown: true });
    if (!Notification.isSupported()) return;
    new Notification({ title: S.trayHintTitle, body: S.trayHintBody, icon: windowImage() }).show();
  }
}

/** Для журнала — только схема адреса, без самого адреса. */
function safeScheme(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return 'invalid';
  }
}
