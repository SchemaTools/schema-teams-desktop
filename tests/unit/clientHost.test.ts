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
import { timerFixture, proposalFixture } from '../fixtures/time';
import { releaseFixture } from '../fixtures/updates';

const URL = 'file:///unit/client.html';
type Handler = (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>;
const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  api: { epoch: 7, owner: 1 as number | null },
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
function fixture(patch: Partial<Settings> = {}) {
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
  const host = new ClientHost({
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
  owned.state.epoch = h.api.epoch;
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
    (host as unknown as { event: (name: string, data: unknown) => void }).event('time:timer', {
      timer: timerFixture(),
    });
    wait.resolve({ ok: true, data: null });
    await read;
    expect(owned.state.timer).toEqual(timerFixture());
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
    const expected = { version: 1, taskId: 21, startedAt: timer.startedAt };
    expect(await invoke({ kind: 'timer.pause', epoch: 7, expected })).toMatchObject({ ok: true });
    expect(owned.state.timer).toEqual(timer);
    expect(h.timerPause).toHaveBeenCalledWith(expected);
    h.timerFinish.mockResolvedValue({ ok: true, data: null });
    await invoke({
      kind: 'timer.finish',
      epoch: 7,
      expected: { ...expected, version: 2 },
      rows: proposalFixture().rows,
      note: 'Тест',
    });
    expect(owned.state.timer).toBeNull();
    expect(h.timerFinish).toHaveBeenCalledWith(
      { ...expected, version: 2 },
      proposalFixture().rows,
      'Тест',
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
