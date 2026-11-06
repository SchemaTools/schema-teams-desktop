// По замечаниям руководителя 06.11.2026: новый чат (личный и групповой) и «кто в сети».
import { describe, expect, it, vi } from 'vitest';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import * as parse from '../../src/main/api/parse';
import { PresenceTracker } from '../../src/main/presence';
import { requestValid } from '../../src/shared/requests';
import {
  fromLatinLayout,
  groupMembersValid,
  groupTitleValid,
  peopleServerQuery,
  rankPeople,
} from '../../src/shared/newChat';
import { presenceText } from '../../src/renderer/presence';
import type { ChatSummary } from '../../src/shared/client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function setup(id = 1) {
  const fetch = vi.fn<TeamsApiOptions['fetch']>();
  const api = new TeamsApi({ fetch });
  fetch.mockResolvedValueOnce(
    json({ user: { id, shortName: 'Иванова И.И.', mustChangePassword: false }, csrfToken: 'c-A' }),
  );
  await api.authenticate();
  return { api, fetch };
}
const headers = (init?: RequestInit) => new Headers(init?.headers);
const summary = (extra: Partial<ChatSummary> = {}): ChatSummary => ({
  id: 9,
  kind: 'direct',
  title: '',
  peer: { id: 2, shortName: 'Петров П.П.' },
  objectId: null,
  objectCode: null,
  memberCount: 2,
  last: null,
  unread: 0,
  mentioned: false,
  photoFileId: null,
  ...extra,
});

describe('разбор ответов: коллеги и присутствие', () => {
  it('коллеги — массив {id, shortName} не длиннее 50 без повторов', () => {
    expect(parse.people([{ id: 2, shortName: 'Петров П.П.' }])).toEqual([
      { id: 2, shortName: 'Петров П.П.' },
    ]);
    expect(() => parse.people({})).toThrow();
    expect(() => parse.people([{ id: 0, shortName: 'x' }])).toThrow();
    expect(() =>
      parse.people([
        { id: 2, shortName: 'a' },
        { id: 2, shortName: 'b' },
      ]),
    ).toThrow();
    expect(() =>
      parse.people(Array.from({ length: 51 }, (_, i) => ({ id: i + 1, shortName: 'x' }))),
    ).toThrow();
  });
  it('снимок присутствия: ид в сети без повторов, lastSeen по строковым ид, focus не нужен', () => {
    const value = parse.presenceSnapshot({
      online: [2, 3, 2],
      lastSeen: { '4': '2026-11-06T08:00:00.000Z' },
      focus: { '2': '2026-11-06T18:00:00.000Z' },
    });
    expect(value.online).toEqual([2, 3]);
    expect([...value.lastSeen]).toEqual([[4, '2026-11-06T08:00:00.000Z']]);
    expect(() => parse.presenceSnapshot({ online: [-1], lastSeen: {} })).toThrow();
    expect(() => parse.presenceSnapshot({ online: [], lastSeen: { abc: 'x' } })).toThrow();
    expect(() => parse.presenceSnapshot({ online: [], lastSeen: { '2': 'не дата' } })).toThrow();
    expect(() => parse.presenceSnapshot({ online: 'все' })).toThrow();
  });
  it('событие presence: {userId, online, lastSeen}', () => {
    expect(
      parse.presenceChange({ userId: 2, online: true, lastSeen: null, focusUntil: null }),
    ).toEqual({ userId: 2, online: true, lastSeen: null });
    expect(() => parse.presenceChange({ userId: 2, online: 'да', lastSeen: null })).toThrow();
    expect(() => parse.presenceChange({ userId: 2, online: false, lastSeen: 5 })).toThrow();
  });
});

describe('PresenceTracker', () => {
  it('событие во время запроса снимка не затирается более старым снимком', () => {
    const t = new PresenceTracker();
    const token = t.begin();
    expect(t.apply({ userId: 2, online: false, lastSeen: '2026-11-06T09:00:00.000Z' })).toBe(true);
    // снимок снят до отключения: в нём сотрудник ещё в сети
    expect(t.accept(token, { online: [2, 3], lastSeen: new Map() })).toBe(true);
    expect(t.view()).toEqual({ online: [3], lastSeen: { '2': '2026-11-06T09:00:00.000Z' } });
  });
  it('устаревший снимок (после сброса или нового запроса) не принимается', () => {
    const t = new PresenceTracker();
    const first = t.begin();
    const second = t.begin();
    expect(t.accept(first, { online: [5], lastSeen: new Map() })).toBe(false);
    t.reset();
    expect(t.accept(second, { online: [5], lastSeen: new Map() })).toBe(false);
    expect(t.view()).toEqual({ online: [], lastSeen: {} });
  });
  it('повтор того же события ничего не меняет; null не стирает известное время', () => {
    const t = new PresenceTracker();
    expect(t.apply({ userId: 2, online: false, lastSeen: '2026-11-06T09:00:00.000Z' })).toBe(true);
    const v = t.version;
    expect(t.apply({ userId: 2, online: false, lastSeen: '2026-11-06T09:00:00.000Z' })).toBe(false);
    expect(t.version).toBe(v);
    expect(t.apply({ userId: 2, online: true, lastSeen: null })).toBe(true);
    expect(t.isOnline(2)).toBe(true);
    expect(t.view().lastSeen).toEqual({ '2': '2026-11-06T09:00:00.000Z' });
  });
});

describe('IPC: белый список запросов нового чата', () => {
  it('принимает только узкие формы', () => {
    expect(requestValid({ kind: 'chat.people', epoch: 1, q: 'Иван' })).toBe(true);
    expect(requestValid({ kind: 'chat.people', epoch: 1, q: 'x'.repeat(101) })).toBe(false);
    expect(requestValid({ kind: 'chat.people', q: '' })).toBe(false);
    expect(requestValid({ kind: 'chat.direct', epoch: 1, userId: 2 })).toBe(true);
    expect(requestValid({ kind: 'chat.direct', epoch: 1, userId: 0 })).toBe(false);
    expect(requestValid({ kind: 'chat.direct', epoch: 1, userId: 2, extra: 1 })).toBe(false);
    const group = { kind: 'chat.group', epoch: 1, title: 'Группа А', userIds: [2, 3] };
    expect(requestValid({ ...group, requestId: 'group-key-0001' })).toBe(true);
    expect(requestValid(group)).toBe(false);
    expect(requestValid({ ...group, requestId: 'bad key' })).toBe(false);
    expect(requestValid({ ...group, title: '  ', requestId: 'group-key-0001' })).toBe(false);
    expect(requestValid({ ...group, userIds: [], requestId: 'group-key-0001' })).toBe(false);
    expect(requestValid({ ...group, userIds: [2, 2], requestId: 'group-key-0001' })).toBe(false);
    expect(requestValid({ kind: 'presence.read', epoch: 1 })).toBe(true);
    expect(requestValid({ kind: 'presence.read', epoch: 1, userId: 2 })).toBe(false);
  });
  it('название 1…80 знаков без перевода строки, участников 1…49', () => {
    expect(groupTitleValid('А'.repeat(80))).toBe(true);
    expect(groupTitleValid('А'.repeat(81))).toBe(false);
    expect(groupTitleValid('Группа\nА')).toBe(false);
    expect(groupMembersValid(Array.from({ length: 49 }, (_, i) => i + 2))).toBe(true);
    expect(groupMembersValid(Array.from({ length: 50 }, (_, i) => i + 2))).toBe(false);
  });
});

describe('TeamsApi: новый чат', () => {
  it('личный чат: POST с CSRF, ответ — личный чат с выбранным коллегой', async () => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json(summary()));
    expect(await h.api.openDirect(2)).toMatchObject({ ok: true, data: { id: 9 } });
    const [path, init] = h.fetch.mock.calls[1] ?? [];
    expect(path).toBe('/api/chats/direct');
    expect(init?.method).toBe('POST');
    expect(headers(init).get('x-csrf-token')).toBe('c-A');
    expect(JSON.parse(String(init?.body))).toEqual({ userId: 2 });
    h.fetch.mockResolvedValueOnce(json(summary({ peer: { id: 3, shortName: 'x' } })));
    expect(await h.api.openDirect(2)).toMatchObject({ ok: false, code: 'invalid_data' });
    expect(await h.api.openDirect(1)).toMatchObject({ ok: false, code: 'validation' });
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it('группа: название обрезается, ключ повтора в заголовке, 201 и проверка ответа', async () => {
    const h = await setup();
    const group = summary({ id: 30, kind: 'group', title: 'Группа А', peer: null });
    h.fetch.mockResolvedValueOnce(json(group, 201));
    expect(await h.api.createGroup('  Группа А ', [2, 3], 'group-key-0001')).toMatchObject({
      ok: true,
      data: { id: 30 },
    });
    const init = h.fetch.mock.calls[1]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'Группа А', userIds: [2, 3] });
    expect(headers(init).get('idempotency-key')).toBe('group-key-0001');
    expect(headers(init).get('x-csrf-token')).toBe('c-A');
    h.fetch.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    expect(await h.api.createGroup('Группа А', [2], 'group-key-0002')).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    // себя в участниках не бывает — сервер добавляет создателя сам
    expect(await h.api.createGroup('Группа А', [1, 2], 'group-key-0003')).toMatchObject({
      ok: false,
      code: 'validation',
    });
  });
  it('коллеги: запрос кодируется, себя в списке нет', async () => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(
      json([
        { id: 1, shortName: 'Иванова И.И.' },
        { id: 2, shortName: 'Петров П.П.' },
      ]),
    );
    expect(await h.api.people(' Пет ')).toEqual({
      ok: true,
      data: [{ id: 2, shortName: 'Петров П.П.' }],
    });
    expect(h.fetch.mock.calls[1]?.[0]).toBe('/api/chats/people?q=%D0%9F%D0%B5%D1%82');
    h.fetch.mockResolvedValueOnce(json([]));
    await h.api.people('');
    expect(h.fetch.mock.calls[2]?.[0]).toBe('/api/chats/people');
  });
});

describe('умный поиск по фамилии', () => {
  const people = [
    { id: 2, shortName: 'Петров П.П.' },
    { id: 3, shortName: 'Семёнова А.А.' },
    { id: 4, shortName: 'Иванова И.И.' },
    { id: 5, shortName: 'Андреев С.П.' },
  ];
  it('фамилия с начала — выше вхождения; «е» находит «ё»', () => {
    expect(rankPeople(people, 'пе').map((p) => p.id)).toEqual([2]);
    expect(rankPeople(people, 'семен').map((p) => p.id)).toEqual([3]);
    expect(rankPeople(people, 'ан').map((p) => p.id)).toEqual([5, 4]);
    expect(rankPeople(people, '').map((p) => p.id)).toEqual([5, 4, 2, 3]);
  });
  it('английская раскладка понимается', () => {
    expect(fromLatinLayout('bdfyjdf')).toBe('иванова');
    expect(rankPeople(people, 'bdfy').map((p) => p.id)).toEqual([4]);
    expect(peopleServerQuery('bdfy')).toBe('иван');
  });
  it('серверу — самый длинный кусок без «е/ё»: сервер не приравнивает их', () => {
    expect(peopleServerQuery('Семёнова')).toBe('нова');
    expect(peopleServerQuery('Петров')).toBe('тров');
    expect(peopleServerQuery('Иванова')).toBe('иванова');
    expect(peopleServerQuery('е')).toBe('');
  });
});

describe('подпись «в сети» в шапке личного чата', () => {
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  it('в сети, был сегодня/вчера/раньше — по поясу бюро', () => {
    expect(presenceText(true, null, 'Europe/Moscow', now)).toBe('в сети');
    expect(presenceText(false, null, 'Europe/Moscow', now)).toBe('не в сети');
    expect(presenceText(false, '2026-11-06T08:05:00.000Z', 'Europe/Moscow', now)).toBe(
      'был(а) в сети в 11:05',
    );
    expect(presenceText(false, '2026-11-05T20:30:00.000Z', 'Europe/Moscow', now)).toBe(
      'был(а) в сети вчера в 23:30',
    );
    // 21:30 по UTC 05.11 — уже 06.11 по Москве
    expect(presenceText(false, '2026-11-05T21:30:00.000Z', 'Europe/Moscow', now)).toBe(
      'был(а) в сети в 00:30',
    );
    expect(presenceText(false, '2026-11-01T07:00:00.000Z', 'Europe/Moscow', now)).toBe(
      'был(а) в сети 1 ноября в 10:00',
    );
  });
});
