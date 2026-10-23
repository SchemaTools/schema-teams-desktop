// Собственные уведомления — опыт Д2 для Enter / Shift+Enter, без серверного моста Д3.
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { S } from '../strings';
import { customToastPage } from './customToastPage';
import type { ToastSpec } from './toastScenarios';

const CHANNEL = 'experiment:custom-toast';
const RESULT = 'experiment:custom-toast-result';
const LIFETIME = 8000;
const GAP = 12;
const WIDTH = 364;

interface Entry {
  win: BrowserWindow;
  spec: ToastSpec;
  url: string;
  height: number;
  hover: boolean;
  draft: boolean;
  sent: boolean;
  timer?: NodeJS.Timeout;
}

interface Options {
  onReply: (spec: ToastSpec, text: string) => void;
  onButton: (spec: ToastSpec, index: number) => void;
  onShow: (spec: ToastSpec) => void;
  onClose: (spec: ToastSpec) => void;
}

export class CustomToasts {
  private readonly entries = new Map<string, Entry>();
  private readonly onIpc = (event: IpcMainEvent, raw: unknown) => this.receive(event, raw);
  private readonly reposition = () => this.layout();

  constructor(private readonly o: Options) {
    ipcMain.on(CHANNEL, this.onIpc);
    screen.on('display-metrics-changed', this.reposition);
    screen.on('display-removed', this.reposition);
  }

  show(spec: ToastSpec): void {
    const area = screen.getPrimaryDisplay().workArea;
    const height = Math.min(spec.hasReply ? 258 : 194, area.height - GAP * 2);
    const previous = this.entries.get(spec.id);
    // Не заменяем уведомление, пока сотрудник пишет ответ.
    if (previous?.draft) return;
    if (previous) {
      this.entries.delete(spec.id);
      previous.win.close();
    }
    const fits = () =>
      this.entries.size < 3 &&
      [...this.entries.values()].reduce((total, entry) => total + entry.height + GAP, height) +
        GAP * 2 <=
        area.height;
    while (!fits()) {
      const oldest = [...this.entries.values()].find((entry) => !entry.draft && !entry.hover);
      if (!oldest) return;
      this.entries.delete(oldest.spec.id);
      oldest.win.close();
    }
    const win = new BrowserWindow({
      title: S.customToastTitle,
      width: WIDTH,
      height,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#f9f9f9',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../../preload/customToast.js'),
        partition: 'toast-experiment',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const url = customToastPage(spec);
    const entry: Entry = { win, spec, url, height, hover: false, draft: false, sent: false };
    this.entries.set(spec.id, entry);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      this.layout();
      win.showInactive();
      this.arm(entry);
      this.o.onShow(spec);
    });
    win.once('closed', () => {
      clearTimeout(entry.timer);
      if (this.entries.get(spec.id) === entry) this.entries.delete(spec.id);
      this.layout();
      this.o.onClose(spec);
    });
    void win.loadURL(url);
  }

  destroy(): void {
    ipcMain.removeListener(CHANNEL, this.onIpc);
    screen.removeListener('display-metrics-changed', this.reposition);
    screen.removeListener('display-removed', this.reposition);
    for (const entry of [...this.entries.values()]) entry.win.close();
  }

  private layout(): void {
    const area = screen.getPrimaryDisplay().workArea;
    // После смены масштаба/монитора уменьшаем окна, сохраняя уже набранные черновики.
    const availableHeight = Math.floor(
      (area.height - GAP * (this.entries.size + 1)) / Math.max(1, this.entries.size),
    );
    let bottom = area.y + area.height - GAP;
    for (const entry of [...this.entries.values()].reverse()) {
      if (entry.win.isDestroyed()) continue;
      const height = Math.min(entry.height, Math.max(1, availableHeight));
      const width = Math.min(WIDTH, area.width - GAP * 2);
      bottom -= height;
      entry.win.setBounds({
        x: area.x + area.width - width - GAP,
        y: Math.max(area.y + GAP, bottom),
        width,
        height,
      });
      bottom -= GAP;
    }
  }

  private arm(entry: Entry): void {
    clearTimeout(entry.timer);
    if (!entry.hover && !entry.draft && !entry.sent) {
      entry.timer = setTimeout(() => entry.win.close(), LIFETIME);
    }
  }

  private receive(event: IpcMainEvent, raw: unknown): void {
    const entry = [...this.entries.values()].find((item) => item.win.webContents === event.sender);
    if (
      !entry ||
      entry.win.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== entry.url ||
      typeof raw !== 'object' ||
      raw === null
    ) {
      return;
    }
    const message = raw as Record<string, unknown>;
    if (message.action === 'close') {
      entry.win.close();
    } else if (message.action === 'hover' || message.action === 'draft') {
      if (typeof message.active !== 'boolean') return;
      entry[message.action] = message.active;
      // После отправки таймер подтверждения не зависит от ухода мыши.
      if (!entry.sent) this.arm(entry);
    } else if (message.action === 'reply') {
      if (
        entry.sent ||
        !entry.spec.hasReply ||
        typeof message.text !== 'string' ||
        message.text.length > 32000 ||
        message.text.trim() === ''
      ) {
        return;
      }
      entry.sent = true;
      clearTimeout(entry.timer);
      this.o.onReply(entry.spec, message.text);
      event.sender.send(RESULT, S.customToastSent(entry.spec.title));
      entry.timer = setTimeout(() => entry.win.close(), 1300);
    } else if (message.action === 'button') {
      if (
        entry.sent ||
        typeof message.index !== 'number' ||
        !Number.isInteger(message.index) ||
        !entry.spec.buttons[message.index]
      ) {
        return;
      }
      entry.sent = true;
      this.o.onButton(entry.spec, message.index);
      entry.win.close();
    }
  }
}
