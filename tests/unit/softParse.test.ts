import { afterEach, describe, expect, it, vi } from 'vitest';
import * as parse from '../../src/main/api/parse';
import type { ChatSummary } from '../../src/shared/client';

const chat = (id: number, kind: string = 'group'): Record<string, unknown> => ({
  id,
  kind,
  title: 'Объект А',
  peer: null,
  objectId: null,
  objectCode: null,
  memberCount: 2,
  last: null,
  unread: 0,
  mentioned: false,
  photoFileId: null,
});
const message = (id: number, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  chatId: 4,
  author: { id: 2, shortName: 'Иванова И.И.' },
  text: 'Проверка',
  at: '2026-11-05T09:00:00Z',
  editedAt: null,
  deleted: false,
  replyTo: null,
  files: [],
  mentions: [],
  links: [],
  canEdit: false,
  reactions: [],
  cards: [],
  sticker: null,
  poll: null,
  ...fields,
});

afterEach(() => parse.onSkipped(undefined));

describe('мягкий разбор ответов сервера (ТЗ 3.3)', () => {
  it('неизвестный вид чата пропускает этот чат, а не весь список, и пишет вид в журнал', () => {
    const skipped = vi.fn();
    parse.onSkipped(skipped);
    const list = parse.list({
      items: [chat(1), chat(2, 'task'), { ...chat(3), unread: -1 }, chat(4, 'object')],
      unreadTotal: 1,
    });
    expect(list.items.map((item: ChatSummary) => item.id)).toEqual([1, 4]);
    expect(skipped).toHaveBeenCalledTimes(2);
    expect(skipped).toHaveBeenCalledWith('chat');
    expect(() => parse.list({ items: 'нет', unreadTotal: 0 })).toThrow();
  });
  it('страница больше 50 сообщений разбирается, негодное сообщение пропускается', () => {
    const skipped = vi.fn();
    parse.onSkipped(skipped);
    const items = Array.from({ length: 80 }, (_, index) => message(index + 1));
    items[10] = { ...message(11), at: 'не дата' };
    const page = parse.messages({ items, hasMore: true, hasNewer: false });
    expect(page.items).toHaveLength(79);
    expect(page.items.some((item) => item.id === 11)).toBe(false);
    expect(skipped).toHaveBeenCalledWith('message');
  });
  it('служебный текст длиннее 4000 принимается до разумного предела', () => {
    expect(parse.message(message(1, { text: 'а'.repeat(12000) })).text).toHaveLength(12000);
    expect(() =>
      parse.message(message(1, { text: 'а'.repeat(parse.MESSAGE_TEXT_LIMIT + 1) })),
    ).toThrow();
  });
  it('необязательные поля необязательны, лишние отбрасываются, негодные элементы списков пропускаются', () => {
    const skipped = vi.fn();
    parse.onSkipped(skipped);
    const minimal = parse.message({
      id: 7,
      chatId: 4,
      text: '',
      at: '2026-11-05T09:00:00Z',
      future: { anything: true },
    });
    expect(minimal).toMatchObject({
      id: 7,
      author: null,
      deleted: false,
      editedAt: null,
      replyTo: null,
      files: [],
      reactions: [],
      cards: [],
      sticker: null,
      poll: null,
      canEdit: false,
    });
    expect(minimal).not.toHaveProperty('future');
    const mixed = parse.message(
      message(8, {
        reactions: [{ kind: 'like', users: [] }, { kind: 5 }],
        cards: Array.from({ length: 60 }, (_, index) => ({ type: 'task', id: index + 1 })),
        files: [{ fileId: 0 }],
      }),
    );
    expect(mixed.reactions).toEqual([{ kind: 'like', users: [] }]);
    expect(mixed.cards).toHaveLength(60);
    expect(mixed.files).toEqual([]);
    expect(skipped).toHaveBeenCalledWith('reaction');
    expect(skipped).toHaveBeenCalledWith('file');
  });
  it('обязательные поля по-прежнему проверяются', () => {
    for (const broken of [
      message(0),
      message(1, { chatId: undefined }),
      message(1, { text: 5 }),
      message(1, { at: undefined }),
      message(1, { deleted: 'нет' }),
    ])
      expect(() => parse.message(broken)).toThrow();
  });
});
