import { describe, expect, it, vi } from 'vitest';
import { TeamsApi } from '../../src/main/api/client';
import * as parse from '../../src/main/api/parse';
import { LiveNoticeGate } from '../../src/main/notifications/liveGate';
import { chatGroups } from '../../src/renderer/model';
import { REACTION_KINDS, type ChatSummary, type NotificationItem } from '../../src/shared/client';
import { requestValid } from '../../src/shared/requests';

const chat = (id = 4, fields: Partial<ChatSummary> = {}): ChatSummary => ({
  id,
  kind: 'object',
  title: 'Одинаковое название',
  peer: null,
  objectId: id + 100,
  objectCode: 'ОБ',
  memberCount: 2,
  last: null,
  unread: 0,
  mentioned: false,
  photoFileId: null,
  ...fields,
});
const item = (id = 501, event = 'album_issued'): NotificationItem => ({
  id,
  event,
  at: '2026-10-30T09:00:00Z',
  read: false,
  author: null,
  task: null,
  changes: [],
  reason: null,
  subject: 'Не определяет вид события',
  link: '/albums/7',
});
const message = {
  id: 101,
  chatId: 4,
  author: null,
  text: '',
  at: '2026-10-30T09:00:00Z',
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
};
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
async function apiFixture(owner = 1) {
  const fetch = vi.fn<ConstructorParameters<typeof TeamsApi>[0]['fetch']>();
  const api = new TeamsApi({ fetch, onAuthLost: vi.fn() });
  fetch.mockResolvedValueOnce(
    json({
      user: { id: owner, shortName: 'Тест', mustChangePassword: false },
      csrfToken: `csrf-${owner}`,
    }),
  );
  await api.authenticate();
  return { api, fetch };
}

describe('D4 chat contracts', () => {
  it('preserves missing/null unknown values and rejects malformed current fields', () => {
    expect(parse.summary(chat())).not.toHaveProperty('myActiveTasks');
    expect(parse.summary(chat(4, { myActiveTasks: null, top: null }))).toMatchObject({
      myActiveTasks: null,
      top: null,
    });
    expect(parse.summary(chat(4, { myActiveTasks: 0, top: false }))).toMatchObject({
      myActiveTasks: 0,
      top: false,
    });
    for (const value of [-1, 0.5, '2', [], {}])
      expect(() => parse.summary({ ...chat(), myActiveTasks: value })).toThrow();
    for (const value of [0, 'false', [], {}])
      expect(() => parse.summary({ ...chat(), top: value })).toThrow();
  });
  it('groups by IDs and server task counts; top is exclusive and last-message sorted', () => {
    const last = (id: number, at: string) => ({
      id,
      at,
      authorId: 2,
      authorShortName: 'Тест',
      preview: '',
      deleted: false,
    });
    const groups = chatGroups([
      chat(1, { top: true, myActiveTasks: 9, last: last(10, '2026-10-30T08:00:00Z') }),
      chat(2, { top: true, last: last(11, '2026-10-30T09:00:00Z') }),
      chat(3, { myActiveTasks: 1 }),
      chat(4, { myActiveTasks: 0 }),
      chat(5, { myActiveTasks: null }),
      chat(6),
      chat(7, { kind: 'group', myActiveTasks: 2 }),
    ]);
    expect(groups.top.map((c) => c.id)).toEqual([2, 1]);
    expect(groups.active.map((c) => c.id)).toEqual([3]);
    expect(groups.other.map((c) => c.id)).toEqual([4, 5, 6, 7]);
  });
  it('uses all eight reaction mutations and rejects unknown/extra IPC fields', async () => {
    const { api, fetch } = await apiFixture();
    for (const kind of REACTION_KINDS) {
      expect(
        requestValid({
          kind: 'chat.reaction',
          epoch: api.epoch,
          chatId: 4,
          messageId: 101,
          reaction: kind,
          remove: false,
        }),
      ).toBe(true);
      fetch.mockResolvedValueOnce(json([]));
      expect(await api.reactions(4, 101, kind, false)).toEqual({ ok: true, data: [] });
      expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({ kind });
    }
    expect(requestValid({ kind: 'chat.top', epoch: api.epoch, chatId: 4, top: true })).toBe(true);
    expect(
      requestValid({ kind: 'chat.top', epoch: api.epoch, chatId: 4, top: true, ownerId: 2 }),
    ).toBe(false);
    expect(requestValid({ kind: 'chat.top', epoch: api.epoch, chatId: 4, top: 1 })).toBe(false);
  });
  it('top uses authenticated PUT/CSRF and surfaces sixth-pin and rights rejection without success', async () => {
    const { api, fetch } = await apiFixture();
    fetch.mockResolvedValueOnce(json(chat(4, { top: true })));
    expect(await api.top(4, true)).toMatchObject({ ok: true, data: { id: 4, top: true } });
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/chats/4/top');
    expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('PUT');
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get('x-csrf-token')).toBe('csrf-1');
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({ top: true });
    fetch.mockResolvedValueOnce(json({ error: { code: 'top_limit' } }, 409));
    expect(await api.top(5, true)).toMatchObject({
      ok: false,
      code: 'top_limit',
      error: 'Закрепить можно не больше 5 чатов.',
    });
    fetch.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    expect(await api.top(6, true)).toMatchObject({ ok: false, code: 'forbidden' });
  });
  it('rejects foreign/top-mismatched responses and late previous-login success', async () => {
    const { api, fetch } = await apiFixture();
    for (const value of [chat(8, { top: true }), chat(4, { top: false }), chat()]) {
      fetch.mockResolvedValueOnce(json(value));
      expect(await api.top(4, true)).toMatchObject({ ok: false, code: 'invalid_data' });
    }
    let resolve!: (r: Response) => void;
    fetch.mockReturnValueOnce(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    const pending = api.top(4, true);
    api.clear();
    resolve(json(chat(4, { top: true })));
    expect(await pending).toMatchObject({ ok: false, code: 'stale_session' });
  });
  it('parses socket-only quiet separately from REST and binds event kind/id', () => {
    expect(parse.message(message)).not.toHaveProperty('quiet');
    expect(parse.messageEvent(message).quiet).toBeNull();
    expect(parse.messageEvent({ ...message, quiet: true }).quiet).toBe(true);
    expect(() => parse.messageEvent({ ...message, quiet: 'false' })).toThrow();
    expect(
      parse.notificationPush({
        item: item(),
        kind: 'album_issued',
        notificationId: 501,
        quiet: false,
      }).kind,
    ).toBe('album_issued');
    expect(
      parse.notificationPush({
        item: item(502, 'future_event'),
        kind: 'future_event',
        notificationId: 502,
        quiet: true,
      }).kind,
    ).toBe('future_event');
    expect(() =>
      parse.notificationPush({
        item: item(),
        kind: 'remarks_closed',
        notificationId: 501,
        quiet: false,
      }),
    ).toThrow();
    expect(() =>
      parse.notificationPush({
        item: item(),
        kind: 'album_issued',
        notificationId: 502,
        quiet: false,
      }),
    ).toThrow();
  });
});

describe('Live popup watermarks', () => {
  it('never evicts seen/quiet IDs at capacity, and only fresh covering history reopens the gate', () => {
    const gate = new LiveNoticeGate(2);
    gate.prime([], []);
    expect(gate.message(4, 101)).toBe(true);
    expect(gate.message(4, 102)).toBe(true);
    expect(gate.message(4, 103)).toBe(false);
    expect(gate.message(4, 101)).toBe(false);
    gate.reconnect();
    gate.prime([], []);
    expect(gate.message(4, 104)).toBe(false);
    gate.prime([], [], true);
    expect(gate.message(4, 101)).toBe(false);
    gate.prime(
      [
        chat(4, {
          last: {
            id: 104,
            at: message.at,
            authorId: 2,
            authorShortName: 'Тест',
            preview: '',
            deleted: false,
          },
        }),
      ],
      [],
      true,
    );
    expect(gate.message(4, 103)).toBe(false);
    expect(gate.message(4, 105)).toBe(true);
    const notifications = new LiveNoticeGate(2);
    notifications.prime([], []);
    expect(notifications.notification(501)).toBe(true);
    expect(notifications.notification(502)).toBe(true);
    expect(notifications.notification(503)).toBe(false);
    expect(notifications.notification(501)).toBe(false);
    notifications.prime([], [item(503)], true);
    expect(notifications.notification(503)).toBe(false);
    expect(notifications.notification(504)).toBe(true);
  });
  it('accepts concurrent live IDs out of order above a separate history baseline exactly once', () => {
    const gate = new LiveNoticeGate();
    gate.prime(
      [
        chat(4, {
          last: {
            id: 100,
            at: message.at,
            authorId: 2,
            authorShortName: 'Тест',
            preview: '',
            deleted: false,
          },
        }),
      ],
      [item(100)],
    );
    for (const id of [102, 101]) {
      expect(gate.message(4, id)).toBe(true);
      expect(gate.notification(id)).toBe(true);
    }
    for (const id of [101, 102, 100, 99]) {
      expect(gate.message(4, id)).toBe(false);
      expect(gate.notification(id)).toBe(false);
    }
    gate.reconnect();
    gate.prime([], []);
    expect(gate.message(4, 101)).toBe(false);
    expect(gate.notification(101)).toBe(false);
    expect(gate.message(4, 103)).toBe(true);
    expect(gate.notification(103)).toBe(true);
  });
  it('suppressed/replayed live IDs never reappear; reconnect/history prime without flood', () => {
    const gate = new LiveNoticeGate();
    expect(gate.message(4, 100)).toBe(false);
    gate.prime([], [item()]);
    expect(gate.notification(501)).toBe(false);
    expect(gate.message(4, 101)).toBe(true);
    expect(gate.message(4, 101)).toBe(false);
    expect(gate.notification(502)).toBe(true);
    expect(gate.notification(502)).toBe(false);
    gate.reconnect();
    expect(gate.message(4, 102)).toBe(false);
    gate.prime(
      [
        chat(4, {
          last: {
            id: 105,
            at: message.at,
            authorId: 2,
            authorShortName: 'Тест',
            preview: '',
            deleted: false,
          },
        }),
      ],
      [item(505)],
    );
    expect(gate.message(4, 104)).toBe(false);
    expect(gate.notification(504)).toBe(false);
    expect(gate.message(4, 106)).toBe(true);
    expect(gate.notification(506)).toBe(true);
    gate.reset();
    gate.prime([], []);
    expect(gate.message(4, 101)).toBe(true);
  });
});
