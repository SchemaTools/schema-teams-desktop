import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent, Tray } from 'electron';
import type { ApiResult, FocusState } from '../../src/shared/client';
import type { ClientSnapshot, DesktopRequest } from '../../src/shared/desktop';
import type { MainWindow } from '../../src/main/mainWindow';
import type { SettingsStore } from '../../src/main/settings';
import type { Logger } from '../../src/main/logger';
import { requestValid } from '../../src/shared/requests';

const URL = 'file:///unit/client.html';
type Handler = (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>;
const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  api: { epoch: 7, owner: 1 as number | null },
  health: vi.fn(),
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
  toastShow: vi.fn(),
  toastClear: vi.fn(),
  toastDestroy: vi.fn(),
  realtimeStart: vi.fn(),
  realtimeStop: vi.fn(),
  quit: vi.fn(),
  beep: vi.fn(),
  openExternal: vi.fn(),
  traySetImage: vi.fn(),
  setOverlayIcon: vi.fn(),
  published: [] as { channel: string; state: ClientSnapshot }[],
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const cookies = Object.assign(new EventEmitter(), { get: h.cookiesGet, remove: h.cookiesRemove });
  const ses = { cookies, fetch: h.fetch, protocol: { handle: vi.fn(), unhandle: vi.fn() } };
  return {
    app: { getVersion: () => '0.4.0-test', quit: h.quit },
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
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active' }),
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
    show = h.toastShow;
    clear = h.toastClear;
    destroy = h.toastDestroy;
  },
}));
vi.mock('../../src/main/desktop/notificationState', () => ({
  WindowsNotificationPolicy: class {
    allows() {
      return Promise.resolve(true);
    }
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
function fixture() {
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
  const host = new ClientHost({
    main: { win, show: vi.fn() } as unknown as MainWindow,
    server: new globalThis.URL('https://example.test/'),
    settings: { get: () => normalizeSettings(null), update: vi.fn() } as unknown as SettingsStore,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
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
  return { host, win, invoke, state: owned.state, owned };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  h.handlers.clear();
  h.published.length = 0;
  h.api.epoch = 7;
  h.api.owner = 1;
  // Не запускаем bootstrap/сокет: эти тесты проверяют только маршрутизацию
  // настоящего IPC handler при управляемых поколениях API и cookie jar.
  h.health.mockImplementation(() => new Promise(() => {}));
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
});
afterEach(() => {
  for (const host of hosts.splice(0)) host.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ClientHost: поколение входа проверяется в доверенном main-frame IPC', () => {
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
