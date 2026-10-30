import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import { requestValid } from '../../src/shared/requests';
import { randomUUID } from 'node:crypto';
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const session = (csrf = 'csrf-A') => ({
  user: { id: 1, shortName: 'Тест', mustChangePassword: false },
  csrfToken: csrf,
});
async function fixture() {
  const fetch = vi.fn<TeamsApiOptions['fetch']>(),
    api = new TeamsApi({ fetch, onAuthLost: vi.fn() });
  fetch.mockResolvedValueOnce(json(session()));
  await api.authenticate();
  return { api, fetch };
}
const zip = () => zipSync({ 'report.txt': strToU8('Одобренное описание') });
describe('D7 strict authenticated API', () => {
  it('network IPC accepts only opaque preview/attempt receipts and current epoch, never a caller body/key/owner', () => {
    const id = randomUUID();
    for (const kind of ['report.send', 'report.retry', 'report.fallback']) {
      expect(requestValid({ kind, epoch: 7, id })).toBe(true);
      for (const extra of [
        { key: 'user-key-0001' },
        { fileIds: [30] },
        { text: 'Изменённое тело' },
        { ownerId: 2 },
        { url: 'https://outside.test' },
      ])
        expect(requestValid({ kind, epoch: 7, id, ...extra })).toBe(false);
      expect(requestValid({ kind, id })).toBe(false);
    }
    expect(requestValid({ kind: 'report.resolve', epoch: 7, id, confirmed: true })).toBe(true);
    expect(requestValid({ kind: 'report.resolve', epoch: 7, id, confirmed: false })).toBe(false);
  });
  it('uploads exact ZIP bytes as octet-stream with CSRF/encoded filename and verifies real server file DTO', async () => {
    const f = await fixture(),
      bytes = zip(),
      name = 'Schema Teams report.zip';
    f.fetch.mockResolvedValueOnce(
      json(
        {
          fileId: 30,
          fileName: name,
          size: bytes.length,
          mime: 'application/octet-stream',
          isImage: false,
        },
        201,
      ),
    );
    expect(await f.api.supportUpload(name, bytes)).toMatchObject({
      ok: true,
      data: { fileId: 30 },
    });
    const [path, init] = f.fetch.mock.calls[1] ?? [];
    expect(path).toBe('/api/desktop/support/files');
    expect(init?.method).toBe('POST');
    expect(Buffer.from(init?.body as Uint8Array)).toEqual(Buffer.from(bytes));
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('x-csrf-token')).toBe('csrf-A');
    expect(headers.get('x-file-name')).toBe(encodeURIComponent(name));
    expect(headers.get('idempotency-key')).toBeNull();
    f.fetch.mockResolvedValueOnce(
      json(
        {
          fileId: 31,
          fileName: name,
          size: bytes.length + 1,
          mime: 'application/octet-stream',
          isImage: false,
        },
        201,
      ),
    );
    expect(await f.api.supportUpload(name, bytes)).toMatchObject({
      ok: false,
      code: 'invalid_data',
    });
    f.fetch.mockResolvedValueOnce(
      json(
        { fileId: 31, fileName: name, size: bytes.length, mime: 'application/zip', isImage: false },
        201,
      ),
    );
    expect(await f.api.supportUpload(name, bytes)).toMatchObject({
      ok: false,
      code: 'invalid_data',
    });
  });
  it('forbids unsafe upload bytes/name before HTTP and never guesses a file ID after lost response', async () => {
    const f = await fixture();
    expect(await f.api.supportUpload('report.png', new Uint8Array([77, 90, 1, 2]))).toMatchObject({
      ok: false,
      code: 'validation',
    });
    expect(await f.api.supportUpload('../report.zip', zip())).toMatchObject({
      ok: false,
      code: 'validation',
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.fetch.mockRejectedValueOnce(Error('transport'));
    expect(await f.api.supportUpload('report.zip', zip())).toMatchObject({
      ok: false,
      code: 'network',
      uncertain: true,
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('final JSON is only text/fileIds; 200/201 receipts stay strict, no-support is honest', async () => {
    const f = await fixture(),
      payload = { text: 'Одобренный текст', fileIds: [30, 31, 32] },
      key = 'support-final-0001';
    f.fetch.mockResolvedValueOnce(json({ chatId: 9, messageId: 80 }, 201));
    expect(await f.api.supportSend(payload, key)).toEqual({
      ok: true,
      data: { chatId: 9, messageId: 80 },
    });
    const [path, init] = f.fetch.mock.calls[1] ?? [];
    expect(path).toBe('/api/desktop/support');
    expect(JSON.parse(String(init?.body))).toEqual(payload);
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(key);
    f.fetch.mockResolvedValueOnce(json({ chatId: 9, messageId: 80 }, 200));
    expect(await f.api.supportSend(payload, key)).toMatchObject({
      ok: true,
      data: { messageId: 80 },
    });
    f.fetch.mockResolvedValueOnce(json({ chatId: 9, messageId: 0 }, 201));
    expect(await f.api.supportSend(payload, key)).toMatchObject({
      ok: false,
      code: 'invalid_data',
      uncertain: true,
    });
    f.fetch.mockResolvedValueOnce(
      json({ error: { code: 'no_support_chat', message: 'private' } }, 409),
    );
    expect(await f.api.supportSend(payload, key)).toMatchObject({
      ok: false,
      code: 'no_support_chat',
      error: 'Чат поддержки не настроен. Сохраните архив и передайте его администратору.',
    });
  });
  it('rejects invalid/more-than-three/duplicate IDs and malformed keys before network; empty text with files is allowed', async () => {
    const f = await fixture();
    for (const fileIds of [[1, 2, 3, 4], [1, 1], [0], [-1], [1.5], ['1']])
      expect(
        await f.api.supportSend({ text: 'Описание', fileIds } as never, 'valid-key-0001'),
      ).toMatchObject({ ok: false, code: 'validation' });
    for (const key of ['', 'bad/key', ['valid-key-0001']])
      expect(
        await f.api.supportSend({ text: 'Описание', fileIds: [] }, key as never),
      ).toMatchObject({ ok: false, code: 'validation' });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.fetch.mockResolvedValueOnce(json({ chatId: 9, messageId: 80 }, 201));
    expect(await f.api.supportSend({ text: '', fileIds: [30] }, 'valid-key-0001')).toMatchObject({
      ok: true,
    });
  });
  it('CSRF refresh repeats exact final body/key, transport-unknown never automatically replays', async () => {
    const f = await fixture();
    f.fetch
      .mockResolvedValueOnce(json({ error: { code: 'csrf' } }, 403))
      .mockResolvedValueOnce(json(session('csrf-B')))
      .mockResolvedValueOnce(json({ chatId: 9, messageId: 80 }, 201));
    const payload = { text: 'Текст', fileIds: [30] },
      key = 'support-final-0002';
    expect(await f.api.supportSend(payload, key)).toMatchObject({ ok: true });
    const calls = f.fetch.mock.calls.filter((c) => c[0] === '/api/desktop/support');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]?.body).toBe(calls[1]?.[1]?.body);
    expect(calls.map((c) => new Headers(c[1]?.headers).get('idempotency-key'))).toEqual([key, key]);
    f.fetch.mockRejectedValueOnce(Error('lost'));
    const before = f.fetch.mock.calls.length;
    expect(await f.api.supportSend(payload, key)).toMatchObject({
      ok: false,
      code: 'network',
      uncertain: true,
    });
    expect(f.fetch.mock.calls.length - before).toBe(1);
  });
  it('morning uses server date/calendar; wrong or missing counts are rejected', async () => {
    const f = await fixture(),
      body = { date: '2026-10-31', workday: true, dueToday: 0, review: 0, newRemarks: 0 };
    f.fetch.mockResolvedValueOnce(json(body));
    expect(await f.api.morning()).toEqual({ ok: true, data: body });
    expect(f.fetch.mock.calls.at(-1)?.[0]).toBe('/api/desktop/morning');
    f.fetch.mockResolvedValueOnce(json({ ...body, review: -1 }));
    expect(await f.api.morning()).toMatchObject({ ok: false, code: 'invalid_data' });
    f.fetch.mockResolvedValueOnce(json({ date: body.date, workday: true }));
    expect(await f.api.morning()).toMatchObject({ ok: false, code: 'invalid_data' });
  });
});
