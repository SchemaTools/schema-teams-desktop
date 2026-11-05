import { BrowserWindow } from 'electron';
import { PARTITION } from './mainWindow';
import { isServerUrl } from './navigation';
/**
 * Повтор проверки входа на том же адресе. Не на странице входа — раз в 4 с: смена
 * временного пароля на сайте не меняет адрес, и окно входа должно закрыться без
 * заметной задержки. На странице входа вход ещё не выполнен — раз в 30 с.
 */
export const LOGIN_RECHECK_MS = 4_000;
export const LOGIN_PAGE_RECHECK_MS = 30_000;
const loginPage = (url: string) => {
  try {
    const path = new URL(url).pathname;
    return path === '/login' || path.startsWith('/login/');
  } catch {
    return true;
  }
};
/**
 * Когда окну входа звать проверку входа (bootstrap): сразу — при переходе на адрес
 * сервера, отличный от страницы входа; на том же адресе — не чаще LOGIN_RECHECK_MS;
 * пока открыта страница входа, вход ещё не выполнен — только редкий страховочный повтор.
 */
export class LoginReadiness {
  private lastUrl = '';
  private lastAt = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly server: URL,
    private readonly now: () => number = () => performance.now(),
  ) {}
  shouldCheck(url: string): boolean {
    if (!isServerUrl(url, this.server)) return false;
    const at = this.now();
    const changed = url !== this.lastUrl;
    const login = loginPage(url);
    const interval = login ? LOGIN_PAGE_RECHECK_MS : LOGIN_RECHECK_MS;
    if (login && changed) {
      // Первая загрузка страницы входа тоже проверяет: cookie могли остаться от прошлого входа.
      this.lastUrl = url;
      if (this.lastAt !== Number.NEGATIVE_INFINITY) return false;
    } else if (!changed && at - this.lastAt < interval) return false;
    this.lastUrl = url;
    this.lastAt = at;
    return true;
  }
}
export class LoginWindow {
  private win?: BrowserWindow;
  private pulse?: NodeJS.Timeout;
  get open(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }
  constructor(
    private readonly server: URL,
    private readonly onReady: () => void,
    private readonly partition = PARTITION,
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
        partition: this.partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.win = win;
    const readiness = new LoginReadiness(this.server);
    const check = (url: string) => {
      if (this.win === win && !win.isDestroyed() && readiness.shouldCheck(url)) this.onReady();
    };
    // Опрос ловит смену адреса, о которой страница не сообщила событием навигации.
    this.pulse = setInterval(() => {
      if (!win.isDestroyed()) check(win.webContents.getURL());
    }, 2000);
    win.webContents.on('did-finish-load', () => check(win.webContents.getURL()));
    win.webContents.on('did-navigate-in-page', (_e, url, mainFrame) => {
      if (mainFrame) check(url);
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
