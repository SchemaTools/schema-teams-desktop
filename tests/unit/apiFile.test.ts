import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_LIMIT, TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const me = (mustChangePassword = false) => ({
  user: { id: 1, shortName: 'Иванова И.И.', mustChangePassword },
  csrfToken: 'csrf-test-only',
});
const setup = () => {
  const fetch = vi.fn<TeamsApiOptions['fetch']>();
  const onAuthLost = vi.fn();
  return { fetch, onAuthLost, api: new TeamsApi({ fetch, onAuthLost }) };
};
async function authenticated() {
  const h = setup();
  h.fetch.mockResolvedValueOnce(json(me()));
  expect((await h.api.authenticate()).ok).toBe(true);
  return h;
}

afterEach(() => vi.useRealTimers());

describe('TeamsApi: бинарное скачивание вложения', () => {
  it('запрашивает только ID по cookie и возвращает main DTO с байтами и MIME', async () => {
    const { api, fetch } = await authenticated();
    const bytes = new Uint8Array([255, 0, 42]);
    fetch.mockResolvedValueOnce(
      new Response(bytes, {
        headers: { 'content-type': 'IMAGE/PNG; charset=binary', 'content-length': '3' },
      }),
    );
    expect(await api.download(42, 3)).toEqual({
      ok: true,
      data: { bytes, mime: 'image/png' },
    });
    const [path, init] = fetch.mock.calls[1] ?? [];
    expect(path).toBe('/api/files/42');
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', redirect: 'manual' });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('x-csrf-token')).toBeNull();
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('принимает файл нулевого размера и использует безопасный MIME по умолчанию', async () => {
    const { api, fetch } = await authenticated();
    fetch.mockResolvedValueOnce(new Response(new Uint8Array(0)));
    expect(await api.download(1, 0)).toEqual({
      ok: true,
      data: { bytes: new Uint8Array(0), mime: 'application/octet-stream' },
    });
  });

  it('проверяет ID и объявленный размер до обращения к сети', async () => {
    const { api, fetch } = await authenticated();
    for (const fileId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(await api.download(fileId, 1)).toMatchObject({ ok: false, code: 'validation' });
    for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, FILE_LIMIT + 1])
      expect(await api.download(1, size)).toMatchObject({ ok: false, code: 'validation' });
    expect(FILE_LIMIT).toBe(50 * 1024 * 1024);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('до входа и при обязательной смене пароля файл не скачивается', async () => {
    const { api, fetch } = setup();
    expect(await api.download(1, 1)).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(json(me(true)));
    await api.authenticate();
    expect(await api.download(1, 1)).toMatchObject({
      ok: false,
      code: 'password_change_required',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ограничивает реальные chunks объявленным размером и без Content-Length', async () => {
    const { api, fetch } = await authenticated();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3, 4]));
          },
          cancel,
        }),
      ),
    );
    expect(await api.download(1, 3)).toMatchObject({ ok: false, code: 'payload_too_large' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('отвергает усечённое тело, даже если Content-Length совпал с полученным', async () => {
    const { api, fetch } = await authenticated();
    fetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2]), { headers: { 'content-length': '2' } }),
    );
    expect(await api.download(1, 3)).toMatchObject({ ok: false, code: 'invalid_file' });
  });

  it('не начинает чтение тела с Content-Length больше ожидаемого размера', async () => {
    const { api, fetch } = await authenticated();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { 'content-length': '4' },
      }),
    );
    expect(await api.download(1, 3)).toMatchObject({ ok: false, code: 'payload_too_large' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 303, 307, 308])('не следует redirect %s на другой адрес', async (status) => {
    const { api, fetch } = await authenticated();
    fetch.mockResolvedValueOnce(
      new Response(null, { status, headers: { location: 'https://example.invalid/private' } }),
    );
    expect(await api.download(1, 1)).toMatchObject({ ok: false, code: 'invalid_data' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.redirect).toBe('manual');
  });

  it('401 очищает прежний вход и не читает HTML или зависшее тело ответа', async () => {
    const { api, fetch, onAuthLost } = await authenticated();
    const cancel = vi.fn();
    const epoch = api.epoch;
    fetch.mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        status: 401,
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(await api.download(1, 1)).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(api.owner).toBeNull();
    expect(api.epoch).toBeGreaterThan(epoch);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await api.download(1, 1)).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'server_error'],
  ] as const)('%s возвращает безопасную ошибку без содержимого ответа', async (status, code) => {
    const { api, fetch, onAuthLost } = await authenticated();
    fetch.mockResolvedValueOnce(new Response('private-response-fixture', { status }));
    const result = await api.download(1, 1);
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain('private-response-fixture');
    expect(api.owner).toBe(1);
    expect(onAuthLost).not.toHaveBeenCalled();
  });

  it('смена epoch во время чтения отменяет поток и не возвращает старые байты', async () => {
    const { api, fetch } = await authenticated();
    const cancel = vi.fn();
    let started: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          pull() {
            started?.();
          },
          cancel,
        }),
      ),
    );
    const download = api.download(1, 2);
    await reading;
    api.clear();
    expect(await download).toMatchObject({ ok: false, code: 'stale_session' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });

  it('бинарный поток получает 60 секунд, после чего отменяется без автоматического повтора', async () => {
    const { api, fetch } = await authenticated();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
    vi.useFakeTimers();
    const download = api.download(1, 1);
    let settled = false;
    void download.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(59999);
    expect(settled).toBe(false);
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await download).toMatchObject({ ok: false, code: 'timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
