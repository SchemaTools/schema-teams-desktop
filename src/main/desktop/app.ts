import { app, nativeImage, nativeTheme, shell, type Tray, type Rectangle } from 'electron';
import { randomUUID } from 'node:crypto';
import type {
  DesktopEvents,
  DesktopEventName,
  DesktopNotify,
  DesktopCommandResult,
} from '../../bridge/protocol';
import { teamsLink } from '../../bridge/validate';
import { ServerBridge } from './bridge';
import { ServerPages } from './pages';
import { WindowsNotificationPolicy } from './notificationState';
import { TrayMenu } from './trayMenu';
import { initialState, focusOn, tooltip, type DesktopState } from './state';
import { statusBitmap, badgeBitmap } from './statusBitmap';
import { CustomToasts } from '../notifications/toasts';
import type { ToastSpec } from '../notifications/types';
import type { MainWindow } from '../mainWindow';
import type { SettingsStore } from '../settings';
import type { Logger } from '../logger';
import { encodePng } from '../png';
import { S } from '../strings';

interface Options {
  main: MainWindow;
  server: URL;
  tray: Tray;
  settings: SettingsStore;
  log: Logger;
}
interface Notice {
  wire: DesktopNotify;
  owner: number;
  buttons: DesktopNotify['buttons'];
  lastText?: string;
  requestId?: string;
}
export class DesktopApp {
  private state: DesktopState = initialState();
  private epoch = 0;
  private readonly meta = new WeakMap<ToastSpec, Notice>();
  private readonly policy = new WindowsNotificationPolicy();
  private readonly toasts: CustomToasts;
  private readonly menu: TrayMenu;
  private readonly bridge: ServerBridge;
  private readonly pages: ServerPages;
  private readonly tick: NodeJS.Timeout;
  private readonly theme = () => this.update();
  private readonly windowChanged = () => {
    this.overlay();
    void this.bridge.command('windowState', {
      visible: this.o.main.win.isVisible(),
      focused: this.o.main.win.isFocused(),
    });
  };

  constructor(private readonly o: Options) {
    this.pages = new ServerPages(o.server);
    this.toasts = new CustomToasts({
      onReply: (spec, text) => this.reply(spec, text),
      onButton: (spec, index) => {
        void this.button(spec, index);
      },
      onOpen: (spec) => {
        const item = this.meta.get(spec);
        if (item && item.owner === this.state.user?.id) void this.navigate(item.wire.link);
      },
      onShow: (spec) => {
        o.log.info('уведомление показано');
        if (this.meta.has(spec) && o.settings.get().notifications.sound) shell.beep();
      },
      onClose: () => {},
    });
    this.menu = new TrayMenu({
      version: app.getVersion(),
      getState: () => this.state,
      onAction: (action) => this.menuAction(action),
    });
    this.bridge = new ServerBridge({
      win: o.main.win,
      server: o.server,
      log: o.log,
      onEvent: (name, data) => this.event(name, data),
      onReset: () => this.reset(),
    });
    o.main.win.on('show', this.windowChanged);
    o.main.win.on('hide', this.windowChanged);
    o.main.win.on('focus', this.windowChanged);
    o.main.win.on('blur', this.windowChanged);
    nativeTheme.on('updated', this.theme);
    this.tick = setInterval(() => this.update(), 30000);
    this.update();
  }
  showMenu(bounds: Rectangle): void {
    this.menu.show(bounds);
  }
  private reset(): void {
    this.epoch++;
    this.state = initialState();
    this.toasts.clear();
    this.pages.destroy();
    this.menu.hide();
    this.update();
  }
  private event(name: DesktopEventName, data: DesktopEvents[DesktopEventName]): void {
    switch (name) {
      case 'hello': {
        const hello = data as DesktopEvents['hello'];
        this.state.user = hello.user;
        this.state.serverVersion = hello.serverVersion;
        this.state.ready = true;
        this.state.online = true;
        this.windowChanged();
        break;
      }
      case 'signedOut':
        break;
      case 'connection':
        this.state.online = data === 'online';
        break;
      case 'counters': {
        const counters = data as DesktopEvents['counters'];
        this.state.chat = counters.chat;
        this.state.notifications = counters.notifications;
        break;
      }
      case 'focus':
        this.state.focusUntil = (data as DesktopEvents['focus'])?.until ?? null;
        break;
      case 'timer':
        this.state.timer = data as DesktopEvents['timer'];
        this.state.timerReceivedAt = Date.now();
        break;
      case 'notify':
        void this.notify(data as DesktopNotify);
        return;
    }
    this.o.log.info('событие моста', { event: name });
    this.update();
  }
  private async notify(wire: DesktopNotify): Promise<void> {
    const epoch = this.epoch,
      owner = this.state.user?.id;
    const prefs = this.o.settings.get().notifications;
    if (!owner || !this.state.ready || !this.state.online || !prefs.enabled) return;
    // Основные правила решает страница. Дополнительная защита от запоздавшего события.
    if (focusOn(this.state) && wire.kind !== 'mention') return;
    if (!(await this.policy.allows())) {
      this.o.log.info('уведомление скрыто Windows');
      return;
    }
    if (epoch !== this.epoch || owner !== this.state.user?.id || !this.state.online) return;
    const buttons = wire.buttons.filter((button) => button !== 'reply');
    const labels = { open: S.desktopOpen, read: S.desktopRead, startTimer: S.desktopStartTask };
    const spec: ToastSpec = {
      key: wire.key,
      id: wire.key,
      groupId: wire.chatId ? `chat:${wire.chatId}` : wire.key,
      title: wire.title,
      body: prefs.preview ? wire.text : S.desktopNewMessage,
      hasReply: wire.buttons.includes('reply') && wire.chatId !== null,
      buttons: buttons.map((button) => labels[button as keyof typeof labels]),
      delayMs: 0,
    };
    this.meta.set(spec, { wire, owner, buttons });
    this.toasts.show(spec);
  }
  private async reply(spec: ToastSpec, text: string): Promise<DesktopCommandResult> {
    const item = this.meta.get(spec);
    if (
      !item ||
      item.owner !== this.state.user?.id ||
      !item.wire.chatId ||
      !item.wire.buttons.includes('reply')
    )
      return { ok: false, error: S.bridgeOffline };
    if (item.lastText !== text || !item.requestId) {
      item.lastText = text;
      item.requestId = randomUUID();
    }
    return this.bridge.command('reply', { chatId: item.wire.chatId, text }, item.requestId);
  }
  private async button(spec: ToastSpec, index: number): Promise<void> {
    const item = this.meta.get(spec);
    if (!item || item.owner !== this.state.user?.id) return;
    let result: DesktopCommandResult = { ok: true };
    switch (item.buttons[index]) {
      case 'open':
        result = await this.navigate(item.wire.link);
        break;
      case 'read':
        if (item.wire.read) result = await this.bridge.command('markRead', item.wire.read);
        break;
      case 'startTimer':
        if (item.wire.taskId)
          result = await this.bridge.command('timer', {
            action: 'start',
            taskId: item.wire.taskId,
          });
        break;
    }
    this.notice(result);
  }
  private async navigate(link: string | null): Promise<DesktopCommandResult> {
    this.o.main.show();
    if (!link) return { ok: true };
    if (!teamsLink(link)) return { ok: false, error: S.bridgeCommandFailed };
    const result = await this.bridge.command('navigate', { link });
    this.notice(result);
    return result;
  }
  private notice(result: DesktopCommandResult): void {
    if (!this.o.main.win.isDestroyed())
      this.o.main.win.webContents.send('desktop:compatibility', result.ok ? '' : result.error);
  }
  private async menuAction(action: string): Promise<DesktopCommandResult> {
    if (action === 'open') {
      this.o.main.show();
      return { ok: true };
    }
    if (action === 'quit') {
      app.quit();
      return { ok: true };
    }
    if (action === 'chat') return this.navigate('/chat');
    if (action === 'notifications') {
      this.o.main.show();
      return this.bridge.openNotifications();
    }
    if (action === 'start' || action === 'change' || action === 'stop') {
      if (!this.state.ready || !this.state.online) return { ok: false, error: S.bridgeOffline };
      this.pages.open(action === 'stop' ? 'finish' : 'pick', this.o.tray.getBounds());
      return { ok: true };
    }
    if (action === 'pause' || action === 'resume') return this.bridge.command('timer', { action });
    if (action === 'focus-off') return this.bridge.command('focus', { until: null });
    const until = new Date();
    if (action === 'focus-30' || action === 'focus-60')
      until.setMinutes(until.getMinutes() + (action === 'focus-30' ? 30 : 60));
    else if (action === 'focus-1500') {
      until.setHours(15, 0, 0, 0);
      if (until.getTime() <= Date.now()) return { ok: false, error: S.desktopFocusPast };
    } else if (action === 'focus-end') until.setHours(23, 59, 59, 999);
    else return { ok: false, error: S.bridgeCommandFailed };
    return this.bridge.command('focus', { until: until.toISOString() });
  }
  private update(): void {
    if (this.o.tray.isDestroyed()) return;
    const state = {
      count: this.state.chat + this.state.notifications,
      online: this.state.ready && this.state.online,
      focus: focusOn(this.state),
      timer: this.state.timer.state,
    };
    const image = nativeImage.createEmpty();
    for (const [scaleFactor, size] of [
      [1, 16],
      [1.25, 20],
      [1.5, 24],
      [2, 32],
    ] as const)
      image.addRepresentation({
        scaleFactor,
        width: size,
        height: size,
        buffer: encodePng(
          statusBitmap(size, nativeTheme.shouldUseDarkColorsForSystemIntegratedUI, state),
        ),
      });
    this.o.tray.setImage(image);
    this.o.tray.setToolTip(tooltip(this.state));
    this.overlay();
    this.menu.update();
  }
  private overlay(): void {
    if (this.o.main.win.isDestroyed()) return;
    const count = this.state.chat + this.state.notifications;
    const show = this.state.user && this.state.ready && count > 0 && this.o.main.win.isVisible();
    this.o.main.win.setOverlayIcon(
      show ? nativeImage.createFromBuffer(encodePng(badgeBitmap(count))) : null,
      S.desktopUnread(count),
    );
  }
  destroy(): void {
    clearInterval(this.tick);
    nativeTheme.removeListener('updated', this.theme);
    this.o.main.win.removeListener('show', this.windowChanged);
    this.o.main.win.removeListener('hide', this.windowChanged);
    this.o.main.win.removeListener('focus', this.windowChanged);
    this.o.main.win.removeListener('blur', this.windowChanged);
    this.bridge.destroy();
    this.pages.destroy();
    this.toasts.destroy();
    this.menu.destroy();
  }
}
