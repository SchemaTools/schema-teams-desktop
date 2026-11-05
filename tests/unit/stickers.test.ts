import { describe, expect, it, vi } from 'vitest';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import { stickers } from '../../src/main/api/parse';
import type { ChatMessage } from '../../src/shared/client';
import { requestValid } from '../../src/shared/requests';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stickerMessage = (stickerId: number | null): ChatMessage => ({
  id: 10,
  chatId: 4,
  author: { id: 1, shortName: 'Иванова И.И.' },
  text: '',
  at: '2026-11-05T09:00:00Z',
  editedAt: null,
  deleted: false,
  replyTo: null,
  files: [],
  mentions: [],
  links: [],
  canEdit: true,
  reactions: [],
  cards: [],
  sticker: stickerId === null ? null : { id: stickerId, fileId: 801 },
  poll: null,
});
async function setup() {
  const fetch = vi.fn<TeamsApiOptions['fetch']>();
  const api = new TeamsApi({ fetch, onAuthLost: vi.fn() });
  fetch.mockResolvedValueOnce(
    json({
      user: { id: 1, shortName: 'Иванова И.И.', mustChangePassword: false },
      csrfToken: 'csrf-A',
    }),
  );
  await api.authenticate();
  return { api, fetch };
}

describe('набор стикеров бюро', () => {
  it('разбирает стикеры и свои эмодзи, негодные записи пропускает', () => {
    expect(
      stickers([
        {
          id: 1,
          kind: 'sticker',
          name: '',
          fileId: 801,
          author: { id: 2, shortName: 'Петров П.П.' },
          createdAt: '2026-11-01T00:00:00Z',
        },
        { id: 2, kind: 'emoji', name: 'кофе', fileId: 802, author: null },
        { id: 3, kind: 'gif', name: '', fileId: 803, author: null },
        { id: 4, kind: 'sticker', name: '', fileId: null, author: null },
        'мусор',
      ]),
    ).toEqual([
      {
        id: 1,
        kind: 'sticker',
        name: '',
        fileId: 801,
        author: { id: 2, shortName: 'Петров П.П.' },
      },
      { id: 2, kind: 'emoji', name: 'кофе', fileId: 802, author: null },
    ]);
  });
  it('ответ не списком — ошибка данных', () => {
    expect(() => stickers({ items: [] })).toThrow();
  });
  it('запрос набора — GET /api/chat-stickers', async () => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json([]));
    expect(await h.api.stickers()).toEqual({ ok: true, data: [] });
    expect(h.fetch.mock.calls[1]?.[0]).toBe('/api/chat-stickers');
  });
});

describe('отправка стикера', () => {
  it('без текста и файлов, с ключом повтора; ответ сверяется по стикеру', async () => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json(stickerMessage(11), 201));
    expect(await h.api.send(4, '', 'sticker-key-0001', [], undefined, 11)).toEqual({
      ok: true,
      data: stickerMessage(11),
    });
    const [path, init] = h.fetch.mock.calls[1] ?? [];
    expect(path).toBe('/api/chats/4/messages');
    expect(JSON.parse(String(init?.body))).toEqual({ text: '', stickerId: 11 });
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('sticker-key-0001');

    h.fetch.mockResolvedValueOnce(json(stickerMessage(12), 201));
    expect(await h.api.send(4, '', 'sticker-key-0002', [], undefined, 11)).toMatchObject({
      ok: false,
      code: 'invalid_data',
    });
  });
  it('стикер вместе с текстом или файлами и негодный ид — без запроса', async () => {
    const h = await setup();
    expect(await h.api.send(4, 'текст', 'sticker-key-0003', [], undefined, 11)).toMatchObject({
      code: 'validation',
    });
    expect(await h.api.send(4, '', 'sticker-key-0004', [90], undefined, 11)).toMatchObject({
      code: 'validation',
    });
    expect(await h.api.send(4, '', 'sticker-key-0005', [], undefined, 0)).toMatchObject({
      code: 'validation',
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it('запрос окна: стикер — только с пустым текстом и без файлов', () => {
    const base = { kind: 'chat.send', epoch: 1, chatId: 4, requestId: 'sticker-key-0006' };
    expect(requestValid({ ...base, text: '', stickerId: 11 })).toBe(true);
    expect(requestValid({ ...base, text: 'да', stickerId: 11 })).toBe(false);
    expect(requestValid({ ...base, text: '', stickerId: 11, fileIds: [90] })).toBe(false);
    expect(requestValid({ ...base, text: '', stickerId: -1 })).toBe(false);
    expect(requestValid({ ...base, text: '' })).toBe(false);
    expect(requestValid({ kind: 'chat.stickers', epoch: 1 })).toBe(true);
    expect(requestValid({ kind: 'chat.stickers', epoch: 1, extra: 1 })).toBe(false);
  });
});
