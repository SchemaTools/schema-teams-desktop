import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiResult, ChatFile } from '../../src/shared/client';
import type { SupportPayload, SupportReceipt } from '../../src/shared/report';
import { SupportLedger, type SupportStorage } from '../../src/main/diagnostics/ledger';
import { SupportSender, type SupportContext } from '../../src/main/diagnostics/sender';
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const failure = (code: string, uncertain = false): ApiResult<never> => ({
  ok: false,
  code,
  error: 'Ошибка',
  retryable: false,
  ...(uncertain && { uncertain: true }),
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  let text: string | null = null,
    failWrite = 0,
    writes = 0,
    alive = true,
    preview = true;
  const context: SupportContext = {
    serverHash: 'a'.repeat(64),
    ownerId: 1,
    epoch: 7,
    chatId: 9,
    serverNow: '2026-10-31T04:00:00.000Z',
    uncertaintyMs: 100,
  };
  const storage: SupportStorage = {
    read: () => text,
    replace: (next) => {
      writes++;
      if (writes === failWrite) throw Error('disk');
      text = next;
    },
  };
  const ledger = new SupportLedger(storage),
    id = randomUUID(),
    bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
  const bundle = vi.fn(async () => ({
    previewId: id,
    text: 'Одобренный текст',
    files: [{ name: 'report.zip', bytes }],
  }));
  const upload = vi.fn<(name: string, bytes: Uint8Array) => Promise<ApiResult<ChatFile>>>(
    async (name, data) =>
      ok({
        fileId: 30,
        fileName: name,
        size: data.length,
        mime: 'application/octet-stream',
        isImage: false,
      }),
  );
  const post = vi.fn<(payload: SupportPayload, key: string) => Promise<ApiResult<SupportReceipt>>>(
    async () => ok({ chatId: 9, messageId: 80 }),
  );
  const fresh = vi.fn(async () => ok({ ...context }));
  const make = (store = ledger) =>
    new SupportSender({
      ledger: store,
      fresh,
      current: (c) =>
        alive &&
        c.epoch === context.epoch &&
        c.ownerId === context.ownerId &&
        c.chatId === context.chatId,
      previewCurrent: () => preview,
      bundle,
      upload,
      post,
    });
  return {
    ledger,
    storage,
    id,
    bytes,
    bundle,
    upload,
    post,
    fresh,
    context,
    make,
    sender: make(),
    get text() {
      return text;
    },
    set failWrite(n: number) {
      failWrite = n;
    },
    set alive(v: boolean) {
      alive = v;
    },
    set preview(v: boolean) {
      preview = v;
    },
  };
}
describe('Support sender explicit frozen final flow', () => {
  it('the same approved preview is consumed on confirmation; sequential send twice never reuploads or creates a new key', async () => {
    const f = fixture();
    const first = await f.sender.send(f.id);
    expect(first).toMatchObject({ ok: true, data: { status: 'confirmed' } });
    expect(await f.sender.send(f.id)).toEqual(first);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.post).toHaveBeenCalledTimes(1);
    const nextId = randomUUID();
    f.bundle.mockResolvedValue({
      previewId: nextId,
      text: 'Новое одобренное обращение',
      files: [{ name: 'report.zip', bytes: f.bytes }],
    });
    expect(await f.sender.send(nextId)).toMatchObject({ ok: true, data: { status: 'confirmed' } });
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.post.mock.calls[1]?.[1]).not.toBe(f.post.mock.calls[0]?.[1]);
  });
  it('posts only after durable intent, with exact approved bytes and confirmed IDs', async () => {
    const f = fixture();
    f.post.mockImplementationOnce(async (payload, key) => {
      const saved = JSON.parse(f.text ?? '{}').records[0];
      expect(saved).toMatchObject({ key, payload, status: 'intent' });
      return ok({ chatId: 9, messageId: 80 });
    });
    expect(await f.sender.send(f.id)).toMatchObject({
      ok: true,
      data: { status: 'confirmed', receipt: { chatId: 9, messageId: 80 } },
    });
    expect(f.upload.mock.calls[0]?.[1]).toEqual(f.bytes);
    expect(f.upload.mock.calls[0]?.[1]).not.toBe(f.bytes);
    expect(f.post.mock.calls[0]?.[0]).toEqual({ text: 'Одобренный текст', fileIds: [30] });
    expect(JSON.parse(f.text ?? '{}').records[0].receipt).toEqual({ chatId: 9, messageId: 80 });
  });
  it('unknown survives edit/new preview/restart; explicit retry uses same body/key without upload or collection', async () => {
    const f = fixture();
    f.post.mockResolvedValueOnce(failure('timeout', true));
    expect(await f.sender.send(f.id)).toMatchObject({ ok: true, data: { status: 'unresolved' } });
    const first = f.post.mock.calls[0];
    const record = f.ledger.current(f.context);
    if (!record) throw Error('No record');
    f.bundle.mockResolvedValue({
      previewId: randomUUID(),
      text: 'Новый текст',
      files: [{ name: 'different.zip', bytes: new Uint8Array([9]) }],
    });
    expect(await f.sender.send(randomUUID())).toMatchObject({
      ok: false,
      code: 'support_unresolved',
    });
    f.preview = false;
    const restored = new SupportLedger(f.storage),
      next = f.make(restored);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(await next.retry(record.id)).toMatchObject({ ok: true, data: { status: 'confirmed' } });
    expect(f.post.mock.calls[1]).toEqual(first);
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.bundle).toHaveBeenCalledTimes(1);
  });
  it('failed intent write gives zero final POST; receipt write failure remains blocked across restart', async () => {
    const f = fixture();
    f.failWrite = 1;
    expect(await f.sender.send(f.id)).toMatchObject({ ok: false, code: 'support_storage' });
    expect(f.post).not.toHaveBeenCalled();
    const g = fixture();
    g.failWrite = 2;
    expect(await g.sender.send(g.id)).toMatchObject({ ok: false, code: 'support_storage' });
    expect(g.post).toHaveBeenCalledTimes(1);
    expect(g.ledger.healthy).toBe(false);
    const restored = new SupportLedger(g.storage);
    expect(restored.current(g.context)?.status).toBe('unresolved');
    expect(restored.locked(g.context)).toBe(true);
  });
  it('lost upload response or preview expiry during upload never reaches the final POST', async () => {
    const f = fixture();
    f.upload.mockResolvedValueOnce(failure('network', true));
    expect(await f.sender.send(f.id)).toMatchObject({ ok: false, code: 'network' });
    expect(f.post).not.toHaveBeenCalled();
    expect(f.ledger.current(f.context)).toBeNull();
    const g = fixture();
    g.upload.mockImplementationOnce(async (name, data) => {
      g.preview = false;
      return ok({
        fileId: 30,
        fileName: name,
        size: data.length,
        mime: 'application/octet-stream',
        isImage: false,
      });
    });
    expect(await g.sender.send(g.id)).toMatchObject({ ok: false, code: 'stale_report' });
    expect(g.post).not.toHaveBeenCalled();
  });
  it('parallel click has one flight, no duplicate upload/final', async () => {
    const f = fixture(),
      pending = deferred<ApiResult<SupportReceipt>>();
    f.post.mockReturnValueOnce(pending.promise);
    const first = f.sender.send(f.id);
    await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1));
    expect(await f.sender.send(f.id)).toMatchObject({ ok: false, code: 'busy' });
    pending.resolve(ok({ chatId: 9, messageId: 80 }));
    await first;
    expect(f.upload).toHaveBeenCalledTimes(1);
  });
  it('first proven refusal can release, unknown then 403 keeps may-have-committed lock', async () => {
    const f = fixture();
    f.post.mockResolvedValueOnce(failure('forbidden'));
    expect(await f.sender.send(f.id)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(f.ledger.locked(f.context)).toBe(false);
    const g = fixture();
    g.post.mockResolvedValueOnce(failure('network', true));
    await g.sender.send(g.id);
    const record = g.ledger.current(g.context);
    if (!record) throw Error('No record');
    g.post.mockResolvedValueOnce(failure('forbidden'));
    await g.sender.retry(record.id);
    expect(g.ledger.locked(g.context)).toBe(true);
    expect(g.ledger.current(g.context)).toMatchObject({ status: 'review', mayHaveCommitted: true });
  });
  it('expiry and backward server clock forbid POST and do not move the deadline', async () => {
    const f = fixture();
    f.post.mockResolvedValueOnce(failure('timeout', true));
    await f.sender.send(f.id);
    const record = f.ledger.current(f.context);
    if (!record) throw Error('No record');
    f.context.serverNow = record.retryNotAfter;
    expect(await f.sender.retry(record.id)).toMatchObject({ ok: false, code: 'support_review' });
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.ledger.current(f.context)?.retryNotAfter).toBe(record.retryNotAfter);
    const g = fixture();
    g.post.mockResolvedValueOnce(failure('timeout', true));
    await g.sender.send(g.id);
    const old = g.ledger.current(g.context);
    if (!old) throw Error('No record');
    g.context.serverNow = '2026-10-31T03:59:59.000Z';
    await g.sender.retry(old.id);
    expect(g.post).toHaveBeenCalledTimes(1);
    expect(g.ledger.current(g.context)?.reason).toBe('clock');
  });
  it('rechecks fresh clock uncertainty after upload before creating any final intent', async () => {
    const f = fixture();
    f.fresh.mockResolvedValueOnce(ok({ ...f.context }));
    f.fresh.mockResolvedValueOnce(ok({ ...f.context, uncertaintyMs: 60001 }));
    expect(await f.sender.send(f.id)).toMatchObject({ ok: false, code: 'support_clock' });
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.ledger.current(f.context)).toBeNull();
  });
  it('chat changes during upload stop first final; wrong receipt never confirms or releases lock', async () => {
    const f = fixture();
    f.upload.mockImplementationOnce(async (name, data) => {
      f.context.chatId = 10;
      return ok({
        fileId: 30,
        fileName: name,
        size: data.length,
        mime: 'application/octet-stream',
        isImage: false,
      });
    });
    expect(await f.sender.send(f.id)).toMatchObject({ ok: false, code: 'stale_report' });
    expect(f.post).not.toHaveBeenCalled();
    const g = fixture();
    g.post.mockResolvedValueOnce(ok({ chatId: 10, messageId: 80 }));
    expect(await g.sender.send(g.id)).toMatchObject({ ok: false, code: 'support_changed' });
    expect(g.ledger.current(g.context)?.status).toBe('review');
  });
  it('late destroyed host result cannot rewrite a new writer entry', async () => {
    const f = fixture(),
      pending = deferred<ApiResult<SupportReceipt>>();
    f.post.mockReturnValueOnce(pending.promise);
    const work = f.sender.send(f.id);
    await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1));
    f.alive = false;
    const second = new SupportLedger(f.storage);
    const a = second.current(f.context);
    if (!a) throw Error('No record');
    const b = second.begin({
      serverHash: f.context.serverHash,
      ownerId: 2,
      chatId: 9,
      previewId: randomUUID(),
      payload: { text: 'B', fileIds: [] },
      files: [],
      firstAt: a.firstAt,
      retryNotAfter: a.retryNotAfter,
    });
    expect(b).not.toBeNull();
    const before = f.text;
    pending.resolve(ok({ chatId: 9, messageId: 80 }));
    expect(await work).toMatchObject({ ok: false, code: 'stale_report' });
    expect(f.text).toBe(before);
    expect(new SupportLedger(f.storage).current({ ...f.context, ownerId: 2 })?.payload.text).toBe(
      'B',
    );
  });
});
