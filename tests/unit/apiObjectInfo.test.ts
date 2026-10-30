import { describe, expect, it, vi } from 'vitest';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import type { ChatDetail, ObjectInfo } from '../../src/shared/client';
import { requestValid } from '../../src/shared/requests';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (id = 1) => ({
  user: { id, shortName: 'Иванова И.И.', mustChangePassword: false },
  csrfToken: 'fixture-csrf',
});
const detail = (): ChatDetail => ({
  chat: {
    id: 4,
    kind: 'object',
    title: 'ОБ-А · Объект А',
    peer: null,
    objectId: 7,
    objectCode: 'ОБ-А',
    memberCount: 2,
    last: null,
    unread: 0,
    mentioned: false,
    photoFileId: null,
  },
  members: [],
  canManageMembers: false,
  canLeave: false,
  canWrite: true,
  canPin: true,
  pinned: null,
  taskStageId: null,
});
const info = (): ObjectInfo => ({
  id: 7,
  code: 'ОБ-А',
  name: 'Объект А',
  fullName: null,
  client: 'Тестовый заказчик',
  address: null,
  status: 'active',
  statusNote: null,
  gip: { id: 1, shortName: 'Иванова И.И.' },
  gap: null,
  pm: null,
  folderRoot: '\\\\server\\share\\object-a',
  modelPath: null,
  currentStageId: 71,
  stages: [
    {
      id: 71,
      code: 'Р',
      name: 'Рабочая документация',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      closed: false,
    },
  ],
});
async function setup() {
  const fetch = vi.fn<TeamsApiOptions['fetch']>().mockResolvedValueOnce(json(me()));
  const api = new TeamsApi({ fetch });
  await api.authenticate();
  return { api, fetch };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
describe('TeamsApi: read-only object information mapped through authorized chat', () => {
  it('maps object ID from chat detail and projects only needed fields', async () => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json(detail())).mockResolvedValueOnce(
      json({
        ...info(),
        csrfToken: 'private-value',
        internal: { secret: 'private-value' },
        version: 8,
      }),
    );
    expect(await h.api.objectInfo(4)).toEqual({ ok: true, data: info() });
    expect(h.fetch.mock.calls.map((c) => c[0])).toEqual([
      '/api/auth/me',
      '/api/chats/4',
      '/api/objects/7',
    ]);
    expect(h.fetch.mock.calls[2]?.[1]).toMatchObject({ method: 'GET', credentials: 'include' });
  });
  it.each(['direct', 'group', 'bureau'] as const)(
    'does not call an object route for %s chat',
    async (kind) => {
      const h = await setup(),
        d = detail();
      d.chat = { ...d.chat, kind, objectId: null };
      h.fetch.mockResolvedValueOnce(json(d));
      expect(await h.api.objectInfo(4)).toMatchObject({ ok: false, code: 'validation' });
      expect(h.fetch).toHaveBeenCalledTimes(2);
    },
  );
  it('does not accept an object ID from renderer IPC', () => {
    expect(requestValid({ kind: 'chat.objectInfo', epoch: 7, chatId: 4 })).toBe(true);
    for (const request of [
      { kind: 'chat.objectInfo', epoch: 7, chatId: 4, objectId: 8 },
      { kind: 'chat.objectInfo', epoch: 7, chatId: 0 },
      { kind: 'chat.objectInfo', chatId: 4 },
      { kind: 'chat.objectInfo', epoch: 7, chatId: 4, url: '/api/objects/8' },
    ])
      expect(requestValid(request)).toBe(false);
  });
  it('rejects invalid chat ID before network', async () => {
    const h = await setup();
    expect(await h.api.objectInfo(0)).toMatchObject({ ok: false, code: 'validation' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it('stops when chat membership is denied', async () => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404));
    expect(await h.api.objectInfo(4)).toMatchObject({ ok: false, code: 'not_found' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it('does not turn object access denial into object data', async () => {
    const h = await setup();
    h.fetch
      .mockResolvedValueOnce(json(detail()))
      .mockResolvedValueOnce(
        json({ error: { code: 'forbidden', message: 'private detail' } }, 403),
      );
    const result = await h.api.objectInfo(4);
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    expect(JSON.stringify(result)).not.toContain('private detail');
  });
  it.each([
    { id: 8 },
    { status: 'future-status' },
    { currentStageId: 72 },
    { stages: [{ ...info().stages[0], startDate: '2026-02-30' }] },
    { stages: [info().stages[0], info().stages[0]] },
    { gip: { id: 0, shortName: 'Invalid' } },
  ])('rejects mismatched or malformed object response %j', async (change) => {
    const h = await setup();
    h.fetch
      .mockResolvedValueOnce(json(detail()))
      .mockResolvedValueOnce(json({ ...info(), ...change }));
    expect(await h.api.objectInfo(4)).toMatchObject({ ok: false, code: 'invalid_data' });
  });
  it('accepts nullable metadata, archived object and no selected stage', async () => {
    const h = await setup(),
      value: ObjectInfo = {
        ...info(),
        status: 'archive',
        currentStageId: null,
        stages: [],
        gip: null,
        client: null,
        folderRoot: null,
      };
    h.fetch.mockResolvedValueOnce(json(detail())).mockResolvedValueOnce(json(value));
    expect(await h.api.objectInfo(4)).toEqual({ ok: true, data: value });
  });
  it('never requests object data after session changes during chat lookup', async () => {
    const h = await setup(),
      wait = deferred<Response>();
    h.fetch.mockReturnValueOnce(wait.promise);
    const pending = h.api.objectInfo(4);
    h.api.clear();
    expect(await pending).toMatchObject({ ok: false, code: 'stale_session' });
    wait.resolve(json(detail()));
    await new Promise((done) => setImmediate(done));
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it('drops a late object response after another user signs in', async () => {
    const h = await setup(),
      wait = deferred<Response>();
    h.fetch.mockResolvedValueOnce(json(detail())).mockReturnValueOnce(wait.promise);
    const pending = h.api.objectInfo(4);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(3));
    h.api.clear();
    h.fetch.mockResolvedValueOnce(json(me(2)));
    await h.api.authenticate();
    wait.resolve(json(info()));
    expect(await pending).toMatchObject({ ok: false, code: 'stale_session' });
    expect(h.api.owner).toBe(2);
  });
});
