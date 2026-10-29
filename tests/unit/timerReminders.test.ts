import { describe, expect, it } from 'vitest';
import {
  TimerReminders,
  isReminderTime,
  type ReminderTicket,
} from '../../src/main/timer/reminders';
import { normalizeSettings } from '../../src/main/settings';
import { requestValid } from '../../src/shared/requests';
import { timerFixture } from '../fixtures/time';
import type { ClientSnapshot } from '../../src/shared/desktop';
const at = (day = 29, hour = 18, minute = 30, second = 0) =>
  new Date(2026, 9, day, hour, minute, second).getTime();
const running = (
  owner = 1,
): Pick<ClientSnapshot, 'user' | 'timer' | 'timerReady' | 'connection'> => ({
  timerReady: true,
  connection: 'online',
  user: { id: owner, shortName: 'Тест', mustChangePassword: false },
  timer: timerFixture(),
});
const required = (ticket: ReminderTicket | null) => {
  if (!ticket) throw Error('Missing reminder ticket');
  return ticket;
};
describe('TimerReminders: local calendar, one shown reminder, bounded retry', () => {
  it.each(['00:00', '09:30', '18:30', '23:30'])('accepts exact half-hour %s', (value) =>
    expect(isReminderTime(value)).toBe(true),
  );
  it.each(['9:30', '24:00', '18:15', '18:60', '18:30:00', ' 18:30', '18:30\n', null, 1830])(
    'rejects malformed setting %j',
    (value) => {
      expect(isReminderTime(value)).toBe(false);
      expect(requestValid({ kind: 'timer.preferences', epoch: 1, reminderTime: value })).toBe(
        false,
      );
      expect(normalizeSettings({ timer: { reminderTime: value } }).timer.reminderTime).toBe(
        '18:30',
      );
    },
  );
  it('issues at the local minute, never before, without mutating input', () => {
    const r = new TimerReminders(),
      s = running(),
      copy = structuredClone(s);
    expect(r.due(s, '18:30', at(29, 18, 29, 59))).toBeNull();
    const t = required(r.due(s, '18:30', at()));
    expect(t).toMatchObject({ owner: 1, date: '2026-10-29', taskId: 21, reminderTime: '18:30' });
    expect(r.valid(t, s, '18:30', at())).toBe(true);
    expect(s).toEqual(copy);
  });
  it.each([
    { timerReady: false },
    { connection: 'offline' as const },
    { user: null },
    { timer: null },
    { timer: timerFixture('pause') },
  ])('requires confirmed online running state %o', (patch) =>
    expect(new TimerReminders().due({ ...running(), ...patch }, '18:30', at())).toBeNull(),
  );
  it('suppressed attempts retry after a minute and invalidate the old issued ticket', () => {
    const r = new TimerReminders(),
      s = running(),
      first = required(r.due(s, '18:30', at()));
    expect(r.due(s, '18:30', at() + 59999)).toBeNull();
    const next = required(r.due(s, '18:30', at() + 60000));
    expect(r.valid(first, s, '18:30', at() + 60000)).toBe(false);
    r.shown(first);
    expect(r.valid(next, s, '18:30', at() + 60000)).toBe(true);
    r.shown(next);
    expect(r.due(s, '18:30', at(29, 23))).toBeNull();
  });
  it('keeps a shown day across resets and separates owners/days', () => {
    const r = new TimerReminders(),
      s = running(),
      t = required(r.due(s, '18:30', at()));
    r.shown(t);
    r.reset();
    expect(r.valid(t, s, '18:30', at())).toBe(false);
    expect(r.due(s, '18:30', at())).toBeNull();
    expect(r.due(running(2), '18:30', at())).not.toBeNull();
    expect(r.due(s, '18:30', at(30))).not.toBeNull();
  });
  it('restores only valid shown dates from local settings', () => {
    const settings = normalizeSettings({
      timerReminderSeen: {
        '1': '2026-10-29',
        '2': '2026-02-30',
        bad: '2026-10-29',
        '3': 'private-name',
      },
    });
    expect(settings.timerReminderSeen).toEqual({ '1': '2026-10-29' });
    const r = new TimerReminders();
    r.remember(1, settings.timerReminderSeen['1'] ?? '');
    expect(r.due(running(), '18:30', at())).toBeNull();
    expect(r.due(running(), '18:30', at(30))).not.toBeNull();
  });
  it('old buttons fail for changed owner, task, start, setting, midnight and offline', () => {
    const r = new TimerReminders(),
      s = running(),
      t = required(r.due(s, '18:30', at()));
    for (const next of [
      running(2),
      { ...s, connection: 'offline' as const },
      { ...s, timerReady: false },
      { ...s, timer: timerFixture('pause') },
      { ...s, timer: timerFixture('run', 22) },
      { ...s, timer: { ...timerFixture(), startedAt: '2026-10-29T05:00:00Z' } },
    ])
      expect(r.valid(t, next, '18:30', at())).toBe(false);
    expect(r.valid(t, s, '19:00', at())).toBe(false);
    expect(r.valid(t, s, '18:30', at(30, 0))).toBe(false);
    expect(r.valid(t, s, '18:30', at() - 1)).toBe(false);
  });
  it('late launch is eligible; backward clock and invalid timestamps do not flood', () => {
    const r = new TimerReminders(),
      s = running();
    expect(r.due(s, '18:30', at(29, 20))).not.toBeNull();
    expect(r.due(s, '18:30', at(29, 19))).toBeNull();
    for (const now of [NaN, Infinity, Number.MAX_VALUE]) expect(r.due(s, '18:30', now)).toBeNull();
  });
  it('preferences IPC excludes arbitrary local/server fields', () => {
    const v = { kind: 'timer.preferences', epoch: 1, reminderTime: '19:00' };
    expect(requestValid(v)).toBe(true);
    for (const patch of [
      { serverUrl: 'https://example.test' },
      { pauseOnLock: true },
      { epoch: -1 },
      { reminderTime: '18:30\n' },
    ])
      expect(requestValid({ ...v, ...patch })).toBe(false);
  });
});
