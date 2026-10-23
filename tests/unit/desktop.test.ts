import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { eventValid, notifyValid, teamsLink } from '../../src/bridge/validate';
import type { DesktopNotify } from '../../src/bridge/protocol';
import { initialState, elapsed, focusOn, tooltip } from '../../src/main/desktop/state';
import { statusBitmap, badgeBitmap } from '../../src/main/desktop/statusBitmap';
import { normalizeSettings } from '../../src/main/settings';

const notification: DesktopNotify = {
  key: 'chat:7',
  kind: 'message',
  title: 'Чат',
  text: 'Сообщение',
  author: 'Иванова И.И.',
  link: '/chat/7?m=11',
  chatId: 7,
  messageId: 11,
  count: 1,
  buttons: ['reply', 'open', 'read'],
  read: { kind: 'chat', chatId: 7, messageId: 11 },
};
describe('серверный договор и граница IPC', () => {
  it('копия протокола совпадает с опубликованным серверным blob', () => {
    const body = readFileSync(join(__dirname, '../../src/bridge/protocol.ts'));
    const hash = createHash('sha1')
      .update(Buffer.from(`blob ${body.length}\0`))
      .update(body)
      .digest('hex');
    expect(hash).toBe('21bb1258ab9f82b05786e1ba11f58f7ec4fa56f6');
  });
  it.each(['/chat/7?m=11', '/albums/4', '/chat'])('принимает внутреннюю ссылку %s', (link) =>
    expect(teamsLink(link)).toBe(true),
  );
  it.each([
    '//example.com/x',
    '/\\example.com/x',
    'https://example.com',
    'javascript:alert(1)',
    '/\n/example.com',
  ])('блокирует чужую ссылку %s', (link) => expect(teamsLink(link)).toBe(false));
  it('принимает уведомление сервера и отклоняет опасные/негодные поля', () => {
    expect(notifyValid(notification)).toBe(true);
    for (const changes of [
      { chatId: -1 },
      { buttons: ['reply'], chatId: null },
      { link: '//example.com' },
      { count: -1 },
      { buttons: ['open', 'open'] },
      { read: { kind: 'chat', chatId: 7, messageId: 0 } },
      { buttons: ['startTimer'], taskId: null },
    ])
      expect(notifyValid({ ...notification, ...changes })).toBe(false);
    expect(notifyValid({ ...notification, buttons: ['open', 'startTimer'], taskId: 4 })).toBe(true);
  });
  it('проверяет hello, счётчики, состояние связи и фокус', () => {
    expect(
      eventValid('hello', {
        protocol: '1.1',
        user: { id: 1, shortName: 'Тест' },
        serverVersion: '0.10.0',
      }),
    ).toBe(true);
    expect(
      eventValid('hello', {
        protocol: 'bad',
        user: { id: 1, shortName: 'Тест' },
        serverVersion: '0.10.0',
      }),
    ).toBe(false);
    expect(eventValid('counters', { chat: 2, notifications: 3 })).toBe(true);
    expect(eventValid('counters', { chat: 2.2, notifications: 3 })).toBe(false);
    expect(eventValid('focus', { until: 'not a date' })).toBe(false);
    expect(eventValid('focus', null)).toBe(true);
    expect(eventValid('connection', 'unknown')).toBe(false);
    expect(eventValid('signedOut', { unexpected: true })).toBe(false);
  });
});
describe('состояние трея', () => {
  it('отсчёт продолжается только у запущенного таймера, не у паузы', () => {
    const state = initialState();
    state.timerReceivedAt = 1000;
    state.timer = { state: 'run', elapsedSec: 120, startedAt: null, task: null, reason: null };
    expect(elapsed(state, 61000)).toBe(180);
    expect(elapsed(state, 0)).toBe(120);
    state.timer.state = 'pause';
    expect(elapsed(state, 61000)).toBe(120);
  });
  it('фокус истекает и состояние входа/связи отражается в подсказке', () => {
    const state = initialState();
    expect(tooltip(state)).toContain('Нет связи');
    state.focusUntil = '2026-10-23T15:00:00Z';
    expect(focusOn(state, Date.parse('2026-10-23T14:00Z'))).toBe(true);
    expect(focusOn(state, Date.parse('2026-10-23T16:00Z'))).toBe(false);
    state.user = { id: 1, shortName: 'Тест' };
    state.chat = 3;
    state.notifications = 4;
    state.ready = true;
    state.online = true;
    expect(tooltip(state)).toContain('7');
  });
  it('значки показывают разные статусы и непрозрачный счётчик для панели задач', () => {
    const base = { count: 0, online: true, focus: false, timer: 'idle' as const };
    const blank = statusBitmap(16, true, base);
    for (const patch of [
      { count: 1 },
      { count: 12 },
      { online: false },
      { focus: true },
      { timer: 'pause' as const },
    ])
      expect(statusBitmap(16, true, { ...base, ...patch }).data.equals(blank.data)).toBe(false);
    expect(badgeBitmap(2).data.equals(badgeBitmap(12).data)).toBe(false);
    expect(statusBitmap(32, false, base).data.length).toBe(32 * 32 * 4);
  });
  it('новые настройки уведомлений сохраняют частичные значения и безопасные defaults', () => {
    expect(normalizeSettings({ notifications: { preview: false } }).notifications).toEqual({
      enabled: true,
      sound: true,
      preview: false,
    });
    expect(
      normalizeSettings({ notifications: { enabled: 'no', sound: false } }).notifications,
    ).toEqual({ enabled: true, sound: false, preview: true });
  });
});
