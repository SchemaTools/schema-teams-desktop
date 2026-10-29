import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import { validateUpload, MAX_UPLOAD_BYTES } from '../../src/main/files/uploadPolicy';
import type { ChatFile, ChatMessage } from '../../src/shared/client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = (id = 1, csrf = 'csrf-A', mustChangePassword = false) => ({
  user: { id, shortName: 'Иванова И.И.', mustChangePassword },
  csrfToken: csrf,
});
const file = (fileId = 90): ChatFile => ({
  fileId,
  fileName: 'План объекта А.txt',
  size: 4,
  mime: 'application/octet-stream',
  isImage: false,
});
const message = (files: ChatFile[] = [], text = 'Проверка'): ChatMessage => ({
  id: 10,
  chatId: 4,
  author: { id: 1, shortName: 'Иванова И.И.' },
  text,
  at: '2026-10-29T09:00:00Z',
  editedAt: null,
  deleted: false,
  replyTo: null,
  files,
  mentions: [],
  links: [],
  canEdit: true,
  reactions: [],
  cards: [],
  sticker: null,
  poll: null,
});
const error = (code: string, status: number) =>
  json({ error: { code, message: 'private error detail' } }, status);
async function setup(id = 1, mustChangePassword = false) {
  const fetch = vi.fn<TeamsApiOptions['fetch']>(),
    onAuthLost = vi.fn();
  const api = new TeamsApi({ fetch, onAuthLost });
  fetch.mockResolvedValueOnce(json(session(id, 'csrf-A', mustChangePassword)));
  await api.authenticate();
  return { api, fetch, onAuthLost };
}
const bytes = () => new Uint8Array([1, 2, 3, 4]);
const headers = (init?: RequestInit) => new Headers(init?.headers);
afterEach(() => vi.useRealTimers());

describe('TeamsApi: сообщения с предварительно загруженными файлами', () => {
  it('отправляет файл без текста и проверяет исходные fileIds в ответе', async () => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json(message([file()], ''), 201));
    expect(await h.api.send(4, '', 'send-files-0001', [90])).toEqual({
      ok: true,
      data: message([file()], ''),
    });
    const [path, init] = h.fetch.mock.calls[1] ?? [];
    expect(path).toBe('/api/chats/4/messages');
    expect(JSON.parse(String(init?.body))).toEqual({ text: '', fileIds: [90] });
    expect(headers(init).get('idempotency-key')).toBe('send-files-0001');
    expect(headers(init).get('x-csrf-token')).toBe('csrf-A');
  });
  it('сохраняет прежний формат текстового сообщения без fileIds', async () => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json(message(), 201));
    expect((await h.api.send(4, ' Проверка ', 'send-files-0001')).ok).toBe(true);
    expect(JSON.parse(String(h.fetch.mock.calls[1]?.[1]?.body))).toEqual({ text: 'Проверка' });
  });
  it('принимает иной порядок того же набора файлов, не смешивая идентификаторы', async () => {
    const h = await setup();
    const reply = message([file(91), file(90)]);
    h.fetch.mockResolvedValueOnce(json(reply));
    expect(await h.api.send(4, 'Проверка', 'send-files-0001', [90, 91])).toEqual({
      ok: true,
      data: reply,
    });
  });
  it('не доверяет неверным идентификаторам, дублям и превышению 10 файлов', async () => {
    const h = await setup();
    for (const ids of [[0], [-1], [90, 90], Array.from({ length: 11 }, (_, i) => i + 1)])
      expect(await h.api.send(4, 'Проверка', 'send-files-0001', ids)).toMatchObject({
        ok: false,
        code: 'validation',
      });
    expect(await h.api.send(4, '', 'send-files-0001', [])).toMatchObject({
      ok: false,
      code: 'validation',
    });
    expect(await h.api.send(4, '', 'send-files-0001', null as unknown as number[])).toMatchObject({
      ok: false,
      code: 'validation',
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    message([file(91)]),
    message([]),
    { ...message([file()]), author: { id: 2, shortName: 'Петров П.П.' } },
    { ...message([file()]), chatId: 5 },
    { ...message([file()]), text: 'Другое сообщение' },
  ])('не объявляет чужой или изменённый ответ подтверждением отправки %#', async (reply) => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json(reply, 201));
    expect(await h.api.send(4, 'Проверка', 'send-files-0001', [90])).toMatchObject({
      ok: false,
      code: 'invalid_data',
      uncertain: true,
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it('после неизвестного исхода явный повтор использует тот же payload и ключ', async () => {
    const h = await setup();
    h.fetch
      .mockRejectedValueOnce(Error('private'))
      .mockResolvedValueOnce(json(message([file()]), 200));
    expect(await h.api.send(4, 'Проверка', 'send-files-0001', [90])).toMatchObject({
      ok: false,
      uncertain: true,
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect((await h.api.send(4, 'Проверка', 'send-files-0001', [90])).ok).toBe(true);
    expect(h.fetch.mock.calls[1]?.[1]?.body).toBe(h.fetch.mock.calls[2]?.[1]?.body);
    expect(headers(h.fetch.mock.calls[1]?.[1]).get('idempotency-key')).toBe(
      headers(h.fetch.mock.calls[2]?.[1]).get('idempotency-key'),
    );
  });
});

describe('TeamsApi: загрузка байтов в чат', () => {
  it('посылает байты по cookie с CSRF и encoded X-File-Name, без JSON-обёртки', async () => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json(file(), 201));
    expect(await h.api.upload(4, bytes(), file().fileName, 'text/plain')).toEqual({
      ok: true,
      data: file(),
    });
    const [path, init] = h.fetch.mock.calls[1] ?? [];
    expect(path).toBe('/api/chats/4/files');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'manual' });
    expect(headers(init).get('content-type')).toBe('application/octet-stream');
    expect(headers(init).get('x-file-name')).toBe(encodeURIComponent(file().fileName));
    expect(headers(init).get('x-csrf-token')).toBe('csrf-A');
    expect(headers(init).get('authorization')).toBeNull();
    expect([...new Uint8Array(init?.body as ArrayBuffer)]).toEqual([...bytes()]);
  });
  it('403 csrf обновляет только ключ, один раз повторяет те же байты и имя', async () => {
    const h = await setup(),
      original = bytes();
    h.fetch
      .mockImplementationOnce(async () => {
        original[0] = 99;
        return error('csrf', 403);
      })
      .mockResolvedValueOnce(json(session(1, 'csrf-B')))
      .mockResolvedValueOnce(json(file(), 201));
    expect((await h.api.upload(4, original, file().fileName, 'text/plain')).ok).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(4);
    const first = h.fetch.mock.calls[1]?.[1],
      second = h.fetch.mock.calls[3]?.[1];
    expect([...new Uint8Array(first?.body as ArrayBuffer)]).toEqual([1, 2, 3, 4]);
    expect([...new Uint8Array(second?.body as ArrayBuffer)]).toEqual([1, 2, 3, 4]);
    expect(headers(second).get('x-csrf-token')).toBe('csrf-B');
    expect(headers(first).get('x-file-name')).toBe(headers(second).get('x-file-name'));
  });
  it('второй 403 csrf больше не повторяется', async () => {
    const h = await setup();
    h.fetch
      .mockResolvedValueOnce(error('csrf', 403))
      .mockResolvedValueOnce(json(session(1, 'csrf-B')))
      .mockResolvedValueOnce(error('csrf', 403));
    expect(await h.api.upload(4, bytes(), file().fileName, 'text/plain')).toMatchObject({
      ok: false,
      code: 'csrf',
    });
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });
  it('не отправляет без входа или при обязательной смене пароля', async () => {
    const fetch = vi.fn<TeamsApiOptions['fetch']>(),
      api = new TeamsApi({ fetch });
    expect(await api.upload(4, bytes(), file().fileName, 'text/plain')).toMatchObject({
      ok: false,
      code: 'unauthenticated',
    });
    expect(fetch).not.toHaveBeenCalled();
    const h = await setup(1, true);
    expect(await h.api.upload(4, bytes(), file().fileName, 'text/plain')).toMatchObject({
      ok: false,
      code: 'password_change_required',
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, { ...file(), fileName: 'another.txt' }, { ...file(), size: 999 }])(
    'не принимает повреждённый или не тот ChatFile %#',
    async (body) => {
      const h = await setup();
      h.fetch.mockResolvedValueOnce(json(body, 201));
      expect(await h.api.upload(4, bytes(), file().fileName, 'text/plain')).toMatchObject({
        ok: false,
        code: 'invalid_data',
        uncertain: true,
      });
    },
  );
  it.each([
    error('forbidden', 403),
    error('not_found', 404),
    error('forbidden_type', 400),
    error('too_large', 400),
  ])('возвращает безопасную серверную ошибку без повтора %#', async (response) => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(response);
    const r = await h.api.upload(4, bytes(), file().fileName, 'text/plain');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('private error detail');
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it('смена входа при CSRF refresh не переносит старую загрузку новому пользователю', async () => {
    const h = await setup();
    h.fetch
      .mockResolvedValueOnce(error('csrf', 403))
      .mockResolvedValueOnce(json(session(2, 'csrf-B')));
    expect(await h.api.upload(4, bytes(), file().fileName, 'text/plain')).toMatchObject({
      ok: false,
      code: 'stale_session',
    });
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it('выход во время запроса прерывает сигнал и отвергает поздний ответ', async () => {
    const h = await setup();
    let finish: ((r: Response) => void) | undefined;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.api.upload(4, bytes(), file().fileName, 'text/plain');
    h.api.clear();
    finish?.(json(file(), 201));
    expect(await pending).toMatchObject({ ok: false, code: 'stale_session' });
    expect(h.fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });
  it('тайм-аут 60 секунд остаётся неизвестным исходом без скрытого повтора', async () => {
    vi.useFakeTimers();
    const h = await setup();
    h.fetch.mockImplementationOnce(() => new Promise(() => {}));
    const pending = h.api.upload(4, bytes(), file().fileName, 'text/plain');
    await vi.advanceTimersByTimeAsync(60000);
    expect(await pending).toMatchObject({ ok: false, code: 'timeout', uncertain: true });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it('проверяет ID и байты до сети', async () => {
    const h = await setup();
    expect(await h.api.upload(0, bytes(), file().fileName, 'text/plain')).toMatchObject({
      ok: false,
      code: 'validation',
    });
    expect(await h.api.upload(4, new Uint8Array(0), file().fileName, 'text/plain')).toMatchObject({
      ok: false,
      code: 'validation',
    });
    expect(
      await h.api.upload(4, new Uint8Array(MAX_UPLOAD_BYTES + 1), file().fileName, 'text/plain'),
    ).toMatchObject({ ok: false, code: 'validation' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Локальная проверка upload до любых HTTP-запросов', () => {
  it.each([
    '../file.txt',
    'folder/file.txt',
    'a\\b.txt',
    'a.txt:stream',
    'CON .txt',
    'LPT1.pdf',
    ' файл.txt',
    'file.txt.',
    'file\r\n.txt',
    'file.exe',
    'file.HTML',
    'file.svg',
    'file.lnk',
    'file.reg',
    'file.jse',
    'file.jſ',
  ])('отвергает опасное имя %s', (name) =>
    expect(validateUpload(name, bytes(), 'text/plain')).toBeNull(),
  );
  it.each([
    Buffer.from('MZexecutable'),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from('#!/bin/sh\necho test'),
    Buffer.from('\uFEFF <!DOCTYPE HTML><html>'),
    Buffer.from('<svg></svg>'),
    Buffer.from('<?xml version="1.0"?><svg/>'),
  ])('отвергает содержимое под безопасным расширением %#', (bad) =>
    expect(validateUpload('image.png', bad, 'image/png')).toBeNull(),
  );
  it('определяет PNG по байтам, а не MIME, и не превращает текст в изображение', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jEpoAAAAASUVORK5CYII=',
      'base64',
    );
    expect(validateUpload('Фото.png', png, 'application/octet-stream')).toBe('image/png');
    expect(validateUpload('Фото.png', bytes(), 'image/png')).toBe('application/octet-stream');
  });
});

describe('TeamsApi: поставить/снять реакцию', () => {
  it('POST и DELETE используют точные маршруты, CSRF и проверенный массив', async () => {
    const h = await setup(),
      reactions = [{ kind: 'like', users: [{ id: 1, shortName: 'Иванова И.И.' }] }];
    h.fetch.mockResolvedValueOnce(json(reactions)).mockResolvedValueOnce(json([]));
    expect(await h.api.reactions(4, 10, 'like', false)).toEqual({ ok: true, data: reactions });
    expect(await h.api.reactions(4, 10, 'like', true)).toEqual({ ok: true, data: [] });
    expect(h.fetch.mock.calls[1]?.[0]).toBe('/api/chats/4/messages/10/reactions');
    expect(h.fetch.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(h.fetch.mock.calls[1]?.[1]?.body))).toEqual({ kind: 'like' });
    expect(h.fetch.mock.calls[2]?.[0]).toBe('/api/chats/4/messages/10/reactions/like');
    expect(h.fetch.mock.calls[2]?.[1]?.method).toBe('DELETE');
    expect(h.fetch.mock.calls[2]?.[1]?.body).toBeUndefined();
    expect(headers(h.fetch.mock.calls[2]?.[1]).get('x-csrf-token')).toBe('csrf-A');
  });
  it('проверяет известный набор, идентификаторы и режим до сети', async () => {
    const h = await setup();
    for (const kind of ['fire', 'party', 'like/../path', 'LIKE', ''])
      expect(await h.api.reactions(4, 10, kind, false)).toMatchObject({
        ok: false,
        code: 'validation',
      });
    expect(await h.api.reactions(0, 10, 'like', false)).toMatchObject({
      ok: false,
      code: 'validation',
    });
    expect(await h.api.reactions(4, 0, 'like', false)).toMatchObject({
      ok: false,
      code: 'validation',
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it('не повторяет неизвестный исход, не выдаёт сломанный массив за успех', async () => {
    const h = await setup();
    h.fetch
      .mockRejectedValueOnce(Error('private'))
      .mockResolvedValueOnce(json([{ kind: 'like', users: [{ id: 0, shortName: 'invalid' }] }]));
    expect(await h.api.reactions(4, 10, 'like', false)).toMatchObject({
      ok: false,
      code: 'network',
      uncertain: true,
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(await h.api.reactions(4, 10, 'like', true)).toMatchObject({
      ok: false,
      code: 'invalid_data',
      uncertain: true,
    });
  });
});
