import { PauseOutbox, type PauseOutboxStorage } from '../../src/main/timer/pauseOutbox';
import { PauseReturns } from '../../src/main/timer/pauseReturns';
import { EventEmitter } from 'node:events';
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

const URL = 'file:///unit/client.html';
type Handler = (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>;
const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  api: { epoch: 7, owner: 1 as number | null },
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
  policyAllows: vi.fn(),
  idleState: vi.fn(),
  toastOptions: undefined as
    | undefined
    | {
        beforeShow: (spec: ToastSpec) => Promise<boolean>;
        onShow: (spec: ToastSpec) => void;
        onClose: (spec: ToastSpec) => void;
        onButton: (spec: ToastSpec, index: number) => void;
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
    app: { getVersion: () => '0.6.0', quit: h.quit },
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
      clear() {
        h.clear();
        h.api.epoch++;
        h.api.owner = null;
      }
      readDesktopConfig = h.readDesktopConfig;
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
    constructor(options: NonNullable<typeof h.toastOptions>) {
      h.toastOptions = options;
    }
    show = h.toastShow;
    dismiss = h.toastDismiss;
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
    start = h.realtimeStart;
    stop = h.realtimeStop;
  },
}));

import { ClientHost } from '../../src/main/clientHost';
import { normalizeSettings } from '../../src/main/settings';

const hosts: ClientHost[] = [];
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
});
afterEach(() => {
  for (const host of hosts.splice(0)) host.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
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
        notifications: { enabled: true, sound: true, preview: true },
      },
    });
    const result = await invoke({
      kind: 'settings.patch',
      patch: { notifications: { sound: false } },
    });
    expect(result.ok).toBe(true);
    expect(getSettings().notifications).toEqual({ enabled: true, sound: false, preview: true });
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
      const { host, getSettings } = fixture();
      if (reason === 'dnd') h.policyAllows.mockResolvedValue(false);
      if (reason === 'locked') h.idleState.mockReturnValue('locked');
      if (reason === 'quiet')
        h.notificationSettings.mockResolvedValue({
          ok: true,
          data: { rows: [], digestHourly: false, quiet: { from: '20:00', to: '08:00' } },
        });
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
      notifications: { enabled: true, sound: false, preview: false },
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
    pending.resolve({ ok: true, data: null });
    await read;
    expect(h.toastDismiss).toHaveBeenCalledWith('chat:4');
    expect(required(h.toastShow.mock.calls.at(-1))[0].body).not.toContain('новых сообщений');
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
  it('scheduled wake while locked waits for actual unlock and preserves that end through a later policy delay', () => {
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
      wake: () => void;
      unlock: () => void;
      observeServerTime: (value: string) => void;
    };
    host.locked = true;
    host.suspended = true;
    host.wake();
    expect(stores.returns.list(scope)[0]?.returnedAt).toBeNull();
    disk.clock.now += 60000;
    host.observeServerTime(new Date(disk.clock.now).toISOString());
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
    if (change === 'timestamp')
      stores.returns.returned(scope, record.key, '2026-10-29T05:00:00.000Z', 'unlock');
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
