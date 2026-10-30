import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsApi, FILE_LIMIT, type TeamsApiOptions } from '../../src/main/api/client';
import {
  AttachmentService,
  attachmentCanOpen,
  attachmentName,
  rasterMime,
  type FileTarget,
} from '../../src/main/files/service';
import type { ChatFile, ChatMessage } from '../../src/shared/client';

const pdf = new TextEncoder().encode('%PDF-1.7\nexample attachment\n');
const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6t8AAAAASUVORK5CYII=',
    'base64',
  ),
);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const binary = (bytes: Uint8Array, mime: string) =>
  new Response(new Uint8Array(bytes).buffer, {
    headers: { 'content-type': mime, 'content-length': String(bytes.length) },
  });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const temporaryFolders: string[] = [];
const services: AttachmentService[] = [];

function message(file: ChatFile): ChatMessage {
  return {
    id: 10,
    chatId: 4,
    author: { id: 2, shortName: 'Петров П.П.' },
    text: 'Тестовый файл',
    at: '2026-10-28T09:00:00.000Z',
    editedAt: null,
    deleted: false,
    replyTo: null,
    files: [file],
    mentions: [],
    links: [],
    canEdit: false,
    reactions: [],
    cards: [],
    sticker: null,
    poll: null,
  };
}

async function harness({
  fileName = 'План объекта А.pdf',
  bytes = pdf,
  mime = 'application/pdf',
  isImage = false,
}: {
  fileName?: string;
  bytes?: Uint8Array;
  mime?: string;
  isImage?: boolean;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'schema-attachment-unit-'));
  temporaryFolders.push(dir);
  const file: ChatFile = { fileId: 70, fileName, size: bytes.length, mime, isImage };
  const state = {
    message: message(file),
    getPage: vi.fn<() => Promise<Response>>(),
    getFile: vi.fn<() => Promise<Response>>().mockImplementation(async () => binary(bytes, mime)),
  };
  state.getPage.mockImplementation(async () =>
    json({ items: [state.message], hasMore: false, hasNewer: false }),
  );
  const fetch = vi.fn<TeamsApiOptions['fetch']>().mockImplementation(async (path) => {
    if (path === '/api/auth/me')
      return json({
        user: {
          id: 1,
          shortName: 'Иванова И.И.',
          fullName: 'Тестовый сотрудник',
          login: 'example',
          roles: [],
          permissions: [],
          mustChangePassword: false,
        },
        csrfToken: 'csrf-unit-test',
      });
    if (path === '/api/chats/4/messages?around=10') return state.getPage();
    if (path === '/api/files/70') return state.getFile();
    return json({ error: { code: 'not_found' } }, 404);
  });
  const api = new TeamsApi({ fetch });
  const auth = await api.authenticate();
  expect(auth.ok).toBe(true);
  const openPath = vi.fn<(path: string) => Promise<string>>().mockResolvedValue('');
  const reveal = vi.fn<(path: string) => void>();
  const service = new AttachmentService({ api, downloads: () => dir, openPath, reveal });
  services.push(service);
  const target: FileTarget = { epoch: api.epoch, chatId: 4, messageId: 10, fileId: 70 };
  return { dir, file, state, fetch, api, service, target, openPath, reveal };
}

afterEach(async () => {
  for (const service of services.splice(0)) service.destroy();
  for (const dir of temporaryFolders.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('Attachment names and local open policy', () => {
  it('сохраняет обычное имя с кириллицей, пробелами и расширением', () => {
    expect(attachmentName('План объекта А (2).pdf')).toBe('План объекта А (2).pdf');
    expect(attachmentCanOpen('План.pdf', pdf)).toBe(true);
    expect(attachmentCanOpen('Модель.rvt', new Uint8Array([1, 2, 3]))).toBe(true);
    expect(attachmentCanOpen('Фото.png', png)).toBe(true);
    expect(rasterMime(png)).toBe('image/png');
  });

  it.each([
    '',
    '.',
    '..',
    '../other.pdf',
    String.raw`..\other.pdf`,
    String.raw`C:\other.pdf`,
    String.raw`\\server\share\other.pdf`,
    'report.pdf:payload.exe',
    'file?.pdf',
    ' report.pdf',
    'report.pdf ',
    'report.pdf.',
    'CON',
    'nul.txt',
    'COM1.pdf',
    'LPT¹.txt',
    'CON .txt',
    'LPT1 .pdf',
    'name\u0000.pdf',
    'name\u202Efdp.exe',
    `${'a'.repeat(241)}.pdf`,
  ])('отклоняет неоднозначное или служебное имя %j', (name) => {
    expect(attachmentName(name)).toBeNull();
  });

  it.each([
    'script.exe',
    'script.bat',
    'script.ps1',
    'shortcut.lnk',
    'settings.reg',
    'test.cpl',
    'file.unknown',
  ])('не разрешает запуск %s', (name) =>
    expect(attachmentCanOpen(name, new Uint8Array([1, 2, 3]))).toBe(false),
  );

  it.each([
    ['report.pdf', 'MZpayload'],
    ['note.txt', '\u007fELFpayload'],
    ['note.txt', '#!/bin/sh\necho example'],
    ['report.pdf', '  <!doctype html><html>example</html>'],
    ['note.txt', '\ufeff<script>example</script>'],
    ['drawing.pdf', '<?xml version="1.0"?><svg></svg>'],
    ['photo.png', '<svg></svg>'],
    ['report.pdf', 'ordinary text'],
  ])('не доверяет расширению %s при неподходящем содержимом', (name, contents) => {
    const bytes = new TextEncoder().encode(contents);
    expect(attachmentCanOpen(name, bytes)).toBe(false);
    expect(rasterMime(bytes)).toBeNull();
  });
});

describe('AttachmentService: current membership and downloads', () => {
  it.each([
    'missing-message',
    'wrong-message',
    'wrong-chat',
    'deleted-message',
    'missing-file',
  ] as const)(
    'не скачивает файл, если текущая переписка его не подтверждает: %s',
    async (scenario) => {
      const h = await harness();
      if (scenario === 'missing-message')
        h.state.getPage.mockResolvedValue(json({ items: [], hasMore: false, hasNewer: false }));
      if (scenario === 'wrong-message') h.state.message.id = 11;
      if (scenario === 'wrong-chat') h.state.message.chatId = 5;
      if (scenario === 'deleted-message') h.state.message.deleted = true;
      if (scenario === 'missing-file') h.state.message.files = [];
      const result = await h.service.action(h.target, 'save');
      expect(result.ok).toBe(false);
      expect(h.state.getFile).not.toHaveBeenCalled();
      expect(await readdir(h.dir)).toEqual([]);
      expect(h.openPath).not.toHaveBeenCalled();
      expect(h.reveal).not.toHaveBeenCalled();
    },
  );

  it('проверяет доступ к сообщению до запроса байтов', async () => {
    const h = await harness();
    h.state.getPage.mockResolvedValue(json({ error: { code: 'forbidden' } }, 403));
    await expect(h.service.action(h.target, 'save')).resolves.toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(h.state.getFile).not.toHaveBeenCalled();
    expect(await readdir(h.dir)).toEqual([]);
  });

  it.each(['invalid-name', 'oversize'] as const)(
    'не скачивает неподходящие метаданные: %s',
    async (kind) => {
      const h = await harness();
      if (kind === 'invalid-name') h.file.fileName = '../outside.pdf';
      else h.file.size = FILE_LIMIT + 1;
      await expect(h.service.action(h.target, 'save')).resolves.toMatchObject({
        ok: false,
        code: 'invalid_file',
      });
      expect(h.state.getFile).not.toHaveBeenCalled();
      expect(await readdir(h.dir)).toEqual([]);
    },
  );

  it('повторно проверяет серверный доступ к байтам и не сохраняет тело ошибки', async () => {
    const h = await harness();
    h.state.getFile.mockResolvedValue(new Response('private-denied-body', { status: 404 }));
    const result = await h.service.action(h.target, 'save');
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
    expect(JSON.stringify(result)).not.toContain('private-denied-body');
    expect(await readdir(h.dir)).toEqual([]);
  });

  it('сохраняет точные байты без открытия и не перезаписывает существующий файл', async () => {
    const h = await harness();
    const original = new TextEncoder().encode('existing user file');
    await writeFile(join(h.dir, h.file.fileName), original);
    await expect(h.service.action(h.target, 'save')).resolves.toEqual({ ok: true, data: 'saved' });
    expect(await readFile(join(h.dir, h.file.fileName))).toEqual(Buffer.from(original));
    expect(await readFile(join(h.dir, 'План объекта А (1).pdf'))).toEqual(Buffer.from(pdf));
    expect(h.openPath).not.toHaveBeenCalled();
    expect(h.reveal).not.toHaveBeenCalled();
    await expect(h.service.action(h.target, 'save')).resolves.toEqual({ ok: true, data: 'saved' });
    expect(await readdir(h.dir)).toHaveLength(2);
    expect(h.state.getPage).toHaveBeenCalledTimes(2);
    expect(h.state.getFile).toHaveBeenCalledTimes(2);
  });

  it('не использует изменённый пользователем локальный файл для открытия', async () => {
    const h = await harness();
    await h.service.action(h.target, 'save');
    const previous = join(h.dir, h.file.fileName);
    await writeFile(previous, 'changed user data');
    await expect(h.service.action(h.target, 'open')).resolves.toEqual({ ok: true, data: 'opened' });
    expect(await readFile(previous, 'utf8')).toBe('changed user data');
    expect(h.openPath).toHaveBeenCalledExactlyOnceWith(join(h.dir, 'План объекта А (1).pdf'));
    expect(await readFile(join(h.dir, 'План объекта А (1).pdf'))).toEqual(Buffer.from(pdf));
  });

  it('открывает разрешённый файл и явно показывает сохранённый файл в папке', async () => {
    const h = await harness();
    await expect(h.service.action(h.target, 'open')).resolves.toEqual({ ok: true, data: 'opened' });
    await expect(h.service.action(h.target, 'reveal')).resolves.toEqual({
      ok: true,
      data: 'revealed',
    });
    const path = join(h.dir, h.file.fileName);
    expect(h.openPath).toHaveBeenCalledExactlyOnceWith(path);
    expect(h.reveal).toHaveBeenCalledExactlyOnceWith(path);
    expect(await readdir(h.dir)).toEqual([h.file.fileName]);
  });

  it.each([
    ['tool.exe', 'MZ example'],
    ['picture.png', '<html>example</html>'],
    ['note.txt', 'MZ executable with false extension'],
  ])(
    'опасное вложение %s сохраняет и показывает в папке без запуска',
    async (fileName, contents) => {
      const h = await harness({ fileName, bytes: new TextEncoder().encode(contents) });
      await expect(h.service.action(h.target, 'open')).resolves.toEqual({
        ok: true,
        data: 'blocked',
      });
      expect(h.openPath).not.toHaveBeenCalled();
      expect(h.reveal).toHaveBeenCalledExactlyOnceWith(join(h.dir, fileName));
    },
  );

  it('не раскрывает подробности ошибки системной программы', async () => {
    const h = await harness();
    h.openPath.mockResolvedValue('private-os-error-fixture');
    const result = await h.service.action(h.target, 'open');
    expect(result).toMatchObject({ ok: false, code: 'file_error' });
    expect(JSON.stringify(result)).not.toContain('private-os-error-fixture');
  });

  it('выход во время загрузки не оставляет файл и не выполняет Shell-действия', async () => {
    const h = await harness();
    const started = deferred<boolean>();
    const pending = deferred<Response>();
    h.state.getFile.mockImplementation(() => {
      started.resolve(true);
      return pending.promise;
    });
    const action = h.service.action(h.target, 'open');
    await started.promise;
    h.api.clear();
    pending.resolve(binary(pdf, 'application/pdf'));
    await expect(action).resolves.toMatchObject({ ok: false, code: 'stale_session' });
    expect(await readdir(h.dir)).toEqual([]);
    expect(h.openPath).not.toHaveBeenCalled();
    expect(h.reveal).not.toHaveBeenCalled();
  });

  it('старое действие после выхода не обращается к API', async () => {
    const h = await harness();
    h.api.clear();
    await expect(h.service.action(h.target, 'save')).resolves.toMatchObject({
      ok: false,
      code: 'stale_session',
    });
    expect(h.state.getPage).not.toHaveBeenCalled();
    expect(h.state.getFile).not.toHaveBeenCalled();
  });
});

describe('AttachmentService: private preview capabilities', () => {
  it('отдаёт изображение по непрозрачному токену и определяет MIME по байтам', async () => {
    const h = await harness({ fileName: 'Фото.png', bytes: png, mime: 'text/html', isImage: true });
    const result = await h.service.preview(h.target);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected preview');
    expect(result.data.url).toMatch(/^schema-attachment:\/\/preview\/[a-f0-9-]{36}$/);
    expect(result.data.url).not.toContain(h.file.fileName);
    const response = h.service.response(new Request(result.data.url));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    const head = h.service.response(new Request(result.data.url, { method: 'HEAD' }));
    expect(head.headers.get('content-length')).toBe(String(png.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(await readdir(h.dir)).toEqual([]);
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it.each(['MZ example', '<html>example</html>', '<svg></svg>', 'not an image'])(
    'не публикует поддельную картинку: %s',
    async (contents) => {
      const h = await harness({
        fileName: 'Фото.png',
        bytes: new TextEncoder().encode(contents),
        mime: 'image/png',
        isImage: true,
      });
      await expect(h.service.preview(h.target)).resolves.toMatchObject({
        ok: false,
        code: 'invalid_file',
      });
      expect(await readdir(h.dir)).toEqual([]);
    },
  );

  it('не публикует файл, который сервер не пометил изображением', async () => {
    const h = await harness({
      fileName: 'Фото.png',
      bytes: png,
      mime: 'image/png',
      isImage: false,
    });
    await expect(h.service.preview(h.target)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_file',
    });
  });

  it('отклоняет чужую схему, путь, query, поддельный токен и метод', async () => {
    const h = await harness({ fileName: 'Фото.png', bytes: png, mime: 'image/png', isImage: true });
    const result = await h.service.preview(h.target);
    if (!result.ok) throw new Error('Expected preview');
    for (const request of [
      new Request(result.data.url.replace('schema-attachment:', 'https:')),
      new Request(result.data.url.replace('//preview/', '//another/')),
      new Request(`${result.data.url}?arbitrary=true`),
      new Request('schema-attachment://preview/00000000-0000-0000-0000-000000000000'),
      new Request(result.data.url, { method: 'POST' }),
    ])
      expect(h.service.response(request).status).toBe(404);
  });

  it.each(['epoch', 'reset', 'destroy'] as const)(
    'отзывает выданный токен после %s',
    async (kind) => {
      const h = await harness({
        fileName: 'Фото.png',
        bytes: png,
        mime: 'image/png',
        isImage: true,
      });
      const result = await h.service.preview(h.target);
      if (!result.ok) throw new Error('Expected preview');
      if (kind === 'epoch') h.api.clear();
      if (kind === 'reset') h.service.reset();
      if (kind === 'destroy') h.service.destroy();
      expect(h.service.response(new Request(result.data.url)).status).toBe(404);
      if (kind !== 'reset')
        await expect(h.service.preview(h.target)).resolves.toMatchObject({
          ok: false,
          code: 'stale_session',
        });
    },
  );

  it('новый просмотр того же файла отзывает предыдущий токен', async () => {
    const h = await harness({ fileName: 'Фото.png', bytes: png, mime: 'image/png', isImage: true });
    const first = await h.service.preview(h.target);
    const second = await h.service.preview(h.target);
    if (!first.ok || !second.ok) throw new Error('Expected previews');
    expect(second.data.url).not.toBe(first.data.url);
    expect(h.service.response(new Request(first.data.url)).status).toBe(404);
    expect(h.service.response(new Request(second.data.url)).status).toBe(200);
  });
});

describe('Safe static attachment failure stages', () => {
  it('distinguishes unsafe name, byte-count mismatch, and unsupported raster without raw names', async () => {
    const h = await harness({ fileName: 'Фото.png', bytes: png, mime: 'image/png', isImage: true });
    h.file.fileName = '../private.png';
    let result = await h.service.preview(h.target);
    expect(result).toMatchObject({
      code: 'invalid_file',
      error: expect.stringContaining('Имя вложения'),
    });
    expect(JSON.stringify(result)).not.toContain('private');
    h.file.fileName = 'Фото.png';
    h.file.size = png.length + 1;
    result = await h.service.preview(h.target);
    expect(result).toMatchObject({
      code: 'invalid_file',
      error: expect.stringContaining('Размер полученного файла'),
    });
    h.file.size = 3;
    h.state.getFile.mockResolvedValue(binary(new Uint8Array([1, 2, 3]), 'image/png'));
    result = await h.service.preview(h.target);
    expect(result).toMatchObject({
      code: 'invalid_file',
      error: expect.stringContaining('Формат изображения'),
    });
  });
});
