import { describe, expect, it, vi } from 'vitest';
import { PHOTO_LIMIT, TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import { AvatarService, type AvatarApi } from '../../src/main/files/avatars';
import { profilePhoto } from '../../src/main/api/parse';

const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
]);
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

async function authenticated() {
  const fetch = vi.fn<TeamsApiOptions['fetch']>();
  const api = new TeamsApi({ fetch, onAuthLost: vi.fn() });
  fetch.mockResolvedValueOnce(
    json({
      user: { id: 1, shortName: 'Иванова И.И.', mustChangePassword: false },
      csrfToken: 'csrf-test-only',
    }),
  );
  expect((await api.authenticate()).ok).toBe(true);
  return { api, fetch };
}

describe('TeamsApi: фото профиля', () => {
  it('скачивает фото без заранее известного размера, по cookie', async () => {
    const { api, fetch } = await authenticated();
    fetch.mockResolvedValueOnce(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    expect(await api.photo(42)).toEqual({ ok: true, data: { bytes: PNG, mime: 'image/png' } });
    const [path, init] = fetch.mock.calls[1] ?? [];
    expect(path).toBe('/api/files/42');
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
  });
  it('фото больше предела и пустой ответ — отказ', async () => {
    const { api, fetch } = await authenticated();
    fetch.mockResolvedValueOnce(
      new Response(PNG, { headers: { 'content-length': String(PHOTO_LIMIT + 1) } }),
    );
    expect(await api.photo(1)).toMatchObject({ ok: false });
    fetch.mockResolvedValueOnce(new Response(new Uint8Array(0)));
    expect(await api.photo(1)).toMatchObject({ ok: false });
  });
  it('404 — нет фото; негодный ид — без запроса', async () => {
    const { api, fetch } = await authenticated();
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await api.photo(5)).toMatchObject({ ok: false, code: 'not_found' });
    const before = fetch.mock.calls.length;
    expect(await api.photo(0)).toMatchObject({ ok: false, code: 'validation' });
    expect(fetch.mock.calls.length).toBe(before);
  });
  it('из профиля берётся только ид фото', () => {
    expect(profilePhoto({ id: 1, photoFileId: 7, phone: '…' })).toBe(7);
    expect(profilePhoto({ id: 1, photoFileId: null })).toBeNull();
    expect(profilePhoto({ id: 1 })).toBeNull();
    expect(() => profilePhoto({ photoFileId: 'x' })).toThrow();
  });
});

function service(answers: Record<number, Uint8Array | null>) {
  let now = 0;
  const api = {
    epoch: 1,
    owner: 'u1' as unknown,
    photo: vi.fn(async (id: number) => {
      const bytes = answers[id];
      return bytes
        ? { ok: true as const, data: { bytes, mime: 'application/octet-stream' } }
        : { ok: false as const, code: 'not_found' as const, retryable: false, error: 'нет' };
    }),
  } satisfies AvatarApi & { epoch: number; owner: unknown };
  const avatars = new AvatarService({ api, now: () => now });
  return { api, avatars, tick: (ms: number) => (now += ms) };
}
const get = (avatars: AvatarService, url: string, method = 'GET') =>
  avatars.response(new Request(url, { method }));

describe('AvatarService', () => {
  it('отдаёт картинку с типом по содержимому, повтор — из памяти', async () => {
    const { api, avatars } = service({ 3: PNG });
    const r = await get(avatars, 'schema-attachment://avatar/3');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
    await get(avatars, 'schema-attachment://avatar/3');
    expect(api.photo).toHaveBeenCalledTimes(1);
  });
  it('не картинка, нет фото, негодный адрес или метод — 404', async () => {
    const { api, avatars } = service({ 4: new Uint8Array([60, 104, 116, 109, 108, 62]) });
    expect((await get(avatars, 'schema-attachment://avatar/4')).status).toBe(404);
    expect((await get(avatars, 'schema-attachment://avatar/9')).status).toBe(404);
    for (const url of [
      'schema-attachment://avatar/0',
      'schema-attachment://avatar/1.5',
      'schema-attachment://avatar/../preview/x',
      'schema-attachment://avatar/',
    ])
      expect((await get(avatars, url)).status).toBe(404);
    expect((await get(avatars, 'schema-attachment://avatar/4', 'POST')).status).toBe(404);
    expect(api.photo).toHaveBeenCalledTimes(2);
  });
  it('промах спрашивается снова через 10 минут, удача — нет', async () => {
    const answers: Record<number, Uint8Array | null> = { 5: null, 6: PNG };
    const { api, avatars, tick } = service(answers);
    await get(avatars, 'schema-attachment://avatar/5');
    await get(avatars, 'schema-attachment://avatar/6');
    answers[5] = PNG;
    tick(60_000);
    expect((await get(avatars, 'schema-attachment://avatar/5')).status).toBe(404);
    tick(10 * 60_000);
    expect((await get(avatars, 'schema-attachment://avatar/5')).status).toBe(200);
    await get(avatars, 'schema-attachment://avatar/6');
    expect(api.photo).toHaveBeenCalledTimes(3);
  });
  it('смена входа и выход: фото прежнего пользователя не отдаётся из памяти', async () => {
    const { api, avatars } = service({ 3: PNG });
    await get(avatars, 'schema-attachment://avatar/3');
    api.epoch = 2;
    await get(avatars, 'schema-attachment://avatar/3');
    expect(api.photo).toHaveBeenCalledTimes(2);
    api.owner = null;
    expect((await get(avatars, 'schema-attachment://avatar/3')).status).toBe(404);
    avatars.stop();
    api.owner = 'u1';
    expect((await get(avatars, 'schema-attachment://avatar/3')).status).toBe(404);
  });
  it('HEAD — без тела', async () => {
    const { avatars } = service({ 3: PNG });
    const r = await get(avatars, 'schema-attachment://avatar/3', 'HEAD');
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });
});
