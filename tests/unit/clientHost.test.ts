import { PauseOutbox, type PauseOutboxStorage } from '../../src/main/timer/pauseOutbox';
import { PauseReturns } from '../../src/main/timer/pauseReturns';
import { SupportLedger } from '../../src/main/diagnostics/ledger';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as pluginFs from '../../src/main/plugins/transactionFs';
import { PluginAutoHolds } from '../../src/main/plugins/autoHolds';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent, Tray } from 'electron';
import type { ApiResult, FocusState } from '../../src/shared/client';
import type { ClientSnapshot, DesktopRequest } from '../../src/shared/desktop';
import type { MainWindow } from '../../src/main/mainWindow';
import type { Settings, SettingsStore } from '../../src/main/settings';
import type { ToastSpec } from '../../src/main/notifications/types';
import type { Logger } from '../../src/main/logger';
import { requestValid } from '../../src/shared/requests';
import { timerFixture, proposalFixture, timerPushFixture } from '../fixtures/time';
import { releaseFixture } from '../fixtures/updates';
import { desktopShutdown } from '../../src/main/desktop/updateShutdown';
import { timerExpected } from '../../src/shared/time';
import { ScreenSaverObserver } from '../../src/main/desktop/screenSaverObserver';
import { PluginUpdateCoordinator } from '../../src/main/plugins/updateCoordinator';
import type { DesktopUpdateControllerOptions } from '../../src/main/desktop/updateController';

const URL = 'file:///unit/client.html';
type Handler = (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>;
const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  api: { epoch: 7, owner: 1 as number | null },
  mutation: { active: 0, revision: 0 },
  loginOpen: false,
  toastReplySurface: false,
  screenSaverRead: vi.fn(),
  readDesktopConfig: vi.fn(),
  timerPending: vi.fn(),
  timerNoticeAck: vi.fn(),
  timerValidateRows: vi.fn(),
  health: vi.fn(),
  latestRelease: vi.fn(),
  authenticate: vi.fn(),
  clear: vi.fn(),
  logout: vi.fn(),
  listChats: vi.fn(),
  detail: vi.fn(),
  messages: vi.fn(),
  send: vi.fn(),
  read: vi.fn(),
  notifications: vi.fn(),
  readNotification: vi.fn(),
  focus: vi.fn(),
  setFocus: vi.fn(),
  focusSummary: vi.fn(),
  notificationSettings: vi.fn(),
  cookiesGet: vi.fn(),
  cookiesRemove: vi.fn(),
  fetch: vi.fn(),
  loginShow: vi.fn(),
  loginClose: vi.fn(),
  pathOpen: vi.fn(),
  pathReset: vi.fn(),
  pathDestroy: vi.fn(),
  filePreview: vi.fn(),
  fileAction: vi.fn(),
  fileReset: vi.fn(),
  fileDestroy: vi.fn(),
  uploadPick: vi.fn(),
  uploadPaste: vi.fn(),
  uploadReset: vi.fn(),
  uploadDestroy: vi.fn(),
  reactions: vi.fn(),
  edit: vi.fn(),
  delete: vi.fn(),
  pin: vi.fn(),
  top: vi.fn(),
  morning: vi.fn(),
  plugins: vi.fn(),
  supportUpload: vi.fn(),
  supportSend: vi.fn(),
  desktopConfig: undefined as undefined | import('../../src/shared/desktopConfig').DesktopConfig,
  chatQuiet: undefined as number | undefined,
  realtimeStatus: undefined as undefined | ((online: boolean) => void),
  search: vi.fn(),
  objectInfo: vi.fn(),
  timer: vi.fn(),
  timeOptions: vi.fn(),
  timerStart: vi.fn(),
  timerPause: vi.fn(),
  timerResume: vi.fn(),
  timerReset: vi.fn(),
  timerProposal: vi.fn(),
  timerFinish: vi.fn(),
  toastShow: vi.fn(),
  toastDismiss: vi.fn(),
  toastUpdate: vi.fn<(id: string, body: string) => boolean>(),
  policyAllows: vi.fn(),
  idleState: vi.fn(),
  toastOptions: undefined as
    | undefined
    | {
        beforeShow: (spec: ToastSpec) => Promise<boolean>;
        onReply: (spec: ToastSpec, text: string) => Promise<{ ok: boolean }>;
        onShow: (spec: ToastSpec) => void;
        onClose: (spec: ToastSpec) => void;
        onButton: (spec: ToastSpec, index: number) => void;
        onOpen: (spec: ToastSpec) => void;
      },
  toastClear: vi.fn(),
  toastDestroy: vi.fn(),
  realtimeStart: vi.fn(),
  realtimeStop: vi.fn(),
  quit: vi.fn(),
  beep: vi.fn(),
  openExternal: vi.fn(),
  traySetImage: vi.fn(),
  applyAutostart: vi.fn(),
  openLogs: vi.fn(),
  readRevit: vi.fn(),
  setOverlayIcon: vi.fn(),
  published: [] as { channel: string; state: ClientSnapshot }[],
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const cookies = Object.assign(new EventEmitter(), { get: h.cookiesGet, remove: h.cookiesRemove });
  const ses = { cookies, fetch: h.fetch, protocol: { handle: vi.fn(), unhandle: vi.fn() } };
  return {
    app: {
      getVersion: () => '0.6.0',
      getAppPath: () => '/unit/app',
      quit: h.quit,
      getPath: (name: string) => `${process.cwd()}/private/host-profile/${name}`,
    },
    BrowserWindow: class extends EventEmitter {},
    ipcMain: {
      handle: (name: string, fn: Handler) => h.handlers.set(name, fn),
      removeHandler: (name: string) => h.handlers.delete(name),
    },
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
    nativeImage: {
      createEmpty: () => ({ addRepresentation: vi.fn() }),
      createFromBuffer: () => ({}),
    },
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: h.idleState }),
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    session: { fromPartition: () => ses },
    shell: { beep: h.beep, openExternal: h.openExternal },
  };
});
vi.mock('../../src/main/mainWindow', () => ({
  CLIENT_FILE: '/unit/client.html',
  CLIENT_URL: 'file:///unit/client.html',
  PARTITION: 'persist:teams',
  guardLocal: () => {},
}));
vi.mock('../../src/main/desktop/screenSaverState', async (original) => {
  const actual = await original<typeof import('../../src/main/desktop/screenSaverState')>();
  return {
    ...actual,
    WindowsScreenSaverReader: class {
      read = h.screenSaverRead;
      invalidate() {}
      dispose() {}
    },
  };
});
vi.mock('../../src/main/api/client', async (original) => {
  const actual = await original<typeof import('../../src/main/api/client')>();
  return {
    ...actual,
    TeamsApi: class {
      get epoch() {
        return h.api.epoch;
      }
      get owner() {
        return h.api.owner;
      }
      get mutationState() {
        return { ...h.mutation };
      }
      get desktopConfiguration() {
        return h.desktopConfig ?? { capabilities: { chatQuiet: h.chatQuiet } };
      }
      clear() {
        h.clear();
        h.api.epoch++;
        h.api.owner = null;
      }
      readDesktopConfig = h.readDesktopConfig;
      plugins = h.plugins;
      timerPending = h.timerPending;
      timerNoticeAck = h.timerNoticeAck;
      timerValidateRows = h.timerValidateRows;
      health = h.health;
      latestRelease = h.latestRelease;
      authenticate = h.authenticate;
      logout = h.logout;
      listChats = h.listChats;
      detail = h.detail;
      messages = h.messages;
      send = h.send;
      read = h.read;
      notifications = h.notifications;
      readNotification = h.readNotification;
      focus = h.focus;
      setFocus = h.setFocus;
      focusSummary = h.focusSummary;
      notificationSettings = h.notificationSettings;
      reactions = h.reactions;
      edit = h.edit;
      delete = h.delete;
      pin = h.pin;
      top = h.top;
      morning = h.morning;
      supportUpload = h.supportUpload;
      supportSend = h.supportSend;
      search = h.search;
      objectInfo = h.objectInfo;
      timer = h.timer;
      timeOptions = h.timeOptions;
      timerStart = h.timerStart;
      timerPause = h.timerPause;
      timerResume = h.timerResume;
      timerReset = h.timerReset;
      timerProposal = h.timerProposal;
      timerFinish = h.timerFinish;
    },
  };
});
vi.mock('../../src/main/loginWindow', () => ({
  LoginWindow: class {
    get open() {
      return h.loginOpen;
    }
    show = h.loginShow;
    close = h.loginClose;
  },
}));
vi.mock('../../src/main/paths/service', () => ({
  PathService: class {
    open = h.pathOpen;
    reset = h.pathReset;
    destroy = h.pathDestroy;
  },
}));
vi.mock('../../src/main/files/service', () => ({
  AttachmentService: class {
    preview = h.filePreview;
    action = h.fileAction;
    reset = h.fileReset;
    destroy = h.fileDestroy;
    response = vi.fn();
  },
}));
vi.mock('../../src/main/files/uploads', () => ({
  UploadService: class {
    pick = h.uploadPick;
    paste = h.uploadPaste;
    reset = h.uploadReset;
    destroy = h.uploadDestroy;
  },
}));
vi.mock('../../src/main/notifications/toasts', () => ({
  CustomToasts: class {
    get hasReplySurface() {
      return h.toastReplySurface;
    }
    constructor(options: NonNullable<typeof h.toastOptions>) {
      h.toastOptions = options;
    }
    show = h.toastShow;
    dismiss = h.toastDismiss;
    update = h.toastUpdate;
    clear = h.toastClear;
    destroy = h.toastDestroy;
  },
}));
vi.mock('../../src/main/desktop/notificationState', () => ({
  WindowsNotificationPolicy: class {
    allows = h.policyAllows;
  },
}));
vi.mock('../../src/main/realtime/connection', () => ({
  RealtimeClient: class {
    constructor(o: { onStatus: (online: boolean) => void }) {
      h.realtimeStatus = o.onStatus;
    }
    start = h.realtimeStart;
    stop = h.realtimeStop;
  },
}));

import { ClientHost } from '../../src/main/clientHost';
import { normalizeSettings } from '../../src/main/settings';

const hosts: ClientHost[] = [];
const updateLeases: { release(): void }[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function fixture(
  patch: Partial<Settings> = {},
  persistence?: { outbox: PauseOutbox; returns: PauseReturns },
  supportLedger?: SupportLedger,
) {
  let settings = normalizeSettings(patch);
  const settingsUpdate = vi.fn((change: Partial<Settings>) => {
    settings = normalizeSettings({ ...settings, ...change });
  });
  const frame = { url: URL };
  const wc = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: frame,
    send: (channel: string, state: ClientSnapshot) =>
      h.published.push({ channel, state: structuredClone(state) }),
  });
  const win = Object.assign(new EventEmitter(), {
    webContents: wc,
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    isDestroyed: () => false,
    show: vi.fn(),
    hide: vi.fn(),
    setOverlayIcon: h.setOverlayIcon,
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const memory = (): PauseOutboxStorage => {
    let text: string | null = null;
    return {
      read: () => text,
      replace: (next) => {
        text = next;
      },
    };
  };
  const host: ClientHost = new ClientHost({
    supportPersistence: supportLedger ?? new SupportLedger(memory()),
    pausePersistence: persistence ?? {
      outbox: new PauseOutbox('fixture-outbox', {
        storage: memory(),
        now: () => (host as unknown as { serverTime: () => number }).serverTime(),
      }),
      returns: new PauseReturns('fixture-returns', memory()),
    },
    main: { win, show: vi.fn() } as unknown as MainWindow,
    server: new globalThis.URL('https://example.test/'),
    settings: { get: () => settings, update: settingsUpdate } as unknown as SettingsStore,
    log: log as unknown as Logger,
    applyAutostart: h.applyAutostart,
    autostartAvailable: true,
    openLogs: h.openLogs,
    readRevit: h.readRevit,
    tray: {
      isDestroyed: () => false,
      setToolTip: vi.fn(),
      setImage: h.traySetImage,
    } as unknown as Tray,
  });
  hosts.push(host);
  const owned = host as unknown as { state: ClientSnapshot; authCookie: string | null };
  // Existing IPC fixtures start with a known stopped detector. T3 cases below
  // explicitly invalidate it and control the actual asynchronous poller reader.
  const saver = (
    host as unknown as {
      saver: import('../../src/main/desktop/screenSaverObserver').ScreenSaverObserver;
    }
  ).saver;
  saver.sample({ state: 'stopped', observedMono: performance.now() }, saver.token);
  owned.state.user = { id: 1, shortName: 'Тест', mustChangePassword: false };
  owned.state.connection = 'online';
  owned.state.timerControl = true;
  owned.state.timerReady = true;
  owned.state.epoch = h.api.epoch;
  (host as unknown as { configEpoch: number; timerEpoch: number }).configEpoch = h.api.epoch;
  (host as unknown as { configEpoch: number; timerEpoch: number }).timerEpoch = h.api.epoch;
  owned.authCookie = 'cookie-A';
  const event = { sender: wc, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const invoke = async (request: DesktopRequest) => {
    const handle = h.handlers.get('client:request');
    if (!handle) throw new Error('IPC handler missing');
    return (await handle(event, request)) as ApiResult<unknown>;
  };
  return {
    host,
    win,
    invoke,
    state: owned.state,
    owned,
    settingsUpdate,
    getSettings: () => settings,
    log,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 29, 9));
  vi.resetAllMocks();
  h.handlers.clear();
  h.published.length = 0;
  h.api.epoch = 7;
  h.api.owner = 1;
  h.mutation = { active: 0, revision: 0 };
  h.loginOpen = false;
  h.toastReplySurface = false;
  h.chatQuiet = undefined;
  h.desktopConfig = undefined;
  // Не запускаем bootstrap/сокет: эти тесты проверяют только маршрутизацию
  // настоящего IPC handler при управляемых поколениях API и cookie jar.
  h.health.mockImplementation(() => new Promise(() => {}));
  h.latestRelease.mockResolvedValue({ ok: true, data: null });
  h.cookiesGet.mockResolvedValue([{ name: 'st_session', value: 'cookie-A' }]);
  h.cookiesRemove.mockResolvedValue(undefined);
  h.logout.mockImplementation(async () => {
    h.api.epoch++;
    h.api.owner = null;
    return { ok: true, data: null };
  });
  h.read.mockResolvedValue({ ok: true, data: null });
  h.send.mockResolvedValue({ ok: true, data: null });
  h.setFocus.mockResolvedValue({ ok: true, data: { until: null, startedAt: null } });
  h.pathOpen.mockResolvedValue('ok');
  h.openLogs.mockResolvedValue('');
  h.toastOptions = undefined;
  h.policyAllows.mockResolvedValue(true);
  h.idleState.mockReturnValue('active');
  h.notificationSettings.mockResolvedValue({
    ok: true,
    data: { rows: [], digestHourly: false, quiet: null },
  });
  h.timer.mockResolvedValue({ ok: true, data: null });
  h.screenSaverRead.mockImplementation(async () => ({
    state: 'stopped',
    observedMono: performance.now(),
  }));
});
afterEach(() => {
  for (const lease of updateLeases.splice(0)) lease.release();
  for (const host of hosts.splice(0)) host.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('T3 screensaver integration — synthetic samples, no real OS transitions', () => {
  type Control = {
    saver: import('../../src/main/desktop/screenSaverObserver').ScreenSaverObserver;
    screenSaverBinding(): string;
    acceptScreenSaver(
      sample: import('../../src/main/desktop/screenSaverState').ScreenSaverSample,
      context: { token: number; binding: string },
    ): void;
    pauseOutbox: PauseOutbox;
    pauseReturns: PauseReturns;
    pauseScope(): import('../../src/main/timer/pauseOutbox').PauseScope;
    observeServerTime(time: string): void;
    publish(): void;
    lock(): void;
    unlock(): void;
    sleep(): void;
    wake(): void;
    showPauseReturn(): void;
  };
  const control = (f: ReturnType<typeof fixture>) => f.host as unknown as Control;
  const ticket = (c: Control) => ({ token: c.saver.token, binding: c.screenSaverBinding() });
  const sample = (c: Control, state: 'running' | 'stopped' | 'unknown') =>
    c.acceptScreenSaver({ state, observedMono: performance.now() }, ticket(c));
  function setup() {
    h.screenSaverRead.mockImplementation(() => new Promise(() => {}));
    const f = fixture(),
      c = control(f);
    f.state.timer = timerFixture();
    f.state.connection = 'offline';
    c.observeServerTime(f.state.timer.serverNow);
    c.publish();
    sample(c, 'stopped');
    return { f, c };
  }
  function confirmed(c: Control, f: ReturnType<typeof fixture>) {
    const scope = c.pauseScope(),
      r = c.pauseOutbox.list(scope)[0];
    if (!r) throw Error('capture missing');
    const timer = {
      ...timerFixture('pause'),
      pauseReason: 'lock' as const,
      segments: [{ from: required(r.expected.currentSegmentFrom), to: r.at }],
    };
    f.state.timer = timer;
    c.pauseReturns.put({
      ...scope,
      key: r.key,
      at: r.at,
      expected: timerExpected(timer),
      returnedAt: null,
      returnKind: null,
      delivery: 'pending',
    });
    return { scope, r };
  }
  it('completion-time calibration is used once, wall clock rollback and repeat samples preserve exact envelope', async () => {
    const { f, c } = setup();
    const initial = Date.parse(required(f.state.timer).serverNow);
    await vi.advanceTimersByTimeAsync(700);
    vi.setSystemTime(new Date(2020, 0, 1));
    sample(c, 'running');
    const r = c.pauseOutbox.list(c.pauseScope())[0];
    expect(r?.eventKind).toBe('screensaver');
    expect(Date.parse(required(r).at)).toBe(initial + 700);
    sample(c, 'running');
    c.lock();
    c.sleep();
    expect(c.pauseOutbox.list(c.pauseScope())).toEqual([r]);
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(h.timerResume).not.toHaveBeenCalled();
  });
  it.each(['timer', 'owner', 'epoch', 'config', 'lock', 'suspend'] as const)(
    'rejects a pending A sample after %s changed',
    (change) => {
      const { f, c } = setup(),
        old = ticket(c);
      if (change === 'timer') f.state.timer = { ...timerFixture(), timerId: 999 };
      if (change === 'owner') {
        h.api.owner = 2;
        required(f.state.user).id = 2;
      }
      if (change === 'epoch') h.api.epoch++;
      if (change === 'config') (c as unknown as { configEpoch: number }).configEpoch = -1;
      if (change === 'lock') c.lock();
      if (change === 'suspend') c.sleep();
      const prior = c.pauseOutbox.list(c.pauseScope());
      c.acceptScreenSaver({ state: 'running', observedMono: performance.now() }, old);
      expect(c.pauseOutbox.list(c.pauseScope())).toEqual(prior);
      expect(h.timerPause).not.toHaveBeenCalled();
    },
  );
  it('fresh sample can capture running B even while an earlier absence latch is open', () => {
    const { f, c } = setup();
    sample(c, 'running');
    f.state.timer = { ...timerFixture(), timerId: 999 };
    sample(c, 'running');
    expect(c.pauseOutbox.list(c.pauseScope()).map((r) => r.expected.timerId)).toEqual([71, 999]);
  });
  it.each(['capability', 'owner', 'logout'] as const)(
    'keeps read-only clearing demand after %s loss, without timer writes',
    (change) => {
      const { f, c } = setup();
      sample(c, 'running');
      const scope = c.pauseScope(),
        prior = c.pauseOutbox.list(scope);
      if (change === 'capability') f.state.timerControl = false;
      if (change === 'owner') {
        h.api.owner = 2;
        required(f.state.user).id = 2;
        f.state.timerControl = false;
      }
      if (change === 'logout') {
        h.api.owner = null;
        f.state.user = null;
        f.state.timerControl = false;
      }
      c.publish();
      expect((c as unknown as { saverActive: boolean }).saverActive).toBe(true);
      sample(c, 'stopped');
      expect(c.saver.absent).toBe(false);
      expect(c.pauseOutbox.list(scope)).toEqual(prior);
      expect(h.timerPause).not.toHaveBeenCalled();
      expect(h.timerResume).not.toHaveBeenCalled();
      if (change !== 'logout') {
        f.state.connection = 'online';
        const notice = {
          epoch: h.api.epoch,
          owner: h.api.owner,
          chatId: null,
          mention: false,
          ordinary: true,
        };
        expect((c as unknown as { current: (n: unknown) => boolean }).current(notice)).toBe(true);
      }
    },
  );
  it.each(['saver-lock', 'lock-saver', 'sleep-saver'] as const)(
    'records return only after every layer clears: %s',
    async (order) => {
      const { f, c } = setup();
      sample(c, 'running');
      const { scope } = confirmed(c, f);
      if (order === 'saver-lock') {
        c.lock();
        sample(c, 'stopped');
        expect(c.pauseReturns.list(scope)[0]?.returnedAt).toBeNull();
        c.unlock();
      }
      if (order === 'lock-saver') {
        c.lock();
        c.unlock();
        expect(c.pauseReturns.list(scope)[0]?.returnedAt).toBeNull();
        sample(c, 'unknown');
        expect(c.saver.returnAllowed).toBe(false);
        sample(c, 'stopped');
      }
      if (order === 'sleep-saver') {
        c.sleep();
        c.wake();
        c.observeServerTime(timerFixture().serverNow);
        c.lock();
        sample(c, 'stopped');
        expect(c.pauseReturns.list(scope)[0]?.returnedAt).toBeNull();
        c.unlock();
      }
      const r = c.pauseReturns.list(scope)[0];
      expect(r?.returnedAt).not.toBeNull();
      const boundary = r?.returnedAt;
      c.observeServerTime(new Date(Date.parse(timerFixture().serverNow) + 1000).toISOString());
      sample(c, 'stopped');
      c.unlock();
      expect(c.pauseReturns.list(scope)[0]?.returnedAt).toBe(boundary);
      expect(h.timerResume).not.toHaveBeenCalled();
    },
  );
  it('stale calibration creates no invented pause and leaves an existing visible review', async () => {
    const { f, c } = setup();
    const mono = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 120001);
    sample(c, 'running');
    mono.mockRestore();
    expect(c.pauseOutbox.list(c.pauseScope())).toEqual([]);
    expect(f.state.timerAbsence?.message).toContain('Проверьте время вручную');
    expect(h.timerPause).not.toHaveBeenCalled();
  });
  it('sleep invalidation cannot be refreshed by an old timer payload through another explicit event', () => {
    const { f, c } = setup();
    c.sleep();
    const scope = c.pauseScope(),
      original = c.pauseOutbox.list(scope);
    c.wake();
    c.lock();
    c.unlock();
    sample(c, 'stopped');
    expect((c as unknown as { serverTime: () => number }).serverTime()).toBeNaN();
    expect(c.pauseOutbox.list(scope)).toEqual(original);
    expect(h.toastShow).not.toHaveBeenCalled();
    sample(c, 'running');
    expect(c.pauseOutbox.list(scope)).toEqual(original);
    c.observeServerTime(
      new Date(Date.parse(required(f.state.timer).serverNow) + 60000).toISOString(),
    );
    expect(Number.isFinite((c as unknown as { serverTime: () => number }).serverTime())).toBe(true);
    sample(c, 'stopped');
    expect(h.timerResume).not.toHaveBeenCalled();
  });
  it('newly observed stopped after restart requires fresh evidence and is labelled connection, not a fabricated unlock', () => {
    const { f, c } = setup();
    sample(c, 'running');
    const { scope } = confirmed(c, f);
    const observer = new ScreenSaverObserver();
    (c as unknown as { saver: ScreenSaverObserver }).saver = observer;
    f.state.connection = 'online';
    c.showPauseReturn();
    expect(h.toastShow).not.toHaveBeenCalled();
    sample(c, 'unknown');
    expect(h.toastShow).not.toHaveBeenCalled();
    sample(c, 'stopped');
    expect(c.pauseReturns.list(scope)[0]?.returnKind).toBe('connection');
    expect(h.toastShow.mock.calls.at(-1)?.[0].body).toContain('Снова подключились');
  });
  it('new saver during an awaited OS policy rejects the popup and its shown/actions', async () => {
    const { f, c } = setup();
    sample(c, 'running');
    const { scope } = confirmed(c, f);
    f.state.connection = 'online';
    sample(c, 'stopped');
    const spec = h.toastShow.mock.calls.at(-1)?.[0] as ToastSpec;
    expect(spec).toBeTruthy();
    const policy = deferred<boolean>(),
      entered = deferred<boolean>();
    h.policyAllows.mockImplementationOnce(() => {
      entered.resolve(true);
      return policy.promise;
    });
    const showing = required(h.toastOptions).beforeShow(spec);
    await entered.promise;
    sample(c, 'running');
    policy.resolve(true);
    expect(await showing).toBe(false);
    required(h.toastOptions).onShow(spec);
    required(h.toastOptions).onButton(spec, 0);
    expect(c.pauseReturns.list(scope)[0]?.delivery).toBe('pending');
    expect(h.timerResume).not.toHaveBeenCalled();
  });
  it('actual asynchronous poller captures ticket before read and ignores stale timer before publishing', async () => {
    const held = deferred<import('../../src/main/desktop/screenSaverState').ScreenSaverSample>();
    h.screenSaverRead
      .mockReturnValueOnce(held.promise)
      .mockImplementation(() => new Promise(() => {}));
    const f = fixture(),
      c = control(f);
    f.state.timer = timerFixture();
    f.state.connection = 'offline';
    c.observeServerTime(f.state.timer.serverNow);
    c.publish();
    expect(h.screenSaverRead).toHaveBeenCalledOnce();
    f.state.timer = { ...timerFixture(), timerId: 999 };
    held.resolve({ state: 'running', observedMono: performance.now() });
    await vi.advanceTimersByTimeAsync(1);
    expect(c.pauseOutbox.list(c.pauseScope())).toEqual([]);
    expect(h.timerPause).not.toHaveBeenCalled();
  });
});

describe('Host updater boundaries use real IPC and the global shutdown lease', () => {
  function updater(f: ReturnType<typeof fixture>) {
    return f.host as unknown as {
      desktopUpdates: { o: DesktopUpdateControllerOptions };
      pending: Map<number, number>;
      pauseFlight: boolean;
      updateContext: () => { stamp: string; document: string };
      publish: () => void;
      flushAbsencePause: () => Promise<void>;
      openTimer: (mode: 'finish') => unknown;
      trayWindow?: {
        isDestroyed(): boolean;
        isVisible(): boolean;
        destroy(): void;
        webContents: { id: number };
      };
      trayDrafts?: { contextId: string; revision: number; dirtyCount: number; busy: boolean };
    };
  }
  it('a direct IPC mutation, timer form and tray opening are blocked during the global lease', async () => {
    const f = fixture(),
      host = updater(f),
      before = f.state.navigateTimer;
    const lease = desktopShutdown.acquire(() => true);
    if (!lease) throw Error('missing lease');
    updateLeases.push(lease);
    expect(
      await f.invoke({
        kind: 'chat.send',
        epoch: 7,
        chatId: 4,
        text: 'text',
        fileIds: [],
        requestId: 'request-1234',
      }),
    ).toMatchObject({ code: 'update_in_progress' });
    expect(await f.invoke({ kind: 'settings.open', tab: 'about' })).toMatchObject({
      code: 'update_in_progress',
    });
    expect(host.openTimer('finish')).toMatchObject({ code: 'update_in_progress' });
    expect(f.state.navigateTimer).toBe(before);
    expect(h.send).not.toHaveBeenCalled();
    f.host.showMenu({ x: 0, y: 0, width: 1, height: 1 });
    expect(host.trayWindow).toBeUndefined();
    expect((await f.invoke({ kind: 'init' })).ok).toBe(true);
  });
  it('a durable pause flush leaves the outbox and API untouched during an update', async () => {
    const f = fixture(),
      host = updater(f);
    const lease = desktopShutdown.acquire(() => true);
    if (!lease) throw Error('missing lease');
    updateLeases.push(lease);
    const outbox = (f.host as unknown as { pauseOutbox: PauseOutbox }).pauseOutbox;
    const replay = vi.spyOn(outbox, 'replay'),
      settle = vi.spyOn(outbox, 'settle');
    await host.flushAbsencePause();
    expect(replay).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(h.timerPause).not.toHaveBeenCalled();
  });
  it('quiescence checks prior IPC, API mutations, pause flight and an open login, then guards future revisions', () => {
    const f = fixture(),
      host = updater(f),
      acquire = host.desktopUpdates.o.acquireQuiescence;
    host.pending.set(1, 2);
    expect(acquire()).toBeNull();
    host.pending.clear();
    h.mutation.active = 1;
    expect(acquire()).toBeNull();
    h.mutation.active = 0;
    host.pauseFlight = true;
    expect(acquire()).toBeNull();
    host.pauseFlight = false;
    h.loginOpen = true;
    expect(acquire()).toBeNull();
    h.loginOpen = false;
    h.toastReplySurface = true;
    expect(acquire()).toBeNull();
    h.toastReplySurface = false;
    const lease = acquire();
    if (!lease) throw Error('missing lease');
    updateLeases.push(lease);
    expect(lease.current()).toBe(true);
    h.mutation.revision++;
    expect(lease.current()).toBe(false);
    expect(desktopShutdown.locked).toBe(true);
  });
  it('background plugin work blocks launch and ACK; waiting alone releases the slot, and a held Desktop lease denies plugin work', async () => {
    const f = fixture(),
      host = updater(f);
    const plugins = f.host as unknown as {
      pluginMaintenance: boolean;
      pluginJobs: { busy: boolean };
      pluginUpdates: { busy: boolean; o: { mayRun(): boolean }; state: { pending: number } };
    };
    const active = vi.spyOn(plugins.pluginUpdates, 'busy', 'get').mockReturnValue(true);
    expect(host.desktopUpdates.o.acquireQuiescence()).toBeNull();
    expect(
      await f.invoke({ kind: 'updates.requestLaunch', jobId: host.updateContext().stamp }),
    ).toMatchObject({ code: 'update_busy' });
    active.mockReturnValue(false);
    const core = vi.spyOn(plugins.pluginJobs, 'busy', 'get').mockReturnValue(true);
    expect(host.desktopUpdates.o.acquireQuiescence()).toBeNull();
    core.mockReturnValue(false);
    plugins.pluginMaintenance = true;
    expect(host.desktopUpdates.o.acquireQuiescence()).toBeNull();
    plugins.pluginMaintenance = false;
    plugins.pluginUpdates.state.pending = 2;
    const lease = host.desktopUpdates.o.acquireQuiescence();
    if (!lease) throw Error('waiting-only must be quiescent');
    updateLeases.push(lease);
    expect(plugins.pluginUpdates.o.mayRun()).toBe(false);
    lease.release();
    expect(plugins.pluginUpdates.o.mayRun()).toBe(true);
  });
  it('an unknown, visible, dirty or busy tray blocks; a freshly reported clean hidden tray permits acquisition', () => {
    const f = fixture(),
      host = updater(f);
    let visible = false;
    host.trayWindow = {
      isDestroyed: () => false,
      isVisible: () => visible,
      destroy: () => {},
      webContents: { id: 2 },
    };
    const acquire = host.desktopUpdates.o.acquireQuiescence;
    expect(acquire()).toBeNull();
    const contextId = host.updateContext().stamp;
    host.trayDrafts = { contextId, revision: 1, dirtyCount: 1, busy: false };
    expect(acquire()).toBeNull();
    host.trayDrafts.dirtyCount = 0;
    host.trayDrafts.busy = true;
    expect(acquire()).toBeNull();
    host.trayDrafts.busy = false;
    visible = true;
    expect(acquire()).toBeNull();
    visible = false;
    const lease = acquire();
    if (!lease) throw Error('missing lease');
    updateLeases.push(lease);
    expect(lease.current()).toBe(true);
    host.trayDrafts.dirtyCount = 1;
    expect(lease.current()).toBe(false);
    host.trayWindow = undefined;
  });
  it('main reload and owner changes invalidate old opaque report tokens', async () => {
    const f = fixture(),
      host = updater(f),
      a = host.updateContext();
    expect(
      await f.invoke({
        kind: 'updates.drafts',
        contextId: a.stamp,
        revision: 0,
        dirtyCount: 0,
        editorsOpen: 0,
        busy: false,
      }),
    ).toEqual({ ok: true, data: null });
    f.win.webContents.emit('did-start-navigation', {}, URL, false, true);
    const b = host.updateContext();
    expect(b.stamp).not.toBe(a.stamp);
    expect(b.document).not.toBe(a.document);
    expect(
      await f.invoke({
        kind: 'updates.drafts',
        contextId: a.stamp,
        revision: 1,
        dirtyCount: 0,
        editorsOpen: 0,
        busy: false,
      }),
    ).toMatchObject({ code: 'stale_session' });
    h.api.epoch++;
    host.publish();
    expect(host.updateContext().stamp).not.toBe(b.stamp);
  });
  it('main cannot forge a tray summary and unknown offer IDs do not fetch an installer', async () => {
    const f = fixture(),
      host = updater(f),
      contextId = host.updateContext().stamp;
    expect(
      await f.invoke({
        kind: 'updates.trayDrafts',
        contextId,
        revision: 0,
        dirtyCount: 0,
        busy: false,
      }),
    ).toMatchObject({ code: 'forbidden' });
    expect((await f.invoke({ kind: 'updates.prepare', offerId: contextId })).ok).toBe(true);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });
  it('a pending reply popup blocks before confirmation and late OS policy cannot show under a lease', async () => {
    vi.setSystemTime(new Date(2026, 9, 29, 18, 30));
    const f = fixture();
    const host = f.host as unknown as {
      acceptTimer: (t: ReturnType<typeof timerFixture>) => void;
      updateContext: () => { stamp: string };
    };
    host.acceptTimer(timerFixture());
    const spec = required(h.toastShow.mock.calls[0])[0] as ToastSpec;
    h.toastReplySurface = true;
    expect(
      await f.invoke({ kind: 'updates.requestLaunch', jobId: host.updateContext().stamp }),
    ).toMatchObject({ code: 'update_busy' });
    h.toastReplySurface = false;
    const delayed = deferred<boolean>();
    h.policyAllows.mockReturnValueOnce(delayed.promise);
    const check = required(h.toastOptions).beforeShow(spec);
    const lease = desktopShutdown.acquire(() => true);
    if (!lease) throw Error('missing lease');
    updateLeases.push(lease);
    delayed.resolve(true);
    expect(await check).toBe(false);
    expect(await required(h.toastOptions).onReply(spec, 'private draft')).toMatchObject({
      ok: false,
    });
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('ClientHost: поколение входа проверяется в доверенном main-frame IPC', () => {
  it('logs connection transitions once, not on every state refresh', () => {
    const f = fixture(),
      host = f.host as unknown as { publish: () => void };
    f.log.info.mockClear();
    host.publish();
    host.publish();
    f.state.connection = 'offline';
    host.publish();
    host.publish();
    f.state.connection = 'online';
    host.publish();
    expect(
      f.log.info.mock.calls.filter((c) => c[0] === 'состояние соединения').map((c) => c[1]),
    ).toEqual([{ state: 'online' }, { state: 'offline' }, { state: 'online' }]);
  });
  it('logs timer, typing and presence kinds before their special branches, without payload fields', () => {
    const f = fixture(),
      host = f.host as unknown as { event: (name: string, data: unknown) => void };
    f.log.info.mockClear();
    host.event('time:timer', { timer: timerFixture() });
    host.event('chat:typing', {
      chatId: 4,
      userId: 2,
      shortName: 'private name',
      text: 'private text',
    });
    host.event('chat:presence', { name: 'private name' });
    expect(
      f.log.info.mock.calls.filter((c) => c[0] === 'событие клиента').map((c) => c[1]),
    ).toEqual([{ event: 'time:timer' }, { event: 'chat:typing' }, { event: 'chat:presence' }]);
    expect(JSON.stringify(f.log.info.mock.calls)).not.toContain('private');
  });
  it('local report works before login, returns no authentication data and discards proofs on logout', async () => {
    const f = fixture();
    f.owned.state.user = null;
    f.owned.state.connection = 'signedOut';
    expect(await f.invoke({ kind: 'report.open' })).toEqual({ ok: true, data: null });
    expect(f.owned.state.navigateReport).toBe(1);
    const preview = await f.invoke({
      kind: 'report.prepare',
      options: {
        description: 'Проблема входа',
        applicationLogs: false,
        revitYear: null,
        includeScreenshot: false,
      },
    });
    expect(preview.ok).toBe(true);
    expect(JSON.stringify(preview)).not.toMatch(/cookie-A|https:|persist:/);
    const id = (preview as { ok: true; data: { id: string } }).data.id;
    f.owned.state.user = { id: 1, shortName: 'Тест', mustChangePassword: false };
    f.owned.state.connection = 'online';
    await f.invoke({ kind: 'logout', epoch: 7 });
    expect(await f.invoke({ kind: 'report.export', id })).toMatchObject({
      ok: false,
      code: 'report_error',
    });
  });
  it('report capture failure exposes only a fixed message, never native details', async () => {
    const f = fixture();
    const result = await f.invoke({ kind: 'report.capture', target: { type: 'window' } });
    expect(result).toMatchObject({
      ok: false,
      code: 'report_error',
      error: 'Не удалось сделать снимок. Выберите источник и повторите.',
    });
  });
  it('setup completes atomically with autostart only after a fresh compatible health read', async () => {
    const f = fixture();
    h.readDesktopConfig.mockResolvedValue({
      ok: true,
      data: {
        bureau: { timeZone: 'Asia/Yekaterinburg', workEnd: '18:00' },
        capabilities: { timerControl: 2 },
      },
    });
    h.timerPending.mockResolvedValue({ ok: true, data: null });
    h.health.mockResolvedValueOnce({
      ok: true,
      data: { status: 'ok', db: 'ok', version: '0.11.2-b' },
    });
    expect(await f.invoke({ kind: 'setup.finish', epoch: 7, autostart: false })).toEqual({
      ok: true,
      data: null,
    });
    expect(f.settingsUpdate).toHaveBeenCalledExactlyOnceWith({
      onboardingComplete: true,
      autostart: false,
    });
    expect(f.getSettings().onboardingComplete).toBe(true);
    expect(h.applyAutostart).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.owned.state.setupRequired).toBe(false);
  });
  it('setup cannot complete while signed out or offline', async () => {
    const f = fixture();
    f.owned.state.connection = 'offline';
    expect((await f.invoke({ kind: 'setup.finish', epoch: 7, autostart: true })).ok).toBe(false);
    f.owned.state.connection = 'signedOut';
    h.api.owner = null;
    f.owned.state.user = null;
    expect((await f.invoke({ kind: 'setup.finish', epoch: 7, autostart: true })).ok).toBe(false);
    expect(f.settingsUpdate).not.toHaveBeenCalled();
  });
  it('failed setup persistence rolls back startup to off for an unfinished new profile', async () => {
    const f = fixture();
    h.health.mockResolvedValueOnce({
      ok: true,
      data: { status: 'ok', db: 'ok', version: '0.11.2' },
    });
    f.settingsUpdate.mockImplementationOnce(() => {
      throw Error('private');
    });
    expect(await f.invoke({ kind: 'setup.finish', epoch: 7, autostart: true })).toMatchObject({
      ok: false,
      code: 'settings_error',
    });
    expect(f.getSettings().onboardingComplete).toBe(false);
    expect(h.applyAutostart.mock.calls).toEqual([[true], [false]]);
  });
  it('late setup completion after another login does not mark the device configured', async () => {
    const f = fixture(),
      pendingHealth = deferred<ApiResult<{ status: 'ok'; db: 'ok'; version: string }>>();
    h.health.mockReturnValueOnce(pendingHealth.promise);
    const pending = f.invoke({ kind: 'setup.finish', epoch: 7, autostart: true });
    h.api.epoch++;
    h.api.owner = 2;
    pendingHealth.resolve({ ok: true, data: { status: 'ok', db: 'ok', version: '0.11.2' } });
    expect(await pending).toMatchObject({ ok: false, code: 'stale_session' });
    expect(f.settingsUpdate).not.toHaveBeenCalled();
  });
  it('setup inventory is read-only and unavailable details never expose local paths', async () => {
    const f = fixture();
    h.api.owner = null;
    f.owned.state.user = null;
    h.readRevit.mockRejectedValueOnce(Error('private-path'));
    expect(JSON.stringify(await f.invoke({ kind: 'setup.inventory' }))).not.toContain(
      'private-path',
    );
    h.readRevit.mockResolvedValueOnce({ checkedAt: Date.now(), years: [] });
    expect(await f.invoke({ kind: 'setup.inventory' })).toMatchObject({
      ok: true,
      data: { years: [] },
    });
    expect(f.settingsUpdate).not.toHaveBeenCalled();
  });
  it('incompatible health blocks setup completion without changing startup', async () => {
    const f = fixture();
    h.health.mockResolvedValueOnce({
      ok: true,
      data: { status: 'ok', db: 'ok', version: '0.10.0' },
    });
    expect((await f.invoke({ kind: 'setup.finish', epoch: 7, autostart: true })).ok).toBe(false);
    expect(f.settingsUpdate).not.toHaveBeenCalled();
    expect(h.applyAutostart).not.toHaveBeenCalled();
  });
  it('public update check is device-scoped, returns only safe metadata and dismisses the shown version', async () => {
    const { invoke, owned } = fixture();
    h.api.owner = null;
    owned.state.user = null;
    owned.state.connection = 'signedOut';
    h.latestRelease.mockResolvedValue({ ok: true, data: releaseFixture() });
    const result = await invoke({ kind: 'updates.check' });
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'available', available: { version: '1.1.0' } },
    });
    expect(JSON.stringify(result)).not.toMatch(/sha256|Setup|\/api\/desktop\/files/);
    expect(await invoke({ kind: 'updates.later', version: '0.1.0' })).toMatchObject({
      ok: false,
      code: 'validation',
    });
    expect(await invoke({ kind: 'updates.later', version: '1.1.0' })).toEqual({
      ok: true,
      data: null,
    });
    expect(owned.state.updates?.dismissedVersion).toBe('1.1.0');
  });
  it('local settings expose a projection and work signed out, preserving timer/history', async () => {
    const { invoke, owned, getSettings } = fixture({
      serverUrl: 'https://private.example.test',
      timer: { pauseOnLock: false, askOnUnlock: false, reminderTime: '19:00' },
      recentTimeTaskIds: { '1': [21] },
    });
    h.api.owner = null;
    owned.state.user = null;
    owned.state.connection = 'signedOut';
    expect(await invoke({ kind: 'settings.read' })).toEqual({
      ok: true,
      data: {
        autostart: true,
        autostartAvailable: true,
        theme: 'system',
        notifications: { enabled: true, sound: true, preview: true, morning: true },
      },
    });
    const result = await invoke({
      kind: 'settings.patch',
      patch: { notifications: { sound: false } },
    });
    expect(result.ok).toBe(true);
    expect(getSettings().notifications).toEqual({
      enabled: true,
      sound: false,
      preview: true,
      morning: true,
    });
    expect(getSettings().timer.reminderTime).toBe('19:00');
    expect(getSettings().recentTimeTaskIds).toEqual({ '1': [21] });
    expect(JSON.stringify(result)).not.toContain('private.example.test');
    expect(h.toastClear).toHaveBeenCalled();
  });
  it('settings save failure rolls back the autostart backend and never reports success', async () => {
    const { invoke, settingsUpdate, getSettings } = fixture();
    settingsUpdate.mockImplementationOnce(() => {
      throw Error('private path');
    });
    expect(await invoke({ kind: 'settings.patch', patch: { autostart: false } })).toMatchObject({
      ok: false,
      code: 'settings_error',
    });
    expect(h.applyAutostart.mock.calls).toEqual([[false], [true]]);
    expect(getSettings().autostart).toBe(true);
  });
  it('autostart backend error leaves saved settings untouched', async () => {
    const { invoke, settingsUpdate } = fixture();
    h.applyAutostart.mockImplementationOnce(() => {
      throw Error('private OS error');
    });
    const result = await invoke({ kind: 'settings.patch', patch: { autostart: false } });
    expect(result).toMatchObject({ ok: false, code: 'settings_error' });
    expect(settingsUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private OS error');
  });
  it('logs open uses the fixed main callback, reports failure without paths', async () => {
    const { invoke } = fixture();
    expect(await invoke({ kind: 'logs.open' })).toEqual({ ok: true, data: null });
    h.openLogs.mockResolvedValueOnce('C:/private/path inaccessible');
    const result = await invoke({ kind: 'logs.open' });
    expect(result).toMatchObject({ ok: false, code: 'logs_error' });
    expect(JSON.stringify(result)).not.toContain('private/path');
    expect(h.openLogs).toHaveBeenCalledTimes(2);
  });
  it('personal-task reminder has no empty mark separator', () => {
    vi.setSystemTime(new Date(2026, 9, 29, 18, 30));
    const { host } = fixture();
    (
      host as unknown as { acceptTimer: (timer: ReturnType<typeof timerFixture>) => void }
    ).acceptTimer(timerFixture('run', 23));
    expect((h.toastShow.mock.calls[0]?.[0] as ToastSpec).body).toMatch(/^Обучение\n/);
  });
  it('reminder appears only after policy permits; shown day persists and finish button only opens review', async () => {
    vi.setSystemTime(new Date(2026, 9, 29, 18, 30));
    const { host, owned, getSettings } = fixture();
    (
      host as unknown as { acceptTimer: (timer: ReturnType<typeof timerFixture>) => void }
    ).acceptTimer(timerFixture());
    const spec = h.toastShow.mock.calls[0]?.[0] as ToastSpec;
    expect(spec).toMatchObject({
      title: 'Таймер ещё идёт',
      hasReply: false,
      buttons: ['■ Закончить работу', 'Ещё работаю'],
    });
    if (!h.toastOptions) throw Error('Missing toast callbacks');
    expect(await h.toastOptions.beforeShow(spec)).toBe(true);
    expect(getSettings().timerReminderSeen).toEqual({});
    h.toastOptions.onShow(spec);
    expect(getSettings().timerReminderSeen).toEqual({ '1': '2026-10-29' });
    h.toastOptions.onButton(spec, 0);
    expect(owned.state.navigateTimer?.mode).toBe('finish');
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(h.timerFinish).not.toHaveBeenCalled();
    expect(h.beep).toHaveBeenCalledTimes(1);
    (host as unknown as { checkReminder: () => void }).checkReminder();
    expect(h.toastShow).toHaveBeenCalledTimes(1);
  });
  it.each(['dnd', 'locked', 'quiet'] as const)(
    'suppressed reminder %s does not consume shown day or play sound',
    async (reason) => {
      vi.setSystemTime(new Date(2026, 9, 29, 18, 30));
      const { host, getSettings, state } = fixture();
      if (reason === 'dnd') h.policyAllows.mockResolvedValue(false);
      if (reason === 'locked') h.idleState.mockReturnValue('locked');
      // С 05.11.2026 неизвестный пояс бюро не гасит уведомление (fail-open), поэтому
      // тишина задаётся явно: известный пояс и интервал, покрывающий момент проверки.
      if (reason === 'quiet') {
        state.bureau = { timeZone: 'UTC', workEnd: '18:00' };
        h.notificationSettings.mockResolvedValue({
          ok: true,
          data: { rows: [], digestHourly: false, quiet: { from: '00:01', to: '00:00' } },
        });
      }
      (
        host as unknown as { acceptTimer: (timer: ReturnType<typeof timerFixture>) => void }
      ).acceptTimer(timerFixture());
      const spec = h.toastShow.mock.calls[0]?.[0] as ToastSpec;
      if (!h.toastOptions) throw Error('Missing toast callbacks');
      expect(await h.toastOptions.beforeShow(spec)).toBe(false);
      expect(getSettings().timerReminderSeen).toEqual({});
      expect(h.beep).not.toHaveBeenCalled();
    },
  );
  it('Focus suppresses local reminder; disabled preview does not leak task name', () => {
    vi.setSystemTime(new Date(2026, 9, 29, 18, 30));
    const { host, owned } = fixture({
      notifications: { enabled: true, sound: false, preview: false, morning: true },
    });
    owned.state.focus.until = new Date(Date.now() + 60000).toISOString();
    const ownedHost = host as unknown as {
      acceptTimer: (timer: ReturnType<typeof timerFixture>) => void;
      checkReminder: () => void;
    };
    ownedHost.acceptTimer(timerFixture());
    expect(h.toastShow).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(2026, 9, 29, 18, 31));
    owned.state.focus.until = null;
    ownedHost.checkReminder();
    const spec = h.toastShow.mock.calls[0]?.[0] as ToastSpec;
    expect(spec.body).not.toContain('План первого этажа');
    expect(spec.body).toContain('Проверьте трудозатраты');
    h.toastOptions?.onShow(spec);
    expect(h.beep).not.toHaveBeenCalled();
  });
  it('late policy result and old reminder button cannot act after owner/timer changes', async () => {
    vi.setSystemTime(new Date(2026, 9, 29, 18, 30));
    const { host, owned } = fixture();
    const wait = deferred<boolean>();
    h.policyAllows.mockReturnValueOnce(wait.promise);
    const ownedHost = host as unknown as {
      acceptTimer: (timer: ReturnType<typeof timerFixture>) => void;
    };
    ownedHost.acceptTimer(timerFixture());
    const spec = h.toastShow.mock.calls[0]?.[0] as ToastSpec;
    if (!h.toastOptions) throw Error('Missing toast callbacks');
    const before = h.toastOptions.beforeShow(spec);
    await Promise.resolve();
    await Promise.resolve();
    ownedHost.acceptTimer(timerFixture('pause'));
    wait.resolve(true);
    expect(await before).toBe(false);
    h.toastOptions.onButton(spec, 0);
    expect(owned.state.navigateTimer).toBeUndefined();
    expect(h.timerPause).not.toHaveBeenCalled();
  });
  it('preferences save is scoped and keeps other settings; save failure is explicit', async () => {
    const { invoke, getSettings, settingsUpdate } = fixture();
    expect(
      await invoke({ kind: 'timer.preferences', epoch: 6, reminderTime: '19:00' }),
    ).toMatchObject({ code: 'stale_session' });
    expect(settingsUpdate).not.toHaveBeenCalled();
    expect(await invoke({ kind: 'timer.preferences', epoch: 7, reminderTime: '19:00' })).toEqual({
      ok: true,
      data: null,
    });
    expect(getSettings().timer).toEqual({
      pauseOnLock: true,
      askOnUnlock: true,
      reminderTime: '19:00',
    });
    settingsUpdate.mockImplementationOnce(() => {
      throw Error('private path');
    });
    expect(
      await invoke({ kind: 'timer.preferences', epoch: 7, reminderTime: '20:00' }),
    ).toMatchObject({ code: 'settings_error' });
    expect(getSettings().timer.reminderTime).toBe('19:00');
  });
  it('timer socket state wins over an older read response', async () => {
    const { host, invoke, owned } = fixture(),
      wait = deferred<ApiResult<null>>();
    h.timer.mockReturnValueOnce(wait.promise);
    const read = invoke({ kind: 'timer.read', epoch: 7 });
    (host as unknown as { event: (name: string, data: unknown) => void }).event(
      'time:timer',
      timerPushFixture(timerFixture()),
    );
    wait.resolve({ ok: true, data: null });
    await read;
    expect(owned.state.timer).toMatchObject({ version: 1, state: 'run' });
    expect(owned.state.timerReady).toBe(true);
  });
  it('late timer response after logout cannot restore the previous owner state', async () => {
    const { invoke, owned } = fixture(),
      wait = deferred<ApiResult<ReturnType<typeof timerFixture>>>();
    h.timer.mockReturnValueOnce(wait.promise);
    const read = invoke({ kind: 'timer.read', epoch: 7 });
    await invoke({ kind: 'logout', epoch: 7 });
    wait.resolve({ ok: true, data: timerFixture() });
    expect(await read).toMatchObject({ code: 'stale_session' });
    expect(owned.state.timer).toBeNull();
    expect(owned.state.timerReady).toBe(false);
    expect(owned.state.recentTimeTaskIds).toEqual([]);
  });
  it('timer IPC routes only validated rows and publishes confirmed timer state', async () => {
    const { invoke, owned } = fixture(),
      timer = timerFixture('pause');
    h.timerPause.mockResolvedValue({ ok: true, data: timer });
    const expected = { timerId: 71, revision: 1, currentSegmentFrom: timer.startedAt };
    expect(await invoke({ kind: 'timer.pause', epoch: 7, expected })).toMatchObject({ ok: true });
    expect(owned.state.timer).toEqual(timer);
    expect(h.timerPause).toHaveBeenCalledWith(expected);
    h.timerFinish.mockResolvedValue({ ok: true, data: null });
    await invoke({
      kind: 'timer.finish',
      epoch: 7,
      expected: { ...expected, revision: 2 },
      rows: proposalFixture().rows,
      note: 'Тест',
      preparedRequestId: 'prepared-test',
    });
    expect(owned.state.timer).toBeNull();
    expect(h.timerFinish).toHaveBeenCalledWith(
      { ...expected, revision: 2 },
      proposalFixture().rows,
      'Тест',
      'prepared-test',
    );
  });
  it('старые send/read/open.path отвергаются до сетевых и OS-вызовов', async () => {
    const { invoke } = fixture();
    for (const request of [
      {
        kind: 'chat.send',
        epoch: 6,
        chatId: 4,
        text: 'Прежний текст',
        requestId: 'desk-test-0001',
      },
      { kind: 'chat.read', epoch: 6, chatId: 4, upTo: 10 },
      { kind: 'open.path', epoch: 6, path: '\\\\server\\share\\folder', reveal: false },
      { kind: 'file.preview', epoch: 6, chatId: 4, messageId: 10, fileId: 90 },
      { kind: 'file.action', epoch: 6, chatId: 4, messageId: 10, fileId: 90, action: 'open' },
      { kind: 'file.pick', epoch: 6, chatId: 4, limit: 10 },
      { kind: 'file.paste', epoch: 6, chatId: 4 },
      { kind: 'chat.objectInfo', epoch: 6, chatId: 4 },
      { kind: 'timer.read', epoch: 6 },
      { kind: 'timer.open', epoch: 6, mode: 'pick' },
      { kind: 'timer.start', epoch: 6, taskId: 21, expected: null },
      { kind: 'chat.edit', epoch: 6, chatId: 4, messageId: 10, text: 'Правка' },
      { kind: 'chat.delete', epoch: 6, chatId: 4, messageId: 10 },
      { kind: 'chat.pin', epoch: 6, chatId: 4, messageId: null },
      {
        kind: 'chat.reaction',
        epoch: 6,
        chatId: 4,
        messageId: 10,
        reaction: 'like',
        remove: false,
      },
    ] satisfies DesktopRequest[])
      expect(await invoke(request)).toMatchObject({ ok: false, code: 'stale_session' });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.pathOpen).not.toHaveBeenCalled();
    expect(h.filePreview).not.toHaveBeenCalled();
    expect(h.fileAction).not.toHaveBeenCalled();
    expect(h.uploadPick).not.toHaveBeenCalled();
    expect(h.uploadPaste).not.toHaveBeenCalled();
    expect(h.reactions).not.toHaveBeenCalled();
    expect(h.objectInfo).not.toHaveBeenCalled();
    expect(h.edit).not.toHaveBeenCalled();
    expect(h.delete).not.toHaveBeenCalled();
    expect(h.pin).not.toHaveBeenCalled();
  });
  it('UNC из старого интерфейса всё равно только показывается в папке', async () => {
    const { invoke } = fixture();
    await invoke({
      kind: 'open.path',
      epoch: 7,
      path: '\\\\server\\share\\plan.pdf',
      reveal: false,
    });
    expect(h.pathOpen).toHaveBeenCalledWith({
      kind: 'open.path',
      epoch: 7,
      path: '\\\\server\\share\\plan.pdf',
      reveal: true,
    });
  });
  it('вложения принимают только IDs и epoch, без URL, пути и произвольной операции', () => {
    const request = {
      kind: 'file.action',
      epoch: 7,
      chatId: 4,
      messageId: 10,
      fileId: 90,
      action: 'save',
    };
    expect(requestValid(request)).toBe(true);
    for (const extra of [
      { url: 'https://example.test/private' },
      { path: 'secret.txt' },
      { action: 'execute' },
      { fileId: -1 },
      { messageId: '10' },
    ])
      expect(requestValid({ ...request, ...extra })).toBe(false);
    expect(
      requestValid({ kind: 'file.preview', epoch: 7, chatId: 4, messageId: 10, fileId: 90 }),
    ).toBe(true);
  });
  it('logout захватывает mutex до первого async cookie query; второй logout и новый login не запускаются', async () => {
    const { invoke } = fixture();
    const cookie = deferred<{ name: string; value: string }[]>();
    h.cookiesGet
      .mockReset()
      .mockReturnValueOnce(cookie.promise)
      .mockResolvedValue([{ name: 'st_session', value: 'cookie-A' }]);
    const first = invoke({ kind: 'logout', epoch: 7 });
    expect(h.cookiesGet).toHaveBeenCalledTimes(1);
    const second = await invoke({ kind: 'logout', epoch: 7 });
    expect(second.ok).toBe(false);
    expect(await invoke({ kind: 'login' })).toMatchObject({ ok: false, code: 'busy' });
    expect(h.loginShow).not.toHaveBeenCalled();
    expect(h.logout).not.toHaveBeenCalled();
    cookie.resolve([{ name: 'st_session', value: 'cookie-A' }]);
    expect(await first).toEqual({ ok: true, data: null });
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.cookiesRemove).toHaveBeenCalledTimes(1);
    expect(h.cookiesGet).toHaveBeenCalledTimes(2);
  });
  it('поздний logout A не удаляет cookie B и не инвалидирует новый вход', async () => {
    const { invoke, state } = fixture();
    const result = deferred<ApiResult<null>>();
    h.logout.mockReturnValueOnce(result.promise);
    const pending = invoke({ kind: 'logout', epoch: 7 });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.logout).toHaveBeenCalledTimes(1);
    h.api.epoch = 8;
    h.api.owner = 2;
    state.user = { id: 2, shortName: 'Другой вход', mustChangePassword: false };
    state.epoch = 8;
    h.cookiesGet.mockResolvedValue([{ name: 'st_session', value: 'cookie-B' }]);
    result.resolve({ ok: true, data: null });
    expect(await pending).toMatchObject({ ok: false, code: 'stale_session' });
    expect(h.cookiesRemove).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.api.owner).toBe(2);
    expect(state.user.id).toBe(2);
  });
  it('автоматическое read требует видимый, активный main-window и выбранный чат', async () => {
    const { invoke, win } = fixture();
    await invoke({ kind: 'chat.view', epoch: 7, chatId: 4 });
    win.isVisible.mockReturnValue(false);
    expect(await invoke({ kind: 'chat.read', epoch: 7, chatId: 4, upTo: 10 })).toMatchObject({
      ok: false,
      code: 'validation',
    });
    win.isVisible.mockReturnValue(true);
    win.isFocused.mockReturnValue(false);
    expect(await invoke({ kind: 'chat.read', epoch: 7, chatId: 4, upTo: 10 })).toMatchObject({
      ok: false,
      code: 'validation',
    });
    win.isFocused.mockReturnValue(true);
    await invoke({ kind: 'chat.view', epoch: 7, chatId: 5 });
    expect(await invoke({ kind: 'chat.read', epoch: 7, chatId: 4, upTo: 10 })).toMatchObject({
      ok: false,
      code: 'validation',
    });
    expect(h.read).not.toHaveBeenCalled();
    await invoke({ kind: 'chat.view', epoch: 7, chatId: 4 });
    expect(await invoke({ kind: 'chat.read', epoch: 7, chatId: 4, upTo: 10 })).toEqual({
      ok: true,
      data: null,
    });
    expect(h.read).toHaveBeenCalledExactlyOnceWith(4, 10);
  });
  it('смена epoch после await focus.set не публикует фокус прежнего пользователя', async () => {
    const { invoke, state } = fixture();
    const result = deferred<ApiResult<FocusState>>();
    h.setFocus.mockReturnValueOnce(result.promise);
    const pending = invoke({ kind: 'focus.set', epoch: 7, minutes: 30 });
    expect(h.setFocus).toHaveBeenCalledTimes(1);
    h.api.epoch = 8;
    h.api.owner = 2;
    state.user = { id: 2, shortName: 'Другой вход', mustChangePassword: false };
    state.epoch = 8;
    const previous = { until: null, startedAt: null };
    state.focus = previous;
    result.resolve({
      ok: true,
      data: { until: '2026-10-28T16:00:00Z', startedAt: '2026-10-28T15:30:00Z' },
    });
    expect(await pending).toMatchObject({ ok: false, code: 'stale_session' });
    expect(state.focus).toBe(previous);
    expect(h.published).toEqual([]);
  });
});

describe('Support Host authenticated main boundary', () => {
  const configure = (owner = 1) => {
    h.desktopConfig = {
      bureau: { timeZone: 'Asia/Yekaterinburg', workEnd: '18:00' },
      serverNow: '2026-10-31T04:00:00.000Z',
      supportChatId: 9,
      capabilities: { support: 1, timerControl: 2 },
    };
    h.authenticate.mockResolvedValue({
      ok: true,
      data: { id: owner, shortName: 'Тест', mustChangePassword: false },
    });
    h.readDesktopConfig.mockResolvedValue({ ok: true, data: h.desktopConfig });
    h.supportUpload.mockImplementation(async (name: string, bytes: Uint8Array) => ({
      ok: true,
      data: {
        fileId: 30,
        fileName: name,
        size: bytes.length,
        mime: 'application/octet-stream',
        isImage: false,
      },
    }));
    h.supportSend.mockResolvedValue({ ok: true, data: { chatId: 9, messageId: 80 } });
  };
  const preview = async (f: ReturnType<typeof fixture>) => {
    const result = await f.invoke({
      kind: 'report.prepare',
      options: {
        description: 'Одобренное описание',
        applicationLogs: false,
        revitYear: null,
        includeScreenshot: false,
      },
    });
    if (!result.ok) throw Error('No preview');
    return (result.data as { id: string }).id;
  };
  it('sequential report.send IPC for the same confirmed preview returns one receipt without a second upload/post', async () => {
    const f = fixture();
    configure();
    const id = await preview(f);
    const first = await f.invoke({ kind: 'report.send', epoch: 7, id });
    expect(first).toMatchObject({
      ok: true,
      data: { status: 'confirmed', receipt: { messageId: 80 } },
    });
    expect(await f.invoke({ kind: 'report.send', epoch: 7, id })).toEqual(first);
    expect(h.supportUpload).toHaveBeenCalledTimes(1);
    expect(h.supportSend).toHaveBeenCalledTimes(1);
    const next = await preview(f);
    expect(next).not.toBe(id);
    expect(await f.invoke({ kind: 'report.send', epoch: 7, id: next })).toMatchObject({ ok: true });
    expect(h.supportSend).toHaveBeenCalledTimes(2);
  });
  it('destroyed old Host completion cannot overwrite a new Host confirmed owner entry', async () => {
    let text: string | null = null;
    const storage = {
      read: () => text,
      replace: (next: string) => {
        text = next;
      },
    };
    const first = fixture({}, undefined, new SupportLedger(storage));
    configure();
    const id = await preview(first),
      pending = deferred<unknown>();
    h.supportSend.mockReturnValueOnce(pending.promise);
    const oldWork = first.invoke({ kind: 'report.send', epoch: 7, id });
    await vi.waitFor(() => expect(h.supportSend).toHaveBeenCalledTimes(1));
    expect(h.supportSend).toHaveBeenCalledTimes(1);
    first.host.destroy();
    h.api.owner = 2;
    h.api.epoch = 8;
    const second = fixture({}, undefined, new SupportLedger(storage));
    second.state.user = { id: 2, shortName: 'Другой', mustChangePassword: false };
    configure(2);
    h.supportSend.mockResolvedValue({ ok: true, data: { chatId: 9, messageId: 81 } });
    const otherId = await preview(second);
    expect(await second.invoke({ kind: 'report.send', epoch: 8, id: otherId })).toMatchObject({
      ok: true,
      data: { receipt: { messageId: 81 } },
    });
    const before = text;
    pending.resolve({ ok: false, code: 'unauthenticated', error: 'Нет входа', retryable: false });
    expect(await oldWork).toMatchObject({ ok: false, code: 'stale_session' });
    expect(text).toBe(before);
    const persisted = new SupportLedger(storage);
    expect(
      persisted.current({
        serverHash: (second.host as unknown as { serverScopeHash: string }).serverScopeHash,
        ownerId: 2,
      })?.receipt?.messageId,
    ).toBe(81);
  });
});

describe('Morning summary: actual-show persistence and current scope', () => {
  const setup = () => {
    vi.setSystemTime(new Date('2026-10-31T04:00:00.000Z'));
    const f = fixture();
    h.desktopConfig = {
      bureau: { timeZone: 'Asia/Yekaterinburg', workEnd: '18:00' },
      serverNow: '2026-10-31T04:00:00.000Z',
      supportChatId: null,
      capabilities: { morning: 1, timerControl: 2 },
    };
    f.state.bureau = h.desktopConfig.bureau;
    const host = f.host as unknown as {
      checkMorning: () => Promise<void>;
      observeServerTime: (v: unknown) => void;
      morningAttempt: unknown;
    };
    host.observeServerTime(h.desktopConfig.serverNow);
    h.morning.mockResolvedValue({
      ok: true,
      data: { date: '2026-10-31', workday: true, dueToday: 2, review: 0, newRemarks: 3 },
    });
    return { ...f, host };
  };
  it('mixed counts hide zero rows and only onShow persists; own shown button and body still open /my', async () => {
    const f = setup();
    await f.host.checkMorning();
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    expect(spec.body).toBe('Сроки сегодня: 2 · Новых замечаний: 3');
    expect(f.getSettings().morningSeen).toEqual([]);
    expect(await required(h.toastOptions).beforeShow(spec)).toBe(true);
    required(h.toastOptions).onShow(spec);
    expect(f.getSettings().morningSeen).toHaveLength(1);
    expect(f.getSettings().morningSeen[0]).toMatch(/:1:2026-10-31$/);
    required(h.toastOptions).onButton(spec, 0);
    required(h.toastOptions).onOpen(spec);
    expect(h.openExternal).toHaveBeenCalledTimes(2);
    expect(h.openExternal).toHaveBeenLastCalledWith('https://example.test/my');
    f.host.morningAttempt = undefined;
    await f.host.checkMorning();
    expect(h.toastShow).toHaveBeenCalledTimes(1);
  });
  it('all-zero and server holiday do not consume day, later positive same day remains eligible', async () => {
    const f = setup();
    h.morning.mockResolvedValueOnce({
      ok: true,
      data: { date: '2026-10-31', workday: true, dueToday: 0, review: 0, newRemarks: 0 },
    });
    await f.host.checkMorning();
    expect(h.toastShow).not.toHaveBeenCalled();
    expect(f.getSettings().morningSeen).toEqual([]);
    f.host.morningAttempt = undefined;
    h.morning.mockResolvedValueOnce({
      ok: true,
      data: { date: '2026-10-31', workday: false, dueToday: 2, review: 0, newRemarks: 3 },
    });
    await f.host.checkMorning();
    expect(h.toastShow).not.toHaveBeenCalled();
    expect(f.getSettings().morningSeen).toEqual([]);
    f.host.morningAttempt = undefined;
    await f.invoke({ kind: 'settings.patch', patch: { notifications: { preview: false } } });
    await f.host.checkMorning();
    expect(h.toastShow).toHaveBeenCalledTimes(1);
    expect((required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec).body).toBe(
      'Откройте «Мою работу», чтобы посмотреть сводку.',
    );
  });
  it('disabled toggle and missing capability prevent the read; before 08:00 does too', async () => {
    const f = setup();
    await f.invoke({ kind: 'settings.patch', patch: { notifications: { morning: false } } });
    await f.host.checkMorning();
    expect(h.morning).not.toHaveBeenCalled();
    await f.invoke({ kind: 'settings.patch', patch: { notifications: { morning: true } } });
    f.host.observeServerTime('2026-10-31T02:59:59.000Z');
    await f.host.checkMorning();
    expect(h.morning).not.toHaveBeenCalled();
    f.host.observeServerTime('2026-10-31T04:00:00.000Z');
    h.desktopConfig = { ...required(h.desktopConfig), capabilities: { timerControl: 2 } };
    await f.host.checkMorning();
    expect(h.morning).not.toHaveBeenCalled();
  });
  it('DND and a delayed policy after toggleOff never mark a shown day', async () => {
    const f = setup();
    await f.host.checkMorning();
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    h.policyAllows.mockResolvedValueOnce(false);
    expect(await required(h.toastOptions).beforeShow(spec)).toBe(false);
    expect(f.getSettings().morningSeen).toEqual([]);
    const policy = deferred<boolean>();
    h.policyAllows.mockReturnValueOnce(policy.promise);
    const waiting = required(h.toastOptions).beforeShow(spec);
    await f.invoke({ kind: 'settings.patch', patch: { notifications: { morning: false } } });
    policy.resolve(true);
    expect(await waiting).toBe(false);
    required(h.toastOptions).onShow(spec);
    expect(f.getSettings().morningSeen).toEqual([]);
    expect(h.beep).not.toHaveBeenCalled();
  });
  it('late response after logout/owner epoch change cannot create an old summary', async () => {
    const f = setup(),
      pending = deferred<unknown>();
    h.morning.mockReturnValueOnce(pending.promise);
    const read = f.host.checkMorning();
    h.api.epoch = 8;
    h.api.owner = 2;
    f.state.epoch = 8;
    f.state.user = { id: 2, shortName: 'Другой вход', mustChangePassword: false };
    pending.resolve({
      ok: true,
      data: { date: '2026-10-31', workday: true, dueToday: 2, review: 0, newRemarks: 3 },
    });
    await read;
    expect(h.toastShow).not.toHaveBeenCalled();
    expect(f.getSettings().morningSeen).toEqual([]);
  });
  it('storage failure shows honest warning, does not claim durable seen, retries persistence without another popup', async () => {
    const f = setup();
    await f.host.checkMorning();
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    f.settingsUpdate.mockImplementationOnce(() => {
      throw Error('disk');
    });
    required(h.toastOptions).onShow(spec);
    expect(f.getSettings().morningSeen).toEqual([]);
    expect(f.state.morningWarning).toContain('сохранить отметку не удалось');
    f.host.morningAttempt = undefined;
    await f.host.checkMorning();
    expect(f.getSettings().morningSeen).toHaveLength(1);
    expect(f.state.morningWarning).toBeNull();
    expect(h.toastShow).toHaveBeenCalledTimes(1);
  });
  it('old day blocks both body and button after a delayed show policy', async () => {
    const f = setup();
    await f.host.checkMorning();
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    f.host.observeServerTime('2026-11-01T04:00:00.000Z');
    expect(await required(h.toastOptions).beforeShow(spec)).toBe(false);
    required(h.toastOptions).onButton(spec, 0);
    required(h.toastOptions).onOpen(spec);
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(f.getSettings().morningSeen).toEqual([]);
  });
});

describe('D4 live metadata and personal top routing', () => {
  it('accepts a genuinely new live push immediately after socket online, before the REST refresh', () => {
    const f = fixture();
    h.chatQuiet = 1;
    required(h.realtimeStatus)(true);
    live(f.host).event('chat:message', message(101, false));
    expect(h.toastShow).toHaveBeenCalledTimes(1);
    live(f.host).event('chat:message', message(101, false));
    expect(h.toastShow).toHaveBeenCalledTimes(1);
  });
  // Изменено 05.11.2026 (ревью PR #6, Ч3): у события колокольчика тишину уже решил сервер
  // (`quiet`, ТЗ 5.2 п.3) — приложение не дублирует её своими настройками.
  it('mention with server quiet:false is not re-checked against local quiet hours', async () => {
    vi.setSystemTime(new Date('2026-10-29T01:00:00Z'));
    const f = fixture();
    f.state.bureau = { timeZone: 'UTC', workEnd: '18:00' };
    h.notificationSettings.mockResolvedValue({
      ok: true,
      data: { rows: [], digestHourly: false, quiet: { from: '00:00', to: '02:00' } },
    });
    const host = live(f.host);
    host.liveNotices.prime([], []);
    const item = notification(510, 'chat_mention');
    item.link = '/chat/4?m=101';
    host.event('notification', { item, kind: item.event, notificationId: item.id, quiet: false });
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    expect(await required(h.toastOptions).beforeShow(spec)).toBe(true);
    expect(h.notificationSettings).not.toHaveBeenCalled();
  });
  it('legacy chat message without server quiet uses bureau time zone; read failure fails open with a warning', async () => {
    vi.setSystemTime(new Date('2026-10-29T01:00:00Z'));
    const f = fixture();
    f.state.bureau = { timeZone: 'Asia/Yekaterinburg', workEnd: '18:00' };
    f.state.chats = [{ id: 4, kind: 'direct' } as import('../../src/shared/client').ChatSummary];
    h.notificationSettings.mockResolvedValue({
      ok: true,
      data: { rows: [], digestHourly: false, quiet: { from: '00:00', to: '02:00' } },
    });
    const host = live(f.host);
    host.liveNotices.prime([], []);
    host.event('chat:message', message(101));
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    expect(await required(h.toastOptions).beforeShow(spec)).toBe(true);
    f.state.bureau = { timeZone: 'UTC', workEnd: '18:00' };
    expect(await required(h.toastOptions).beforeShow(spec)).toBe(false);
    // Сбой чтения: последние удачные настройки этого входа, предупреждение в журнал.
    h.notificationSettings.mockResolvedValue({
      ok: false,
      code: 'network',
      error: 'offline',
      retryable: true,
    });
    expect(await required(h.toastOptions).beforeShow(spec)).toBe(false);
    expect(f.log.warn).toHaveBeenCalledWith('тихие часы не проверены', {
      reason: 'settings_unavailable',
    });
    // Без удачных настроек этого входа — показываем (fail-open), а не гасим молча.
    (f.host as unknown as { quietCache?: unknown }).quietCache = undefined;
    expect(await required(h.toastOptions).beforeShow(spec)).toBe(true);
  });
  const message = (id: number, quiet?: boolean) => ({
    id,
    chatId: 4,
    text: 'Новое',
    deleted: false,
    author: { id: 2, shortName: 'Тест' },
    mentions: [],
    at: '2026-10-29T00:00:00Z',
    editedAt: null,
    replyTo: null,
    files: [],
    links: [],
    canEdit: false,
    reactions: [],
    cards: [],
    sticker: null,
    poll: null,
    ...(quiet !== undefined && { quiet }),
  });
  const live = (host: ClientHost) =>
    host as unknown as {
      event: (name: string, value: unknown) => void;
      liveNotices: {
        prime: (chats: never[], notifications: never[]) => void;
        reconnect: () => void;
      };
    };
  const notification = (id: number, event = 'album_issued') => ({
    id,
    event,
    at: '2026-10-29T00:00:00Z',
    read: false,
    author: null,
    task: null,
    changes: [],
    reason: null,
    subject: 'Альбом выдан',
    link: '/albums/7',
  });
  it('quiet true suppresses a live popup, remains seen, and still schedules refresh', () => {
    const f = fixture();
    const host = live(f.host);
    host.liveNotices.prime([], []);
    h.chatQuiet = 1;
    host.event('chat:message', message(101, true));
    expect(h.toastShow).not.toHaveBeenCalled();
    host.event('chat:message', message(101, false));
    expect(h.toastShow).not.toHaveBeenCalled();
    host.event('chat:message', message(102, false));
    expect(h.toastShow).toHaveBeenCalledTimes(1);
    host.event('chat:message', message(102, false));
    expect(h.toastShow).toHaveBeenCalledTimes(1);
    host.event('chat:message', message(103));
    expect(h.toastShow).toHaveBeenCalledTimes(1);
    expect((f.host as unknown as { refreshTimer: unknown }).refreshTimer).toBeDefined();
  });
  it('legacy missing quiet uses local policy, reconnect events never flood', () => {
    const f = fixture();
    const host = live(f.host);
    host.liveNotices.prime([], []);
    host.event('chat:message', message(101));
    expect(h.toastShow).toHaveBeenCalledTimes(1);
    host.liveNotices.reconnect();
    host.event('chat:message', message(102));
    expect(h.toastShow).toHaveBeenCalledTimes(1);
  });
  it('validates notification kind/id, deduplicates and never celebrates quiet/closed/unknown', () => {
    const f = fixture();
    const host = live(f.host);
    host.liveNotices.prime([], []);
    host.event('notification', {
      item: notification(501),
      kind: 'remarks_closed',
      notificationId: 501,
      quiet: false,
    });
    expect(h.toastShow).not.toHaveBeenCalled();
    host.event('notification', {
      item: notification(501),
      kind: 'album_issued',
      notificationId: 501,
      quiet: true,
    });
    expect(f.state.albumCelebration).toBeUndefined();
    host.event('notification', {
      item: notification(501),
      kind: 'album_issued',
      notificationId: 501,
      quiet: false,
    });
    expect(h.toastShow).not.toHaveBeenCalled();
    host.event('notification', {
      item: notification(502),
      kind: 'album_issued',
      notificationId: 502,
      quiet: false,
    });
    expect(f.state.albumCelebration).toEqual({ notificationId: 502, at: Date.now() });
    expect(h.toastShow).toHaveBeenCalledTimes(1);
    for (const [id, kind] of [
      [503, 'remarks_closed'],
      [504, 'future_event'],
    ] as const)
      host.event('notification', {
        item: notification(id, kind),
        kind,
        notificationId: id,
        quiet: false,
      });
    expect(f.state.albumCelebration?.notificationId).toBe(502);
    expect(h.toastShow).toHaveBeenCalledTimes(3);
  });
  it('personal top is disabled without a server field and rejects a late previous epoch', async () => {
    const f = fixture();
    expect(await f.invoke({ kind: 'chat.top', epoch: 7, chatId: 4, top: true })).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    expect(h.top).not.toHaveBeenCalled();
    f.state.chats = [{ id: 4, top: false } as import('../../src/shared/client').ChatSummary];
    const pending = deferred<ApiResult<import('../../src/shared/client').ChatSummary>>();
    h.top.mockReturnValueOnce(pending.promise);
    const result = f.invoke({ kind: 'chat.top', epoch: 7, chatId: 4, top: true });
    h.api.epoch = 8;
    h.api.owner = 2;
    f.state.chats = [];
    pending.resolve({
      ok: true,
      data: { id: 4, top: true } as import('../../src/shared/client').ChatSummary,
    });
    expect(await result).toMatchObject({ ok: false, code: 'stale_session' });
    expect(f.state.chats).toEqual([]);
  });
});

describe('Read receipts bound popup accumulation to unread message IDs', () => {
  const notify = (host: ClientHost, id: number) =>
    (
      host as unknown as {
        messageNotice: (message: import('../../src/shared/client').ChatMessage) => void;
      }
    ).messageNotice({
      id,
      chatId: 4,
      text: 'Фото и сообщения',
      deleted: false,
      author: { id: 2, shortName: 'Тест' },
      mentions: [],
      at: '2026-10-29T00:00:00.000Z',
      editedAt: null,
      replyTo: null,
      files: [],
      links: [],
      canEdit: false,
      reactions: [],
      cards: [],
      sticker: null,
      poll: null,
    } as import('../../src/shared/client').ChatMessage);
  it('out-of-order 102 then 101 keeps the newest popup link through read101 and dismisses only at read102', async () => {
    const f = fixture();
    notify(f.host, 102);
    notify(f.host, 101);
    const notice = () => {
      const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
      const notices = (f.host as unknown as { notices: WeakMap<ToastSpec, { messageId: number }> })
        .notices;
      return { spec, messageId: notices.get(spec)?.messageId };
    };
    expect(notice().messageId).toBe(102);
    expect(notice().spec.body).toContain('2 новых сообщений');
    const read = (upTo: number) =>
      (f.host as unknown as { acceptRead: (chatId: number, upTo: number) => void }).acceptRead(
        4,
        upTo,
      );
    // С 05.11.2026 (ревью PR #6): частичное прочтение на другом устройстве не всплывает
    // заново со звуком — уже показанное уведомление только меняет текст.
    const count = h.toastShow.mock.calls.length;
    read(101);
    expect(h.toastShow).toHaveBeenCalledTimes(count);
    expect(h.toastUpdate).toHaveBeenLastCalledWith('chat:4', expect.any(String));
    expect(h.toastUpdate.mock.calls.at(-1)?.[1]).not.toContain('2 новых сообщений');
    expect(notice().messageId).toBe(102);
    expect(await required(h.toastOptions).beforeShow(notice().spec)).toBe(true);
    read(102);
    expect(h.toastDismiss).toHaveBeenCalledWith('chat:4');
    expect(h.toastShow).toHaveBeenCalledTimes(count);
  });
  it('deduplicates pushes and closes an existing toast only after successful read', async () => {
    const f = fixture();
    notify(f.host, 10);
    notify(f.host, 11);
    notify(f.host, 11);
    expect(h.toastShow).toHaveBeenCalledTimes(2);
    expect(required(h.toastShow.mock.calls.at(-1))[0].body).toContain('2 новых');
    await f.invoke({ kind: 'chat.view', epoch: 7, chatId: 4 });
    h.read.mockResolvedValueOnce({ ok: false, code: 'network', error: 'offline', retryable: true });
    await f.invoke({ kind: 'chat.read', epoch: 7, chatId: 4, upTo: 11 });
    expect(h.toastDismiss).not.toHaveBeenCalled();
    await f.invoke({ kind: 'chat.read', epoch: 7, chatId: 4, upTo: 11 });
    expect(h.toastDismiss).toHaveBeenCalledWith('chat:4');
    await f.invoke({ kind: 'chat.view', epoch: 7, chatId: null });
    notify(f.host, 11);
    notify(f.host, 12);
    expect(required(h.toastShow.mock.calls.at(-1))[0].body).not.toContain('новых сообщений');
  });
  it('a late read preserves newer messages and updates their already visible toast', async () => {
    const f = fixture(),
      pending = deferred<ApiResult<null>>();
    notify(f.host, 10);
    await f.invoke({ kind: 'chat.view', epoch: 7, chatId: 4 });
    h.read.mockReturnValueOnce(pending.promise);
    const read = f.invoke({ kind: 'chat.read', epoch: 7, chatId: 4, upTo: 10 });
    await f.invoke({ kind: 'chat.view', epoch: 7, chatId: null });
    notify(f.host, 11);
    expect(required(h.toastShow.mock.calls.at(-1))[0].body).toContain('2 новых');
    const shown = h.toastShow.mock.calls.length;
    pending.resolve({ ok: true, data: null });
    await read;
    // Без нового всплытия и звука: текст показанного уведомления обновляется на месте.
    expect(h.toastShow).toHaveBeenCalledTimes(shown);
    expect(h.toastDismiss).not.toHaveBeenCalled();
    expect(h.toastUpdate.mock.calls.at(-1)?.[1]).not.toContain('новых сообщений');
    notify(f.host, 12);
    expect(required(h.toastShow.mock.calls.at(-1))[0].body).toContain('2 новых');
  });
  it('a successful read invalidates a popup waiting for policy permission', async () => {
    const f = fixture(),
      policy = deferred<boolean>();
    notify(f.host, 10);
    h.policyAllows.mockReturnValueOnce(policy.promise);
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    const show = required(h.toastOptions).beforeShow(spec);
    await Promise.resolve();
    await f.invoke({ kind: 'chat.view', epoch: 7, chatId: 4 });
    await f.invoke({ kind: 'chat.read', epoch: 7, chatId: 4, upTo: 10 });
    await f.invoke({ kind: 'chat.view', epoch: 7, chatId: null });
    policy.resolve(true);
    expect(await show).toBe(false);
  });
});

describe('Server midnight notices and safe absence pause', () => {
  const notice = () => ({
    id: 91,
    event: 'timer_stopped',
    at: '2026-10-29T00:00:00.000Z',
    read: false,
    author: null,
    task: null,
    subject: 'Таймер',
    reason: 'Проверьте время',
    changes: [],
    link: '/time',
    batch: null,
  });
  const pending = (host: ClientHost) =>
    (host as unknown as { checkTimerPending: () => Promise<void> }).checkTimerPending();
  it('each persisted device acknowledges only an actual policy-approved display', async () => {
    const first = fixture(),
      second = fixture();
    h.timerPending.mockResolvedValue({ ok: true, data: notice() });
    h.timerNoticeAck.mockResolvedValue({ ok: true, data: null });
    await pending(first.host);
    const firstId = required(first.getSettings().deviceId);
    const firstSpec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    expect(first.settingsUpdate).toHaveBeenCalledWith({ deviceId: firstId });
    expect(h.timerPending).toHaveBeenCalledWith(firstId);
    expect(h.timerNoticeAck).not.toHaveBeenCalled();
    // Callbacks belong to each host; capture the second device's spec and exercise its policy.
    await pending(second.host);
    const secondId = required(second.getSettings().deviceId);
    expect(secondId).not.toBe(firstId);
    const secondSpec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    h.policyAllows.mockResolvedValueOnce(false);
    expect(await required(h.toastOptions).beforeShow(secondSpec)).toBe(false);
    required(h.toastOptions).onClose(secondSpec);
    expect(h.timerNoticeAck).not.toHaveBeenCalled();
    await pending(second.host);
    const shown = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    expect(await required(h.toastOptions).beforeShow(shown)).toBe(true);
    required(h.toastOptions).onShow(shown);
    await Promise.resolve();
    expect(h.timerNoticeAck).toHaveBeenCalledExactlyOnceWith(secondId, 91);
    expect(firstSpec).not.toBe(secondSpec);
  });
  it('Focus leaves pending unconsumed and later allows it; late logout never acknowledges', async () => {
    const f = fixture();
    h.timerPending.mockResolvedValue({ ok: true, data: notice() });
    f.owned.state.focus.until = new Date(Date.now() + 60000).toISOString();
    await pending(f.host);
    expect(h.toastShow).not.toHaveBeenCalled();
    f.owned.state.focus.until = null;
    await pending(f.host);
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    await f.invoke({ kind: 'logout', epoch: 7 });
    required(h.toastOptions).onShow(spec);
    expect(h.timerNoticeAck).not.toHaveBeenCalled();
  });
  it('offline departure preserves A for review when fresh B is already known and never resumes', async () => {
    const f = fixture();
    f.owned.state.timer = timerFixture();
    f.owned.state.timerObservedAt = Date.now();
    f.owned.state.connection = 'offline';
    const host = f.host as unknown as {
      pauseForAbsence: () => void;
      flushAbsencePause: () => Promise<void>;
    };
    host.pauseForAbsence();
    expect(h.timerPause).not.toHaveBeenCalled();
    f.owned.state.timer = { ...timerFixture(), timerId: 99, version: 9 };
    f.owned.state.connection = 'online';
    h.timerPause.mockResolvedValue({
      ok: false,
      code: 'stale_timer',
      error: 'changed',
      retryable: false,
    });
    await host.flushAbsencePause();
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(h.timerResume).not.toHaveBeenCalled();
    expect(f.owned.state.timer.timerId).toBe(99);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error('Missing fixture value');
  return value;
}

describe('Absence and popup regression guards', () => {
  it('an idempotent delayed pause result cannot overwrite a newer socket timer B', async () => {
    const f = fixture(),
      response = deferred<ApiResult<ReturnType<typeof timerFixture>>>();
    f.owned.state.timer = timerFixture();
    f.owned.state.timerObservedAt = Date.now();
    f.owned.state.connection = 'offline';
    const host = f.host as unknown as {
      pauseForAbsence: () => void;
      flushAbsencePause: () => Promise<void>;
      event: (name: string, data: unknown) => void;
    };
    host.pauseForAbsence();
    f.owned.state.connection = 'online';
    h.timerPause.mockReturnValueOnce(response.promise);
    const pause = host.flushAbsencePause();
    const next = { ...timerFixture(), timerId: 99, version: 10 };
    host.event('time:timer', timerPushFixture(next));
    response.resolve({ ok: true, data: timerFixture('pause') });
    await pause;
    expect(f.owned.state.timer?.timerId).toBe(99);
    expect(f.owned.state.timer?.version).toBe(10);
  });
  it('timer_busy during departure retries the same envelope on regular online refresh', async () => {
    const f = fixture();
    f.owned.state.timer = timerFixture();
    f.owned.state.timerObservedAt = Date.now();
    h.timerPause
      .mockResolvedValueOnce({ ok: false, code: 'timer_busy', error: 'busy', retryable: false })
      .mockResolvedValueOnce({ ok: true, data: timerFixture('pause') });
    const host = f.host as unknown as { pauseForAbsence: () => void; refresh: () => Promise<void> };
    host.pauseForAbsence();
    await Promise.resolve();
    await Promise.resolve();
    h.listChats.mockResolvedValue({ ok: true, data: { items: [], unreadTotal: 0 } });
    h.notifications.mockResolvedValue({ ok: true, data: { items: [], unread: 0 } });
    h.focus.mockResolvedValue({ ok: true, data: { until: null, startedAt: null } });
    h.timer.mockResolvedValue({
      ok: true,
      data: { ...timerFixture(), serverNow: '2026-10-29T04:40:02.000Z' },
    });
    h.timerPending.mockResolvedValue({ ok: true, data: null });
    await host.refresh();
    await Promise.resolve();
    expect(h.timerPause).toHaveBeenCalledTimes(2);
    expect(h.timerPause.mock.calls[1]).toEqual(h.timerPause.mock.calls[0]);
    expect(h.timerResume).not.toHaveBeenCalled();
  });
  it('a toast rejected before creation does not consume midnight pending for the session', async () => {
    const f = fixture();
    h.timerPending.mockResolvedValue({
      ok: true,
      data: {
        id: 91,
        event: 'timer_stopped',
        at: '2026-10-29T00:00:00.000Z',
        read: false,
        author: null,
        task: null,
        subject: 'Таймер',
        reason: 'Проверьте время',
        changes: [],
        link: '/time',
        batch: null,
      },
    });
    h.toastShow.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const host = f.host as unknown as { checkTimerPending: () => Promise<void> };
    await host.checkTimerPending();
    await host.checkTimerPending();
    expect(h.toastShow).toHaveBeenCalledTimes(2);
    expect(h.timerNoticeAck).not.toHaveBeenCalled();
  });
});

it('replay cached pause A cannot replace B already observed before the retry started', async () => {
  const f = fixture();
  f.owned.state.timer = timerFixture();
  f.owned.state.timerObservedAt = Date.now();
  const host = f.host as unknown as {
    pauseForAbsence: () => void;
    flushAbsencePause: () => Promise<void>;
    event: (name: string, data: unknown) => void;
  };
  h.timerPause.mockResolvedValueOnce({
    ok: false,
    code: 'network',
    error: 'unknown',
    retryable: true,
    uncertain: true,
  });
  host.pauseForAbsence();
  await Promise.resolve();
  await Promise.resolve();
  host.event('time:timer', timerPushFixture({ ...timerFixture(), timerId: 99, version: 10 }));
  h.timerPause.mockResolvedValueOnce({ ok: true, data: timerFixture('pause') });
  await host.flushAbsencePause();
  expect(f.owned.state.timer?.timerId).toBe(99);
  expect(f.owned.state.timer?.version).toBe(10);
  expect(h.timerPause).toHaveBeenCalledTimes(1);
});

it('the matching own pause socket event confirms absence without replacing its fresh observation', async () => {
  const f = fixture(),
    response = deferred<ApiResult<ReturnType<typeof timerFixture>>>();
  f.owned.state.timer = timerFixture();
  f.owned.state.timerObservedAt = Date.now();
  f.owned.state.connection = 'offline';
  const host = f.host as unknown as {
    pauseForAbsence: () => void;
    flushAbsencePause: () => Promise<void>;
    event: (name: string, data: unknown) => void;
    absence: {
      return: (kind: 'unlock', state: ClientSnapshot) => void;
      warning: unknown;
      depart: (kind: 'lock', state: ClientSnapshot) => void;
    };
  };
  host.absence.depart('lock', f.owned.state);
  host.pauseForAbsence();
  f.owned.state.connection = 'online';
  h.timerPause.mockReturnValueOnce(response.promise);
  const pause = host.flushAbsencePause();
  const ownPause = {
    ...timerFixture('pause'),
    pauseReason: 'lock' as const,
    segments: [{ from: timerFixture().startedAt, to: String(h.timerPause.mock.calls[0]?.[1]) }],
  };
  host.event('time:timer', timerPushFixture(ownPause));
  host.absence.return('unlock', f.owned.state);
  expect(host.absence.warning).not.toBeNull();
  response.resolve({ ok: true, data: ownPause });
  await pause;
  expect(host.absence.warning).toBeNull();
  expect(f.owned.state.timer?.state).toBe('pause');
});

describe('0.7.1 durable Windows absence integration (synthetic events only)', () => {
  const memory = () => {
    let text: string | null = null;
    return {
      read: () => text,
      replace: (next: string) => {
        text = next;
      },
    };
  };
  const persistent = () => {
    const outboxStorage = memory(),
      returnStorage = memory(),
      clock = { now: Date.parse(timerFixture().serverNow) };
    return {
      clock,
      outboxStorage,
      returnStorage,
      open: () => ({
        outbox: new PauseOutbox('memory-outbox', { storage: outboxStorage, now: () => clock.now }),
        returns: new PauseReturns('memory-returns', returnStorage),
      }),
    };
  };
  type Control = {
    pauseForAbsence: (kind?: 'lock' | 'suspend') => void;
    flushAbsencePause: () => Promise<void>;
    pauseScope: () => import('../../src/main/timer/pauseOutbox').PauseScope | null;
    acceptTimer: (timer: ReturnType<typeof timerFixture>) => void;
    observeServerTime: (time: string) => void;
    publish: () => void;
    timerEpoch: number;
    configEpoch: number;
  };
  const control = (host: ClientHost) => host as unknown as Control;
  const fresh = async (f: ReturnType<typeof fixture>, timer = timerFixture()) => {
    h.timer.mockResolvedValueOnce({ ok: true, data: timer });
    await f.invoke({ kind: 'timer.read', epoch: h.api.epoch });
  };
  const captured = (
    f: ReturnType<typeof fixture>,
    store: ReturnType<ReturnType<typeof persistent>['open']>,
  ) => {
    f.owned.state.timer = timerFixture();
    f.owned.state.connection = 'offline';
    control(f.host).pauseForAbsence();
    return required(store.outbox.list(required(control(f.host).pauseScope()))[0]);
  };
  const paused = (record: import('../../src/main/timer/pauseOutbox').PauseEnvelope) => ({
    ...timerFixture('pause'),
    pauseReason: 'lock' as const,
    segments: [{ from: record.expected.currentSegmentFrom ?? '', to: record.at }],
  });
  it('persists before API, restores with new process epoch only after fresh context, and reuses exact envelope', async () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores),
      record = captured(f, stores);
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(disk.outboxStorage.read()).not.toMatch(/cookie|csrf|https|epoch/);
    f.host.destroy();
    h.api.owner = 1;
    h.api.epoch = 100;
    const restored = disk.open(),
      next = fixture({}, restored),
      host = control(next.host);
    host.configEpoch = -1;
    host.timerEpoch = -1;
    next.owned.state.timer = timerFixture();
    await host.flushAbsencePause();
    expect(h.timerPause).not.toHaveBeenCalled();
    host.configEpoch = 100;
    await fresh(next);
    h.timerPause.mockResolvedValueOnce({ ok: true, data: paused(record) });
    await host.flushAbsencePause();
    expect(h.timerPause).toHaveBeenCalledExactlyOnceWith(record.expected, record.at, record.key);
    expect(restored.outbox.list(required(host.pauseScope()))).toEqual([]);
    expect(restored.returns.list(required(host.pauseScope()))[0]).toMatchObject({
      key: record.key,
      delivery: 'pending',
    });
  });
  it('query/session-end bind once, never send or block shutdown; unconfirmed query is review after restart', async () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores);
    f.owned.state.timer = timerFixture();
    const event = { preventDefault: vi.fn() };
    expect(f.win.listenerCount('query-session-end')).toBe(1);
    f.win.emit('query-session-end', event);
    const scope = required(control(f.host).pauseScope());
    expect(stores.outbox.list(scope)[0]?.status).toBe('candidate');
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    f.host.destroy();
    expect(f.win.listenerCount('query-session-end')).toBe(0);
    expect(f.win.listenerCount('session-end')).toBe(0);
    expect(disk.open().outbox.list(scope)[0]).toMatchObject({
      status: 'review',
      reviewReason: 'unconfirmed-query',
    });
  });
  it('confirmed session-end promotes original query time/key with no network in either callback', () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores);
    f.owned.state.timer = timerFixture();
    f.win.emit('query-session-end');
    const scope = required(control(f.host).pauseScope()),
      record = required(stores.outbox.list(scope)[0]);
    f.win.emit('session-end');
    expect(stores.outbox.list(scope)[0]).toEqual({ ...record, status: 'pending' });
    expect(h.timerPause).not.toHaveBeenCalled();
  });
  it('live cancelled query does not backdate or suppress a later real lock', () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores);
    f.owned.state.timer = timerFixture();
    f.owned.state.connection = 'offline';
    f.win.emit('query-session-end');
    const scope = required(control(f.host).pauseScope()),
      query = required(stores.outbox.list(scope)[0]);
    f.win.emit('focus');
    disk.clock.now += 60000;
    control(f.host).observeServerTime(new Date(disk.clock.now).toISOString());
    control(f.host).pauseForAbsence('suspend');
    const records = stores.outbox.list(scope);
    expect(records[0]?.status).toBe('cancelled');
    expect(records[1]?.eventKind).toBe('suspend');
    expect(records[1]?.key).not.toBe(query.key);
    expect(Date.parse(records[1]?.at ?? '')).toBeGreaterThan(Date.parse(query.at));
    expect(h.timerPause).not.toHaveBeenCalled();
  });
  it('crash between Return-write and outbox removal reconciles by key; actual show survives restart without duplicate', async () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores),
      record = captured(f, stores),
      scope = required(control(f.host).pauseScope()),
      timer = paused(record);
    stores.returns.put({
      ...scope,
      key: record.key,
      at: record.at,
      returnedAt: null,
      returnKind: null,
      expected: {
        timerId: record.expected.timerId,
        revision: record.expected.revision + 1,
        currentSegmentFrom: null,
      },
      delivery: 'pending',
    });
    f.host.destroy();
    h.api.owner = 1;
    const restored = disk.open(),
      next = fixture({}, restored);
    await fresh(next, timer);
    await control(next.host).flushAbsencePause();
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(restored.outbox.list(scope)).toEqual([]);
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    h.policyAllows.mockResolvedValueOnce(false);
    expect(await required(h.toastOptions).beforeShow(spec)).toBe(false);
    required(h.toastOptions).onClose(spec);
    expect(restored.returns.list(scope)[0]?.delivery).toBe('pending');
    await control(next.host).flushAbsencePause();
    const shown = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    expect(await required(h.toastOptions).beforeShow(shown)).toBe(true);
    required(h.toastOptions).onShow(shown);
    expect(restored.returns.list(scope)[0]?.delivery).toBe('shown');
    const count = h.toastShow.mock.calls.length;
    next.host.destroy();
    h.api.owner = 1;
    const third = fixture({}, disk.open());
    await fresh(third, timer);
    await control(third.host).flushAbsencePause();
    expect(h.toastShow).toHaveBeenCalledTimes(count);
    expect(h.timerResume).not.toHaveBeenCalled();
  });
  it('Return-write failure retains durable outbox and visible warning without claiming delivered pause', async () => {
    const disk = persistent(),
      stores = disk.open();
    stores.returns = new PauseReturns('failed', {
      read: () => null,
      replace: () => {
        throw Error('disk full');
      },
    });
    const f = fixture({}, stores),
      record = captured(f, stores);
    f.owned.state.connection = 'online';
    h.timerPause.mockResolvedValueOnce({ ok: true, data: paused(record) });
    await control(f.host).flushAbsencePause();
    expect(stores.outbox.list(required(control(f.host).pauseScope()))).toHaveLength(1);
    expect(f.owned.state.timerAbsence?.message).toContain('Не удалось надёжно сохранить');
    expect(h.toastShow).not.toHaveBeenCalled();
  });
  it('outbox storage failure sends nothing; foreign owner sees no old timer or prompt', async () => {
    const stores = {
        outbox: new PauseOutbox('failed', {
          storage: {
            read: () => null,
            replace: () => {
              throw Error('full');
            },
          },
        }),
        returns: new PauseReturns('returns', memory()),
      },
      f = fixture({}, stores);
    f.owned.state.timer = timerFixture();
    control(f.host).pauseForAbsence();
    await control(f.host).flushAbsencePause();
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(f.owned.state.timerAbsence?.message).toContain('Не удалось надёжно сохранить');
  });
  it('server 5xx remains review with no automatic retry; transport unknown retries after server-clock backoff', async () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores),
      record = captured(f, stores),
      host = control(f.host),
      scope = required(host.pauseScope());
    f.owned.state.connection = 'online';
    h.timerPause.mockResolvedValueOnce({
      ok: false,
      code: 'network',
      error: 'unknown',
      retryable: true,
    });
    await host.flushAbsencePause();
    await host.flushAbsencePause();
    expect(h.timerPause).toHaveBeenCalledTimes(1);
    expect(stores.outbox.list(scope)[0]?.status).toBe('unknown');
    disk.clock.now += 60000;
    host.observeServerTime(new Date(disk.clock.now).toISOString());
    h.timerPause.mockResolvedValueOnce({
      ok: false,
      code: 'server_error',
      error: 'unknown',
      retryable: true,
      uncertain: true,
    });
    await host.flushAbsencePause();
    expect(h.timerPause.mock.calls[1]).toEqual([record.expected, record.at, record.key]);
    expect(stores.outbox.list(scope)[0]).toMatchObject({
      status: 'review',
      reviewReason: 'server-error',
    });
    disk.clock.now += 60000;
    host.observeServerTime(new Date(disk.clock.now).toISOString());
    await host.flushAbsencePause();
    expect(h.timerPause).toHaveBeenCalledTimes(2);
  });
  it('24-hour expiry uses fresh server time despite a backwards local Windows wall clock', async () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores),
      record = captured(f, stores);
    f.host.destroy();
    disk.clock.now += 24 * 60 * 60000;
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    h.api.owner = 1;
    const restored = disk.open(),
      next = fixture({}, restored);
    await fresh(next, { ...timerFixture(), serverNow: new Date(disk.clock.now).toISOString() });
    await control(next.host).flushAbsencePause();
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(restored.outbox.list(required(control(next.host).pauseScope()))[0]).toMatchObject({
      key: record.key,
      status: 'review',
      reviewReason: 'expired',
    });
  });

  it('only a shown return button can resume its bound paused timer; a later B cannot use it', async () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores),
      record = captured(f, stores);
    f.owned.state.connection = 'online';
    h.timerPause.mockResolvedValueOnce({ ok: true, data: paused(record) });
    await control(f.host).flushAbsencePause();
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    required(h.toastOptions).onButton(spec, 0);
    expect(h.timerResume).not.toHaveBeenCalled();
    required(h.toastOptions).onShow(spec);
    const resumed = {
      ...timerFixture(),
      version: 3,
      segments: [...paused(record).segments, { from: '2026-10-29T04:50:00.000Z', to: null }],
    };
    h.timerResume.mockResolvedValueOnce({ ok: true, data: resumed });
    required(h.toastOptions).onButton(spec, 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.timerResume).toHaveBeenCalledExactlyOnceWith({
      timerId: record.expected.timerId,
      revision: 2,
      currentSegmentFrom: null,
    });
    expect(stores.returns.list(required(control(f.host).pauseScope()))).toEqual([]);
    f.owned.state.timer = { ...timerFixture(), timerId: 99, version: 5 };
    required(h.toastOptions).onButton(spec, 0);
    expect(h.timerResume).toHaveBeenCalledTimes(1);
  });
  it('a different authenticated owner cannot restore or display the prior owner pause', async () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores);
    captured(f, stores);
    f.host.destroy();
    h.api.owner = 2;
    const restored = disk.open(),
      next = fixture({}, restored);
    next.owned.state.user = { id: 2, shortName: 'Другой вход', mustChangePassword: false };
    await fresh(next, timerFixture());
    await control(next.host).flushAbsencePause();
    control(next.host).publish();
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(h.toastShow).not.toHaveBeenCalled();
    expect(next.owned.state.timerAbsence).toBeNull();
  });
  it('post-show delivery persistence failure keeps pending intent and warns instead of claiming durable once-only display', async () => {
    const disk = persistent(),
      stores = disk.open();
    let fail = false;
    stores.returns = new PauseReturns('returns', {
      read: () => null,
      replace: (next) => {
        if (fail) throw Error('full');
        disk.returnStorage.replace(next);
      },
    });
    const f = fixture({}, stores),
      record = captured(f, stores);
    f.owned.state.connection = 'online';
    h.timerPause.mockResolvedValueOnce({ ok: true, data: paused(record) });
    await control(f.host).flushAbsencePause();
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    fail = true;
    required(h.toastOptions).onShow(spec);
    expect(f.owned.state.timerAbsence?.message).toContain('Не удалось надёжно сохранить');
    expect(stores.returns.list(required(control(f.host).pauseScope()))[0]?.delivery).toBe(
      'pending',
    );
    required(h.toastOptions).onButton(spec, 0);
    expect(h.timerResume).not.toHaveBeenCalled();
  });
  it('scheduled wake while locked waits for fresh detector and actual unlock, preserving the end through policy delay', () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores),
      record = captured(f, stores),
      scope = required(control(f.host).pauseScope());
    stores.returns.put({
      ...scope,
      key: record.key,
      expected: {
        timerId: record.expected.timerId,
        revision: record.expected.revision + 1,
        currentSegmentFrom: null,
      },
      at: record.at,
      returnedAt: null,
      returnKind: null,
      delivery: 'pending',
    });
    const host = f.host as unknown as {
      locked: boolean;
      suspended: boolean;
      lock: () => void;
      sleep: () => void;
      wake: () => void;
      unlock: () => void;
      observeServerTime: (value: string) => void;
      saver: { token: number };
      screenSaverBinding: () => string;
      acceptScreenSaver: (
        sample: { state: 'stopped'; observedMono: number },
        context: { token: number; binding: string },
      ) => void;
    };
    host.lock();
    host.sleep();
    host.wake();
    expect(stores.returns.list(scope)[0]?.returnedAt).toBeNull();
    disk.clock.now += 60000;
    host.observeServerTime(new Date(disk.clock.now).toISOString());
    host.acceptScreenSaver(
      { state: 'stopped', observedMono: performance.now() },
      { token: host.saver.token, binding: host.screenSaverBinding() },
    );
    host.unlock();
    const first = stores.returns.list(scope)[0];
    expect(first?.returnKind).toBe('unlock');
    disk.clock.now += 300000;
    host.observeServerTime(new Date(disk.clock.now).toISOString());
    host.unlock();
    expect(stores.returns.list(scope)[0]?.returnedAt).toBe(first?.returnedAt);
  });
  it('capacity-warning acknowledgement exposes preserved reviews without silently pruning them', async () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores),
      scope = required(control(f.host).pauseScope());
    for (let index = 0; index < 64; index++) {
      const item = required(
        stores.outbox.capture(
          scope,
          { timerId: 1000 + index, revision: 1, currentSegmentFrom: timerFixture().startedAt },
          timerFixture().serverNow,
          'lock',
        ),
      );
      stores.outbox.markStale(scope, item.key);
    }
    f.owned.state.timer = timerFixture();
    f.owned.state.connection = 'offline';
    control(f.host).pauseForAbsence();
    expect(f.owned.state.timerAbsence?.message).toContain('Не удалось надёжно сохранить');
    await f.invoke({
      kind: 'timer.absenceDismiss',
      epoch: h.api.epoch,
      id: required(f.owned.state.timerAbsence).id,
    });
    expect(stores.outbox.list(scope)).toHaveLength(64);
    expect(f.owned.state.timerAbsence?.message).not.toContain('Не удалось надёжно сохранить');
    expect(f.owned.state.timerAbsence?.message).toContain('Автоматический повтор остановлен');
    expect(h.timerPause).not.toHaveBeenCalled();
  });
  it('verified 401 remains terminal for its original scope even when auth loss advances the epoch', async () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture({}, stores),
      record = captured(f, stores),
      scope = required(control(f.host).pauseScope());
    f.owned.state.connection = 'online';
    h.timerPause.mockImplementationOnce(async () => {
      h.api.epoch++;
      h.api.owner = null;
      f.owned.state.user = null;
      return { ok: false, code: 'unauthenticated', error: 'login', retryable: false };
    });
    await control(f.host).flushAbsencePause();
    expect(stores.outbox.list(scope)[0]).toMatchObject({
      key: record.key,
      status: 'review',
      reviewReason: 'terminal-http',
    });
    expect(h.timerResume).not.toHaveBeenCalled();
  });
  it.each([
    'preference',
    'acknowledged',
    'timestamp',
    'return-health',
    'outbox-health',
    'expected',
  ] as const)('delayed recovery policy cannot show or act on invalidated %s', async (change) => {
    const disk = persistent(),
      stores = disk.open();
    let failReturnWrite = false;
    stores.returns = new PauseReturns('returns', {
      read: disk.returnStorage.read,
      replace: (next) => {
        if (failReturnWrite) throw Error('full');
        disk.returnStorage.replace(next);
      },
    });
    const f = fixture({}, stores),
      record = captured(f, stores),
      scope = required(control(f.host).pauseScope());
    f.owned.state.connection = 'online';
    h.timerPause.mockResolvedValueOnce({ ok: true, data: paused(record) });
    await control(f.host).flushAbsencePause();
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec,
      policy = deferred<boolean>(),
      entered = deferred<boolean>();
    h.policyAllows.mockImplementationOnce(() => {
      entered.resolve(true);
      return policy.promise;
    });
    const presentation = required(h.toastOptions).beforeShow(spec);
    await entered.promise;
    if (change === 'preference')
      f.settingsUpdate({ timer: { ...f.getSettings().timer, askOnUnlock: false } });
    if (change === 'acknowledged')
      await f.invoke({
        kind: 'timer.absenceDismiss',
        epoch: h.api.epoch,
        id: required(f.owned.state.timerAbsence).id,
      });
    if (change === 'timestamp') {
      const old = required(stores.returns.list(scope)[0]);
      stores.returns.dismiss(scope, record.key);
      stores.returns.put({ ...old, returnedAt: '2026-10-29T05:00:00.000Z', returnKind: 'unlock' });
    }
    if (change === 'return-health') {
      failReturnWrite = true;
      expect(stores.returns.shown(scope, record.key)).toBe(false);
    }
    if (change === 'outbox-health') {
      disk.outboxStorage.replace = () => {
        throw Error('full');
      };
      stores.outbox.capture(
        scope,
        { timerId: 999, revision: 1, currentSegmentFrom: timerFixture().startedAt },
        record.at,
        'lock',
      );
    }
    if (change === 'expected') {
      const old = required(stores.returns.list(scope)[0]);
      stores.returns.dismiss(scope, record.key);
      stores.returns.put({ ...old, expected: { ...old.expected, revision: 99 } });
    }
    policy.resolve(true);
    expect(await presentation).toBe(false);
    required(h.toastOptions).onShow(spec);
    required(h.toastOptions).onButton(spec, 0);
    expect(h.timerResume).not.toHaveBeenCalled();
    if (change === 'timestamp') {
      required(h.toastOptions).onClose(spec);
      await control(f.host).flushAbsencePause();
      const next = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
      expect(next).not.toBe(spec);
      expect(next.body).toContain('Не учтено:');
      expect(await required(h.toastOptions).beforeShow(next)).toBe(true);
      required(h.toastOptions).onShow(next);
      expect(stores.returns.list(scope)[0]?.delivery).toBe('shown');
    }
  });
  it('a destroyed old host cannot settle late 401 over the newer single-writer store containing B', async () => {
    const disk = persistent(),
      oldStores = disk.open(),
      first = fixture({}, oldStores),
      oldRecord = captured(first, oldStores),
      response = deferred<ApiResult<ReturnType<typeof timerFixture>>>();
    first.owned.state.connection = 'online';
    h.timerPause.mockReturnValueOnce(response.promise);
    const oldFlight = control(first.host).flushAbsencePause();
    first.host.destroy();
    h.api.owner = 2;
    const nextStores = disk.open(),
      next = fixture({}, nextStores);
    next.owned.state.user = { id: 2, shortName: 'Новый вход', mustChangePassword: false };
    next.owned.state.timer = { ...timerFixture(), timerId: 99 };
    next.owned.state.connection = 'offline';
    control(next.host).pauseForAbsence();
    const scopeB = required(control(next.host).pauseScope()),
      newRecord = required(nextStores.outbox.list(scopeB)[0]),
      before = disk.outboxStorage.read();
    expect(newRecord.key).not.toBe(oldRecord.key);
    response.resolve({ ok: false, code: 'unauthenticated', error: 'expired', retryable: false });
    await oldFlight;
    expect(disk.outboxStorage.read()).toBe(before);
    expect(disk.open().outbox.list(scopeB)).toEqual([newRecord]);
  });
  it('askOnUnlock=false and a newer timer B suppress the old confirmed return prompt', async () => {
    const disk = persistent(),
      stores = disk.open(),
      f = fixture(
        { timer: { pauseOnLock: true, askOnUnlock: false, reminderTime: '18:30' } },
        stores,
      ),
      record = captured(f, stores);
    f.owned.state.connection = 'online';
    h.timerPause.mockResolvedValueOnce({ ok: true, data: paused(record) });
    await control(f.host).flushAbsencePause();
    expect(h.toastShow).not.toHaveBeenCalled();
    f.owned.state.timer = { ...timerFixture(), timerId: 99, version: 20 };
    await control(f.host).flushAbsencePause();
    expect(h.timerResume).not.toHaveBeenCalled();
    expect(stores.returns.list(required(control(f.host).pauseScope()))).toHaveLength(1);
  });
});

describe('Plugin catalog main authorization and scoped opt-in', () => {
  async function notices(waiting: boolean, notifyInstalled = true) {
    const f = fixture({ plugins: { betaScopes: [], autoUpdate: true, notifyInstalled } }),
      owned = f.host as unknown as {
        pluginUpdates: PluginUpdateCoordinator;
        publish(): void;
        showPluginNotices(): void;
      };
    owned.publish();
    owned.pluginUpdates.dispose();
    const coordinator = new PluginUpdateCoordinator({
      context: () => ({ key: String(h.api.owner), automatic: true, beta: false }),
      mayRun: () => true,
      inspect: async () => ({
        status: 'ready',
        installationAvailable: true,
        receiptId: null,
        packages: [],
      }),
      years: async () => [2025],
      catalog: async () => ({
        tester: false,
        plugins: [
          {
            code: 'alpha',
            name: 'Fixture',
            short: 'AL',
            beta: null,
            stable: {
              id: 1,
              version: '1.0',
              verified: true,
              revit: [2025],
              notes: '',
              size: 10,
              sha256: 'a'.repeat(64),
              url: '/api/desktop/plugins/files/1',
              publishedAt: '2026-11-03T00:00:00.000Z',
              requires: [],
            },
          },
        ],
      }),
      install: async () =>
        waiting
          ? { status: 'waiting', reason: 'revit_busy' }
          : {
              status: 'complete',
              receipt: {
                schema: 1,
                id: '00000000-0000-4000-8000-000000000001',
                scope: { serverHash: 'a'.repeat(64), ownerId: 1 },
                rootsHash: 'b'.repeat(64),
                files: [],
                packages: [],
              },
            },
      recover: async () => ({ status: 'blocked', reason: 'unused' }),
      processes: async () => 'busy',
      cancel: () => {},
      changed: () => {
        owned.publish();
        owned.showPluginNotices();
      },
    });
    owned.pluginUpdates = coordinator;
    h.toastShow.mockClear();
    await coordinator.refresh();
    await Promise.resolve();
    return { f, coordinator };
  }
  it('plugin waiting remains pending until actual policy-approved display, and late owner cannot acknowledge it', async () => {
    const { coordinator } = await notices(true);
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    expect(spec).toMatchObject({
      title: 'Готовы обновления плагинов',
      hasReply: false,
      buttons: ['Что нового', 'Хорошо'],
    });
    expect(coordinator.pendingNotices()).toHaveLength(1);
    h.policyAllows.mockResolvedValueOnce(false);
    expect(await required(h.toastOptions).beforeShow(spec)).toBe(false);
    expect(coordinator.pendingNotices()).toHaveLength(1);
    const delayed = deferred<boolean>();
    h.policyAllows.mockReturnValueOnce(delayed.promise);
    const show = required(h.toastOptions).beforeShow(spec);
    h.api.owner = 2;
    delayed.resolve(true);
    expect(await show).toBe(false);
    required(h.toastOptions).onShow(spec);
    expect(coordinator.pendingNotices()).toEqual([]);
  });
  it('installed notification preference suppresses only completion, not the waiting notice', async () => {
    const complete = await notices(false, false);
    expect(complete.coordinator.state.items[0]?.phase).toBe('complete');
    expect(h.toastShow).not.toHaveBeenCalled();
    const waiting = await notices(true, false);
    expect(waiting.coordinator.state.pending).toBe(1);
    expect(h.toastShow).toHaveBeenCalled();
  });
  const setup = () => {
    const f = fixture();
    h.desktopConfig = {
      bureau: { timeZone: 'Asia/Yekaterinburg', workEnd: '18:00' },
      serverNow: '2026-10-31T04:00:00.000Z',
      supportChatId: null,
      capabilities: { plugins: 1, timerControl: 2 },
    };
    h.plugins.mockResolvedValue({ ok: true, data: { tester: true, plugins: [] } });
    return f;
  };
  it.skipIf(process.platform !== 'win32')(
    'A2: a destroyed old Host cannot write rollback holds after a late path check',
    async () => {
      const f = setup();
      await f.invoke({ kind: 'plugins.refresh', epoch: 7 });
      const owned = f.host as unknown as {
        pluginAutoHolds: PluginAutoHolds;
        pluginContext(): import('../../src/main/plugins/controller').PluginJobContext | null;
        pluginJobs: { o: import('../../src/main/plugins/controller').PluginControllerOptions };
      };
      const context = required(owned.pluginContext()),
        root = mkdtempSync(join(process.cwd(), 'private', 'stale-plugin-holds-')),
        file = join(root, 'holds.json'),
        store = new PluginAutoHolds(file);
      owned.pluginAutoHolds = store;
      const previous: import('../../src/main/plugins/transactionTypes').PluginReceipt = {
          schema: 1,
          id: '00000000-0000-4000-8000-000000000001',
          rootsHash: 'b'.repeat(64),
          scope: context.scope,
          files: [],
          packages: [
            {
              code: 'alpha',
              buildId: 2,
              version: '2.0',
              archiveSha256: '2'.repeat(64),
              archiveSize: 10,
              descriptorId: 'synthetic',
              revit: [2025],
            },
          ],
        },
        next = { ...previous, packages: [] };
      const gate = deferred<undefined>(),
        pathCheck = vi.spyOn(pluginFs, 'nodePathSafe').mockReturnValueOnce(gate.promise);
      try {
        const work = required(owned.pluginJobs.o.beforeRollback)(previous, next);
        expect(pathCheck).toHaveBeenCalledOnce();
        f.host.destroy();
        store.add(['c'.repeat(64)]);
        const before = readFileSync(file),
          write = vi.spyOn(store, 'add');
        gate.resolve(undefined);
        await expect(work).rejects.toThrow('stale_plugin_job');
        expect(write).not.toHaveBeenCalled();
        expect(readFileSync(file)).toEqual(before);
      } finally {
        pathCheck.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('IPC accepts intent only; paths, trust pins, plans and unsupported years are rejected', () => {
    expect(requestValid({ kind: 'plugins.preferences', epoch: 7, notifyInstalled: false })).toBe(
      true,
    );
    expect(requestValid({ kind: 'plugins.preferences', epoch: 7, notifyInstalled: 'false' })).toBe(
      false,
    );
    expect(
      requestValid({
        kind: 'plugins.preferences',
        epoch: 7,
        notifyInstalled: false,
        automaticHolds: [],
      }),
    ).toBe(false);
    const install = { kind: 'plugins.install', epoch: 7, code: 'floor-plans', years: [2025] };
    expect(requestValid(install)).toBe(true);
    for (const extra of [
      { targetRoot: 'C:\\outside' },
      { publisherPins: ['a'.repeat(64)] },
      { plan: {} },
      { years: [2027] },
      { years: [2025, 2025] },
      { code: '../foreign' },
    ])
      expect(requestValid({ ...install, ...extra })).toBe(false);
    expect(requestValid({ kind: 'plugins.rollback', epoch: 7, receiptId: '../previous' })).toBe(
      false,
    );
    expect(requestValid({ kind: 'plugins.recover', epoch: 7, path: 'C:\\outside' })).toBe(false);
  });
  it.skipIf(process.platform !== 'win32')(
    'a direct install intent cannot bypass the unconfigured production trust policy',
    async () => {
      const f = setup();
      await f.invoke({ kind: 'plugins.refresh', epoch: 7 });
      h.plugins.mockClear();
      expect(
        await f.invoke({ kind: 'plugins.install', epoch: 7, code: 'floor-plans', years: [2025] }),
      ).toMatchObject({
        ok: false,
        code: 'plugin_job_blocked',
        error: expect.stringContaining('не настроены'),
      });
      expect(h.plugins).not.toHaveBeenCalled();
      expect(f.state.plugins?.managed?.installationAvailable).toBe(false);
    },
  );
  it.skipIf(process.platform !== 'win32').each(['owner', 'same-epoch-lifetime'] as const)(
    'a held install preflight cannot restart the old intent in a new %s context',
    async (kind) => {
      const f = setup();
      await f.invoke({ kind: 'plugins.refresh', epoch: 7 });
      const owned = f.host as unknown as {
        pluginJobs: {
          inspect: () => Promise<import('../../src/shared/plugins').ManagedPluginsView>;
          install: () => Promise<unknown>;
        };
        inventory: { inspect: () => Promise<unknown> };
        publish: () => void;
        configEpoch: number;
      };
      const pending = deferred<import('../../src/shared/plugins').ManagedPluginsView>();
      const inspect = vi.spyOn(owned.pluginJobs, 'inspect').mockReturnValueOnce(pending.promise),
        install = vi.spyOn(owned.pluginJobs, 'install'),
        inventory = vi.spyOn(owned.inventory, 'inspect');
      const work = f.invoke({
        kind: 'plugins.install',
        epoch: 7,
        code: 'floor-plans',
        years: [2025],
      });
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
      if (kind === 'owner') {
        h.api.owner = 2;
        h.api.epoch = 8;
        f.state.epoch = 8;
        f.state.user = { id: 2, shortName: 'Другой', mustChangePassword: false };
        owned.configEpoch = 8;
        owned.publish();
      } else {
        f.state.connection = 'offline';
        owned.publish();
        f.state.connection = 'online';
        owned.publish();
      }
      pending.resolve({
        status: 'unavailable',
        installationAvailable: false,
        receiptId: null,
        packages: [],
      });
      expect(await work).toMatchObject({ ok: false, code: 'stale_session' });
      expect(install).not.toHaveBeenCalled();
      expect(inventory).not.toHaveBeenCalled();
    },
  );
  it.skipIf(process.platform !== 'win32')(
    'an offline→online transition invalidates the previous job lifetime even within the same epoch',
    async () => {
      const f = setup();
      await f.invoke({ kind: 'plugins.refresh', epoch: 7 });
      const owned = f.host as unknown as {
        pluginJobs: { invalidate: () => void };
        publish: () => void;
      };
      const invalidated = vi.spyOn(owned.pluginJobs, 'invalidate');
      f.state.connection = 'offline';
      owned.publish();
      f.state.connection = 'online';
      owned.publish();
      expect(invalidated.mock.calls.length).toBeGreaterThanOrEqual(2);
    },
  );
  it.skipIf(process.platform === 'win32')(
    'non-Windows hosts deny plugin mutations before inventory or catalog IO',
    async () => {
      const f = setup();
      await f.invoke({ kind: 'plugins.refresh', epoch: 7 });
      h.plugins.mockClear();
      const owned = f.host as unknown as { inventory: { inspect: () => Promise<unknown> } };
      const inventory = vi.spyOn(owned.inventory, 'inspect');
      const intents: DesktopRequest[] = [
        { kind: 'plugins.install', epoch: 7, code: 'floor-plans', years: [2025] },
        { kind: 'plugins.recover', epoch: 7 },
        { kind: 'plugins.rollback', epoch: 7, receiptId: '11111111-1111-4111-8111-111111111111' },
      ];
      for (const intent of intents)
        expect(await f.invoke(intent)).toMatchObject({
          ok: false,
          code: 'forbidden',
        });
      expect(h.plugins).not.toHaveBeenCalled();
      expect(inventory).not.toHaveBeenCalled();
    },
  );
  it('local beta opt-in belongs to current server+owner, and tester removal gates it immediately', async () => {
    const f = setup();
    await f.invoke({ kind: 'plugins.refresh', epoch: 7 });
    expect(await f.invoke({ kind: 'plugins.preferences', epoch: 7, beta: true })).toEqual({
      ok: true,
      data: null,
    });
    expect(f.state.plugins?.beta).toBe(true);
    h.api.owner = 2;
    h.api.epoch = 8;
    f.state.user = { id: 2, shortName: 'Другой', mustChangePassword: false };
    f.state.epoch = 8;
    (f.host as unknown as { configEpoch: number }).configEpoch = 8;
    await f.invoke({ kind: 'plugins.refresh', epoch: 8 });
    expect(f.state.plugins?.beta).toBe(false);
    await f.invoke({ kind: 'plugins.preferences', epoch: 8, beta: true });
    expect(f.getSettings().plugins?.betaScopes).toHaveLength(2);
    h.plugins.mockResolvedValue({ ok: true, data: { tester: false, plugins: [] } });
    await f.invoke({ kind: 'plugins.refresh', epoch: 8 });
    expect(f.state.plugins?.beta).toBe(false);
    expect(await f.invoke({ kind: 'plugins.preferences', epoch: 8, beta: true })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });
  it('missing capability performs no catalog read or preference write and hides previous catalog', async () => {
    const f = setup();
    await f.invoke({ kind: 'plugins.refresh', epoch: 7 });
    h.desktopConfig = { ...required(h.desktopConfig), capabilities: { timerControl: 2 } };
    h.plugins.mockClear();
    await f.invoke({ kind: 'plugins.refresh', epoch: 7 });
    expect(h.plugins).not.toHaveBeenCalled();
    expect(f.state.plugins?.catalog).toBeNull();
    expect(
      await f.invoke({ kind: 'plugins.preferences', epoch: 7, autoUpdate: false }),
    ).toMatchObject({ ok: false, code: 'forbidden' });
  });
  it('late pending catalog after host destroy cannot publish to replacement host', async () => {
    const f = setup(),
      pending = deferred<ApiResult<import('../../src/shared/plugins').PluginCatalog>>();
    h.plugins.mockReturnValueOnce(pending.promise);
    const work = f.invoke({ kind: 'plugins.refresh', epoch: 7 });
    (f.host as unknown as { pluginCatalog: { invalidate: () => void } }).pluginCatalog.invalidate();
    f.host.destroy();
    const replacement = setup();
    const before = h.published.length;
    pending.resolve({ ok: true, data: { tester: true, plugins: [] } });
    expect(await work).toMatchObject({ ok: false, code: 'stale_session' });
    expect(h.published).toHaveLength(before);
    expect(replacement.state.plugins?.catalog ?? null).toBeNull();
  });
});

describe('T1 finish requires online at the common main entrypoint', () => {
  it('offline IPC/tray mode finish does not change navigation or issue a timer command, online still opens', async () => {
    const f = fixture();
    f.state.connection = 'offline';
    const before = f.state.navigateTimer;
    expect(await f.invoke({ kind: 'timer.open', epoch: 7, mode: 'finish' })).toMatchObject({
      ok: false,
      code: 'offline',
    });
    expect(f.state.navigateTimer).toBe(before);
    expect(f.state.error).toContain('Подключитесь к серверу');
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(h.timerProposal).not.toHaveBeenCalled();
    expect(h.timerFinish).not.toHaveBeenCalled();
    f.state.connection = 'online';
    expect(await f.invoke({ kind: 'timer.open', epoch: 7, mode: 'finish' })).toEqual({
      ok: true,
      data: null,
    });
    expect(f.state.navigateTimer?.mode).toBe('finish');
  });
  it('reminder button and body share offline guard and never open finish', () => {
    vi.setSystemTime(new Date(2026, 9, 29, 18, 30));
    const f = fixture();
    (
      f.host as unknown as { acceptTimer: (t: ReturnType<typeof timerFixture>) => void }
    ).acceptTimer(timerFixture());
    const spec = required(h.toastShow.mock.calls[0])[0] as ToastSpec;
    f.state.connection = 'offline';
    required(h.toastOptions).onButton(spec, 0);
    required(h.toastOptions).onOpen(spec);
    expect(f.state.navigateTimer).toBeUndefined();
    expect(h.timerPause).not.toHaveBeenCalled();
    expect(h.timerFinish).not.toHaveBeenCalled();
  });
});

describe('Ревью PR #6: сессия, связь, уведомления, трей', () => {
  type Live = {
    event: (name: string, value: unknown) => void;
    liveNotices: { prime: (chats: never[], notifications: never[]) => void };
    messageNotice: (message: import('../../src/shared/client').ChatMessage) => void;
  };
  const live = (host: ClientHost) => host as unknown as Live;
  const chatMessage = (id: number, chatId = 4): import('../../src/shared/client').ChatMessage => ({
    id,
    chatId,
    text: 'Проверка',
    deleted: false,
    author: { id: 2, shortName: 'Иванова И.И.' },
    mentions: [],
    at: '2026-11-05T09:00:00.000Z',
    editedAt: null,
    replyTo: null,
    files: [],
    links: [],
    canEdit: false,
    reactions: [],
    cards: [],
    sticker: null,
    poll: null,
  });
  const chat = (id: number, kind: string) =>
    ({ id, kind, title: 'Объект А' }) as import('../../src/shared/client').ChatSummary;

  it('session того же пользователя обновляет данные без сброса входа, тостов и epoch', async () => {
    const f = fixture();
    h.authenticate.mockResolvedValue({
      ok: true,
      data: { id: 1, shortName: 'Иванова И.И.', mustChangePassword: false },
    });
    const offline = { ok: false, code: 'network', error: 'offline', retryable: true };
    h.readDesktopConfig.mockResolvedValue(offline);
    h.listChats.mockResolvedValue(offline);
    h.notifications.mockResolvedValue(offline);
    h.focus.mockResolvedValue(offline);
    live(f.host).event('session', undefined);
    await vi.waitFor(() => expect(f.state.user?.shortName).toBe('Иванова И.И.'));
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.toastClear).not.toHaveBeenCalled();
    expect(h.api.epoch).toBe(7);
    expect(f.state.connection).toBe('online');
  });
  it('session со сменой пользователя — полный сброс', async () => {
    const f = fixture();
    h.authenticate.mockImplementation(async () => {
      // Настоящий TeamsApi при смене пользователя очищает себя и меняет поколение.
      h.api.epoch++;
      h.api.owner = 2;
      return { ok: true, data: { id: 2, shortName: 'Петров П.П.', mustChangePassword: false } };
    });
    const current = () => (f.host as unknown as { state: ClientSnapshot }).state;
    live(f.host).event('session', undefined);
    await vi.waitFor(() => expect(current().user).toBeNull());
    expect(h.clear).toHaveBeenCalled();
  });
  it('session при сбое связи не сбрасывает вход', async () => {
    const f = fixture();
    h.authenticate.mockResolvedValue({
      ok: false,
      code: 'network',
      error: 'offline',
      retryable: true,
    });
    h.health.mockResolvedValue({ ok: true, data: { status: 'ok', db: 'ok', version: '0.12.1' } });
    live(f.host).event('session', undefined);
    await vi.waitFor(() => expect(h.health).toHaveBeenCalled());
    expect(h.toastClear).not.toHaveBeenCalled();
    expect(f.state.user?.id).toBe(1);
  });
  it('разрыв сокета при живом REST не включает «Нет связи»; недоступный сервер — включает', async () => {
    const f = fixture();
    const before = h.health.mock.calls.length;
    h.health.mockResolvedValue({ ok: true, data: { status: 'ok', db: 'ok', version: '0.12.1' } });
    required(h.realtimeStatus)(false);
    await vi.waitFor(() => expect(h.health).toHaveBeenCalledTimes(before + 1));
    await Promise.resolve();
    expect(f.state.connection).toBe('online');
    h.health.mockResolvedValue({ ok: false, code: 'network', error: 'Нет связи', retryable: true });
    required(h.realtimeStatus)(false);
    await vi.waitFor(() => expect(f.state.connection).toBe('offline'));
  });
  it('событие чата перечитывает только список чатов, колокольчик — только уведомления', async () => {
    const f = fixture();
    h.listChats.mockResolvedValue({ ok: true, data: { items: [], unreadTotal: 0 } });
    h.notifications.mockResolvedValue({
      ok: true,
      data: { items: [], unread: 0, nextBefore: null },
    });
    const revision = f.state.historyRevision ?? 0;
    live(f.host).event('chat:update', {});
    live(f.host).event('chat:reaction', {});
    await vi.advanceTimersByTimeAsync(400);
    expect(h.listChats).toHaveBeenCalledTimes(1);
    expect(h.notifications).not.toHaveBeenCalled();
    expect(h.focus).not.toHaveBeenCalled();
    expect(h.timer).not.toHaveBeenCalled();
    expect(f.state.historyRevision).toBe(revision + 1);
    live(f.host).event('notification', { item: null });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.notifications).toHaveBeenCalledTimes(1);
    expect(h.listChats).toHaveBeenCalledTimes(1);
  });
  it('«печатает…» не перерисовывает значок трея; значок — только при смене счётчика', () => {
    const f = fixture();
    f.state.chats = [chat(4, 'group')];
    f.state.unread = 1;
    f.state.typing = [];
    const publish = () => (f.host as unknown as { publish: () => void }).publish();
    publish();
    const drawn = h.traySetImage.mock.calls.length;
    const sent = h.published.length;
    live(f.host).event('chat:typing', { chatId: 4, userId: 2, shortName: 'Иванова И.И.' });
    expect(h.published.length).toBe(sent + 1);
    expect(h.traySetImage).toHaveBeenCalledTimes(drawn);
    publish();
    expect(h.traySetImage).toHaveBeenCalledTimes(drawn);
    f.state.unread = 2;
    publish();
    expect(h.traySetImage).toHaveBeenCalledTimes(drawn + 1);
  });
  it('в группе и чате объекта текст тоста — «Фамилия И.О.: текст», в личном — только текст', () => {
    const f = fixture();
    f.state.chats = [chat(4, 'group'), chat(5, 'object'), chat(6, 'direct')];
    live(f.host).messageNotice(chatMessage(10, 4));
    expect(required(h.toastShow.mock.calls.at(-1))[0].body).toBe('Иванова И.И.: Проверка');
    live(f.host).messageNotice(chatMessage(11, 5));
    expect(required(h.toastShow.mock.calls.at(-1))[0].body).toBe('Иванова И.И.: Проверка');
    live(f.host).messageNotice(chatMessage(12, 6));
    expect(required(h.toastShow.mock.calls.at(-1))[0].body).toBe('Проверка');
  });
  it('пачка сообщений устаревает через минуту: позднее прочтение не трогает старый тост', () => {
    const f = fixture();
    live(f.host).messageNotice(chatMessage(10));
    live(f.host).messageNotice(chatMessage(11));
    vi.setSystemTime(Date.now() + 61000);
    (f.host as unknown as { acceptRead: (chatId: number, upTo: number) => void }).acceptRead(4, 10);
    expect(h.toastUpdate).not.toHaveBeenCalled();
    live(f.host).messageNotice(chatMessage(12));
    expect(required(h.toastShow.mock.calls.at(-1))[0].body).not.toContain('новых сообщений');
  });
  it('«Прочитано» на тосте упоминания гасит и сообщение, и событие колокольчика', async () => {
    const f = fixture();
    h.readNotification.mockResolvedValue({ ok: true, data: { unread: 0 } });
    const host = live(f.host);
    host.liveNotices.prime([], []);
    const item = {
      id: 610,
      event: 'chat_mention',
      at: '2026-11-05T09:00:00Z',
      read: false,
      author: null,
      task: null,
      changes: [],
      reason: null,
      subject: 'Иванова И.И. упомянула вас',
      link: '/chat/4?m=101',
    };
    host.event('notification', { item, kind: item.event, notificationId: item.id, quiet: false });
    const spec = required(h.toastShow.mock.calls.at(-1))[0] as ToastSpec;
    required(h.toastOptions).onButton(spec, 1);
    await Promise.resolve();
    expect(h.read).toHaveBeenCalledWith(4, 101);
    expect(h.readNotification).toHaveBeenCalledWith(610);
  });
});
