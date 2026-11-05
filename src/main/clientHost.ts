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
import { PauseReturns, type PauseReturn, type PauseReturnKind } from './timer/pauseReturns';
import { ScreenSaverObserver } from './desktop/screenSaverObserver';
import {
  ScreenSaverPoller,
  WindowsScreenSaverReader,
  type ScreenSaverSample,
} from './desktop/screenSaverState';
import type {
  ApiResult,
  ChatMessage,
  NotificationItem,
  NotificationSettings,
  FocusState,
} from '../shared/client';
import type { ClientSnapshot, DesktopRequest } from '../shared/desktop';
import { requestValid } from '../shared/requests';
import { TeamsApi, failure } from './api/client';
import * as parse from './api/parse';
import { workTimer, controlledTimer } from './api/time';
import type { WorkTimer } from '../shared/time';
import { TimerAbsence } from './timer/absence';
import { TimerReminders, isReminderTime, type ReminderTicket } from './timer/reminders';
import { elapsedAt, timerClock, matchesTimer, timerExpected, utcInstant } from '../shared/time';
import { quietDecision } from './api/notificationPrefs';
import { trayTooltip } from './desktop/trayTooltip';
import { LiveNoticeGate } from './notifications/liveGate';
import { RealtimeClient, type RealtimeEvent } from './realtime/connection';
import { CLIENT_FILE, CLIENT_URL, PARTITION, guardLocal, type MainWindow } from './mainWindow';
import { applyWindowTheme, windowBackground } from './windowTheme';
import { LoginWindow } from './loginWindow';
import { CustomToasts } from './notifications/toasts';
import type { ToastSpec } from './notifications/types';
import { WindowsNotificationPolicy } from './desktop/notificationState';
import { PathService } from './paths/service';
import { confirmForeignHost } from './paths/dialog';
import { uncHostTrusted } from './paths/validate';
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
import { createProductionDesktopUpdateController } from './desktop/updateFactory';
import { desktopShutdown } from './desktop/updateShutdown';
import {
  APPROVED_DESKTOP_PUBLISHER_DER_SHA256,
  desktopPublisherConfigured,
} from './desktop/updateTrust';
import { ServerConfigurationService } from './desktop/serverConfiguration';
import { supportedServerVersion, MINIMUM_SERVER_VERSION } from '../shared/serverConfiguration';
import type { Health } from '../shared/client';
import type { RevitInventory } from '../shared/setup';
import { RevitInventoryService } from './desktop/revitInventory';
import { ReportService, type ReportBackend } from './diagnostics/service';
import { SupportLedger, supportStorage } from './diagnostics/ledger';
import { SupportSender, type SupportContext } from './diagnostics/sender';
import { PluginCatalogService } from './plugins/catalog';
import {
  PluginUpdater,
  type PluginUpdateNotice,
  type PluginUpdaterContext,
} from './plugins/updater';
import { PluginInstaller } from './plugins/installer';
import { S } from './strings';
import { createProductionInstaller, pluginInstallationAvailable } from './plugins/production';
import { readRevitProcesses } from './plugins/safety';
import {
  MorningNotices,
  bureauMorning,
  type MorningContext,
  type MorningTicket,
} from './notifications/morning';

interface Options {
  supportPersistence?: SupportLedger;
  pausePersistence?: { outbox: PauseOutbox; returns: PauseReturns };
  main: MainWindow;
  server: URL | null;
  /** Серверы бюро для путей из сборки (UNC_HOSTS); хост сервера Teams добавляется сам. */
  uncHosts?: readonly string[];
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
  pluginUpdate?: PluginUpdateNotice;
  morning?: MorningTicket;
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
  /** Сервер уже применил тихие часы (`quiet` в событии): приложение их не дублирует (ТЗ 5.2 п.3). */
  serverQuiet?: boolean;
}
/** Что перечитать после события сокета: всё, только список чатов или только колокольчик. */
type RefreshScope = 'all' | 'chats' | 'notifications';
const mergeScope = (a: RefreshScope | null, b: RefreshScope): RefreshScope =>
  a === null || a === b ? b : 'all';
/** Пачка «N новых сообщений» одного чата живёт минуту (ТЗ 5.3). */
const COUNT_WINDOW = 60000;
export const PAUSE_RECOVERED_MESSAGE = S.pauseRecovered;
/** Через сколько считать запрос завершения Windows отменённым, если процесс жив. */
export const SHUTDOWN_QUERY_MS = 60_000;
/**
 * Нарастающая задержка повтора паузы: сеть и 5xx — 30 с, 1 мин, 2 мин …, timer_busy —
 * 1 с, 2 с, 4 с …; не реже раза в 5 минут. Повторы идут с тем же ключом идемпотентности,
 * пока не истечёт срок его хранения сервером (24 ч, PAUSE_REPLAY_WINDOW_MS).
 */
export const pauseRetryDelay = (count: number, base = 30_000): number =>
  Math.min(300_000, base * 2 ** Math.max(0, Math.min(count, 20) - 1));
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
  private readonly pluginCatalog = new PluginCatalogService({
    context: () =>
      !this.destroyed &&
      this.api?.owner &&
      this.state.connection === 'online' &&
      this.state.user?.id === this.api.owner &&
      this.configEpoch === this.api.epoch &&
      (this.api.desktopConfiguration?.capabilities.plugins ?? 0) >= 1
        ? `${this.serverScopeHash}:${this.api.owner}:${this.api.epoch}`
        : null,
    read: () => this.api.plugins(),
    changed: () => {
      if (!this.destroyed) {
        this.publish();
        if (this.pluginCatalog.state.status === 'ready') void this.pluginUpdates?.refresh();
      }
    },
    now: () => performance.now(),
  });
  /** Диск плагинов; заменяется только в тестах. */
  private pluginInstaller: PluginInstaller = createProductionInstaller();
  private readonly pluginUpdates = new PluginUpdater({
    context: () => this.pluginContext(),
    catalog: () =>
      this.pluginCatalog.state.status === 'ready' ? this.pluginCatalog.state.catalog : null,
    years: async () => {
      const inventory = await this.inventory.inspect(true);
      return inventory.years.filter((y) => y.executable === 'found').map((y) => y.year);
    },
    installer: () => this.pluginInstaller,
    download: async (build, root, signal) => {
      const result = await this.api.downloadPlugin(build, root, signal);
      if (!result.ok) throw Error(result.code);
      return result.data;
    },
    processes: readRevitProcesses,
    mayRun: () => !this.destroyed && !desktopShutdown.locked,
    audit: (event) => this.o.log.info('плагины', { ...event }),
    changed: () => {
      if (!this.destroyed) {
        this.publish();
        queueMicrotask(() => this.showPluginNotices());
      }
    },
  });
  private readonly pluginNoticeWindows = new Map<string, PluginUpdateNotice>();
  private trayWindow?: BrowserWindow;
  private readonly peers = new Map<number, string>();
  private readonly pending = new Map<number, number>();
  private activeChat: number | null = null;
  private boot = 0;
  private bootFlight?: Promise<void>;
  private bootEpoch = -1;
  private socketOnline = false;
  private probing?: Promise<void>;
  private onlineFallback?: NodeJS.Timeout;
  private refreshScope: RefreshScope | null = null;
  private againScope: RefreshScope | null = null;
  private quietCache?: { epoch: number; settings: NotificationSettings };
  private trayKey?: string;
  private trayTip?: string;
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
  private updateDocument = randomUUID();
  private updateStamp = randomUUID();
  private updateFingerprint?: string;
  private trayDrafts?: { contextId: string; revision: number; dirtyCount: number; busy: boolean };
  private readonly desktopUpdates = createProductionDesktopUpdateController({
    context: () => this.updateContext(),
    readLatest: async () => {
      const result = await this.api.latestRelease();
      if (!result.ok) throw Error(result.code);
      return result.data;
    },
    acquireQuiescence: () => {
      const stamp = this.updateContext().stamp,
        mutation = this.api.mutationState;
      return desktopShutdown.acquire(
        () =>
          !this.destroyed &&
          this.updateContext().stamp === stamp &&
          !this.pauseFlight &&
          !this.pluginUpdates.busy &&
          !this.login?.open &&
          !this.toasts.hasReplySurface &&
          this.traySafeForUpdate() &&
          this.api.mutationState.active === 0 &&
          this.api.mutationState.revision === mutation.revision &&
          [...this.pending.values()].reduce((sum, count) => sum + count, 0) <= 1,
      );
    },
    onChange: () => {
      if (!this.destroyed) this.publish();
    },
    onFailure: (failure) => this.o.log.warn('ошибка обновления', { ...failure }),
  });
  private readonly configuration: ServerConfigurationService;
  private readonly inventory: RevitInventoryService;
  private readonly report: ReportService;
  private readonly support: SupportSender;
  private reportBinding?: { id: string; epoch: number; owner: number; serverHash: string };
  private reportExportBinding?: { id: string; epoch: number; owner: number; serverHash: string };
  private readonly morning = new MorningNotices();
  private morningFlight = false;
  private morningAttempt?: { key: string; at: number };
  private morningSaveWarning?: MorningTicket;
  private reminderId: string | null = null;
  private locked = false;
  private suspended = false;
  private readonly saver = new ScreenSaverObserver();
  private saverPoller?: ScreenSaverPoller<{ token: number; binding: string }>;
  private saverActive = false;
  private saverBinding = '';
  private saverUncertain = false;
  private readonly pauseOutbox: PauseOutbox;
  private readonly pauseReturns: PauseReturns;
  private readonly serverScopeHash: string;
  private serverClock: { ms: number; observedAt: number } | null = null;
  private clockInvalidatedBySleep = false;
  private configEpoch = -1;
  private timerEpoch = -1;
  private storageWarning = false;
  private pauseClockWarning = false;
  private returnedAt: string | null = null;
  private returnedKind: PauseReturnKind | null = null;
  private queryCandidate?: { scope: PauseScope; key: string };
  /** Отмена запроса завершения Windows, если через минуту процесс жив и сеанс продолжается. */
  private queryCancelTimer?: NodeJS.Timeout;
  /** Повтор отложенной паузы по времени nextAt (без ожидания очередного дозапроса). */
  private pauseRetryTimer?: NodeJS.Timeout;
  private prunedScope?: string;
  private prunedAt?: number;
  private readonly pauseAttempts = new Map<string, { count: number; nextAt: number }>();
  private readonly recoveryNotices = new Set<string>();
  private readonly sessionQuery = () => this.captureShutdownQuery();
  private readonly sessionEnded = () => this.finalizeShutdownQuery();
  private readonly mainActive = () => this.cancelShutdownQuery();
  private pauseFlight = false;
  private noticePending = new Set<number>();
  private readonly themeChanged = () => this.publish();
  private readonly lock = () => {
    this.locked = true;
    this.saver.explicit('lock', true, performance.now());
    this.absence.depart('lock', this.state);
    this.pauseForAbsence();
    this.saverPoller?.fresh();
    this.toasts.clear();
  };
  private readonly unlock = () => {
    this.locked = false;
    // Разблокировка — сеанс продолжается: запрос завершения Windows был отменён.
    this.cancelShutdownQuery();
    this.saver.explicit('lock', false, performance.now());
    this.absence.return('unlock', this.state, Date.now(), false);
    this.recordReturnTime('unlock');
    this.saverPoller?.fresh();
    this.publish();
    this.scheduleRefresh();
  };
  private readonly sleep = () => {
    this.suspended = true;
    this.saver.explicit('suspend', true, performance.now());
    this.saverPoller?.suspend();
    this.absence.depart('suspend', this.state);
    this.pauseForAbsence('suspend');
    // Monotonic clocks across sleep are not a new server calibration.
    this.serverClock = null;
    this.clockInvalidatedBySleep = true;
    this.toasts.clear();
  };
  private readonly wake = () => {
    this.suspended = false;
    this.cancelShutdownQuery();
    this.saver.explicit('suspend', false, performance.now());
    this.absence.return('resume', this.state, Date.now(), false);
    this.recordReturnTime('wake');
    this.saverPoller?.resume();
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
    const ledger =
      o.supportPersistence ??
      new SupportLedger(supportStorage(join(app.getPath('userData'), 'support-send-ledger.json')));
    // Испорченный файл уже в карантине `<имя>.corrupt-<время>`; работа идёт с пустого состояния.
    if (this.pauseOutbox.health.recovered)
      o.log.warn('хранилище сброшено', { store: 'pause-outbox' });
    if (this.pauseReturns.recovered) o.log.warn('хранилище сброшено', { store: 'pause-returns' });
    if (ledger.recovered) o.log.warn('хранилище сброшено', { store: 'support-ledger' });

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
    this.support = new SupportSender({
      ledger,
      fresh: () => this.freshSupportContext(),
      current: (context) => this.supportCurrent(context),
      previewCurrent: (id, context) =>
        this.report.current(id) &&
        this.reportBinding?.id === id &&
        this.reportBinding.epoch === context.epoch &&
        this.reportBinding.owner === context.ownerId &&
        this.reportBinding.serverHash === context.serverHash,
      bundle: (id) => this.report.bundle(id),
      upload: (name, bytes) => this.api.supportUpload(name, bytes),
      post: (payload, key) => this.api.supportSend(payload, key),
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
      allowMutation: () => !desktopShutdown.locked,
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
      onPluginAudit: (audit) => o.log.info('плагины', { ...audit }),
    });
    // Мягкий разбор (ТЗ 3.3): пропуск пишется в журнал видом элемента, не чаще раза в минуту.
    const skippedAt = new Map<string, number>();
    parse.onSkipped((kind) => {
      const now = Date.now();
      if (now - (skippedAt.get(kind) ?? -Infinity) < 60000) return;
      skippedAt.set(kind, now);
      o.log.warn('пропущены данные сервера', { kind });
    });
    this.paths = new PathService({
      log: o.log,
      trusted: (host) => uncHostTrusted(host, o.uncHosts ?? [], o.server),
      confirm: (host) => confirmForeignHost(host, o.main.win),
    });
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
          title: S.attachTitle,
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
        if (desktopShutdown.locked) return { ok: false, error: S.waitUpdateCheck };
        const n = this.notices.get(spec);
        if (!n?.chatId || !this.owned(n)) return { ok: false, error: S.loginChanged };
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
        if (n.pluginUpdate) {
          if (index === 0 && this.current(n))
            void this.request({ kind: 'settings.open', tab: 'plugins' });
          return;
        }
        if (n.morning) {
          if (this.morningValid(n.morning, true)) this.openNotice(n);
          return;
        }
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
            if (!this.openTimer('finish', undefined, n.recovery.expected).ok) return;
            this.dropPauseReturn(n.recovery.key);
            this.publish();
          }
          return;
        }
        if (n.reminder) {
          if (this.current(n) && index === 0) this.openTimer('finish');
          return;
        }
        if (index === 0) this.openNotice(n);
        else {
          // «Прочитано» у упоминания гасит и сообщение в чате, и событие колокольчика.
          if (n.chatId && n.messageId) void this.readChat(n.chatId, n.messageId);
          if (n.notificationId)
            void this.api
              .readNotification(n.notificationId)
              .then(() => this.scheduleRefresh('notifications'));
        }
      },
      onOpen: (spec) => {
        const n = this.notices.get(spec);
        if (
          n &&
          this.owned(n) &&
          (!n.pluginUpdate || this.current(n)) &&
          (!n.reminder || this.current(n)) &&
          (!n.morning || this.morningValid(n.morning, true))
        )
          this.openNotice(n);
      },
      onShow: (spec) => {
        const n = this.notices.get(spec);
        if (n && this.current(n)) {
          if (n.pluginUpdate) this.pluginUpdates.shown(n.pluginUpdate);
          if (n.morning) {
            this.morning.shown(n.morning);
            this.saveMorning(n.morning);
          }
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
        if (n?.pluginUpdate) this.pluginNoticeWindows.delete(n.pluginUpdate.id);
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
          if (online) {
            // «Нет связи» снимает только ответ сервера: сокет может подняться, когда
            // REST ещё недоступен (например, сервер отвечает 503).
            if (this.state.connection === 'offline') void this.probeServer();
            else {
              this.state.connection = 'online';
              this.publish();
            }
            this.scheduleRefresh();
            return;
          }
          // Разрыв сокета — ещё не «Нет связи»: история и отправка идут через REST.
          // Плашка — только если сервер не отвечает (проверка /api/health).
          this.configEpoch = -1;
          this.timerEpoch = -1;
          void this.probeServer();
        },
      });
    }
    this.peers.set(o.main.win.webContents.id, CLIENT_URL);
    ipcMain.handle('client:request', (e, raw: unknown) => this.receive(e, raw));
    o.main.win.webContents.on('did-finish-load', () => this.publish());
    o.main.win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        this.updateDocument = randomUUID();
        this.syncUpdateContext();
      }
    });
    this.ses.cookies.on('changed', this.cookieChanged);
    nativeTheme.on('updated', this.themeChanged);
    this.saverPoller = new ScreenSaverPoller(
      new WindowsScreenSaverReader({ appPath: app.getAppPath(), isPackaged: app.isPackaged }),
      (sample, context) => this.acceptScreenSaver(sample, context),
      () => ({ token: this.saver.token, binding: this.screenSaverBinding() }),
      {
        // Помощник запускается только при бездействии (заставка без него не включится)
        // или пока заставка замечена; блокировка/сон/пробуждение читают внеочередно.
        idleSeconds: () => Number(powerMonitor.getSystemIdleTime?.()) || 0,
        latched: () => this.saver.saverLatched,
      },
    );
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
      lifetime: () => this.updateContext().stamp,
      onOffer: (release, stamp) => {
        this.desktopUpdates.setOffer(release, stamp);
      },
      onChange: (state) => {
        this.state.updates = state;
        this.publish();
      },
    });
    this.state.updates = this.updates.state;
    this.tick = setInterval(() => {
      if (this.state.focus.until && Date.parse(this.state.focus.until) <= Date.now())
        this.updateFocus({ until: null, startedAt: null });
      this.scheduleRefresh();
    }, 30000);
    // Незавершённая установка плагина доводится при запуске — до входа и без сервера.
    void this.pluginUpdates.refresh();
    void this.bootstrap().then(
      () => this.updates.start(),
      () => this.updates.start(),
    );
  }
  private invalidate(): void {
    this.pluginCatalog.reset();
    this.configEpoch = -1;
    this.timerEpoch = -1;
    this.serverClock = null;
    this.pauseClockWarning = false;
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
    this.pluginCatalog.reset();
    this.configEpoch = -1;
    this.timerEpoch = -1;
    this.serverClock = null;
    this.pauseClockWarning = false;
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
      this.offline(health.ok ? S.serverUnavailable : health.error);
      return;
    }
    this.state.serverVersion = health.data.version;
    if (!supportedServerVersion(health.data.version)) {
      this.state.connection = 'incompatible';
      this.state.error = S.serverTooOld(MINIMUM_SERVER_VERSION);
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
    if (config.ok) this.observeServerTime(config.data.serverNow);
    this.state.timerControl = config.ok && (config.data.capabilities.timerControl ?? 0) >= 2;
    this.retry = 0;
    // После «Нет связи» сервер снова ответил — сразу «в сети»; при входе коротко ждём сокет.
    this.state.connection =
      this.socketOnline || !this.realtime || this.state.connection === 'offline'
        ? 'online'
        : 'connecting';
    this.publish();
    await this.refresh();
    if (boot !== this.boot || this.destroyed || !this.api.owner) return;
    await this.realtime?.start();
    // Сервер ответил по REST — история и отправка доступны и без сокета. Обычно сокет
    // подключается за доли секунды; не подключился за 3 с (прокси режет WebSocket и
    // long-polling ещё пробуется) — «в сети» по проверке /api/health, без ожидания сокета.
    clearTimeout(this.onlineFallback);
    this.onlineFallback = setTimeout(() => {
      if (!this.destroyed && boot === this.boot && this.state.connection === 'connecting')
        void this.probeServer();
    }, 3000);
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
  /**
   * События сокета перечитывают только затронутое (список чатов или колокольчик) и
   * сливаются за 300 мс; полный дозапрос — по таймеру, показу окна, восстановлению связи.
   */
  private scheduleRefresh(scope: RefreshScope = 'all'): void {
    if (this.destroyed) return;
    this.refreshScope = mergeScope(this.refreshScope, scope);
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(
      () => {
        this.refreshTimer = undefined;
        const next = this.refreshScope ?? 'all';
        this.refreshScope = null;
        void this.refresh(next);
      },
      scope === 'all' ? 150 : 300,
    );
  }
  /** Разрыв сокета или сбой REST: «Нет связи» — только если сервер не отвечает на /api/health. */
  private probeServer(): Promise<void> {
    if (this.probing) return this.probing;
    const epoch = this.api.epoch;
    const flight = this.api
      .health()
      .then((health) => {
        if (this.destroyed || epoch !== this.api.epoch || !this.state.user) return;
        if (!health.ok || health.data.status !== 'ok') {
          this.offline(health.ok ? S.serverUnavailable : health.error);
          return;
        }
        // Сервер отвечает: остаёмся «в сети»; дозапрос — по таймеру 30 с или при
        // восстановлении сокета (без цикла «сбой → проверка → дозапрос»).
        if (this.state.connection === 'offline' || this.state.connection === 'connecting')
          this.state.connection = 'online';
        this.publish();
      })
      .finally(() => {
        if (this.probing === flight) this.probing = undefined;
      });
    this.probing = flight;
    return flight;
  }
  private async refresh(scope: RefreshScope = 'all'): Promise<void> {
    if (!this.api.owner || this.destroyed) return;
    if (this.refreshing) {
      this.again = true;
      this.againScope = mergeScope(this.againScope, scope);
      return;
    }
    this.refreshing = true;
    const epoch = this.api.epoch;
    try {
      if (scope !== 'all') {
        await this.refreshPart(scope, epoch);
        return;
      }
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
        if (config.ok) this.observeServerTime(config.data.serverNow);
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
        this.liveNotices.prime(chats.data.items, notifications.data.items);
      if (focus.ok) this.updateFocus(focus.data);
      const bad = [chats, notifications, focus].find((r) => !r.ok);
      this.state.error = bad && !bad.ok ? bad.error : null;
      this.state.historyRevision = (this.state.historyRevision ?? 0) + 1;
      if (this.unreachable(chats)) void this.probeServer();
      else if (chats.ok && this.state.connection === 'offline') this.state.connection = 'online';
      this.publish();
      if (focus.ok) this.checkReminder();
      void this.checkMorning();
      void this.pluginCatalog.refresh();
      this.showPluginNotices();
      await this.checkTimerPending();
      void this.flushAbsencePause();
    } finally {
      this.refreshing = false;
      if (this.again) {
        this.again = false;
        const next = this.againScope ?? 'all';
        this.againScope = null;
        this.scheduleRefresh(next);
      }
    }
  }
  private unreachable(result: ApiResult<unknown>): boolean {
    return !result.ok && ['network', 'timeout', 'server_error'].includes(result.code);
  }
  /** Точечное обновление после события сокета: один GET вместо полного дозапроса. */
  private async refreshPart(scope: 'chats' | 'notifications', epoch: number): Promise<void> {
    if (scope === 'chats') {
      const chats = await this.api.listChats();
      if (this.destroyed || epoch !== this.api.epoch) return;
      if (chats.ok) {
        this.state.chats = chats.data.items;
        this.state.unread = chats.data.unreadTotal;
        this.liveNotices.prime(chats.data.items, this.state.notifications);
      }
      this.state.error = chats.ok ? null : chats.error;
      this.state.historyRevision = (this.state.historyRevision ?? 0) + 1;
      if (this.unreachable(chats)) void this.probeServer();
    } else {
      const notifications = await this.api.notifications();
      if (this.destroyed || epoch !== this.api.epoch) return;
      if (notifications.ok) {
        this.state.notifications = notifications.data.items;
        this.state.notificationUnread = notifications.data.unread;
        this.liveNotices.prime(this.state.chats, notifications.data.items);
      }
      this.state.error = notifications.ok ? null : notifications.error;
      if (this.unreachable(notifications)) void this.probeServer();
    }
    this.publish();
  }
  private observeServerTime(value: unknown): void {
    if (utcInstant(value)) {
      this.serverClock = { ms: Date.parse(value), observedAt: performance.now() };
      this.clockInvalidatedBySleep = false;
    }
  }
  private supportCurrent(context: SupportContext): boolean {
    const config = this.api.desktopConfiguration;
    return (
      !this.destroyed &&
      this.api.owner === context.ownerId &&
      this.state.user?.id === context.ownerId &&
      this.api.epoch === context.epoch &&
      context.serverHash === this.serverScopeHash &&
      this.configEpoch === context.epoch &&
      (config?.capabilities.support ?? 0) >= 1 &&
      config?.supportChatId === context.chatId
    );
  }
  private async freshSupportContext(): Promise<ApiResult<SupportContext>> {
    const epoch = this.api.epoch,
      owner = this.api.owner,
      started = performance.now();
    if (!owner || this.destroyed) return failure('unauthenticated');
    const auth = await this.api.authenticate();
    if (this.destroyed || this.api.epoch !== epoch || this.api.owner !== owner)
      return failure('stale_session');
    if (!auth.ok) return auth;
    if (auth.data.id !== owner) return failure('stale_session');
    const config = await this.api.readDesktopConfig();
    if (this.destroyed || this.api.epoch !== epoch || this.api.owner !== owner)
      return failure('stale_session');
    this.configEpoch = config.ok ? epoch : -1;
    this.state.bureau = config.ok ? config.data.bureau : null;
    this.state.timerControl = config.ok && (config.data.capabilities.timerControl ?? 0) >= 2;
    if (!config.ok) return config;
    this.state.bureau = config.data.bureau;
    this.state.timerControl = (config.data.capabilities.timerControl ?? 0) >= 2;
    this.observeServerTime(config.data.serverNow);
    if ((config.data.capabilities.support ?? 0) < 1 || !config.data.supportChatId)
      return failure('no_support_chat');
    const uncertaintyMs = performance.now() - started;
    if (!Number.isFinite(uncertaintyMs) || uncertaintyMs < 0 || uncertaintyMs > 60000)
      return failure('timeout');
    return ok({
      serverHash: this.serverScopeHash,
      ownerId: owner,
      epoch,
      chatId: config.data.supportChatId,
      serverNow: config.data.serverNow,
      uncertaintyMs,
    });
  }
  private morningContext(): MorningContext | null {
    const config = this.api.desktopConfiguration,
      owner = this.api.owner;
    if (
      this.destroyed ||
      !owner ||
      this.state.user?.id !== owner ||
      this.state.connection !== 'online' ||
      this.configEpoch !== this.api.epoch ||
      (config?.capabilities.morning ?? 0) < 1 ||
      !config
    )
      return null;
    return {
      serverHash: this.serverScopeHash,
      owner,
      epoch: this.api.epoch,
      timeZone: config.bureau.timeZone,
      now: this.serverTime(),
    };
  }
  private morningValid(ticket: MorningTicket, shownAction = false): boolean {
    const context = this.morningContext();
    return (
      this.o.settings.get().notifications.morning &&
      !!context &&
      !this.locked &&
      !this.suspended &&
      !this.saver.absent &&
      this.morning.valid(ticket, context, this.o.settings.get().morningSeen, shownAction)
    );
  }
  private saveMorning(ticket: MorningTicket): void {
    try {
      this.o.settings.update({
        morningSeen: [...new Set([...this.o.settings.get().morningSeen, ticket.key])].slice(-128),
      });
      this.morningSaveWarning = undefined;
      this.state.morningWarning = null;
    } catch {
      this.morningSaveWarning = ticket;
      this.state.morningWarning = S.morningSaveFailed;
    }
    this.publish();
  }
  private async checkMorning(): Promise<void> {
    const context = this.morningContext();
    if (
      !context ||
      this.morningFlight ||
      this.locked ||
      this.suspended ||
      this.saver.absent ||
      !this.o.settings.get().notifications.enabled ||
      !this.o.settings.get().notifications.morning
    )
      return;
    if (
      this.morningSaveWarning &&
      this.morningSaveWarning.context.owner === context.owner &&
      this.morningSaveWarning.context.serverHash === context.serverHash
    )
      this.saveMorning(this.morningSaveWarning);
    const clock = bureauMorning(context.now, context.timeZone);
    if (!clock?.afterEight) return;
    const key = `${context.serverHash}:${context.owner}:${clock.date}`;
    if (this.o.settings.get().morningSeen.includes(key)) return;
    if (this.morningAttempt?.key === key && performance.now() - this.morningAttempt.at < 60000)
      return;
    this.morningAttempt = { key, at: performance.now() };
    this.morningFlight = true;
    try {
      const result = await this.api.morning();
      const current = this.morningContext();
      if (
        !result.ok ||
        !current ||
        current.epoch !== context.epoch ||
        current.owner !== context.owner ||
        current.serverHash !== context.serverHash
      )
        return;
      const ticket = this.morning.ticket(current, result.data, this.o.settings.get().morningSeen);
      if (!ticket || !this.morningValid(ticket)) return;
      this.showNotice(
        ticket.key,
        S.morningTitle,
        [
          result.data.dueToday ? S.morningDue(result.data.dueToday) : null,
          result.data.review ? S.morningReview(result.data.review) : null,
          result.data.newRemarks ? S.morningRemarks(result.data.newRemarks) : null,
        ]
          .filter(Boolean)
          .join(' · '),
        {
          morning: ticket,
          epoch: context.epoch,
          owner: context.owner,
          chatId: null,
          link: '/my',
          mention: false,
          ordinary: true,
        },
      );
    } finally {
      this.morningFlight = false;
    }
  }
  private serverTime(): number {
    const age = this.serverClock ? performance.now() - this.serverClock.observedAt : NaN;
    return this.serverClock && Number.isFinite(age) && age >= 0 ? this.serverClock.ms + age : NaN;
  }
  private screenSaverBinding(): string {
    const timer = this.state.timer;
    return JSON.stringify([
      this.boot,
      this.api.epoch,
      this.api.owner,
      this.state.user?.id,
      this.configEpoch,
      this.timerEpoch,
      this.timerRevision,
      this.state.timerReady,
      this.state.timerControl,
      timer?.timerId,
      timer?.version,
      timer?.segments.at(-1)?.from,
      timer?.state,
      this.o.settings.get().timer.pauseOnLock,
    ]);
  }
  private syncScreenSaverDemand(): void {
    const scope = this.pauseScope();
    const binding = `${this.boot}:${this.api.epoch}:${scope?.ownerId ?? ''}`;
    if (binding !== this.saverBinding) {
      this.saverBinding = binding;
      this.saver.invalidate();
      this.saverPoller?.stop();
      this.saverActive = false;
    }
    // A physical latch must still be cleared by observation after logout or
    // capability removal. Permission to read it is independent of timer writes.
    const wanted =
      !this.destroyed &&
      (this.saver.absent ||
        (!!scope &&
          this.state.timerControl &&
          ((this.state.timer?.state === 'run' &&
            this.o.settings.get().timer.pauseOnLock &&
            this.startedHere(this.state.timer)) ||
            this.pauseOutbox
              .list(scope)
              .some((r) => r.status === 'pending' || r.status === 'unknown') ||
            // Вопрос о возврате (и его кнопки после показа) нужен только для паузы, на которой
            // таймер стоит сейчас; без таймера опрос заставки ради записи не держим.
            (!!this.state.timer &&
              this.pauseReturns
                .list(scope)
                .some((r) => matchesTimer(this.state.timer ?? null, r.expected))))));
    if (wanted && !this.saverActive && this.saverPoller) {
      this.saverActive = true;
      if (this.suspended) this.saverPoller.suspend();
      this.saverPoller.start();
    } else if (!wanted && this.saverActive) {
      this.saverActive = false;
      this.saver.invalidate();
      this.saverPoller?.stop();
    }
  }
  private acceptScreenSaver(
    sample: ScreenSaverSample,
    context: { token: number; binding: string },
  ): void {
    if (this.destroyed) return;
    if (context.binding !== this.screenSaverBinding()) {
      this.saverPoller?.fresh();
      return;
    }
    const result = this.saver.sample(sample, context.token);
    if (!result) return;
    this.saverUncertain = sample.state === 'unknown';
    if (sample.state === 'running') {
      this.absence.depart('screensaver', this.state);
      this.toasts.clear();
      // Snapshot, scope and timer expected were captured before the async read.
      // No timer A sample may be retargeted to timer B on completion.
      this.pauseForAbsence('screensaver');
    } else if (sample.state === 'stopped') {
      this.absence.return('screensaver', this.state, Date.now(), false);
      if (result.transition === 'return') this.recordReturnTime('screensaver');
      this.showPauseReturn();
    }
    this.publish();
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
    this.settleEndedPauseReturns(timer);
    // Refresh also reads Focus. Wait for it before considering a popup.
    if (!this.refreshing) this.checkReminder();
  }
  /**
   * Пауза после отсутствия закончилась — таймер продолжен, завершён или сброшен
   * из трея, окна, сайта или с другого компьютера: запись «пауза подтверждена» снимается.
   * Опоздавший снимок с меньшей ревизией того же таймера запись не снимает.
   */
  private settleEndedPauseReturns(timer: WorkTimer | null): void {
    const scope = this.pauseScope();
    if (!scope || this.timerEpoch !== this.api.epoch) return;
    const removed = this.pauseReturns.settleEnded(
      scope,
      (r) => !timer || timer.timerId !== r.expected.timerId || timer.version > r.expected.revision,
    );
    if (!removed) return;
    const left = new Set(this.pauseReturns.list(scope).map((r) => r.key));
    for (const key of [...this.recoveryNotices])
      if (!left.has(key)) {
        this.toasts.dismiss('pause-return:' + key);
        this.recoveryNotices.delete(key);
      }
  }
  /** Таймер запущен из этого приложения (локальная отметка при timer.start). */
  private startedHere(timer: WorkTimer | null | undefined): boolean {
    const scope = this.pauseScope();
    return Boolean(
      scope &&
      timer?.timerId &&
      this.o.settings
        .get()
        .timerStartedHere.includes(`${scope.serverScopeHash}:${scope.ownerId}:${timer.timerId}`),
    );
  }
  private rememberStartedHere(timer: WorkTimer | null): void {
    const scope = this.pauseScope();
    if (!scope || !timer?.timerId) return;
    const key = `${scope.serverScopeHash}:${scope.ownerId}:${timer.timerId}`;
    const list = this.o.settings.get().timerStartedHere;
    if (list.includes(key)) return;
    try {
      this.o.settings.update({ timerStartedHere: [...list, key].slice(-32) });
    } catch {
      this.o.log.warn('не удалось сохранить таймер этого компьютера');
    }
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
      !this.o.settings.get().timer.pauseOnLock ||
      // Решение руководителя 05.11.2026: на паузу ставится только таймер, запущенный
      // с этого компьютера. Таймер с сайта или другого ПК этот компьютер не трогает.
      !this.startedHere(timer)
    )
      return null;
    // A run snapshot is the calibration source. Ongoing elapsed time uses only a monotonic clock.
    if (!this.serverClock && !this.clockInvalidatedBySleep && kind !== 'screensaver')
      this.observeServerTime(timer.serverNow);
    // The detector must not invent an event timestamp from an old timer payload,
    // especially after sleep. Expired calibration leaves a visible review warning.
    if (
      kind === 'screensaver' &&
      (!this.serverClock || performance.now() - this.serverClock.observedAt > 120000)
    ) {
      this.pauseClockWarning = true;
      return null;
    }
    const now = this.serverTime();
    if (!Number.isFinite(now)) {
      this.pauseClockWarning = true;
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
  private pauseForAbsence(kind: 'lock' | 'suspend' | 'screensaver' = 'lock'): void {
    const command = this.captureAbsence(kind);
    if (command) {
      // Запрос завершения, если был, заменён настоящим событием (capture его убрал).
      this.queryCandidate = undefined;
      clearTimeout(this.queryCancelTimer);
      void this.flushAbsencePause();
    }
    this.publish();
  }
  private captureShutdownQuery(): void {
    const command = this.captureAbsence('query-session-end');
    if (command?.status === 'candidate') {
      this.queryCandidate = {
        scope: { serverScopeHash: command.serverScopeHash, ownerId: command.ownerId },
        key: command.key,
      };
      // Завершение Windows могли отменить (приложение не дало закрыться, пользователь
      // нажал «Отмена»): если через минуту процесс жив, кандидат снимается без следа.
      clearTimeout(this.queryCancelTimer);
      this.queryCancelTimer = setTimeout(() => this.cancelShutdownQuery(), SHUTDOWN_QUERY_MS);
      this.queryCancelTimer.unref?.();
    }
    // Windows callback is synchronous persistence only: no network, no shutdown blocking.
  }
  private finalizeShutdownQuery(): void {
    clearTimeout(this.queryCancelTimer);
    const candidate = this.queryCandidate;
    if (candidate && !this.pauseOutbox.confirmSessionEnd(candidate.scope, candidate.key))
      this.storageWarning = true;
    this.queryCandidate = undefined;
  }
  private cancelShutdownQuery(): void {
    clearTimeout(this.queryCancelTimer);
    const candidate = this.queryCandidate;
    this.queryCandidate = undefined;
    if (!candidate) return;
    const stillCandidate = this.pauseOutbox
      .list(candidate.scope)
      .some((r) => r.key === candidate.key && r.status === 'candidate');
    if (stillCandidate && !this.pauseOutbox.cancelQuery(candidate.scope, candidate.key))
      this.storageWarning = true;
    if (!this.destroyed) this.publish();
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
    // Вопрос «Продолжить?» выключен — запись о возврате не нужна и не копится.
    if (
      this.o.settings.get().timer.askOnUnlock &&
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
    // An update must leave durable pauses queued, never classify a local IO
    // barrier as an unconfirmed server command or consume the return question.
    if (desktopShutdown.locked) return;
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
    this.prunePauseStores(scope);
    // Выключение «паузы при блокировке» действует на новые события; уже стоящие
    // в очереди паузы уходят как обычно (время до выключения уже не учтено).
    const records = this.pauseOutbox.list(scope);
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
      if (attempts && this.serverTime() < attempts.nextAt) {
        this.schedulePauseRetry(attempts.nextAt);
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
          // Сервер занят другой командой этого таймера: изменение не применено,
          // попытка засчитывается, повтор — по нарастающей задержке.
          const count = (attempts?.count ?? 0) + 1;
          this.pauseAttempts.set(command.key, {
            count,
            nextAt: this.serverTime() + pauseRetryDelay(count, 1000),
          });
        } else if (['network', 'timeout', 'server_error'].includes(result.code)) {
          // ТЗ 9.4: команда уходит при появлении связи. Исход неизвестен — повтор с тем же
          // ключом идемпотентности, пока сервер его хранит (истечение — review «expired»).
          const count = (attempts?.count ?? 0) + 1;
          this.pauseOutbox.settle(
            scope,
            command.key,
            result.code === 'server_error'
              ? { kind: 'http-failure', status: 500 }
              : { kind: 'unknown' },
          );
          this.pauseAttempts.set(command.key, {
            count,
            nextAt: this.serverTime() + pauseRetryDelay(count),
          });
        } else if (
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
      const next = this.pauseAttempts.get(command.key);
      if (next && this.pauseOutbox.list(scope).some((r) => r.key === command.key))
        this.schedulePauseRetry(next.nextAt);
      this.publish();
      this.scheduleRefresh();
      break;
    }
    this.showPauseReturn();
  }
  /** Повтор отложенной паузы к сроку nextAt (время сервера), не дожидаясь дозапроса. */
  private schedulePauseRetry(nextAt: number): void {
    if (this.destroyed || this.pauseRetryTimer) return;
    const delay = Math.max(0, Math.min(300_000, nextAt - this.serverTime()));
    if (!Number.isFinite(delay)) return;
    this.pauseRetryTimer = setTimeout(() => {
      this.pauseRetryTimer = undefined;
      if (!this.destroyed) void this.flushAbsencePause();
    }, delay + 50);
    this.pauseRetryTimer.unref?.();
  }
  /** Записи чужого сервера и пользователя, старше недели — убираются (журнал — число). */
  private prunePauseStores(scope: PauseScope): void {
    const key = `${scope.serverScopeHash}:${scope.ownerId}`;
    const now = Date.now();
    if (this.prunedScope === key && this.prunedAt !== undefined && now - this.prunedAt < 3600_000)
      return;
    this.prunedScope = key;
    this.prunedAt = now;
    const removed = this.pauseOutbox.prune(scope, now) + this.pauseReturns.prune(scope, now);
    if (removed) this.o.log.info('записи паузы удалены', { count: String(removed) });
  }
  private showPauseReturn(): void {
    const scope = this.pauseScope();
    if (
      !scope ||
      !this.saver.returnAllowed ||
      !Number.isFinite(this.serverTime()) ||
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
      title: S.pauseReturnTitle,
      body:
        this.o.settings.get().notifications.preview && this.state.timer
          ? `${S.pauseReturnFrom(record.returnKind === 'unlock')}${new Date(record.at).toLocaleString('ru-RU', { timeZone: this.state.bureau?.timeZone ?? 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${S.pauseReturnUntil(record.returnKind)}${new Date(record.returnedAt ?? record.at).toLocaleString('ru-RU', { timeZone: this.state.bureau?.timeZone ?? 'UTC', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.\n${[this.state.timer.task.mark, this.state.timer.task.title].filter(Boolean).join(' · ').slice(0, 100)} · ${timerClock(elapsedAt(this.state.timer, this.state.timerObservedAt ?? Date.now()))}`
          : S.pauseReturnHidden,
      hasReply: false,
      buttons: [S.desktopResume, S.pauseReturnFinish],
      delayMs: 0,
    };
    this.recoveryNotices.add(record.key);
    this.notices.set(spec, notice);
    if (this.toasts.show(spec) === false) this.recoveryNotices.delete(record.key);
  }
  private recordReturnTime(kind: PauseReturnKind): void {
    if (
      !this.saver.returnAllowed ||
      this.locked ||
      this.suspended ||
      !Number.isFinite(this.serverTime())
    )
      return;
    this.absence.confirmReturn();
    if (!this.returnedAt) {
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
      this.dropPauseReturn(record.key);
    } else this.state.timerError = result.error;
    this.publish();
    this.scheduleRefresh();
  }
  /** Снять запись по кнопке; уже снятая свежим снимком (продолжение) — не ошибка записи. */
  private dropPauseReturn(key: string): void {
    const scope = this.pauseScope();
    if (
      scope &&
      this.pauseReturns.list(scope).some((r) => r.key === key) &&
      !this.pauseReturns.dismiss(scope, key)
    )
      this.storageWarning = true;
  }
  private absenceRecordId(key: string): number {
    return Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, 12), 16) + 1;
  }
  private durableAbsenceWarning(): ClientSnapshot['timerAbsence'] {
    const scope = this.pauseScope();
    if (!scope) return null;
    const now = Number.isFinite(this.serverTime()) ? this.serverTime() : Date.now();
    if (this.pauseClockWarning)
      return {
        id: this.absenceRecordId('clock-warning'),
        from: now,
        to: now,
        durable: true,
        message: S.absenceNoServerTime,
      };
    if (this.storageWarning || this.pauseOutbox.health.blocked || !this.pauseReturns.healthy)
      return {
        id: this.absenceRecordId('storage'),
        from: now,
        to: now,
        durable: true,
        message: S.absenceStorage,
      };
    if (this.pauseOutbox.health.recovered || this.pauseReturns.recovered)
      return {
        id: this.absenceRecordId('recovered'),
        from: now,
        to: now,
        durable: true,
        message: PAUSE_RECOVERED_MESSAGE,
      };
    const record = this.pauseOutbox.list(scope)[0];
    if (record)
      return {
        id: this.absenceRecordId(record.key),
        from: Date.parse(record.at),
        to: now,
        durable: true,
        message:
          record.status === 'candidate' || record.reviewReason === 'unconfirmed-query'
            ? S.absenceQuery
            : record.status === 'pending' || record.status === 'unknown'
              ? S.absencePending
              : S.absenceRejected,
      };
    const returned = this.pauseReturns.list(scope)[0];
    if (!returned && this.saverUncertain && this.state.timer?.state === 'run')
      return {
        id: this.absenceRecordId('screensaver-unknown'),
        from: now,
        to: now,
        durable: true,
        message: S.absenceScreensaver,
      };
    return returned
      ? {
          id: this.absenceRecordId(returned.key),
          from: Date.parse(returned.at),
          to: now,
          durable: true,
          // Запись живёт, только пока таймер стоит на этой паузе (settleEndedPauseReturns).
          message: S.absenceConfirmed,
        }
      : null;
  }
  private acknowledgeAbsence(id: number): void {
    const scope = this.pauseScope();
    if (!scope) return;
    if (id === this.absenceRecordId('clock-warning')) this.pauseClockWarning = false;
    if (id === this.absenceRecordId('recovered')) {
      this.pauseOutbox.acknowledgeRecovery();
      this.pauseReturns.acknowledgeRecovery();
    }
    for (const record of this.pauseOutbox.list(scope))
      if (this.absenceRecordId(record.key) === id) {
        if (record.status === 'candidate') {
          if (!this.pauseOutbox.cancelQuery(scope, record.key)) this.storageWarning = true;
          continue;
        }
        if (['pending', 'unknown'].includes(record.status))
          this.pauseOutbox.settle(scope, record.key, { kind: 'review' });
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
      ticket = this.reminders.due(
        this.state,
        settings.timer.reminderTime,
        this.reminderNow(),
        this.state.bureau?.timeZone,
      );
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
      ...(this.state.bureau?.timeZone && { timeZone: this.state.bureau.timeZone }),
    });
    const spec: ToastSpec = {
      id: ticket.id,
      key: ticket.id,
      groupId: ticket.id,
      title: S.timerReminderTitle,
      body: settings.notifications.preview
        ? `${taskLabel}\n${S.reminderSince(timerClock(elapsedAt(timer, this.state.timerObservedAt ?? Date.now())), start)}`
        : S.reminderHidden,
      hasReply: false,
      buttons: [S.reminderFinish, S.timerStillWorking],
      delayMs: 0,
    };
    this.reminderId = spec.id;
    this.notices.set(spec, notice);
    this.toasts.show(spec);
  }
  /** Время для напоминания 18:30: серверное, если откалибровано, иначе часы компьютера. */
  private reminderNow(): number {
    const now = this.serverTime();
    return Number.isFinite(now) ? now : Date.now();
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
    if (name === 'desktop:plugins') {
      // Только новое чтение каталога: начатую запись на диск событие не обрывает.
      this.pluginCatalog.invalidate();
      return;
    }
    if (name === 'time:timer') {
      this.timerRevision++;
      try {
        this.acceptTimer(this.state.timerControl ? controlledTimer(data) : workTimer(data));
        if (this.state.timerControl) this.observeServerTime(parse.object(data).serverNow);
      } catch {
        this.state.timerReady = false;
        this.state.timerError = S.timerReadFailed;
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
        // «Печатает…» — только снимок окнам, без пересчёта плагинов и перерисовки значка.
        this.sendState();
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
      void this.sessionChanged();
      return;
    }
    if (name === 'chat:message') {
      try {
        const message = parse.messageEvent(data);
        const fresh = this.liveNotices.message(message.chatId, message.id);
        const quietSupported = (this.api.desktopConfiguration?.capabilities.chatQuiet ?? 0) >= 1;
        if (fresh && message.quiet !== true && (!quietSupported || message.quiet === false))
          this.messageNotice(message, message.quiet === false);
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
    this.scheduleRefresh(
      name === 'notification' ? 'notifications' : name.startsWith('chat:') ? 'chats' : 'all',
    );
  }
  /**
   * Событие `session` — «права или вход изменились» (docs/server-api.md), а не выход.
   * Перечитываем /api/auth/me: тот же пользователь и живая сессия — только обновляем
   * данные и права (черновики, тосты быстрого ответа и epoch сохраняются). Полный сброс —
   * при 401 (authLost → signedOut) или смене пользователя/временного пароля.
   */
  private async sessionChanged(): Promise<void> {
    const epoch = this.api.epoch,
      owner = this.api.owner;
    if (!owner) {
      void this.bootstrap();
      return;
    }
    const auth = await this.api.authenticate();
    if (this.destroyed) return;
    if (!auth.ok) {
      // 401 уже обработан через onAuthLost; сбой связи — не повод сбрасывать вход.
      if (auth.code !== 'unauthenticated' && auth.code !== 'stale_session') void this.probeServer();
      return;
    }
    if (
      epoch !== this.api.epoch ||
      auth.data.id !== owner ||
      auth.data.mustChangePassword !== this.state.user?.mustChangePassword
    ) {
      this.invalidate();
      void this.bootstrap();
      return;
    }
    this.state.user = auth.data;
    // Права и возможности перечитываются при следующем дозапросе (/api/desktop/config).
    this.configEpoch = -1;
    this.publish();
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
        S.focusSummaryTitle,
        S.focusSummary(result.data.messages, result.data.chats.length, result.data.mentions),
        { epoch, owner: this.api.owner, chatId: null, mention: false, ordinary: true },
      );
    });
  }
  private messageNotice(message: ChatMessage, serverQuiet = false): void {
    const owner = this.api.owner;
    if (
      !owner ||
      message.deleted ||
      message.author?.id === owner ||
      message.mentions.includes(owner)
    )
      return;
    if (message.id <= (this.readThrough.get(message.chatId) ?? 0)) return;
    this.pruneCounts();
    const previous = this.counts.get(message.chatId);
    const messages = previous ? previous.messages : new Set<number>();
    if (messages.has(message.id)) return;
    messages.add(message.id);
    const count = messages.size;
    const last =
      previous && messages.has(previous.last.id) && previous.last.id > message.id
        ? previous.last
        : message;
    this.counts.set(message.chatId, { at: Date.now(), messages, last });
    this.displayMessageNotice(last, count, serverQuiet);
  }
  /** Записи пачек устаревают по времени: старая пачка не воскрешает уведомление. */
  private pruneCounts(now = Date.now()): void {
    for (const [chatId, entry] of this.counts)
      if (now - entry.at >= COUNT_WINDOW) this.counts.delete(chatId);
  }
  /** Текст уведомления по ТЗ 5.3: в группе и чате объекта — «Фамилия И.О.: текст». */
  private messageNoticeText(message: ChatMessage, count: number): string {
    const kind = this.state.chats.find((c) => c.id === message.chatId)?.kind;
    const text = message.text || S.newAttachment;
    const author = message.author?.shortName;
    const line = kind && kind !== 'direct' && author ? `${author}: ${text}` : text;
    return `${count > 1 ? `${S.newMessages(count)}\n` : ''}${line}`;
  }
  private displayMessageNotice(message: ChatMessage, count: number, serverQuiet = false): void {
    const owner = this.api.owner;
    if (!owner) return;
    const title =
      this.state.chats.find((c) => c.id === message.chatId)?.title ??
      message.author?.shortName ??
      S.desktopNewMessage;
    this.showNotice(`chat:${message.chatId}`, title, this.messageNoticeText(message, count), {
      epoch: this.api.epoch,
      owner,
      chatId: message.chatId,
      messageId: message.id,
      mention: false,
      ordinary: true,
      serverQuiet,
    });
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
    this.pruneCounts();
    const current = this.counts.get(chatId);
    if (!current) return;
    for (const id of current.messages) if (id <= upTo) current.messages.delete(id);
    if (!current.messages.size || current.last.id <= upTo) {
      this.counts.delete(chatId);
      this.toasts.dismiss(`chat:${chatId}`);
    } else if (this.o.settings.get().notifications.preview)
      // Частично прочитано на другом устройстве: уже показанное уведомление только
      // обновляет счётчик и текст — без нового всплытия и звука.
      this.toasts.update(
        `chat:${chatId}`,
        this.messageNoticeText(current.last, current.messages.size),
      );
  }
  private bellNotice(item: NotificationItem, pendingDeviceId?: string): void {
    const owner = this.api.owner;
    if (!owner) return;
    const chat = item.link && /^\/chat\/(\d+)(?:\?m=(\d+))?$/.exec(item.link);
    this.showNotice(
      `notification:${item.id}`,
      item.event === 'timer_stopped'
        ? S.timerStoppedTitle
        : item.event === 'album_issued'
          ? S.albumIssuedTitle
          : item.event === 'remarks_closed'
            ? S.remarksClosedTitle
            : (item.subject ?? item.task?.title ?? S.appName),
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
        // Событие колокольчика всегда несёт серверный `quiet` (тихие часы, сводка, «Фокус»).
        serverQuiet: true,
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
          ? S.timerStoppedHidden
          : notice.morning
            ? S.morningHidden
            : S.desktopNewMessage,
      hasReply: notice.chatId !== null,
      buttons: notice.timerStopped
        ? [S.checkEntry, S.desktopRead]
        : notice.chatId || notice.notificationId
          ? [S.desktopOpen, S.desktopRead]
          : [S.desktopOpen],
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
      !this.saver.returnAllowed ||
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
      (!n.pluginUpdate ||
        (!desktopShutdown.locked &&
          this.pluginUpdates.noticeCurrent(n.pluginUpdate) &&
          (n.pluginUpdate.type !== 'complete' ||
            this.o.settings.get().plugins?.notifyInstalled !== false))) &&
      (!n.morning || this.morningValid(n.morning)) &&
      (!n.recovery || this.currentRecovery(n.recovery)) &&
      !(
        n.chatId &&
        n.messageId &&
        !n.notificationId &&
        n.messageId <= (this.readThrough.get(n.chatId) ?? 0)
      ) &&
      (!n.reminder ||
        this.reminders.valid(
          n.reminder,
          this.state,
          this.o.settings.get().timer.reminderTime,
          this.reminderNow(),
          this.state.bureau?.timeZone,
        )) &&
      this.state.connection === 'online' &&
      this.o.settings.get().notifications.enabled &&
      !this.locked &&
      !this.suspended &&
      !this.saver.absent &&
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
    if (desktopShutdown.locked) return false;
    const n = this.notices.get(spec);
    if (!n || !this.current(n)) return false;
    // Тихие часы считает сервер (`quiet`, ТЗ 5.2 п.3); приложение проверяет их само только
    // для событий без серверной отметки (старый сервер, локальная сводка «Фокуса»).
    if ((n.ordinary || n.mention) && !n.serverQuiet) {
      const epoch = this.api.epoch;
      if (!this.preferencesFlight || this.preferencesEpoch !== epoch) {
        this.preferencesEpoch = epoch;
        const flight = this.api
          .notificationSettings()
          .then((r) => {
            if (epoch !== this.api.epoch) return false;
            if (r.ok) this.quietCache = { epoch, settings: r.data };
            // Сбой чтения — последние удачные настройки этого входа, иначе показываем.
            const settings = this.quietCache?.epoch === epoch ? this.quietCache.settings : null;
            const decision = quietDecision(
              settings,
              Date.now(),
              this.state.bureau?.timeZone ?? null,
            );
            const warning = r.ok ? decision.warning : 'settings_unavailable';
            if (warning) this.o.log.warn('тихие часы не проверены', { reason: warning });
            return decision.allowed;
          })
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
    return !desktopShutdown.locked && (after === 'active' || after === 'idle') && this.current(n);
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
  ): ApiResult<null> {
    if (this.destroyed) return failure('stale_session');
    if (desktopShutdown.locked) return failure('update_in_progress');
    if (mode === 'finish' && (!this.state.user || this.state.connection !== 'online')) {
      const error = S.finishOffline;
      this.state.error = error;
      this.o.main.show();
      this.trayWindow?.hide();
      this.publish();
      return { ok: false, code: 'offline', error, retryable: false };
    }
    this.state.navigateTimer = {
      mode,
      ...(prepareExpected && { prepareExpected }),
      ...(taskId && { taskId }),
      nonce: (this.state.navigateTimer?.nonce ?? 0) + 1,
    };
    this.o.main.show();
    this.trayWindow?.hide();
    this.publish();
    return ok(null);
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
    if (
      raw.kind.startsWith('updates.') &&
      !['updates.check', 'updates.later', 'updates.trayDrafts'].includes(raw.kind) &&
      event.sender.id !== this.o.main.win.webContents.id
    )
      return failure('forbidden');
    if (raw.kind === 'updates.trayDrafts' && event.sender.id !== this.trayWindow?.webContents.id)
      return failure('forbidden');
    if (
      desktopShutdown.locked &&
      ![
        'init',
        'updates.cancel',
        'updates.drafts',
        'updates.trayDrafts',
        'window.hide',
        'app.quit',
      ].includes(raw.kind)
    )
      return failure('update_in_progress');
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
        if (this.api.owner && (this.api.desktopConfiguration?.capabilities.support ?? 0) >= 1) {
          const epoch = this.api.epoch;
          void this.freshSupportContext()
            .then(() => {
              if (!this.destroyed && this.api.epoch === epoch) this.publish();
            })
            .catch(() => {
              /* Read-only availability refresh; send/retry perform their own guarded preflight. */
            });
        }
        return ok(null);
      case 'report.clear':
        this.reportExportBinding = undefined;
        this.reportBinding = undefined;
        this.report.clear();
        return ok(null);
      case 'report.edit':
        this.reportExportBinding = undefined;
        this.reportBinding = undefined;
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
          if (r.kind === 'report.prepare') {
            const epoch = this.api.epoch,
              owner = this.api.owner;
            const preview = await this.report.prepare(r.options);
            if (this.destroyed || this.api.epoch !== epoch || this.api.owner !== owner)
              return failure('stale_session');
            this.reportBinding = owner
              ? { id: preview.id, epoch, owner, serverHash: this.serverScopeHash }
              : undefined;
            return ok(preview);
          }
          if (r.kind === 'report.export') {
            const epoch = this.api.epoch,
              owner = this.api.owner;
            const exported = await this.report.export(r.id);
            if (this.destroyed || this.api.epoch !== epoch || this.api.owner !== owner)
              return failure('stale_session');
            this.reportExportBinding =
              exported && owner
                ? { id: exported.id, epoch, owner, serverHash: this.serverScopeHash }
                : undefined;
            return ok(exported);
          }
          return this.report.reveal(r.id) ? ok(null) : failure('validation');
        } catch {
          return {
            ok: false,
            code: 'report_error',
            error:
              r.kind === 'report.capture'
                ? S.reportCaptureFailed
                : r.kind === 'report.export'
                  ? S.reportExportFailed
                  : S.reportPrepareFailed,
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
            error: S.revitFoldersFailed,
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
      case 'updates.trayDrafts': {
        const { contextId, revision, dirtyCount, busy } = r;
        if (
          contextId !== this.updateContext().stamp ||
          (this.trayDrafts?.contextId === contextId &&
            (revision < this.trayDrafts.revision ||
              (revision === this.trayDrafts.revision &&
                (dirtyCount !== this.trayDrafts.dirtyCount || busy !== this.trayDrafts.busy))))
        )
          return failure('stale_session');
        this.trayDrafts = { contextId, revision, dirtyCount, busy };
        if (desktopShutdown.locked && !this.traySafeForUpdate()) this.desktopUpdates.invalidate();
        return ok(null);
      }
      case 'updates.prepare':
        return ok(await this.desktopUpdates.prepare(r.offerId));
      case 'updates.cancel':
        return ok(await this.desktopUpdates.cancel(r.jobId));
      case 'updates.requestLaunch':
        if (this.pluginUpdates.busy) return failure('update_busy');
        if (!this.traySafeForUpdate() || this.toasts.hasReplySurface) return failure('update_busy');
        return ok(this.desktopUpdates.requestLaunch(r.jobId));
      case 'updates.acknowledge':
        return ok(await this.desktopUpdates.acknowledge(r.challengeId, r.decision));
      case 'updates.drafts': {
        const { revision, dirtyCount, editorsOpen, busy } = r;
        return this.desktopUpdates.reportDrafts(this.updateDocument, r.contextId, {
          revision,
          dirtyCount,
          editorsOpen,
          busy,
        })
          ? ok(null)
          : failure('stale_session');
      }
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
          error: S.logsOpenFailed,
          retryable: false,
        };
      case 'init':
        return ok(this.state);
      case 'login':
        if (this.loggingOut)
          return {
            ok: false,
            code: 'busy',
            error: S.waitQuit,
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
    if (r.kind === 'plugins.refresh') {
      await this.pluginCatalog.refresh(true);
      await this.pluginUpdates.refresh(true);
      return !this.destroyed && r.epoch === this.api.epoch
        ? ok(this.pluginCatalog.state)
        : failure('stale_session');
    }
    if (r.kind === 'plugins.preferences') {
      if (
        (this.api.desktopConfiguration?.capabilities.plugins ?? 0) < 1 ||
        this.configEpoch !== this.api.epoch
      )
        return failure('forbidden');
      if (r.beta === true && !this.pluginCatalog.state.catalog?.tester) return failure('forbidden');
      const before = this.o.settings.get().plugins ?? {
        betaScopes: [],
        autoUpdate: true,
        notifyInstalled: true,
      };
      const scope = `${this.serverScopeHash}:${this.api.owner}`;
      const betaScopes =
        r.beta === undefined ? before.betaScopes : before.betaScopes.filter((key) => key !== scope);
      if (r.beta === true) betaScopes.push(scope);
      this.o.settings.update({
        plugins: {
          betaScopes: betaScopes.slice(-128),
          autoUpdate: r.autoUpdate ?? before.autoUpdate,
          notifyInstalled: r.notifyInstalled ?? before.notifyInstalled ?? true,
        },
      });
      this.publish();
      void this.pluginUpdates.refresh();
      return ok(null);
    }
    if (r.kind === 'plugins.install' || r.kind === 'plugins.rollback') {
      if (!this.pluginContext()) return failure('forbidden');
      // Запрос только ставит намерение в очередь; ход и итог видны на экране плагинов.
      const result = this.pluginUpdates.request(
        r.code,
        r.kind === 'plugins.install' ? 'install' : 'rollback',
      );
      if (result.accepted) return ok(null);
      return {
        ok: false,
        code: 'plugin_job_blocked',
        retryable: false,
        error:
          result.reason === 'plugin_trust_unconfigured'
            ? S.pluginInstallUnavailable
            : result.reason === 'rollback_unavailable'
              ? S.pluginRollbackUnavailable
              : S.pluginRequestFailed,
      };
    }
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
      case 'report.send':
      case 'report.retry': {
        const result =
          r.kind === 'report.send' ? await this.support.send(r.id) : await this.support.retry(r.id);
        if (!this.destroyed && r.epoch === this.api.epoch) this.publish();
        return result;
      }
      case 'report.resolve': {
        const owner = this.api.owner;
        if (
          !owner ||
          !this.support.resolve({ serverHash: this.serverScopeHash, ownerId: owner }, r.id)
        )
          return failure('busy');
        this.publish();
        return ok(null);
      }
      case 'report.fallback': {
        const owner = this.api.owner,
          bound = this.reportExportBinding;
        if (
          !owner ||
          !this.o.server ||
          !bound ||
          bound.id !== r.id ||
          bound.owner !== owner ||
          bound.epoch !== r.epoch ||
          bound.serverHash !== this.serverScopeHash ||
          !this.report.hasExport(r.id)
        )
          return failure('validation');
        const status = this.support.status(
          { serverHash: this.serverScopeHash, ownerId: owner },
          null,
          false,
          this.serverTime(),
        );
        if (status.error)
          return { ok: false, code: 'support_storage', error: status.error, retryable: false };
        if (status.attempt && ['unresolved', 'review'].includes(status.attempt.status))
          return {
            ok: false,
            code: 'support_unresolved',
            error: S.supportUnresolved,
            retryable: false,
          };
        try {
          await shell.openExternal(new URL('/?feedback=mine', this.o.server.origin).href);
        } catch {
          return {
            ok: false,
            code: 'open_error',
            error: S.feedbackOpenFailed,
            retryable: false,
          };
        }
        if (
          this.destroyed ||
          this.api.epoch !== r.epoch ||
          this.api.owner !== owner ||
          this.reportExportBinding !== bound
        )
          return failure('stale_session');
        return this.report.reveal(r.id) ? ok(null) : failure('validation');
      }
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
        return this.openTimer(r.mode, r.taskId);
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
            error: S.settingSaveFailed,
            retryable: false,
          };
        }
        if (this.reminderId) this.toasts.dismiss(this.reminderId);
        this.reminders.reset();
        // Вопрос после возврата выключен — сохранённые записи «пауза подтверждена» не нужны.
        if (r.askOnUnlock === false) {
          const scope = this.pauseScope();
          if (scope && this.pauseReturns.settleEnded(scope, () => true))
            for (const key of [...this.recoveryNotices]) {
              this.toasts.dismiss('pause-return:' + key);
              this.recoveryNotices.delete(key);
            }
        }
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
          // Сбой записи настроек не мешает принять таймер и обновить данные — только журнал.
          try {
            this.o.settings.update({
              recentTimeTaskIds: {
                ...this.o.settings.get().recentTimeTaskIds,
                [String(this.api.owner)]: ids,
              },
            });
          } catch {
            this.o.log.warn('не удалось сохранить недавние задачи');
          }
          this.rememberStartedHere(result.data);
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
  private showPluginNotices(): void {
    if (this.destroyed || !this.toasts) return;
    for (const [id, ticket] of this.pluginNoticeWindows) {
      if (!this.pluginUpdates.noticeCurrent(ticket)) {
        this.pluginNoticeWindows.delete(id);
        this.toasts.dismiss('plugins:' + id);
      }
    }
    const owner = this.api.owner;
    if (!owner) return;
    for (const ticket of this.pluginUpdates.pendingNotices()) {
      if (this.pluginNoticeWindows.has(ticket.id)) continue;
      const notice: Notice = {
        pluginUpdate: ticket,
        epoch: this.api.epoch,
        owner,
        chatId: null,
        mention: false,
        ordinary: true,
      };
      if (!this.current(notice)) continue;
      // ТЗ 5.3: «Планы этажей 1.43 · ДДУ 1.12 — установятся, когда вы закроете Revit 2025».
      const list = ticket.items.map((i) => `${i.name} ${i.version}`.trim()).join(' · ');
      const years = [...new Set(ticket.items.flatMap((i) => i.years))].sort().join(', ');
      const spec: ToastSpec = {
        id: 'plugins:' + ticket.id,
        key: ticket.id,
        groupId: 'plugin-' + ticket.type,
        title: ticket.type === 'waiting' ? S.pluginWaitingTitle : S.pluginCompleteTitle,
        body: ticket.type === 'waiting' ? S.pluginWaitingBody(list, years) : list,
        hasReply: false,
        buttons: ticket.type === 'waiting' ? [S.pluginNotesButton, S.pluginOkButton] : [],
        delayMs: 0,
      };
      this.pluginNoticeWindows.set(ticket.id, ticket);
      this.notices.set(spec, notice);
      try {
        if (this.toasts.show(spec) === false) this.pluginNoticeWindows.delete(ticket.id);
      } catch {
        this.pluginNoticeWindows.delete(ticket.id);
      }
    }
  }
  /** Вход, при котором работают плагины. Сеть для «Вернуть» и доведения операции не нужна. */
  private pluginContext(): PluginUpdaterContext | null {
    if (
      this.destroyed ||
      !this.api?.owner ||
      this.state.user?.id !== this.api.owner ||
      this.state.user.mustChangePassword ||
      this.configEpoch !== this.api.epoch ||
      (this.api.desktopConfiguration?.capabilities.plugins ?? 0) < 1 ||
      process.platform !== 'win32'
    )
      return null;
    const preferences = this.o.settings.get().plugins ?? {
      betaScopes: [],
      autoUpdate: true,
      notifyInstalled: true,
    };
    return {
      key: JSON.stringify([this.serverScopeHash, this.api.owner, this.api.epoch]),
      scope: PluginInstaller.scope(this.serverScopeHash, this.api.owner),
      automatic: preferences.autoUpdate !== false,
      beta:
        preferences.betaScopes.includes(`${this.serverScopeHash}:${this.api.owner}`) &&
        this.pluginCatalog.state.catalog?.tester === true,
      available: pluginInstallationAvailable(),
    };
  }
  private syncUpdateContext(): void {
    const fingerprint = JSON.stringify([
      this.serverScopeHash,
      this.api?.epoch,
      this.api?.owner,
      this.state?.connection,
      this.updateDocument,
    ]);
    if (fingerprint === this.updateFingerprint) return;
    this.updateFingerprint = fingerprint;
    this.updateStamp = randomUUID();
    this.trayDrafts = undefined;
    this.desktopUpdates.invalidate();
    const interruptedRead = this.updates?.state.status === 'checking';
    this.updates?.reset(true);
    if (interruptedRead)
      queueMicrotask(() => {
        if (!this.destroyed) void this.updates.check();
      });
  }
  private updateContext() {
    this.syncUpdateContext();
    return {
      stamp: this.updateStamp,
      document: this.updateDocument,
      serverOrigin: this.o.server?.origin ?? '',
    };
  }
  private traySafeForUpdate(): boolean {
    if (!this.trayWindow || this.trayWindow.isDestroyed()) return true;
    return (
      !this.trayWindow.isVisible() &&
      this.trayDrafts?.contextId === this.updateStamp &&
      this.trayDrafts.dirtyCount === 0 &&
      !this.trayDrafts.busy
    );
  }
  private publish(): void {
    this.syncScreenSaverDemand();
    this.syncUpdateContext();
    this.state.desktopUpdate = {
      ...this.desktopUpdates.state,
      contextId: this.updateStamp,
      documentId: this.updateDocument,
      installationAvailable:
        process.platform === 'win32' &&
        app.isPackaged &&
        desktopPublisherConfigured(APPROVED_DESKTOP_PUBLISHER_DER_SHA256),
    };
    this.pluginUpdates.sync();
    const pluginPreferences = this.o.settings.get().plugins ?? {
      betaScopes: [],
      autoUpdate: true,
      notifyInstalled: true,
    };
    this.state.plugins = {
      ...this.pluginCatalog.state,
      beta:
        pluginPreferences.betaScopes.includes(`${this.serverScopeHash}:${this.api?.owner}`) &&
        this.pluginCatalog.state.catalog?.tester === true,
      autoUpdate: pluginPreferences.autoUpdate,
      notifyInstalled: pluginPreferences.notifyInstalled !== false,
      workflow: structuredClone(this.pluginUpdates.state),
      managed: structuredClone(this.pluginUpdates.managed),
    };
    if (
      !this.api?.owner ||
      this.state.user?.id !== this.api.owner ||
      this.state.connection !== 'online' ||
      this.configEpoch !== this.api.epoch ||
      (this.api.desktopConfiguration?.capabilities.plugins ?? 0) < 1
    )
      this.state.plugins = {
        ...this.state.plugins,
        status: 'unavailable',
        catalog: null,
        error: null,
        beta: false,
        checkedAt: null,
      };
    if (this.support) {
      const config = this.api.desktopConfiguration,
        owner = this.api.owner;
      const available =
        !!owner &&
        this.state.connection === 'online' &&
        this.configEpoch === this.api.epoch &&
        (config?.capabilities.support ?? 0) >= 1 &&
        !!config?.supportChatId;
      this.state.reportSupport = this.support.status(
        owner ? { serverHash: this.serverScopeHash, ownerId: owner } : null,
        config?.supportChatId ?? null,
        available,
        this.serverTime(),
      );
    }
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
    this.state.themePreference = this.o.settings.get().theme;
    // Рамки окон Windows — в теме приложения (windowTheme.ts).
    const dark = applyWindowTheme(this.state.themePreference);
    this.state.theme = dark ? 'dark' : 'light';
    if (!this.o.main.win.isDestroyed()) this.o.main.win.setBackgroundColor(windowBackground(dark));
    this.sendState();
    this.renderTray();
  }
  /** Снимок окнам интерфейса; лёгкая часть publish() для частых событий («печатает…»). */
  private sendState(): void {
    if (this.destroyed) return;
    this.state.revision++;
    this.state.epoch = this.api?.epoch ?? 0;
    for (const win of [this.o.main.win, this.trayWindow])
      if (win && !win.isDestroyed() && this.peers.has(win.webContents.id))
        win.webContents.send('client:state', this.state);
  }
  /** Значок и подсказка трея перерисовываются только при смене счётчика или состояния. */
  private renderTray(): void {
    if (this.o.tray.isDestroyed()) return;
    const n = this.state.unread + this.state.notificationUnread;
    const online = this.state.connection === 'online';
    const focus = Boolean(
      this.state.focus.until && Date.parse(this.state.focus.until) > Date.now(),
    );
    const timer = this.state.timerReady && this.state.timer ? this.state.timer.state : 'idle';
    const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
    const overlay = n > 0 && Boolean(this.state.user) && this.o.main.win.isVisible();
    const key = JSON.stringify([n, online, focus, timer, dark, overlay]);
    if (key !== this.trayKey) {
      this.trayKey = key;
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
          buffer: encodePng(statusBitmap(size, dark, { count: n, online, focus, timer })),
        });
      this.o.tray.setImage(image);
      if (!this.o.main.win.isDestroyed())
        this.o.main.win.setOverlayIcon(
          overlay ? nativeImage.createFromBuffer(encodePng(badgeBitmap(n))) : null,
          S.desktopUnread(n),
        );
    }
    const signedOut = ['signedOut', 'passwordChange'].includes(this.state.connection);
    const tip = trayTooltip({
      online: online || signedOut,
      signedIn: online && Boolean(this.state.user),
      unread: n,
      timer: this.state.timerReady ? (this.state.timer ?? null) : null,
      timerObservedAt: this.state.timerObservedAt,
      focusUntil: this.state.focus.until,
    });
    if (tip !== this.trayTip) {
      this.trayTip = tip;
      this.o.tray.setToolTip(tip);
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
        error: applyAuto ? S.autostartSaveFailed : S.settingsSaveFailed,
        retryable: false,
      };
    }
    if (patch.notifications) this.toasts.clear();
    this.publish();
    return ok(this.preferences());
  }
  showMenu(bounds: Rectangle): void {
    if (desktopShutdown.locked) return;
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
      this.trayDrafts = undefined;
      guardLocal(win.webContents);
      this.peers.set(win.webContents.id, `${CLIENT_URL}?surface=tray`);
      win.on('blur', () => win.hide());
      win.once('closed', () => {
        this.peers.delete(win.webContents.id);
      });
      win.webContents.on('did-finish-load', () => this.publish());
      win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) {
          this.trayDrafts = undefined;
          this.desktopUpdates.invalidate();
        }
      });
      void win.loadFile(CLIENT_FILE, { query: { surface: 'tray' } }).then(() => {
        if (!win.isDestroyed() && !desktopShutdown.locked) {
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
    this.destroyed = true;
    this.report.clear();
    this.configuration.destroy();
    this.updates.destroy();
    this.desktopUpdates.destroy();
    this.pluginUpdates.dispose();
    this.saverPoller?.dispose();
    clearInterval(this.tick);
    clearTimeout(this.queryCancelTimer);
    clearTimeout(this.pauseRetryTimer);
    this.pluginCatalog.reset();
    this.boot++;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.onlineFallback);
    this.api.clear();
    this.realtime?.stop();
    this.login?.close();
    this.toasts.destroy();
    this.paths.destroy();
    this.files.destroy();
    this.uploads.destroy();
    this.fileSession.protocol.unhandle('schema-attachment');
    parse.onSkipped(undefined);
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
