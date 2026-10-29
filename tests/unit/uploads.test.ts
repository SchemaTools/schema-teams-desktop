import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsApi } from '../../src/main/api/client';
import { UploadService } from '../../src/main/files/uploads';
import type { ChatFile } from '../../src/shared/client';

const folders: string[] = [];
const services: UploadService[] = [];
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function harness() {
  const folder = await mkdtemp(join(tmpdir(), 'schema-upload-unit-'));
  folders.push(folder);
  const file = join(folder, 'Пояснение.txt');
  await writeFile(file, 'test');
  const dto: ChatFile = {
    fileId: 90,
    fileName: 'Пояснение.txt',
    size: 4,
    mime: 'application/octet-stream',
    isImage: false,
  };
  const api = {
    epoch: 7,
    owner: 1 as number | null,
    detail: vi.fn().mockResolvedValue({ ok: true, data: { canWrite: true } }),
    upload: vi.fn().mockResolvedValue({ ok: true, data: dto }),
  };
  const choose = vi.fn().mockResolvedValue({ canceled: false, filePaths: [file] });
  const clipboardImage = vi.fn<() => Promise<Uint8Array | null>>().mockResolvedValue(null);
  const service = new UploadService({ api: api as unknown as TeamsApi, choose, clipboardImage });
  services.push(service);
  return {
    service,
    api,
    choose,
    clipboardImage,
    file,
    folder,
    dto,
    scope: { epoch: 7, chatId: 4 },
  };
}
afterEach(async () => {
  for (const service of services.splice(0)) service.destroy();
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe('UploadService: native selection and session ownership', () => {
  it('uploads exact selected bytes and returns only metadata', async () => {
    const h = await harness();
    expect(await h.service.pick(h.scope, 10)).toEqual({
      ok: true,
      data: { items: [h.dto], canceled: false },
    });
    expect(h.api.upload).toHaveBeenCalledWith(
      4,
      new Uint8Array(Buffer.from('test')),
      'Пояснение.txt',
      'application/octet-stream',
    );
  });
  it('cancel does not read or upload selected paths', async () => {
    const h = await harness();
    h.choose.mockResolvedValue({ canceled: true, filePaths: [h.file] });
    expect(await h.service.pick(h.scope, 10)).toEqual({
      ok: true,
      data: { items: [], canceled: true },
    });
    expect(h.api.upload).not.toHaveBeenCalled();
  });
  it('read-only access never opens the picker or clipboard', async () => {
    const h = await harness();
    h.api.detail.mockResolvedValue({ ok: true, data: { canWrite: false } });
    expect(await h.service.pick(h.scope, 10)).toMatchObject({ ok: false, code: 'read_only' });
    expect(await h.service.paste(h.scope)).toMatchObject({ ok: false, code: 'read_only' });
    expect(h.choose).not.toHaveBeenCalled();
    expect(h.clipboardImage).not.toHaveBeenCalled();
  });
  it('old epoch or signed-out owner cannot open selection', async () => {
    const h = await harness();
    expect(await h.service.pick({ ...h.scope, epoch: 6 }, 10)).toMatchObject({
      ok: false,
      code: 'stale_session',
    });
    h.api.owner = null;
    expect(await h.service.pick(h.scope, 10)).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(h.choose).not.toHaveBeenCalled();
  });
  it('rejects an oversized selection before any file upload', async () => {
    const h = await harness();
    h.choose.mockResolvedValue({ canceled: false, filePaths: [h.file, h.file] });
    expect(await h.service.pick(h.scope, 1)).toMatchObject({
      ok: true,
      data: { items: [], error: expect.any(String) },
    });
    expect(h.api.upload).not.toHaveBeenCalled();
  });
  it('keeps successful metadata when a later file is forbidden', async () => {
    const h = await harness();
    const blocked = join(h.folder, 'blocked.exe');
    await writeFile(blocked, 'MZ');
    h.choose.mockResolvedValue({ canceled: false, filePaths: [h.file, blocked] });
    expect(await h.service.pick(h.scope, 10)).toMatchObject({
      ok: true,
      data: { items: [h.dto], error: expect.any(String) },
    });
    expect(h.api.upload).toHaveBeenCalledTimes(1);
  });
  it('directory, missing and empty files are not uploaded and paths are not exposed', async () => {
    const h = await harness();
    const empty = join(h.folder, 'empty.txt');
    await writeFile(empty, '');
    for (const path of [h.folder, join(h.folder, 'missing.txt'), empty]) {
      h.choose.mockResolvedValue({ canceled: false, filePaths: [path] });
      const result = await h.service.pick(h.scope, 10);
      expect(result).toMatchObject({ ok: true, data: { items: [], error: expect.any(String) } });
      expect(JSON.stringify(result)).not.toContain(h.folder);
    }
    expect(h.api.upload).not.toHaveBeenCalled();
  });
  it('serializes native picker operations even after cancellation until dialog cleanup', async () => {
    const h = await harness();
    const wait = deferred<{ canceled: boolean; filePaths: string[] }>();
    h.choose.mockReturnValue(wait.promise);
    const pending = h.service.pick(h.scope, 10);
    await vi.waitFor(() => expect(h.choose).toHaveBeenCalled());
    expect(await h.service.paste(h.scope)).toMatchObject({ ok: false, code: 'busy' });
    h.service.reset();
    expect(await pending).toMatchObject({ ok: false, code: 'stale_session' });
    expect(await h.service.pick(h.scope, 10)).toMatchObject({ ok: false, code: 'busy' });
    wait.resolve({ canceled: false, filePaths: [h.file] });
    await new Promise((done) => setImmediate(done));
    expect(h.api.upload).not.toHaveBeenCalled();
    h.choose.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await h.service.pick(h.scope, 10)).toMatchObject({ ok: true });
  });
  it('drops clipboard result after a session reset', async () => {
    const h = await harness();
    const wait = deferred<Uint8Array | null>();
    h.clipboardImage.mockReturnValue(wait.promise);
    const pending = h.service.paste(h.scope);
    await vi.waitFor(() => expect(h.clipboardImage).toHaveBeenCalled());
    h.service.reset();
    expect(await pending).toMatchObject({ ok: false, code: 'stale_session' });
    wait.resolve(new Uint8Array([1]));
    await new Promise((done) => setImmediate(done));
    expect(h.api.upload).not.toHaveBeenCalled();
  });
  it('returns null for a clipboard without image and rejects non-PNG bytes', async () => {
    const h = await harness();
    expect(await h.service.paste(h.scope)).toEqual({ ok: true, data: null });
    h.clipboardImage.mockResolvedValue(new Uint8Array([1, 2, 3]));
    expect(await h.service.paste(h.scope)).toMatchObject({ ok: false, code: 'validation' });
    expect(h.api.upload).not.toHaveBeenCalled();
  });
  it('uploads clipboard PNG with an internal filename', async () => {
    const h = await harness();
    const png = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jEpoAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    h.clipboardImage.mockResolvedValue(png);
    expect(await h.service.paste(h.scope)).toEqual({ ok: true, data: h.dto });
    expect(h.api.upload).toHaveBeenCalledWith(
      4,
      png,
      expect.stringMatching(/^Изображение-\d+\.png$/),
      'image/png',
    );
  });
  it('does not retry a failed upload and preserves partial error without paths', async () => {
    const h = await harness();
    h.api.upload.mockResolvedValue({
      ok: false,
      code: 'network',
      error: 'Связь потеряна',
      retryable: true,
    });
    expect(await h.service.pick(h.scope, 10)).toEqual({
      ok: true,
      data: { items: [], canceled: false, error: 'Связь потеряна' },
    });
    expect(h.api.upload).toHaveBeenCalledTimes(1);
  });
  it('drops a late upload response after owner change', async () => {
    const h = await harness();
    const wait = deferred<unknown>();
    h.api.upload.mockReturnValue(wait.promise);
    const pending = h.service.pick(h.scope, 10);
    await vi.waitFor(() => expect(h.api.upload).toHaveBeenCalled());
    h.api.owner = 2;
    wait.resolve({ ok: true, data: h.dto });
    expect(await pending).toMatchObject({ ok: false, code: 'stale_session' });
  });
  it('destroy prevents future native operations', async () => {
    const h = await harness();
    h.service.destroy();
    expect(await h.service.pick(h.scope, 10)).toMatchObject({ ok: false, code: 'stale_session' });
    expect(h.choose).not.toHaveBeenCalled();
  });
});
