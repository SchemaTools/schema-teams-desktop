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
import { randomUUID, createHash } from 'node:crypto';
import {
  PauseOutbox,
  type PauseScope,
  type PauseEnvelope,
  type PauseEvent,
} from './timer/pauseOutbox';
import { PauseReturns, type PauseReturn } from './timer/pauseReturns';
import type { ApiResult, ChatMessage, NotificationItem, FocusState } from '../shared/client';
import type { ClientSnapshot, DesktopRequest } from '../shared/desktop';
import { requestValid } from '../shared/requests';
import { TeamsApi, failure } from './api/client';
import * as parse from './api/parse';
import { workTimer, controlledTimer } from './api/time';
import type { WorkTimer } from '../shared/time';
import { TimerAbsence } from './timer/absence';
import { TimerReminders, isReminderTime, type ReminderTicket } from './timer/reminders';
import { elapsedAt, timerClock, matchesTimer, timerExpected, utcInstant } from '../shared/time';
import { notificationAllowed } from './api/notificationPrefs';
import { LiveNoticeGate } from './notifications/liveGate';
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
import {
  preferencesPatchValid,
  type PreferencesPatch,
  type LocalPreferences,
} from '../shared/preferences';
import { UpdateChecker } from './desktop/updateChecker';
import { ServerConfigurationService } from './desktop/serverConfiguration';
import { supportedServerVersion, MINIMUM_SERVER_VERSION } from '../shared/serverConfiguration';
import type { Health } from '../shared/client';
import type { RevitInventory } from '../shared/setup';
import { RevitInventoryService } from './desktop/revitInventory';
import { ReportService, type ReportBackend } from './diagnostics/service';

interface Options {
  pausePersistence?: { outbox: PauseOutbox; returns: PauseReturns };
  main: MainWindow;
  server: URL | null;
  settings: SettingsStore;
  log: Logger;
  tray: Tray;
  applyAutostart: (enabled: boolean) => void;
  autostartAvailable: boolean;
  openLogs: () => Promise<string>;
  partition?: string;
  serverLocked?: boolean;
  connectionNotice?: string;
  checkServer?: (server: URL) => Promise<ApiResult<Health>>;
  activateServer?: (server: URL) => Promise<void>;
  readRevit?: () => Promise<RevitInventory>;
  report?: Omit<ReportBackend, 'metadata'>;
}
interface Notice {
  recovery?: PauseReturn;
  reminder?: ReminderTicket;
  timerStopped?: boolean;
  epoch: number;
  owner: number;
  chatId: number | null;
  messageId?: number;
  notificationId?: number;
  pendingDeviceId?: string;
  link?: string | null;
  mention: boolean;
  ordinary: boolean;
  lastText?: string;
  requestId?: string;
}
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
export class ClientHost {
  get partition(): string {
    return this.o.partition ?? PARTITION;
  }
  readonly api: TeamsApi;
  private state: ClientSnapshot;
  private readonly ses: Electron.Session;
  private readonly realtime?: RealtimeClient;
  private readonly login?: LoginWindow;
  private readonly paths: PathService;
  private readonly files: AttachmentService;
  private readonly uploads: UploadService;
  private readonly fileSession = session.fromPartition('client-ui');
  private readonly policy = new WindowsNotificationPolicy();
  private readonly toasts: CustomToasts;
  private readonly notices = new WeakMap<ToastSpec, Notice>();
  private readonly counts = new Map<
    number,
    { at: number; messages: Set<number>; last: ChatMessage }
  >();
  private readonly readThrough = new Map<number, number>();
  private readonly liveNotices = new LiveNoticeGate();
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
  private loggedConnection?: ClientSnapshot['connection'];
  private refreshing = false;
  private again = false;
  private refreshTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private retry = 0;
  private timerRevision = 0;
  private readonly absence = new TimerAbsence();
  private readonly reminders = new TimerReminders();
  private readonly updates: UpdateChecker;
  private readonly configuration: ServerConfigurationService;
  private readonly inventory: RevitInventoryService;
  private readonly report: ReportService;
  private reminderId: string | null = null;
  private locked = false;
  private suspended = false;
  private readonly pauseOutbox: PauseOutbox;
  private readonly pauseReturns: PauseReturns;
  private readonly serverScopeHash: string;
  private serverClock: { ms: number; observedAt: number } | null = null;
  private configEpoch = -1;
  private timerEpoch = -1;
  private storageWarning = false;
  private returnedAt: string | null = null;
  private returnedKind: 'unlock' | 'wake' | null = null;
  private queryCandidate?: { scope: PauseScope; key: string };
  private readonly pauseAttempts = new Map<string, { count: number; nextAt: number }>();
  private readonly recoveryNotices = new Set<string>();
  private readonly sessionQuery = () => this.captureShutdownQuery();
  private readonly sessionEnded = () => this.finalizeShutdownQuery();
  private readonly mainActive = () => this.cancelShutdownQuery();
  private pauseFlight = false;
  private noticePending = new Set<number>();
  private readonly themeChanged = () => this.publish();
  private readonly lock = () => {
    this.pauseForAbsence();
    this.absence.depart('lock', this.state);
    this.locked = true;
    this.toasts.clear();
  };
  private readonly unlock = () => {
    this.locked = false;
    this.recordReturnTime('unlock');
    this.absence.return('unlock', this.state);
    this.publish();
    this.scheduleRefresh();
  };
  private readonly sleep = () => {
    this.pauseForAbsence('suspend');
    this.absence.depart('suspend', this.state);
    this.suspended = true;
    this.toasts.clear();
  };
  private readonly wake = () => {
    this.suspended = false;
    this.recordReturnTime('wake');
    this.absence.return('resume', this.state);
    this.publish();
    this.scheduleRefresh();
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
    this.serverScopeHash = createHash('sha256')
      .update(o.server?.origin ?? 'unconfigured')
      .digest('hex');
    this.pauseOutbox =
      o.pausePersistence?.outbox ??
      new PauseOutbox(join(app.getPath('userData'), 'timer-pause-outbox.json'), {
        now: () => this.serverTime(),
      });
    this.pauseReturns =
      o.pausePersistence?.returns ??
      new PauseReturns(join(app.getPath('userData'), 'timer-pause-returns.json'));

    this.report = new ReportService({
      metadata: () => ({
        appVersion: app.getVersion(),
        serverVersion: this.state.serverVersion,
        connection: this.state.connection,
      }),
      readApplication: o.report?.readApplication ?? (async () => []),
      readRevit: o.report?.readRevit ?? (async () => null),
      screens: o.report?.screens ?? (() => []),
      capture:
        o.report?.capture ??
        (async () => {
          throw Error('unavailable');
        }),
      choose: o.report?.choose ?? (async () => null),
      reveal: o.report?.reveal ?? (() => {}),
      saved: () => o.log.info('архив диагностики сохранён'),
    });
    this.inventory = new RevitInventoryService(
      o.readRevit ??
        (async () => {
          throw Error('unavailable');
        }),
    );
    this.ses = session.fromPartition(o.partition ?? PARTITION);
    this.configuration = new ServerConfigurationService({
      current: o.server,
      locked: o.serverLocked ?? true,
      notice: o.connectionNotice,
      readHealth: o.checkServer ?? (async () => failure('unavailable')),
      activate:
        o.activateServer ??
        (async () => {
          throw new Error('unavailable');
        }),
    });
    for (const [owner, date] of Object.entries(o.settings.get().timerReminderSeen))
      this.reminders.remember(Number(owner), date);
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
      navigateSettings: o.connectionNotice ? { tab: 'general', nonce: 1 } : null,
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
      onTimerAudit: (audit) => o.log.info('команда таймера', { ...audit }),
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
        if (n.recovery) {
          if (!this.current(n)) return;
          const shownScope = this.pauseScope();
          if (
            !shownScope ||
            !this.pauseReturns
              .list(shownScope)
              .some((record) => record.key === n.recovery?.key && record.delivery === 'shown')
          )
            return;
          if (index === 0) void this.resumePauseReturn(n);
          else {
            const scope = this.pauseScope();
            if (scope && !this.pauseReturns.dismiss(scope, n.recovery.key))
              this.storageWarning = true;
            this.openTimer('finish', undefined, n.recovery.expected);
          }
          return;
        }
        if (n.reminder) {
          if (this.current(n) && index === 0) this.openTimer('finish');
          return;
        }
        if (index === 0) this.openNotice(n);
        else if (n.chatId && n.messageId) void this.readChat(n.chatId, n.messageId);
        else if (n.notificationId)
          void this.api.readNotification(n.notificationId).then(() => this.scheduleRefresh());
      },
      onOpen: (spec) => {
        const n = this.notices.get(spec);
        if (n && this.owned(n) && (!n.reminder || this.current(n))) this.openNotice(n);
      },
      onShow: (spec) => {
        const n = this.notices.get(spec);
        if (n && this.current(n)) {
          if (n.recovery) {
            const scope = this.pauseScope();
            if (scope && !this.pauseReturns.shown(scope, n.recovery.key)) {
              this.storageWarning = true;
              this.publish();
            }
          }
          if (n.pendingDeviceId && n.notificationId) {
            const id = n.notificationId;
            void this.api.timerNoticeAck(n.pendingDeviceId, id).then((result) => {
              if (!result.ok && this.owned(n)) this.noticePending.delete(id);
            });
          }
          if (n.reminder) {
            this.reminders.shown(n.reminder);
            try {
              o.settings.update({
                timerReminderSeen: {
                  ...o.settings.get().timerReminderSeen,
                  [String(n.owner)]: n.reminder.date,
                },
              });
            } catch {
              o.log.warn('не удалось сохранить день напоминания');
            }
          }
          if (o.settings.get().notifications.sound) shell.beep();
        }
      },
      onClose: (spec) => {
        const n = this.notices.get(spec);
        if (n?.recovery) this.recoveryNotices.delete(n.recovery.key);
        if (n?.pendingDeviceId && n.notificationId) this.noticePending.delete(n.notificationId);
      },
    });
    if (o.server) {
      const origin = o.server.origin;
      this.login = new LoginWindow(
        o.server,
        () => {
          if (!this.loggingOut) void this.bootstrap();
        },
        o.partition ?? PARTITION,
      );
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
          this.liveNotices.reconnect();
          // Socket delivery is already live. Seed from the last accepted history now,
          // so a genuinely new push during the refresh is not mistaken for history.
          if (online) this.liveNotices.prime(this.state.chats, this.state.notifications);
          this.socketOnline = online;
          if (!this.state.user || this.state.user.id !== this.api.owner) return;
          this.state.connection = online ? 'online' : 'offline';
          this.publish();
          if (online) this.scheduleRefresh();
          if (!online) {
            this.configEpoch = -1;
            this.timerEpoch = -1;
          }
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
    o.main.win.on('query-session-end', this.sessionQuery);
    o.main.win.on('session-end', this.sessionEnded);
    o.main.win.on('focus', this.mainActive);
    o.main.win.on('show', () => {
      this.publish();
      this.scheduleRefresh();
    });
    o.main.win.on('hide', () => this.publish());
    o.main.win.on('focus', () => this.scheduleRefresh());
    this.updates = new UpdateChecker({
      enabled: Boolean(o.server),
      currentVersion: app.getVersion(),
      read: () => this.api.latestRelease(),
      onChange: (state) => {
        this.state.updates = state;
        this.publish();
      },
    });
    this.state.updates = this.updates.state;
    this.updates.start();
    this.tick = setInterval(() => {
      if (this.state.focus.until && Date.parse(this.state.focus.until) <= Date.now())
        this.updateFocus({ until: null, startedAt: null });
      this.scheduleRefresh();
    }, 30000);
    void this.bootstrap();
  }
  private invalidate(): void {
    this.configEpoch = -1;
    this.timerEpoch = -1;
    this.serverClock = null;
    this.returnedAt = null;
    this.returnedKind = null;
    this.recoveryNotices.clear();
    this.noticePending.clear();
    this.report.clear();
    this.reminders.reset();
    this.reminderId = null;
    this.absence.reset();
    this.timerRevision++;
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
    this.readThrough.clear();
    this.liveNotices.reset();
    this.state.albumCelebration = null;
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
      timer: null,
      bureau: null,
      timerControl: false,
      timerReady: false,
      timerError: null,
      timerObservedAt: undefined,
      navigateTimer: null,
      recentTimeTaskIds: [],
      error: null,
    };
    this.publish();
  }
  private signedOut(): void {
    this.configEpoch = -1;
    this.timerEpoch = -1;
    this.serverClock = null;
    this.returnedAt = null;
    this.returnedKind = null;
    this.returnedAt = null;
    this.recoveryNotices.clear();
    this.noticePending.clear();
    this.counts.clear();
    this.readThrough.clear();
    this.liveNotices.reset();
    this.state.albumCelebration = null;
    this.report.clear();
    this.reminders.reset();
    this.reminderId = null;
    this.absence.reset();
    this.timerRevision++;
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
      timer: null,
      bureau: null,
      timerControl: false,
      timerReady: false,
      timerError: null,
      timerObservedAt: undefined,
      navigateTimer: null,
      recentTimeTaskIds: [],
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
    if (!supportedServerVersion(health.data.version)) {
      this.state.connection = 'incompatible';
      this.state.error = `Нужен Schema Teams ${MINIMUM_SERVER_VERSION} или новее.`;
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
      this.absence.reset();
      this.reminders.reset();
      this.state.unread = 0;
      this.state.notifications = [];
      this.state.notificationUnread = 0;
      this.state.focus = { until: null, startedAt: null };
      this.state.navigateChat = null;
      this.timerRevision++;
      this.state.timer = null;
      this.state.timerReady = false;
      this.state.timerError = null;
      this.state.navigateTimer = null;
      this.activeChat = null;
      this.toasts.clear();
      this.paths.reset();
      this.files.reset();
      this.uploads.reset();
      this.counts.clear();
      this.readThrough.clear();
      this.liveNotices.reset();
      this.state.albumCelebration = null;
    }
    this.state.user = user.data;
    this.state.recentTimeTaskIds =
      this.o.settings.get().recentTimeTaskIds[String(user.data.id)] ?? [];
    this.state.epoch = this.api.epoch;
    this.state.error = null;
    if (user.data.mustChangePassword) {
      this.state.connection = 'passwordChange';
      this.publish();
      return;
    }
    this.login?.close();
    const config = await this.api.readDesktopConfig();
    if (this.destroyed || boot !== this.boot) return;
    this.configEpoch = config.ok ? this.api.epoch : -1;
    this.state.bureau = config.ok ? config.data.bureau : null;
    this.state.timerControl = config.ok && (config.data.capabilities.timerControl ?? 0) >= 2;
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
      if (this.configEpoch !== epoch) {
        const auth = await this.api.authenticate();
        if (
          this.destroyed ||
          epoch !== this.api.epoch ||
          !auth.ok ||
          auth.data.id !== this.state.user?.id
        )
          return;
        const config = await this.api.readDesktopConfig();
        if (this.destroyed || epoch !== this.api.epoch) return;
        this.configEpoch = config.ok ? epoch : -1;
        this.state.timerControl = config.ok && (config.data.capabilities.timerControl ?? 0) >= 2;
        this.state.bureau = config.ok ? config.data.bureau : null;
      }
      const [chats, notifications, focus] = await Promise.all([
        this.api.listChats(),
        this.api.notifications(),
        this.api.focus(),
        this.readTimer(),
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
      if (chats.ok && notifications.ok)
        this.liveNotices.prime(chats.data.items, notifications.data.items, true);
      if (focus.ok) this.updateFocus(focus.data);
      const bad = [chats, notifications, focus].find((r) => !r.ok);
      this.state.error = bad && !bad.ok ? bad.error : null;
      this.state.historyRevision = (this.state.historyRevision ?? 0) + 1;
      this.publish();
      if (focus.ok) this.checkReminder();
      await this.checkTimerPending();
      void this.flushAbsencePause();
    } finally {
      this.refreshing = false;
      if (this.again) {
        this.again = false;
        this.scheduleRefresh();
      }
    }
  }
  private observeServerTime(value: unknown): void {
    if (utcInstant(value))
      this.serverClock = { ms: Date.parse(value), observedAt: performance.now() };
  }
  private serverTime(): number {
    return this.serverClock
      ? this.serverClock.ms + Math.max(0, performance.now() - this.serverClock.observedAt)
      : NaN;
  }
  private pauseScope(): PauseScope | null {
    return this.api.owner && this.state.user?.id === this.api.owner
      ? { serverScopeHash: this.serverScopeHash, ownerId: this.api.owner }
      : null;
  }
  private acceptTimer(timer: WorkTimer | null): void {
    if (timer) this.observeServerTime(timer.serverNow);
    this.state.timer = timer;
    this.state.timerReady = true;
    this.state.timerError = null;
    this.state.timerObservedAt = Date.now();
    // Refresh also reads Focus. Wait for it before considering a popup.
    if (!this.refreshing) this.checkReminder();
  }
  private captureAbsence(kind: PauseEvent): PauseEnvelope | null {
    const timer = this.state.timer,
      scope = this.pauseScope();
    if (
      !scope ||
      !timer ||
      timer.state !== 'run' ||
      !timer.timerId ||
      !this.state.timerReady ||
      !this.state.timerControl ||
      !this.o.settings.get().timer.pauseOnLock
    )
      return null;
    // A run snapshot is the calibration source. Ongoing elapsed time uses only a monotonic clock.
    if (!this.serverClock) this.observeServerTime(timer.serverNow);
    const now = this.serverTime();
    if (!Number.isFinite(now)) {
      this.storageWarning = true;
      return null;
    }
    const command = this.pauseOutbox.capture(
      scope,
      timerExpected(timer),
      new Date(now).toISOString(),
      kind,
    );
    if (!command) this.storageWarning = true;
    else {
      this.returnedAt = null;
      this.returnedKind = null;
    }
    return command;
  }
  private pauseForAbsence(kind: 'lock' | 'suspend' = 'lock'): void {
    const command = this.captureAbsence(kind);
    if (command) {
      this.queryCandidate = undefined;
      void this.flushAbsencePause();
    }
    this.publish();
  }
  private captureShutdownQuery(): void {
    const command = this.captureAbsence('query-session-end');
    if (command?.status === 'candidate')
      this.queryCandidate = {
        scope: { serverScopeHash: command.serverScopeHash, ownerId: command.ownerId },
        key: command.key,
      };
    // Windows callback is synchronous persistence only: no network, no shutdown blocking.
  }
  private finalizeShutdownQuery(): void {
    const candidate = this.queryCandidate;
    if (candidate && !this.pauseOutbox.confirmSessionEnd(candidate.scope, candidate.key))
      this.storageWarning = true;
    this.queryCandidate = undefined;
  }
  private cancelShutdownQuery(): void {
    const candidate = this.queryCandidate;
    if (candidate && !this.pauseOutbox.cancelQuery(candidate.scope, candidate.key))
      this.storageWarning = true;
    this.queryCandidate = undefined;
  }
  private matchesCapturedPause(
    timer: WorkTimer | null | undefined,
    record: PauseEnvelope,
  ): timer is WorkTimer {
    const last = timer?.segments.at(-1);
    return Boolean(
      timer &&
      timer.timerId === record.expected.timerId &&
      timer.version === record.expected.revision + 1 &&
      timer.state === 'pause' &&
      timer.pauseReason === 'lock' &&
      last?.from === record.expected.currentSegmentFrom &&
      last?.to === record.at,
    );
  }
  private confirmCapturedPause(
    scope: PauseScope,
    record: PauseEnvelope,
    timer: WorkTimer,
  ): boolean {
    if (
      !this.pauseReturns.put({
        ...scope,
        key: record.key,
        expected: timerExpected(timer),
        at: record.at,
        returnedAt:
          this.returnedAt && Date.parse(this.returnedAt) >= Date.parse(record.at)
            ? this.returnedAt
            : null,
        returnKind:
          this.returnedAt && Date.parse(this.returnedAt) >= Date.parse(record.at)
            ? this.returnedKind
            : null,
        delivery: 'pending',
      })
    ) {
      this.storageWarning = true;
      return false;
    }
    const saved = ['pending', 'unknown'].includes(record.status)
      ? this.pauseOutbox.settle(scope, record.key, { kind: 'confirmed' })
      : this.pauseOutbox.dismissReviewed(scope, record.key);
    if (!saved) {
      this.storageWarning = true;
      return false;
    }
    this.absence.confirmed();
    return true;
  }
  private async flushAbsencePause(): Promise<void> {
    const scope = this.pauseScope(),
      epoch = this.api.epoch;
    if (
      !scope ||
      this.pauseFlight ||
      this.state.connection !== 'online' ||
      this.configEpoch !== epoch ||
      this.timerEpoch !== epoch ||
      !this.state.timerReady ||
      !this.state.timerControl ||
      !Number.isFinite(this.serverTime())
    )
      return;
    const records = this.pauseOutbox.list(scope);
    if (!this.o.settings.get().timer.pauseOnLock) {
      for (const record of records)
        if (['pending', 'unknown'].includes(record.status))
          this.pauseOutbox.settle(scope, record.key, { kind: 'review' });
      this.showPauseReturn();
      this.publish();
      return;
    }
    for (const record of records) {
      if (
        !['candidate', 'cancelled'].includes(record.status) &&
        record.reviewReason !== 'unconfirmed-query' &&
        this.matchesCapturedPause(this.state.timer, record)
      )
        this.confirmCapturedPause(scope, record, this.state.timer);
    }
    const commands = this.pauseOutbox.replay(scope, {
      authenticated: true,
      configFresh: true,
      casChecked: true,
      timerControl2: true,
    });
    for (const command of commands) {
      if (!matchesTimer(this.state.timer ?? null, command.expected)) {
        this.pauseOutbox.markStale(scope, command.key);
        continue;
      }
      const attempts = this.pauseAttempts.get(command.key);
      if (attempts && this.serverTime() < attempts.nextAt) continue;
      if (attempts && attempts.count >= 5) {
        this.pauseOutbox.settle(scope, command.key, { kind: 'review' });
        continue;
      }
      this.pauseFlight = true;
      const revision = this.timerRevision;
      try {
        const result = await this.api.timerPause(command.expected, command.at, command.key);
        if (this.destroyed) return;
        // Auth loss may advance the epoch before returning the verified HTTP rejection.
        // Persist its terminal outcome only against the original immutable scope/key.
        if (!result.ok && ['unauthenticated', 'password_change_required'].includes(result.code))
          this.pauseOutbox.settle(scope, command.key, {
            kind: 'http-failure',
            status: result.code === 'unauthenticated' ? 401 : 403,
          });
        if (epoch !== this.api.epoch || this.destroyed) return;
        if (result.ok) {
          if (result.data && this.matchesCapturedPause(result.data, command)) {
            const observed = this.state.timer;
            const sameResult = this.matchesCapturedPause(observed, command);
            if (
              (revision === this.timerRevision &&
                matchesTimer(observed ?? null, command.expected)) ||
              sameResult
            ) {
              if (!sameResult) {
                this.timerRevision++;
                this.acceptTimer(result.data);
              }
              this.confirmCapturedPause(scope, command, result.data);
            } else this.pauseOutbox.markStale(scope, command.key);
          } else this.pauseOutbox.settle(scope, command.key, { kind: 'review' });
        } else if (result.code === 'timer_busy') {
          this.pauseAttempts.set(command.key, {
            count: attempts?.count ?? 0,
            nextAt: this.serverTime() + 1000,
          });
        } else if (['network', 'timeout'].includes(result.code)) {
          const count = (attempts?.count ?? 0) + 1;
          this.pauseOutbox.settle(scope, command.key, { kind: 'unknown' });
          this.pauseAttempts.set(command.key, {
            count,
            nextAt: this.serverTime() + Math.min(300000, 30000 * 2 ** (count - 1)),
          });
        } else if (result.code === 'server_error')
          this.pauseOutbox.settle(scope, command.key, { kind: 'http-failure', status: 500 });
        else if (
          [
            'validation',
            'forbidden',
            'csrf',
            'stale_timer',
            'stale_timer_segment',
            'precondition_required',
            'invalid_event_time',
            'idempotency_conflict',
          ].includes(result.code)
        )
          this.pauseOutbox.settle(scope, command.key, { kind: 'http-failure', status: 400 });
        else this.pauseOutbox.settle(scope, command.key, { kind: 'review' });
      } finally {
        this.pauseFlight = false;
      }
      this.publish();
      this.scheduleRefresh();
      break;
    }
    this.showPauseReturn();
  }
  private showPauseReturn(): void {
    const scope = this.pauseScope();
    if (
      !scope ||
      this.locked ||
      this.suspended ||
      !this.o.settings.get().timer.askOnUnlock ||
      !this.pauseReturns.healthy ||
      this.pauseOutbox.health.blocked
    )
      return;
    let record = this.pauseReturns
      .list(scope)
      .find((r) => r.delivery === 'pending' && matchesTimer(this.state.timer ?? null, r.expected));
    if (!record || this.recoveryNotices.has(record.key)) return;
    if (record.returnedAt === null) {
      const returned = this.returnedAt ?? new Date(this.serverTime()).toISOString();
      if (
        !this.pauseReturns.returned(
          scope,
          record.key,
          returned,
          this.returnedAt ? (this.returnedKind ?? 'connection') : 'connection',
        )
      ) {
        this.storageWarning = true;
        this.publish();
        return;
      }
      record = this.pauseReturns.list(scope).find((item) => item.key === record?.key);
      if (!record) return;
    }
    const notice: Notice = {
      epoch: this.api.epoch,
      owner: scope.ownerId,
      chatId: null,
      mention: false,
      ordinary: true,
      recovery: record,
    };
    if (!this.current(notice)) return;
    const spec: ToastSpec = {
      id: 'pause-return:' + record.key,
      key: record.key,
      groupId: 'pause-return',
      title: 'Таймер на паузе',
      body:
        this.o.settings.get().notifications.preview && this.state.timer
          ? `${record.returnKind === 'unlock' ? 'Не учтено: ' : 'Пауза с '}${new Date(record.at).toLocaleString('ru-RU', { timeZone: this.state.bureau?.timeZone ?? 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${record.returnKind === 'unlock' ? ' — ' : record.returnKind === 'wake' ? '. Система возобновила работу ' : '. Снова подключились '}${new Date(record.returnedAt ?? record.at).toLocaleString('ru-RU', { timeZone: this.state.bureau?.timeZone ?? 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.\n${[this.state.timer.task.mark, this.state.timer.task.title].filter(Boolean).join(' · ').slice(0, 100)} · ${timerClock(elapsedAt(this.state.timer, this.state.timerObservedAt ?? Date.now()))}`
          : 'Пауза подтверждена сервером. Продолжите таймер или проверьте трудозатраты.',
      hasReply: false,
      buttons: ['Продолжить', 'Закончить и проверить'],
      delayMs: 0,
    };
    this.recoveryNotices.add(record.key);
    this.notices.set(spec, notice);
    if (this.toasts.show(spec) === false) this.recoveryNotices.delete(record.key);
  }
  private recordReturnTime(kind: 'unlock' | 'wake'): void {
    if (!Number.isFinite(this.serverTime())) return;
    if (kind === 'unlock') {
      this.returnedAt = new Date(this.serverTime()).toISOString();
      this.returnedKind = 'unlock';
    }
    if (this.locked || this.suspended) return;
    if (this.returnedKind !== 'unlock') {
      this.returnedAt = new Date(this.serverTime()).toISOString();
      this.returnedKind = kind;
    }
    const scope = this.pauseScope();
    if (!scope || !this.returnedAt || !this.returnedKind) return;
    for (const record of this.pauseReturns.list(scope))
      if (!this.pauseReturns.returned(scope, record.key, this.returnedAt, this.returnedKind))
        this.storageWarning = true;
  }
  private async resumePauseReturn(notice: Notice): Promise<void> {
    const record = notice.recovery;
    if (!record || !this.current(notice)) return;
    const epoch = this.api.epoch,
      revision = ++this.timerRevision;
    const result = await this.api.timerResume(record.expected);
    if (epoch !== this.api.epoch || this.destroyed) return;
    if (result.ok) {
      if (revision === this.timerRevision) this.acceptTimer(result.data);
      const scope = this.pauseScope();
      if (scope && !this.pauseReturns.dismiss(scope, record.key)) this.storageWarning = true;
    } else this.state.timerError = result.error;
    this.publish();
    this.scheduleRefresh();
  }
  private absenceRecordId(key: string): number {
    return Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, 12), 16) + 1;
  }
  private durableAbsenceWarning(): ClientSnapshot['timerAbsence'] {
    const scope = this.pauseScope();
    if (!scope) return null;
    const now = Number.isFinite(this.serverTime()) ? this.serverTime() : Date.now();
    if (this.storageWarning || this.pauseOutbox.health.blocked || !this.pauseReturns.healthy)
      return {
        id: this.absenceRecordId('storage'),
        from: now,
        to: now,
        durable: true,
        message:
          'Не удалось надёжно сохранить команду паузы или подтверждение её показа. Автопауза не считается завершённой. Проверьте время вручную; запись очереди не сбрасывается.',
      };
    const record = this.pauseOutbox.list(scope)[0];
    if (record)
      return {
        id: this.absenceRecordId(record.key),
        from: Date.parse(record.at),
        to: now,
        durable: true,
        message:
          record.status === 'candidate' ||
          record.reviewReason === 'unconfirmed-query' ||
          record.status === 'cancelled'
            ? 'Завершение Windows не подтверждено. По этому запросу пауза автоматически не отправляется; проверьте время вручную.'
            : record.status === 'pending' || record.status === 'unknown'
              ? 'Подтверждение паузы пока не получено. Сохраняется исходная команда; после восстановления связи возможен повтор. Если время проверено вручную, отмените дальнейший повтор ниже.'
              : 'Пауза не подтверждена или исходный таймер изменился. Автоматический повтор остановлен. Проверьте интервалы вручную.',
      };
    const returned = this.pauseReturns.list(scope)[0];
    return returned
      ? {
          id: this.absenceRecordId(returned.key),
          from: Date.parse(returned.at),
          to: now,
          durable: true,
          message: matchesTimer(this.state.timer ?? null, returned.expected)
            ? 'Пауза после отсутствия подтверждена сервером. Продолжение выполняется только по вашей команде.'
            : 'Таймер после отсутствия уже изменился. Проверьте сохранённый период перед подтверждением.',
        }
      : null;
  }
  private acknowledgeAbsence(id: number): void {
    const scope = this.pauseScope();
    if (!scope) return;
    for (const record of this.pauseOutbox.list(scope))
      if (this.absenceRecordId(record.key) === id) {
        if (['pending', 'unknown'].includes(record.status))
          this.pauseOutbox.settle(scope, record.key, { kind: 'review' });
        if (record.status === 'candidate') this.pauseOutbox.cancelQuery(scope, record.key);
        if (!this.pauseOutbox.dismissReviewed(scope, record.key)) this.storageWarning = true;
      }
    for (const record of this.pauseReturns.list(scope))
      if (this.absenceRecordId(record.key) === id && !this.pauseReturns.dismiss(scope, record.key))
        this.storageWarning = true;
    if (!this.pauseOutbox.health.blocked && this.pauseReturns.healthy) this.storageWarning = false;
  }
  private async checkTimerPending(): Promise<void> {
    if (!this.state.timerControl || this.state.connection !== 'online') return;
    let deviceId = this.o.settings.get().deviceId;
    if (!deviceId) {
      deviceId = randomUUID();
      try {
        this.o.settings.update({ deviceId });
      } catch {
        return;
      }
    }
    const epoch = this.api.epoch;
    const result = await this.api.timerPending(deviceId);
    if (
      epoch !== this.api.epoch ||
      !result.ok ||
      !result.data ||
      this.noticePending.has(result.data.id)
    )
      return;
    this.noticePending.add(result.data.id);
    this.bellNotice(result.data, deviceId);
  }
  private checkReminder(): void {
    if (this.destroyed) return;
    const settings = this.o.settings.get(),
      ticket = this.reminders.due(this.state, settings.timer.reminderTime);
    if (!ticket || !this.state.timer) return;
    const timer = this.state.timer;
    const taskLabel = [timer.task.mark, timer.task.title].filter(Boolean).join(' · ');
    const notice: Notice = {
      epoch: this.api.epoch,
      owner: ticket.owner,
      chatId: null,
      mention: false,
      ordinary: true,
      reminder: ticket,
    };
    if (!this.current(notice)) return;
    const start = new Date(timer.startedAt).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const spec: ToastSpec = {
      id: ticket.id,
      key: ticket.id,
      groupId: ticket.id,
      title: 'Таймер ещё идёт',
      body: settings.notifications.preview
        ? `${taskLabel}\n${timerClock(elapsedAt(timer, this.state.timerObservedAt ?? Date.now()))} с ${start}`
        : 'Таймер ещё идёт. Проверьте трудозатраты.',
      hasReply: false,
      buttons: ['■ Закончить работу', 'Ещё работаю'],
      delayMs: 0,
    };
    this.reminderId = spec.id;
    this.notices.set(spec, notice);
    this.toasts.show(spec);
  }
  private async readTimer(): Promise<ApiResult<WorkTimer | null>> {
    const epoch = this.api.epoch,
      revision = ++this.timerRevision;
    const result = await this.api.timer();
    if (epoch !== this.api.epoch) return failure('stale_session');
    if (revision === this.timerRevision) {
      if (result.ok) {
        this.timerEpoch = epoch;
        this.observeServerTime(this.api.timerServerNow ?? result.data?.serverNow);
        this.acceptTimer(result.data);
      } else {
        this.state.timerReady = false;
        this.state.timerError = result.error;
      }
      this.publish();
    }
    return result;
  }
  private event(name: RealtimeEvent, data: unknown): void {
    this.o.log.info('событие клиента', { event: name });
    if (name === 'time:timer') {
      this.timerRevision++;
      try {
        this.acceptTimer(this.state.timerControl ? controlledTimer(data) : workTimer(data));
        if (this.state.timerControl) this.observeServerTime(parse.object(data).serverNow);
      } catch {
        this.state.timerReady = false;
        this.state.timerError = 'Не удалось прочитать состояние таймера.';
      }
      this.publish();
      return;
    }
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
    if (name === 'chat:read') {
      try {
        const read = parse.object(data);
        if (
          read.userId === this.api.owner &&
          typeof read.chatId === 'number' &&
          Number.isSafeInteger(read.chatId) &&
          read.chatId > 0 &&
          typeof read.upTo === 'number' &&
          Number.isSafeInteger(read.upTo) &&
          read.upTo > 0
        )
          this.acceptRead(read.chatId, read.upTo);
      } catch {
        /* malformed read receipts cannot clear counters */
      }
    }
    if (name === 'session') {
      this.invalidate();
      void this.bootstrap();
      return;
    }
    if (name === 'chat:message') {
      try {
        const message = parse.messageEvent(data);
        const fresh = this.liveNotices.message(message.chatId, message.id);
        const quietSupported = (this.api.desktopConfiguration?.capabilities.chatQuiet ?? 0) >= 1;
        if (fresh && message.quiet !== true && (!quietSupported || message.quiet === false))
          this.messageNotice(message);
      } catch {
        this.o.log.warn('неподдержанное событие чата');
      }
    }
    if (name === 'notification') {
      try {
        const raw = parse.object(data);
        const modern = raw.kind !== undefined || raw.notificationId !== undefined;
        const push = modern ? parse.notificationPush(raw) : null;
        const item = push?.item ?? parse.notification(raw.item);
        if (this.liveNotices.notification(item.id) && raw.quiet === false) {
          if (push?.kind === 'album_issued') {
            this.state.albumCelebration = { notificationId: push.notificationId, at: Date.now() };
          }
          this.bellNotice(item);
        }
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
    if (message.id <= (this.readThrough.get(message.chatId) ?? 0)) return;
    const previous = this.counts.get(message.chatId);
    const messages =
      previous && Date.now() - previous.at < 60000 ? previous.messages : new Set<number>();
    if (messages.has(message.id)) return;
    messages.add(message.id);
    const count = messages.size;
    const last =
      previous && messages.has(previous.last.id) && previous.last.id > message.id
        ? previous.last
        : message;
    this.counts.set(message.chatId, { at: Date.now(), messages, last });
    this.displayMessageNotice(last, count);
  }
  private displayMessageNotice(message: ChatMessage, count: number): void {
    const owner = this.api.owner;
    if (!owner) return;
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
  private async readChat(chatId: number, upTo: number): Promise<ApiResult<null>> {
    const epoch = this.api.epoch;
    const result = await this.api.read(chatId, upTo);
    if (epoch !== this.api.epoch) return failure('stale_session');
    if (result.ok) {
      this.acceptRead(chatId, upTo);
      this.scheduleRefresh();
    }
    return result;
  }
  private acceptRead(chatId: number, upTo: number): void {
    this.readThrough.set(chatId, Math.max(upTo, this.readThrough.get(chatId) ?? 0));
    const current = this.counts.get(chatId);
    if (!current) return;
    for (const id of current.messages) if (id <= upTo) current.messages.delete(id);
    if (!current.messages.size) {
      this.counts.delete(chatId);
      this.toasts.dismiss(`chat:${chatId}`);
    } else {
      this.toasts.dismiss(`chat:${chatId}`);
      this.displayMessageNotice(current.last, current.messages.size);
    }
  }
  private bellNotice(item: NotificationItem, pendingDeviceId?: string): void {
    const owner = this.api.owner;
    if (!owner) return;
    const chat = item.link && /^\/chat\/(\d+)(?:\?m=(\d+))?$/.exec(item.link);
    this.showNotice(
      `notification:${item.id}`,
      item.event === 'timer_stopped'
        ? 'Вчерашний таймер остановлен в полночь'
        : item.event === 'album_issued'
          ? 'Альбом выдан'
          : item.event === 'remarks_closed'
            ? 'Все замечания закрыты'
            : (item.subject ?? item.task?.title ?? 'Schema Teams'),
      item.reason ??
        item.changes.map((c) => `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`).join('\n'),
      {
        epoch: this.api.epoch,
        owner,
        chatId: chat ? Number(chat[1]) : null,
        ...(chat?.[2] && { messageId: Number(chat[2]) }),
        notificationId: item.id,
        ...(pendingDeviceId && { pendingDeviceId }),
        link: item.link,
        ...(item.event === 'timer_stopped' && { timerStopped: true }),
        mention: item.event === 'chat_mention',
        ordinary: item.event === 'timer_stopped',
      },
    );
  }
  private showNotice(id: string, title: string, body: string, notice: Notice): void {
    const spec: ToastSpec = {
      id,
      key: id,
      groupId: notice.chatId ? `chat:${notice.chatId}` : id,
      title,
      body: this.o.settings.get().notifications.preview
        ? body
        : notice.timerStopped
          ? 'Запись трудозатрат требует проверки.'
          : 'Новое сообщение',
      hasReply: notice.chatId !== null,
      buttons: notice.timerStopped
        ? ['Проверить запись', 'Прочитано']
        : notice.chatId || notice.notificationId
          ? ['Открыть', 'Прочитано']
          : ['Открыть'],
      delayMs: 0,
    };
    this.notices.set(spec, notice);
    if (this.current(notice)) {
      if (this.toasts.show(spec) === false && notice.pendingDeviceId && notice.notificationId)
        this.noticePending.delete(notice.notificationId);
    } else if (notice.pendingDeviceId && notice.notificationId)
      this.noticePending.delete(notice.notificationId);
  }
  private owned(n: Notice): boolean {
    return n.owner === this.api.owner && n.epoch === this.api.epoch;
  }
  private currentRecovery(record: PauseReturn): boolean {
    if (
      !this.o.settings.get().timer.askOnUnlock ||
      !this.pauseReturns.healthy ||
      this.pauseOutbox.health.blocked ||
      this.state.timerReady !== true ||
      this.state.timerControl !== true ||
      this.timerEpoch !== this.api.epoch ||
      this.configEpoch !== this.api.epoch
    )
      return false;
    const scope = this.pauseScope();
    if (
      !scope ||
      record.serverScopeHash !== scope.serverScopeHash ||
      record.ownerId !== scope.ownerId
    )
      return false;
    const stored = this.pauseReturns.list(scope).find((item) => item.key === record.key);
    return Boolean(
      stored &&
      stored.at === record.at &&
      stored.returnedAt === record.returnedAt &&
      stored.returnKind === record.returnKind &&
      stored.expected.timerId === record.expected.timerId &&
      stored.expected.revision === record.expected.revision &&
      stored.expected.currentSegmentFrom === record.expected.currentSegmentFrom &&
      matchesTimer(this.state.timer ?? null, stored.expected),
    );
    // Delivery is deliberately not compared: onShow changes pending -> shown before legitimate actions.
  }
  private current(n: Notice): boolean {
    return (
      this.owned(n) &&
      (!n.recovery || this.currentRecovery(n.recovery)) &&
      !(
        n.chatId &&
        n.messageId &&
        !n.notificationId &&
        n.messageId <= (this.readThrough.get(n.chatId) ?? 0)
      ) &&
      (!n.reminder ||
        this.reminders.valid(n.reminder, this.state, this.o.settings.get().timer.reminderTime)) &&
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
    if (n.ordinary || n.mention) {
      const epoch = this.api.epoch;
      if (!this.preferencesFlight || this.preferencesEpoch !== epoch) {
        this.preferencesEpoch = epoch;
        const flight = this.api
          .notificationSettings()
          .then(
            (r) =>
              epoch === this.api.epoch &&
              r.ok &&
              notificationAllowed(r.data, Date.now(), this.state.bureau?.timeZone ?? null),
          )
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
    if (n.reminder) this.openTimer('finish');
    else if (n.chatId) this.showChat(n.chatId, n.messageId);
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
  private openTimer(
    mode: 'pick' | 'finish',
    taskId?: number,
    prepareExpected?: import('../shared/time').TimerExpected,
  ): void {
    this.state.navigateTimer = {
      mode,
      ...(prepareExpected && { prepareExpected }),
      ...(taskId && { taskId }),
      nonce: (this.state.navigateTimer?.nonce ?? 0) + 1,
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
    if (this.destroyed) return failure('stale_session');
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
      case 'report.open':
        this.state.navigateReport = (this.state.navigateReport ?? 0) + 1;
        this.o.main.show();
        this.trayWindow?.hide();
        this.publish();
        return ok(null);
      case 'report.clear':
        this.report.clear();
        return ok(null);
      case 'report.edit':
        this.report.edit();
        return ok(null);
      case 'report.screens':
        return ok(this.report.screens());
      case 'report.capture':
      case 'report.prepare':
      case 'report.export':
      case 'report.reveal':
        try {
          if (r.kind === 'report.capture') return ok(await this.report.capture(r.target));
          if (r.kind === 'report.prepare') return ok(await this.report.prepare(r.options));
          if (r.kind === 'report.export') return ok(await this.report.export(r.id));
          return this.report.reveal(r.id) ? ok(null) : failure('validation');
        } catch {
          return {
            ok: false,
            code: 'report_error',
            error:
              r.kind === 'report.capture'
                ? 'Не удалось сделать снимок. Выберите источник и повторите.'
                : r.kind === 'report.export'
                  ? 'Не удалось сохранить архив. Проверьте папку и подготовьте файлы заново.'
                  : 'Не удалось подготовить диагностику. Проверьте выбранные файлы и повторите.',
            retryable: true,
          };
        }
      case 'setup.open':
        this.state.navigateSetup = (this.state.navigateSetup ?? 0) + 1;
        this.o.main.show();
        this.trayWindow?.hide();
        this.publish();
        return ok(null);
      case 'setup.inventory':
        try {
          return ok(await this.inventory.inspect(r.refresh));
        } catch {
          return {
            ok: false,
            code: 'inventory_error',
            error: 'Не удалось проверить стандартные папки Revit. Повторите позже.',
            retryable: true,
          };
        }
      case 'server.read':
        return ok(this.configuration.read());
      case 'server.check':
        return this.configuration.check(r.url);
      case 'server.apply':
        if (this.loggingOut) return failure('busy');
        return this.configuration.apply(r.url, r.token);
      case 'updates.check':
        return ok(await this.updates.check());
      case 'updates.later':
        return this.updates.later(r.version) ? ok(null) : failure('validation');
      case 'settings.read':
        return ok(this.preferences());
      case 'settings.patch':
        return this.savePreferences(r.patch);
      case 'settings.open':
        this.state.navigateSettings = {
          tab: r.tab,
          nonce: (this.state.navigateSettings?.nonce ?? 0) + 1,
        };
        this.o.main.show();
        this.trayWindow?.hide();
        this.publish();
        return ok(null);
      case 'logs.open':
        try {
          if (!(await this.o.openLogs())) return ok(null);
        } catch {
          /* Never expose a filesystem path or OS error. */
        }
        return {
          ok: false,
          code: 'logs_error',
          error: 'Не удалось открыть папку журналов.',
          retryable: false,
        };
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
      case 'theme': {
        const result = this.savePreferences({ theme: r.mode });
        return result.ok ? ok(null) : result;
      }
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
    if (
      [
        'timer.start',
        'timer.pause',
        'timer.resume',
        'timer.extend',
        'timer.reset',
        'timer.proposal',
        'timer.validateRows',
        'timer.finish',
      ].includes(r.kind) &&
      (!this.state.timerControl || !this.state.timerReady)
    )
      return failure('precondition_required');
    switch (r.kind) {
      case 'setup.finish': {
        if (this.state.connection !== 'online') return failure('network');
        const health = await this.api.health();
        if (this.destroyed || r.epoch !== this.api.epoch) return failure('stale_session');
        if (
          !health.ok ||
          health.data.status !== 'ok' ||
          health.data.db !== 'ok' ||
          !supportedServerVersion(health.data.version)
        )
          return failure('network');
        const result = this.savePreferences({ autostart: r.autostart }, true);
        return result.ok ? ok(null) : result;
      }
      case 'timer.open':
        this.openTimer(r.mode, r.taskId);
        return ok(null);
      case 'timer.preferences':
        if (!isReminderTime(r.reminderTime)) return failure('validation');
        try {
          this.o.settings.update({
            timer: {
              ...this.o.settings.get().timer,
              reminderTime: r.reminderTime,
              ...(r.pauseOnLock !== undefined && { pauseOnLock: r.pauseOnLock }),
              ...(r.askOnUnlock !== undefined && { askOnUnlock: r.askOnUnlock }),
            },
          });
        } catch {
          return {
            ok: false,
            code: 'settings_error',
            error: 'Не удалось сохранить настройку. Повторите действие.',
            retryable: false,
          };
        }
        if (this.reminderId) this.toasts.dismiss(this.reminderId);
        this.reminders.reset();
        this.publish();
        this.checkReminder();
        return ok(null);
      case 'timer.absenceDismiss':
        this.acknowledgeAbsence(r.id);
        if (this.absence.warning?.id === r.id) this.absence.dismiss();
        this.publish();
        return ok(null);
      case 'timer.read':
        return this.readTimer();
      case 'timer.options':
        return this.api.timeOptions(r.q);
      case 'timer.proposal':
        return this.api.timerProposal(r.expected);
      case 'timer.start':
      case 'timer.pause':
      case 'timer.resume':
      case 'timer.extend':
      case 'timer.reset':
      case 'timer.finish': {
        const epoch = this.api.epoch,
          revision = ++this.timerRevision;
        const result =
          r.kind === 'timer.start'
            ? await this.api.timerStart(r.taskId, r.expected)
            : r.kind === 'timer.pause'
              ? await this.api.timerPause(r.expected)
              : r.kind === 'timer.resume'
                ? await this.api.timerResume(r.expected)
                : r.kind === 'timer.extend'
                  ? await this.api.timerExtend(r.expected)
                  : r.kind === 'timer.reset'
                    ? await this.api.timerReset(r.expected)
                    : await this.api.timerFinish(r.expected, r.rows, r.note, r.preparedRequestId);
        if (epoch !== this.api.epoch) return failure('stale_session');
        if (result.ok && r.kind === 'timer.start' && result.data) {
          const ids = [
            result.data.task.id,
            ...(this.state.recentTimeTaskIds ?? []).filter((id) => id !== result.data?.task.id),
          ].slice(0, 3);
          this.state.recentTimeTaskIds = ids;
          this.o.settings.update({
            recentTimeTaskIds: {
              ...this.o.settings.get().recentTimeTaskIds,
              [String(this.api.owner)]: ids,
            },
          });
        }
        if (revision === this.timerRevision) {
          if (result.ok) this.acceptTimer(result.data);
          else if (result.code !== 'timer_busy') {
            this.state.timerReady = false;
            this.state.timerError = result.error;
          }
          this.publish();
        }
        this.scheduleRefresh();
        return result;
      }
      case 'timer.validateRows':
        return this.api.timerValidateRows(r.preparedRequestId, r.rows);
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
      case 'chat.objectInfo':
        return this.api.objectInfo(r.chatId);
      case 'chat.markRead': {
        if (!this.o.main.win.isVisible() || !this.o.main.win.isFocused())
          return failure('validation');
        const last = this.state.chats.find((c) => c.id === r.chatId)?.last?.id;
        if (!last) return failure('not_found');
        const result = await this.readChat(r.chatId, last);
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
      case 'chat.top': {
        if (typeof this.state.chats.find((chat) => chat.id === r.chatId)?.top !== 'boolean')
          return failure('unsupported');
        const result = await this.api.top(r.chatId, r.top);
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
        const result = await this.readChat(r.chatId, r.upTo);
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
    this.state.setupRequired = !this.o.settings.get().onboardingComplete;
    this.state.preferences = this.preferences();
    this.state.timerReminderTime = this.o.settings.get().timer.reminderTime;
    this.state.timerAskOnUnlock = this.o.settings.get().timer.askOnUnlock;
    this.state.timerPauseOnLock = this.o.settings.get().timer.pauseOnLock;
    this.absence.observe(this.state);
    const warning = this.absence.warning;
    this.state.timerAbsence =
      this.durableAbsenceWarning() ??
      (warning ? { id: warning.id, from: warning.from, to: warning.to } : null);
    if (this.destroyed) return;
    if (this.loggedConnection !== this.state.connection) {
      this.loggedConnection = this.state.connection;
      this.o.log.info('состояние соединения', { state: this.state.connection });
    }
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
              timer: this.state.timerReady && this.state.timer ? this.state.timer.state : 'idle',
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
  private preferences(): LocalPreferences {
    const value = this.o.settings.get();
    return {
      autostart: value.autostart,
      autostartAvailable: this.o.autostartAvailable,
      theme: value.theme,
      notifications: { ...value.notifications },
    };
  }
  private savePreferences(
    patch: PreferencesPatch,
    completeSetup = false,
  ): ApiResult<LocalPreferences> {
    if (!preferencesPatchValid(patch)) return failure('validation');
    const before = this.o.settings.get(),
      autoChanged = patch.autostart !== undefined && patch.autostart !== before.autostart,
      applyAuto = autoChanged || completeSetup;
    try {
      if (applyAuto) this.o.applyAutostart(Boolean(patch.autostart));
      this.o.settings.update({
        ...(completeSetup && { onboardingComplete: true }),
        ...(patch.autostart !== undefined && { autostart: patch.autostart }),
        ...(patch.theme !== undefined && { theme: patch.theme }),
        ...(patch.notifications && {
          notifications: { ...before.notifications, ...patch.notifications },
        }),
      });
    } catch {
      if (applyAuto)
        try {
          this.o.applyAutostart(
            completeSetup && !before.onboardingComplete ? false : before.autostart,
          );
        } catch {
          this.o.log.warn('не удалось восстановить настройку автозапуска');
        }
      return {
        ok: false,
        code: 'settings_error',
        error: applyAuto
          ? 'Не удалось применить автозапуск или сохранить настройку. Проверьте автозапуск Windows.'
          : 'Не удалось сохранить настройки. Повторите действие.',
        retryable: false,
      };
    }
    if (patch.notifications) this.toasts.clear();
    this.publish();
    return ok(this.preferences());
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
    this.report.clear();
    this.configuration.destroy();
    this.updates.destroy();
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
    this.o.main.win.removeListener('query-session-end', this.sessionQuery);
    this.o.main.win.removeListener('session-end', this.sessionEnded);
    this.o.main.win.removeListener('focus', this.mainActive);
  }
  prepareServerSwitch(): void {
    this.loggingOut = true;
    this.login?.close();
    this.invalidate();
  }
}
