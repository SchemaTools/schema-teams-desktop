import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  nativeImage,
  powerMonitor,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type Rectangle,
  type Tray,
} from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ApiResult, ChatMessage, NotificationItem, FocusState } from '../shared/client';
import type { ClientSnapshot, DesktopRequest } from '../shared/desktop';
import { requestValid } from '../shared/requests';
import { TeamsApi, failure } from './api/client';
import * as parse from './api/parse';
import { notificationAllowed } from './api/notificationPrefs';
import { RealtimeClient, type RealtimeEvent } from './realtime/connection';
import { CLIENT_FILE, CLIENT_URL, PARTITION, guardLocal, type MainWindow } from './mainWindow';
import { LoginWindow } from './loginWindow';
import { CustomToasts } from './notifications/toasts';
import type { ToastSpec } from './notifications/types';
import { WindowsNotificationPolicy } from './desktop/notificationState';
import { PathService } from './paths/service';
import { AttachmentService } from './files/service';
import { UploadService } from './files/uploads';
import { statusBitmap, badgeBitmap } from './desktop/statusBitmap';
import { encodePng } from './png';
import type { Logger } from './logger';
import type { SettingsStore } from './settings';

interface Options {
  main: MainWindow;
  server: URL | null;
  settings: SettingsStore;
  log: Logger;
  tray: Tray;
}
interface Notice {
  epoch: number;
  owner: number;
  chatId: number | null;
  messageId?: number;
  notificationId?: number;
  link?: string | null;
  mention: boolean;
  ordinary: boolean;
  lastText?: string;
  requestId?: string;
}
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
export class ClientHost {
  readonly api: TeamsApi;
  private state: ClientSnapshot;
  private readonly ses = session.fromPartition(PARTITION);
  private readonly realtime?: RealtimeClient;
  private readonly login?: LoginWindow;
  private readonly paths: PathService;
  private readonly files: AttachmentService;
  private readonly uploads: UploadService;
  private readonly fileSession = session.fromPartition('client-ui');
  private readonly policy = new WindowsNotificationPolicy();
  private readonly toasts: CustomToasts;
  private readonly notices = new WeakMap<ToastSpec, Notice>();
  private readonly counts = new Map<number, { at: number; count: number }>();
  private trayWindow?: BrowserWindow;
  private readonly peers = new Map<number, string>();
  private readonly pending = new Map<number, number>();
  private activeChat: number | null = null;
  private boot = 0;
  private bootFlight?: Promise<void>;
  private bootEpoch = -1;
  private socketOnline = false;
  private loggingOut = false;
  private authCookie: string | null = null;
  private readonly tick: NodeJS.Timeout;
  private summarizedUntil: string | null = null;
  private preferencesFlight?: Promise<boolean>;
  private preferencesEpoch = -1;
  private destroyed = false;
  private refreshing = false;
  private again = false;
  private refreshTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private retry = 0;
  private locked = false;
  private suspended = false;
  private readonly themeChanged = () => this.publish();
  private readonly lock = () => {
    this.locked = true;
    this.toasts.clear();
  };
  private readonly unlock = () => {
    this.locked = false;
  };
  private readonly sleep = () => {
    this.suspended = true;
    this.toasts.clear();
  };
  private readonly wake = () => {
    this.suspended = false;
  };
  private readonly cookieChanged = (_e: Electron.Event, cookie: Electron.Cookie) => {
    if (!this.o.server || cookie.name !== 'st_session') return;
    const domain = cookie.domain?.replace(/^\./, '');
    if (
      domain &&
      this.o.server.hostname !== domain &&
      !this.o.server.hostname.endsWith(`.${domain}`)
    )
      return;
    this.invalidate();
    if (!this.loggingOut) void this.bootstrap();
  };
  constructor(private readonly o: Options) {
    this.state = {
      connection: o.server ? 'connecting' : 'noServer',
      user: null,
      serverVersion: '',
      appVersion: app.getVersion(),
      epoch: 0,
      revision: 0,
      historyRevision: 0,
      typing: [],
      theme: 'light',
      themePreference: o.settings.get().theme,
      chats: [],
      unread: 0,
      notifications: [],
      notificationUnread: 0,
      focus: { until: null, startedAt: null },
      error: null,
    };
    this.api = new TeamsApi({
      fetch: (path, init) => {
        if (!o.server || !path.startsWith('/api/') || path.includes('\\'))
          return Promise.reject(new Error('invalid-path'));
        return this.ses.fetch(new URL(path, o.server.origin).href, {
          ...init,
          redirect: 'manual',
          credentials: 'include',
        });
      },
      onAuthLost: () => this.signedOut(),
    });
    this.paths = new PathService({ log: o.log });
    this.files = new AttachmentService({
      api: this.api,
      downloads: () => app.getPath('downloads'),
      openPath: (path) => shell.openPath(path),
      reveal: (path) => shell.showItemInFolder(path),
    });
    this.fileSession.protocol.handle('schema-attachment', (request) =>
      this.files.response(request),
    );
    this.uploads = new UploadService({
      api: this.api,
      choose: () =>
        dialog.showOpenDialog(o.main.win, {
          title: 'Прикрепить файлы (до 50 МБ каждый)',
          properties: ['openFile', 'multiSelections'],
        }),
      clipboardImage: async () => {
        const items = await clipboard.read();
        const item = items.find((entry) => entry.types.includes('image/png'));
        if (!item) return null;
        const blob = await item.getType('image/png');
        if (blob.size > 50 * 1024 * 1024) throw new Error('image-size');
        const bytes = Buffer.from(await blob.arrayBuffer());
        if (
          bytes.length < 24 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.toString('ascii', 12, 16) !== 'IHDR'
        )
          throw new Error('image-format');
        const width = bytes.readUInt32BE(16),
          height = bytes.readUInt32BE(20);
        if (!width || !height || width > 8192 || height > 8192 || width * height > 20 * 1024 * 1024)
          throw new Error('image-size');
        return bytes;
      },
    });
    this.toasts = new CustomToasts({
      beforeShow: (spec) => this.beforeNotice(spec),
      onReply: async (spec, text) => {
        const n = this.notices.get(spec);
        if (!n?.chatId || !this.owned(n)) return { ok: false, error: 'Вход изменился.' };
        if (n.lastText !== text || !n.requestId) {
          n.lastText = text;
          n.requestId = randomUUID();
        }
        const r = await this.api.send(n.chatId, text, n.requestId);
        if (r.ok) this.scheduleRefresh();
        return r.ok ? { ok: true } : { ok: false, error: r.error, uncertain: r.uncertain };
      },
      onButton: (spec, index) => {
        const n = this.notices.get(spec);
        if (!n || !this.owned(n)) return;
        if (index === 0) this.openNotice(n);
        else if (n.chatId && n.messageId)
          void this.api.read(n.chatId, n.messageId).then(() => this.scheduleRefresh());
        else if (n.notificationId)
          void this.api.readNotification(n.notificationId).then(() => this.scheduleRefresh());
      },
      onOpen: (spec) => {
        const n = this.notices.get(spec);
        if (n && this.owned(n)) this.openNotice(n);
      },
      onShow: (spec) => {
        const n = this.notices.get(spec);
        if (n && this.current(n) && o.settings.get().notifications.sound) shell.beep();
      },
      onClose: () => {},
    });
    if (o.server) {
      const origin = o.server.origin;
      this.login = new LoginWindow(o.server, () => {
        if (!this.loggingOut) void this.bootstrap();
      });
      this.realtime = new RealtimeClient({
        server: o.server,
        getEpoch: () => this.api.epoch,
        getCookie: async () =>
          (
            await this.ses.cookies.get({
              url: new URL('/socket.io', origin).href,
              name: 'st_session',
            })
          )[0]?.value ?? null,
        onEvent: (name, data) => this.event(name, data),
        onStatus: (online) => {
          this.socketOnline = online;
          if (!this.state.user || this.state.user.id !== this.api.owner) return;
          this.state.connection = online ? 'online' : 'offline';
          this.publish();
          if (online) this.scheduleRefresh();
        },
      });
    }
    this.peers.set(o.main.win.webContents.id, CLIENT_URL);
    ipcMain.handle('client:request', (e, raw: unknown) => this.receive(e, raw));
    o.main.win.webContents.on('did-finish-load', () => this.publish());
    this.ses.cookies.on('changed', this.cookieChanged);
    nativeTheme.on('updated', this.themeChanged);
    powerMonitor.on('lock-screen', this.lock);
    powerMonitor.on('unlock-screen', this.unlock);
    powerMonitor.on('suspend', this.sleep);
    powerMonitor.on('resume', this.wake);
    o.main.win.on('show', () => {
      this.publish();
      this.scheduleRefresh();
    });
    o.main.win.on('hide', () => this.publish());
    o.main.win.on('focus', () => this.scheduleRefresh());
    this.tick = setInterval(() => {
      if (this.state.focus.until && Date.parse(this.state.focus.until) <= Date.now())
        this.updateFocus({ until: null, startedAt: null });
      this.scheduleRefresh();
    }, 30000);
    void this.bootstrap();
  }
  private invalidate(): void {
    this.authCookie = null;
    this.summarizedUntil = null;
    this.boot++;
    this.api.clear();
    this.realtime?.stop();
    this.paths.reset();
    this.files.reset();
    this.uploads.reset();
    this.toasts.clear();
    this.counts.clear();
    this.activeChat = null;
    this.state = {
      ...this.state,
      epoch: this.api.epoch,
      user: null,
      chats: [],
      unread: 0,
      notifications: [],
      notificationUnread: 0,
      focus: { until: null, startedAt: null },
      connection: 'connecting',
      navigateChat: null,
      error: null,
    };
    this.publish();
  }
  private signedOut(): void {
    this.authCookie = null;
    this.summarizedUntil = null;
    this.realtime?.stop();
    this.paths.reset();
    this.files.reset();
    this.uploads.reset();
    this.toasts.clear();
    this.activeChat = null;
    this.state = {
      ...this.state,
      epoch: this.api.epoch,
      user: null,
      chats: [],
      unread: 0,
      notifications: [],
      notificationUnread: 0,
      focus: { until: null, startedAt: null },
      connection: 'signedOut',
      navigateChat: null,
      error: null,
    };
    this.publish();
  }
  bootstrap(): Promise<void> {
    const epoch = this.api.epoch;
    if (this.bootFlight && this.bootEpoch === epoch) return this.bootFlight;
    this.bootEpoch = epoch;
    const flight = this.bootstrapNow().finally(() => {
      if (this.bootFlight === flight) this.bootFlight = undefined;
    });
    this.bootFlight = flight;
    return flight;
  }
  private async bootstrapNow(): Promise<void> {
    if (!this.o.server || this.destroyed) return;
    clearTimeout(this.retryTimer);
    const boot = ++this.boot;
    const health = await this.api.health();
    if (this.destroyed || boot !== this.boot) return;
    if (!health.ok || health.data.status !== 'ok') {
      this.offline(health.ok ? 'Сервер временно недоступен.' : health.error);
      return;
    }
    this.state.serverVersion = health.data.version;
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(health.data.version);
    if (!version || (Number(version[1]) === 0 && Number(version[2]) < 11)) {
      this.state.connection = 'incompatible';
      this.state.error = 'Нужен Schema Teams 0.11.0 или новее.';
      this.publish();
      return;
    }
    const cookieBefore =
      (await this.ses.cookies.get({ url: this.o.server.href, name: 'st_session' }))[0]?.value ??
      null;
    if (this.destroyed || boot !== this.boot) return;
    const user = await this.api.authenticate();
    if (this.destroyed || boot !== this.boot) return;
    if (!user.ok) {
      if (user.code !== 'unauthenticated' && user.code !== 'stale_session')
        this.offline(user.error);
      return;
    }
    const cookieAfter =
      (await this.ses.cookies.get({ url: this.o.server.href, name: 'st_session' }))[0]?.value ??
      null;
    if (this.destroyed || boot !== this.boot) return;
    if (cookieBefore !== cookieAfter) {
      this.invalidate();
      void this.bootstrap();
      return;
    }
    this.authCookie = cookieAfter;
    if (this.state.epoch !== this.api.epoch || this.state.user?.id !== user.data.id) {
      this.state.chats = [];
      this.state.unread = 0;
      this.state.notifications = [];
      this.state.notificationUnread = 0;
      this.state.focus = { until: null, startedAt: null };
      this.state.navigateChat = null;
      this.activeChat = null;
      this.toasts.clear();
      this.paths.reset();
      this.files.reset();
      this.uploads.reset();
      this.counts.clear();
    }
    this.state.user = user.data;
    this.state.epoch = this.api.epoch;
    this.state.error = null;
    if (user.data.mustChangePassword) {
      this.state.connection = 'passwordChange';
      this.publish();
      return;
    }
    this.login?.close();
    this.retry = 0;
    this.state.connection = this.socketOnline ? 'online' : 'connecting';
    this.publish();
    await this.refresh();
    if (boot === this.boot && !this.destroyed && this.api.owner) await this.realtime?.start();
  }
  private offline(error: string): void {
    this.state.connection = 'offline';
    this.state.error = error;
    this.publish();
    const delay = [1000, 2000, 5000, 10000, 30000][Math.min(this.retry++, 4)] ?? 30000;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      void this.bootstrap();
    }, delay);
  }
  private scheduleRefresh(): void {
    if (this.destroyed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 150);
  }
  private async refresh(): Promise<void> {
    if (!this.api.owner || this.destroyed) return;
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    const epoch = this.api.epoch;
    try {
      const [chats, notifications, focus] = await Promise.all([
        this.api.listChats(),
        this.api.notifications(),
        this.api.focus(),
      ]);
      if (this.destroyed || epoch !== this.api.epoch) return;
      if (chats.ok) {
        this.state.chats = chats.data.items;
        this.state.unread = chats.data.unreadTotal;
      }
      if (notifications.ok) {
        this.state.notifications = notifications.data.items;
        this.state.notificationUnread = notifications.data.unread;
      }
      if (focus.ok) this.updateFocus(focus.data);
      const bad = [chats, notifications, focus].find((r) => !r.ok);
      this.state.error = bad && !bad.ok ? bad.error : null;
      this.state.historyRevision = (this.state.historyRevision ?? 0) + 1;
      this.publish();
    } finally {
      this.refreshing = false;
      if (this.again) {
        this.again = false;
        this.scheduleRefresh();
      }
    }
  }
  private event(name: RealtimeEvent, data: unknown): void {
    if (name === 'chat:typing') {
      try {
        const p = parse.object(data);
        if (
          this.state.connection !== 'online' ||
          !this.state.user ||
          typeof p.chatId !== 'number' ||
          !Number.isSafeInteger(p.chatId) ||
          typeof p.userId !== 'number' ||
          !Number.isSafeInteger(p.userId) ||
          p.userId <= 0 ||
          p.userId === this.api.owner ||
          !this.state.chats.some((c) => c.id === p.chatId) ||
          typeof p.shortName !== 'string' ||
          !p.shortName.trim() ||
          p.shortName.length > 200
        )
          return;
        this.state.typing = [
          ...(this.state.typing ?? [])
            .filter(
              (t) => t.until > Date.now() && !(t.chatId === p.chatId && t.userId === p.userId),
            )
            .slice(-99),
          { chatId: p.chatId, userId: p.userId, shortName: p.shortName, until: Date.now() + 5000 },
        ];
        this.publish();
      } catch {
        /* Malformed presence data never reaches the renderer. */
      }
      return;
    }
    if (name === 'chat:presence') return;
    this.o.log.info('событие клиента', { event: name });
    if (name === 'session') {
      this.invalidate();
      void this.bootstrap();
      return;
    }
    if (name === 'chat:message') {
      try {
        this.messageNotice(parse.message(data));
      } catch {
        this.o.log.warn('неподдержанное событие чата');
      }
    }
    if (name === 'notification') {
      try {
        const push = parse.object(data);
        if (push.quiet === false) this.bellNotice(parse.notification(push.item));
      } catch {
        this.o.log.warn('неподдержанное уведомление');
      }
    }
    this.scheduleRefresh();
  }
  private updateFocus(focus: FocusState): void {
    const previous = this.state.focus.until;
    this.state.focus = focus;
    if (!previous || focus.until || previous === this.summarizedUntil || !this.api.owner) return;
    this.summarizedUntil = previous;
    const epoch = this.api.epoch;
    void this.api.focusSummary().then((result) => {
      if (
        !result.ok ||
        epoch !== this.api.epoch ||
        !this.api.owner ||
        !(result.data.messages || result.data.mentions)
      )
        return;
      this.showNotice(
        `focus:${epoch}:${previous}`,
        'Пока вы были в фокусе',
        `${result.data.messages} сообщений в ${result.data.chats.length} чатах · упоминаний: ${result.data.mentions}`,
        { epoch, owner: this.api.owner, chatId: null, mention: false, ordinary: true },
      );
    });
  }
  private messageNotice(message: ChatMessage): void {
    const owner = this.api.owner;
    if (
      !owner ||
      message.deleted ||
      message.author?.id === owner ||
      message.mentions.includes(owner)
    )
      return;
    const previous = this.counts.get(message.chatId);
    const count = previous && Date.now() - previous.at < 60000 ? previous.count + 1 : 1;
    this.counts.set(message.chatId, { at: Date.now(), count });
    const title =
      this.state.chats.find((c) => c.id === message.chatId)?.title ??
      message.author?.shortName ??
      'Новое сообщение';
    this.showNotice(
      `chat:${message.chatId}`,
      title,
      `${count > 1 ? `${count} новых сообщений\n` : ''}${message.text || 'Новое вложение'}`,
      {
        epoch: this.api.epoch,
        owner,
        chatId: message.chatId,
        messageId: message.id,
        mention: false,
        ordinary: true,
      },
    );
  }
  private bellNotice(item: NotificationItem): void {
    const owner = this.api.owner;
    if (!owner) return;
    const chat = item.link && /^\/chat\/(\d+)(?:\?m=(\d+))?$/.exec(item.link);
    this.showNotice(
      `notification:${item.id}`,
      item.subject ?? item.task?.title ?? 'Schema Teams',
      item.reason ??
        item.changes.map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('\n'),
      {
        epoch: this.api.epoch,
        owner,
        chatId: chat ? Number(chat[1]) : null,
        ...(chat?.[2] && { messageId: Number(chat[2]) }),
        notificationId: item.id,
        link: item.link,
        mention: item.event === 'chat_mention',
        ordinary: false,
      },
    );
  }
  private showNotice(id: string, title: string, body: string, notice: Notice): void {
    const spec: ToastSpec = {
      id,
      key: id,
      groupId: notice.chatId ? `chat:${notice.chatId}` : id,
      title,
      body: this.o.settings.get().notifications.preview ? body : 'Новое сообщение',
      hasReply: notice.chatId !== null,
      buttons: notice.chatId || notice.notificationId ? ['Открыть', 'Прочитано'] : ['Открыть'],
      delayMs: 0,
    };
    this.notices.set(spec, notice);
    if (this.current(notice)) this.toasts.show(spec);
  }
  private owned(n: Notice): boolean {
    return n.owner === this.api.owner && n.epoch === this.api.epoch;
  }
  private current(n: Notice): boolean {
    return (
      this.owned(n) &&
      this.state.connection === 'online' &&
      this.o.settings.get().notifications.enabled &&
      !this.locked &&
      !this.suspended &&
      (!this.state.focus.until || Date.parse(this.state.focus.until) <= Date.now() || n.mention) &&
      !(
        n.chatId &&
        this.activeChat === n.chatId &&
        this.o.main.win.isVisible() &&
        this.o.main.win.isFocused()
      )
    );
  }
  private async beforeNotice(spec: ToastSpec): Promise<boolean> {
    const n = this.notices.get(spec);
    if (!n || !this.current(n)) return false;
    if (n.ordinary) {
      const epoch = this.api.epoch;
      if (!this.preferencesFlight || this.preferencesEpoch !== epoch) {
        this.preferencesEpoch = epoch;
        const flight = this.api
          .notificationSettings()
          .then((r) => epoch === this.api.epoch && r.ok && notificationAllowed(r.data))
          .finally(() => {
            if (this.preferencesFlight === flight) this.preferencesFlight = undefined;
          });
        this.preferencesFlight = flight;
      }
      if (!(await this.preferencesFlight)) return false;
    }
    const idle = powerMonitor.getSystemIdleState(1);
    if ((idle !== 'active' && idle !== 'idle') || !(await this.policy.allows())) return false;
    const after = powerMonitor.getSystemIdleState(1);
    return (after === 'active' || after === 'idle') && this.current(n);
  }
  private openNotice(n: Notice): void {
    if (n.chatId) this.showChat(n.chatId, n.messageId);
    else if (n.link) void this.site(n.link);
    else this.o.main.show();
  }
  private showChat(chatId: number, messageId?: number): void {
    this.state.navigateChat = {
      chatId,
      ...(messageId && { messageId }),
      nonce: (this.state.navigateChat?.nonce ?? 0) + 1,
    };
    this.o.main.show();
    this.trayWindow?.hide();
    this.publish();
  }
  private site(path: string): ApiResult<null> {
    if (
      !this.o.server ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      [...path].some((c) => c === '\\' || c.charCodeAt(0) <= 32)
    )
      return failure('validation');
    const url = new URL(path, this.o.server.origin);
    if (url.origin !== this.o.server.origin) return failure('validation');
    void shell.openExternal(url.href);
    return ok(null);
  }
  private async receive(event: IpcMainInvokeEvent, raw: unknown): Promise<unknown> {
    if (
      !requestValid(raw) ||
      this.peers.get(event.sender.id) !== event.senderFrame?.url ||
      event.senderFrame !== event.sender.mainFrame
    )
      return failure('validation');
    if ('epoch' in raw && raw.epoch !== this.api.epoch) return failure('stale_session');
    const count = this.pending.get(event.sender.id) ?? 0;
    if (count >= 8) return failure('server_error');
    this.pending.set(event.sender.id, count + 1);
    try {
      const result = await this.request(raw);
      return 'epoch' in raw && raw.kind !== 'logout' && raw.epoch !== this.api.epoch
        ? failure('stale_session')
        : result;
    } catch {
      return failure('server_error');
    } finally {
      const left = (this.pending.get(event.sender.id) ?? 1) - 1;
      if (left) this.pending.set(event.sender.id, left);
      else this.pending.delete(event.sender.id);
    }
  }
  private async request(r: DesktopRequest): Promise<unknown> {
    switch (r.kind) {
      case 'init':
        return ok(this.state);
      case 'login':
        if (this.loggingOut)
          return {
            ok: false,
            code: 'busy',
            error: 'Дождитесь завершения выхода.',
            retryable: false,
          };
        this.login?.show();
        return ok(null);
      case 'retry':
        void this.bootstrap();
        return ok(null);
      case 'logout': {
        if (!this.o.server || !this.api.owner || this.loggingOut) return failure('unauthenticated');
        this.loggingOut = true;
        this.login?.close();
        try {
          const boundCookie = this.authCookie;
          const before = (
            await this.ses.cookies.get({ url: this.o.server.href, name: 'st_session' })
          )[0]?.value;
          if (r.epoch !== this.api.epoch || before !== boundCookie) return failure('stale_session');
          await this.api.logout();
          const current = (
            await this.ses.cookies.get({ url: this.o.server.href, name: 'st_session' })
          )[0]?.value;
          if ((current && current !== before) || this.api.owner !== null)
            return failure('stale_session');
          if (current) await this.ses.cookies.remove(this.o.server.href, 'st_session');
          this.invalidate();
          this.signedOut();
          return ok(null);
        } finally {
          this.loggingOut = false;
          if (this.state.connection === 'connecting') void this.bootstrap();
        }
      }
      case 'theme':
        this.o.settings.update({ theme: r.mode });
        this.publish();
        return ok(null);
      case 'app.quit':
        app.quit();
        return ok(null);
      case 'window.hide':
        this.trayWindow?.hide();
        return ok(null);
      case 'window.show':
        if (r.chatId) this.showChat(r.chatId, r.messageId);
        else {
          if (r.target === 'events')
            this.state.navigateEvents = (this.state.navigateEvents ?? 0) + 1;
          this.o.main.show();
          this.trayWindow?.hide();
          this.publish();
        }
        return ok(null);
      case 'open.site':
        return this.site(r.path);
      case 'open.link': {
        try {
          const url = new URL(r.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            return failure('validation');
          void shell.openExternal(url.href);
          return ok(null);
        } catch {
          return failure('validation');
        }
      }
    }
    if (!this.api.owner || this.state.user?.mustChangePassword) return failure('unauthenticated');
    switch (r.kind) {
      case 'chat.list':
        return this.api.listChats();
      case 'chat.detail':
        return this.api.detail(r.chatId);
      case 'chat.messages':
        return this.api.messages(r.chatId, {
          ...(r.before && { before: r.before }),
          ...(r.after && { after: r.after }),
          ...(r.around && { around: r.around }),
        });
      case 'chat.send': {
        const result = await this.api.send(r.chatId, r.text, r.requestId, r.fileIds, r.replyTo);
        if (result.ok) this.scheduleRefresh();
        return result;
      }
      case 'chat.search':
        return this.api.search(r.chatId, r.q);
      case 'chat.markRead': {
        if (!this.o.main.win.isVisible() || !this.o.main.win.isFocused())
          return failure('validation');
        const last = this.state.chats.find((c) => c.id === r.chatId)?.last?.id;
        if (!last) return failure('not_found');
        const result = await this.api.read(r.chatId, last);
        if (result.ok) this.scheduleRefresh();
        return result;
      }
      case 'chat.edit':
      case 'chat.delete': {
        const result =
          r.kind === 'chat.edit'
            ? await this.api.edit(r.chatId, r.messageId, r.text)
            : await this.api.delete(r.chatId, r.messageId);
        if (result.ok) this.scheduleRefresh();
        return result;
      }
      case 'chat.pin': {
        const result = await this.api.pin(r.chatId, r.messageId);
        if (result.ok) this.scheduleRefresh();
        return result;
      }
      case 'chat.reaction': {
        const result = await this.api.reactions(r.chatId, r.messageId, r.reaction, r.remove);
        if (result.ok) this.scheduleRefresh();
        return result;
      }
      case 'chat.read': {
        if (
          !this.o.main.win.isVisible() ||
          !this.o.main.win.isFocused() ||
          this.activeChat !== r.chatId
        )
          return failure('validation');
        const result = await this.api.read(r.chatId, r.upTo);
        if (result.ok) this.scheduleRefresh();
        return result;
      }
      case 'chat.view':
        this.activeChat = r.chatId;
        return ok(null);
      case 'chat.typing':
        if (
          this.state.connection !== 'online' ||
          !this.state.user ||
          this.state.user.mustChangePassword ||
          this.activeChat !== r.chatId ||
          !this.o.main.win.isVisible() ||
          !this.o.main.win.isFocused()
        )
          return failure('validation');
        this.realtime?.typing(r.chatId);
        return ok(null);
      case 'open.path':
        return ok(await this.paths.open({ ...r, reveal: true }));
      case 'file.preview':
        return this.files.preview(r);
      case 'file.pick':
        return this.uploads.pick(r, r.limit);
      case 'file.paste':
        return this.uploads.paste(r);
      case 'file.action':
        return this.files.action(r, r.action);
      case 'focus.set': {
        const result = await this.api.setFocus(
          r.minutes ? new Date(Date.now() + r.minutes * 60000).toISOString() : null,
        );
        if (r.epoch !== this.api.epoch) return failure('stale_session');
        if (result.ok) {
          this.updateFocus(result.data);
          this.publish();
          return ok(null);
        }
        return result;
      }
      case 'notifications.read': {
        const result = await this.api.readNotification(r.id);
        if (result.ok) {
          this.scheduleRefresh();
          return ok(null);
        }
        return result;
      }
    }
  }
  private publish(): void {
    if (this.destroyed) return;
    if (this.state.connection !== 'online') this.state.typing = [];
    this.state.revision++;
    this.state.epoch = this.api?.epoch ?? 0;
    this.state.themePreference = this.o.settings.get().theme;
    this.state.theme =
      this.state.themePreference === 'system'
        ? nativeTheme.shouldUseDarkColors
          ? 'dark'
          : 'light'
        : this.state.themePreference;
    for (const win of [this.o.main.win, this.trayWindow])
      if (win && !win.isDestroyed() && this.peers.has(win.webContents.id))
        win.webContents.send('client:state', this.state);
    if (!this.o.tray.isDestroyed()) {
      const n = this.state.unread + this.state.notificationUnread;
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
            statusBitmap(size, nativeTheme.shouldUseDarkColorsForSystemIntegratedUI, {
              count: n,
              online: this.state.connection === 'online',
              focus: Boolean(
                this.state.focus.until && Date.parse(this.state.focus.until) > Date.now(),
              ),
              timer: 'idle',
            }),
          ),
        });
      this.o.tray.setImage(image);
      if (!this.o.main.win.isDestroyed())
        this.o.main.win.setOverlayIcon(
          n > 0 && this.state.user && this.o.main.win.isVisible()
            ? nativeImage.createFromBuffer(encodePng(badgeBitmap(n)))
            : null,
          `Непрочитанных: ${n}`,
        );
      this.o.tray.setToolTip(
        `Schema Teams · ${this.state.connection === 'online' ? `Непрочитанных: ${n}` : 'Нет связи'}`,
      );
    }
  }
  showMenu(bounds: Rectangle): void {
    if (!this.trayWindow || this.trayWindow.isDestroyed()) {
      const win = new BrowserWindow({
        width: 400,
        height: 600,
        show: false,
        frame: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        resizable: false,
        webPreferences: {
          preload: join(__dirname, '../preload/client.js'),
          partition: 'client-ui',
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      this.trayWindow = win;
      guardLocal(win.webContents);
      this.peers.set(win.webContents.id, `${CLIENT_URL}?surface=tray`);
      win.on('blur', () => win.hide());
      win.once('closed', () => {
        this.peers.delete(win.webContents.id);
      });
      win.webContents.on('did-finish-load', () => this.publish());
      void win.loadFile(CLIENT_FILE, { query: { surface: 'tray' } }).then(() => {
        if (!win.isDestroyed()) {
          win.show();
          win.focus();
        }
      });
    }
    const area = screen.getDisplayMatching(bounds).workArea;
    this.trayWindow.setBounds({
      x: Math.max(area.x, Math.min(bounds.x - 376, area.x + area.width - 400)),
      y: Math.max(area.y + 8, area.y + area.height - Math.min(600, area.height - 16) - 8),
      width: Math.min(400, area.width),
      height: Math.min(600, area.height - 16),
    });
    if (!this.trayWindow.webContents.isLoading()) {
      this.trayWindow.show();
      this.trayWindow.focus();
    }
  }
  destroy(): void {
    clearInterval(this.tick);
    this.destroyed = true;
    this.boot++;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.retryTimer);
    this.api.clear();
    this.realtime?.stop();
    this.login?.close();
    this.toasts.destroy();
    this.paths.destroy();
    this.files.destroy();
    this.uploads.destroy();
    this.fileSession.protocol.unhandle('schema-attachment');
    this.trayWindow?.destroy();
    ipcMain.removeHandler('client:request');
    this.ses.cookies.removeListener('changed', this.cookieChanged);
    nativeTheme.removeListener('updated', this.themeChanged);
    powerMonitor.removeListener('lock-screen', this.lock);
    powerMonitor.removeListener('unlock-screen', this.unlock);
    powerMonitor.removeListener('suspend', this.sleep);
    powerMonitor.removeListener('resume', this.wake);
  }
}
