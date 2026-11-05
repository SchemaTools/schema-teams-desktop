import { describe, expect, it, vi } from 'vitest';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import { attachments } from '../../src/main/api/parse';
import { requestValid } from '../../src/shared/requests';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const item = (id: number) => ({
  id,
  messageId: 50,
  at: '2026-11-05T09:00:00Z',
  authorShortName: 'Петров П.П.',
  file: { fileId: 7, fileName: 'Схема.png', size: 10, mime: 'image/png', isImage: true },
});

describe('вложения чата для панели сведений', () => {
  it('разбирает страницу, негодную запись пропускает', () => {
    expect(attachments({ items: [item(3), { id: 'x' }], hasMore: true })).toEqual({
      items: [item(3)],
      hasMore: true,
    });
    expect(() => attachments({ items: [] })).toThrow();
  });
  it('запрос: вид и курсор страницы в адресе, негодное — без сети', async () => {
    const fetch = vi.fn<TeamsApiOptions['fetch']>();
    const api = new TeamsApi({ fetch, onAuthLost: vi.fn() });
    fetch.mockResolvedValueOnce(
      json({
        user: { id: 1, shortName: 'Иванова И.И.', mustChangePassword: false },
        csrfToken: 'csrf-A',
      }),
    );
    await api.authenticate();
    fetch.mockResolvedValueOnce(json({ items: [], hasMore: false }));
    fetch.mockResolvedValueOnce(json({ items: [], hasMore: false }));
    await api.attachments(4, 'image');
    await api.attachments(4, 'file', 120);
    expect(fetch.mock.calls.slice(1).map((c) => c[0])).toEqual([
      '/api/chats/4/attachments?kind=image',
      '/api/chats/4/attachments?kind=file&before=120',
    ]);
    // @ts-expect-error — неверный вид отбрасывается и в работе
    expect(await api.attachments(4, 'video')).toMatchObject({ code: 'validation' });
    expect(await api.attachments(4, 'image', 0)).toMatchObject({ code: 'validation' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('запрос окна проверяется', () => {
    const base = { kind: 'chat.attachments', epoch: 1, chatId: 4 };
    expect(requestValid({ ...base, type: 'image' })).toBe(true);
    expect(requestValid({ ...base, type: 'file', before: 9 })).toBe(true);
    expect(requestValid({ ...base, type: 'video' })).toBe(false);
    expect(requestValid({ ...base, type: 'image', before: -1 })).toBe(false);
    expect(requestValid({ ...base, type: 'image', q: 'x' })).toBe(false);
  });
});
