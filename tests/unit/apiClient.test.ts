import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import type { ChatMessage, ChatSummary } from '../../src/shared/client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (id = 1, token = 'csrf-private-A', mustChangePassword = false) => ({
  user: {
    id,
    shortName: 'Иванова И.И.',
    login: 'example',
    fullName: 'Тестовый сотрудник',
    roles: ['example'],
    permissions: [],
    mustChangePassword,
  },
  csrfToken: token,
  theme: 'system',
  future: { secret: 'private-field' },
});
const chat: ChatSummary = {
  id: 4,
  kind: 'direct',
  title: 'Тестовый чат',
  peer: { id: 2, shortName: 'Петров П.П.' },
  objectId: null,
  objectCode: null,
  memberCount: 2,
  last: null,
  unread: 0,
  mentioned: false,
  photoFileId: null,
};
const message: ChatMessage = {
  id: 10,
  chatId: 4,
  author: { id: 1, shortName: 'Иванова И.И.' },
  text: 'Проверка',
  at: '2026-10-28T09:00:00.000Z',
  editedAt: null,
  deleted: false,
  replyTo: null,
  files: [],
  mentions: [],
  links: [],
  canEdit: true,
  reactions: [],
  cards: [],
  sticker: null,
  poll: null,
};
const error = (code: string, status: number) =>
  json({ error: { code, message: 'private-server-message' } }, status);
const setup = () => {
  const fetch = vi.fn<TeamsApiOptions['fetch']>();
  const onAuthLost = vi.fn();
  const api = new TeamsApi({ fetch, onAuthLost });
  return { fetch, onAuthLost, api };
};
const headers = (init: RequestInit | undefined) => new Headers(init?.headers);
afterEach(() => vi.useRealTimers());

describe('TeamsApi: cookie-сеанс, CSRF и неизвестный результат отправки', () => {
  it('в renderer возвращается только SafeUser, csrf и поля входа остаются в main', async () => {
    const { fetch, api } = setup();
    fetch.mockResolvedValueOnce(json(me()));
    const result = await api.authenticate();
    expect(result).toEqual({
      ok: true,
      data: { id: 1, shortName: 'Иванова И.И.', mustChangePassword: false },
    });
    expect(JSON.stringify(result)).not.toMatch(/csrf|private-field|example|permissions/);
    expect(api.owner).toBe(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth/me');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', redirect: 'manual' });
  });
  it('одновременная проверка входа объединяется', async () => {
    const { fetch, api } = setup();
    let finish: ((r: Response) => void) | undefined;
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = api.authenticate(),
      second = api.authenticate();
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish?.(json(me()));
    expect((await first).ok).toBe(true);
  });
  it('негодные обязательные поля входа не становятся готовым сеансом', async () => {
    const { fetch, api } = setup();
    fetch.mockResolvedValueOnce(json({ ...me(), csrfToken: null }));
    expect(await api.authenticate()).toMatchObject({ ok: false, code: 'invalid_data' });
    expect(api.owner).toBeNull();
    expect(await api.listChats()).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('отправка использует личный csrf и один постоянный idempotency-key', async () => {
    const { fetch, api } = setup();
    fetch.mockResolvedValueOnce(json(me())).mockResolvedValueOnce(json(message, 201));
    await api.authenticate();
    expect(await api.send(4, ' Проверка ', 'desk-test-0001')).toEqual({ ok: true, data: message });
    const [path, init] = fetch.mock.calls[1] ?? [];
    expect(path).toBe('/api/chats/4/messages');
    expect(init?.method).toBe('POST');
    expect(headers(init).get('x-csrf-token')).toBe('csrf-private-A');
    expect(headers(init).get('idempotency-key')).toBe('desk-test-0001');
    expect(headers(init).get('authorization')).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Проверка' });
  });
  it('сетевая ошибка отправки остаётся неподтверждённой и не вызывает повтор', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockRejectedValueOnce(new Error('private text and cookie'));
    await api.authenticate();
    const result = await api.send(4, 'Проверка', 'desk-test-0001');
    expect(result).toMatchObject({ ok: false, code: 'network', uncertain: true });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('негодное тело успешного POST не означает, что сообщение не записано', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(new Response('private body', { status: 201 }));
    await api.authenticate();
    const result = await api.send(4, 'Проверка', 'desk-test-0001');
    expect(result).toMatchObject({ ok: false, code: 'invalid_data', uncertain: true });
    expect(JSON.stringify(result)).not.toContain('private body');
  });
  it('403 csrf обновляет ключ и повторяет только тот же payload и ключ отправки', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(error('csrf', 403))
      .mockResolvedValueOnce(json(me(1, 'csrf-private-B')))
      .mockResolvedValueOnce(json(message, 201));
    await api.authenticate();
    expect((await api.send(4, 'Проверка', 'desk-test-0001')).ok).toBe(true);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      '/api/auth/me',
      '/api/chats/4/messages',
      '/api/auth/me',
      '/api/chats/4/messages',
    ]);
    expect(headers(fetch.mock.calls[1]?.[1]).get('x-csrf-token')).toBe('csrf-private-A');
    expect(headers(fetch.mock.calls[3]?.[1]).get('x-csrf-token')).toBe('csrf-private-B');
    expect(headers(fetch.mock.calls[3]?.[1]).get('idempotency-key')).toBe('desk-test-0001');
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[3]?.[1]?.body);
  });
  it('повторный csrf не запускает бесконечную авторизацию', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(error('csrf', 403))
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(error('csrf', 403));
    await api.authenticate();
    expect(await api.send(4, 'Проверка', 'desk-test-0001')).toMatchObject({
      ok: false,
      code: 'csrf',
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('ключ, ошибочно повторённый с другим текстом, не подтверждает новую отправку старым ответом', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(json({ ...message, text: 'Прежний текст' }));
    await api.authenticate();
    expect(await api.send(4, 'Новый текст', 'desk-test-0001')).toMatchObject({
      ok: false,
      code: 'invalid_data',
      uncertain: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('смена пользователя во время csrf-refresh не отправляет текст предыдущего пользователя', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(error('csrf', 403))
      .mockResolvedValueOnce(json(me(2, 'other-user-csrf')));
    await api.authenticate();
    const epoch = api.epoch;
    expect(await api.send(4, 'Прежний текст', 'desk-test-0001')).toMatchObject({
      ok: false,
      code: 'stale_session',
    });
    expect(api.owner).toBe(2);
    expect(api.epoch).toBeGreaterThan(epoch);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('поздний 401 прежнего epoch не закрывает новый вход', async () => {
    const { fetch, api, onAuthLost } = setup();
    let finish: ((r: Response) => void) | undefined;
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(json(me(2, 'other-csrf')));
    await api.authenticate();
    const old = api.listChats();
    const oldSignal = fetch.mock.calls[1]?.[1]?.signal;
    api.clear();
    await api.authenticate();
    finish?.(error('unauthenticated', 401));
    expect(await old).toMatchObject({ ok: false, code: 'stale_session' });
    expect(oldSignal?.aborted).toBe(true);
    expect(api.owner).toBe(2);
    expect(onAuthLost).not.toHaveBeenCalled();
  });
  it('401 текущего сеанса очищает csrf и сообщает владельцу приложения', async () => {
    const { fetch, api, onAuthLost } = setup();
    fetch.mockResolvedValueOnce(json(me())).mockResolvedValueOnce(error('unauthenticated', 401));
    await api.authenticate();
    expect(await api.listChats()).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(api.owner).toBeNull();
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });
  it('обычный 403 не закрывает вход и не возвращает серверный текст', async () => {
    const { fetch, api, onAuthLost } = setup();
    fetch.mockResolvedValueOnce(json(me())).mockResolvedValueOnce(error('forbidden', 403));
    await api.authenticate();
    const result = await api.listChats();
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    expect(JSON.stringify(result)).not.toContain('private-server-message');
    expect(api.owner).toBe(1);
    expect(onAuthLost).not.toHaveBeenCalled();
  });
  it('401 с незавершённым не-JSON телом немедленно закрывает текущий вход', async () => {
    const { fetch, api, onAuthLost } = setup();
    const cancel = vi.fn();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 401 }),
      );
    await api.authenticate();
    expect(await api.listChats()).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(api.owner).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });
  it('временный пароль не допускает команды, но явный выход доступен', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me(1, 'csrf-private-A', true)))
      .mockResolvedValueOnce(json({ ok: true }));
    await api.authenticate();
    expect(await api.listChats()).toMatchObject({ ok: false, code: 'password_change_required' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await api.logout()).toEqual({ ok: true, data: null });
    expect(api.owner).toBeNull();
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/auth/logout');
  });
  it('неизвестный исход logout всё равно закрывает локальный сеанс', async () => {
    const { fetch, api } = setup();
    fetch.mockResolvedValueOnce(json(me())).mockRejectedValueOnce(new Error('offline'));
    await api.authenticate();
    expect(await api.logout()).toMatchObject({ ok: false, code: 'network', uncertain: true });
    expect(api.owner).toBeNull();
  });
  it('дедлайн охватывает fetch даже если transport игнорирует AbortSignal', async () => {
    const { fetch, api } = setup();
    fetch.mockResolvedValueOnce(json(me())).mockImplementationOnce(() => new Promise(() => {}));
    await api.authenticate();
    vi.useFakeTimers();
    const sent = api.send(4, 'Проверка', 'desk-test-0001');
    await vi.advanceTimersByTimeAsync(15000);
    expect(await sent).toMatchObject({ ok: false, code: 'timeout', uncertain: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('дедлайн также прерывает зависшее чтение тела ответа', async () => {
    const { fetch, api } = setup();
    const cancel = vi.fn();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await api.authenticate();
    vi.useFakeTimers();
    const pending = api.listChats();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({ ok: false, code: 'timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(['header', 'stream'] as const)(
    'ответ более 2 MiB (%s) отменяется и не считается результатом POST',
    async (kind) => {
      const { fetch, api } = setup();
      const body = new Uint8Array(2 * 1024 * 1024 + 1);
      const response =
        kind === 'header'
          ? new Response('{}', { headers: { 'content-length': String(body.length) } })
          : new Response(body);
      fetch.mockResolvedValueOnce(json(me())).mockResolvedValueOnce(response);
      await api.authenticate();
      expect(await api.send(4, 'Проверка', 'desk-test-0001')).toMatchObject({
        ok: false,
        code: 'payload_too_large',
        uncertain: true,
      });
      expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    },
  );
});

describe('TeamsApi: конечные маршруты и недоверенные DTO', () => {
  it('health доступен без входа и сохраняет диагностику 503 с версией', async () => {
    const { fetch, api } = setup();
    fetch.mockResolvedValueOnce(
      json({ status: 'error', db: 'down', version: '0.11.2', future: 1 }, 503),
    );
    expect(await api.health()).toEqual({
      ok: true,
      data: { status: 'error', db: 'down', version: '0.11.2' },
    });
    expect(headers(fetch.mock.calls[0]?.[1]).get('x-csrf-token')).toBeNull();
  });
  it('список проецируется без неизвестных полей, но обязательный unread проверяется', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(
        json({
          items: [{ ...chat, unexpected: 'private' }],
          unreadTotal: 3,
          unexpected: 'private',
        }),
      )
      .mockResolvedValueOnce(json({ items: [{ ...chat, unread: -1 }], unreadTotal: 3 }));
    await api.authenticate();
    expect(await api.listChats()).toEqual({ ok: true, data: { items: [chat], unreadTotal: 3 } });
    expect(await api.listChats()).toMatchObject({ ok: false, code: 'invalid_data' });
  });
  it('история вокруг сообщения использует явный курсор, а не смещение', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(json({ items: [message], hasMore: true, hasNewer: false }));
    await api.authenticate();
    expect((await api.messages(4, { around: 10 })).ok).toBe(true);
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/chats/4/messages?around=10');
  });
  it('сообщение другого разговора не попадает в текущую ленту', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(
        json({ items: [{ ...message, chatId: 5 }], hasMore: false, hasNewer: false }),
      );
    await api.authenticate();
    expect(await api.messages(4)).toMatchObject({ ok: false, code: 'invalid_data' });
  });
  it('невалидные ID, курсоры и текст не достигают HTTP', async () => {
    const { fetch, api } = setup();
    fetch.mockResolvedValueOnce(json(me()));
    await api.authenticate();
    for (const action of [
      () => api.detail(0),
      () => api.messages(4, { before: 1, after: 2 }),
      () => api.messages(4, null as never),
      () => api.send(4, '', 'desk-test-0001'),
      () => api.send(4, 'текст', 'bad'),
      () => api.send(4, 'x'.repeat(4001), 'desk-test-0001'),
      () => api.read(4, -1),
      () => api.readNotification(0),
      () => api.notifications(-1),
      () => api.setFocus('not a date'),
    ])
      expect(await action()).toMatchObject({ ok: false, code: 'validation' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('фокус и прочтение вызывают ограниченные маршруты с CSRF', async () => {
    const { fetch, api } = setup();
    fetch
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(json({ until: null, startedAt: null }))
      .mockResolvedValueOnce(json({ unread: 0 }))
      .mockResolvedValueOnce(json({ ok: true }));
    await api.authenticate();
    expect(await api.setFocus(null)).toEqual({ ok: true, data: { until: null, startedAt: null } });
    expect(await api.readNotification('all')).toEqual({ ok: true, data: { unread: 0 } });
    expect(await api.read(4, 10)).toEqual({ ok: true, data: null });
    expect(fetch.mock.calls.slice(1).map(([path, init]) => [path, init?.method])).toEqual([
      ['/api/focus', 'PUT'],
      ['/api/notifications/read-all', 'POST'],
      ['/api/chats/4/read', 'POST'],
    ]);
    for (const [, init] of fetch.mock.calls.slice(1))
      expect(headers(init).get('x-csrf-token')).toBe('csrf-private-A');
  });
});
