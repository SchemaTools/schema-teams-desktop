import { describe, expect, it } from 'vitest';
import { initialState, type DesktopState } from '../../src/main/desktop/state';
import {
  isReminderTime,
  TimerReminders,
  type ReminderTicket,
} from '../../src/main/timer/reminders';

const at = (day = 28, hour = 18, minute = 30, second = 0) =>
  new Date(2026, 9, day, hour, minute, second).getTime();
function running(owner = 1): DesktopState {
  return {
    ...initialState(),
    ready: true,
    online: true,
    user: { id: owner, shortName: 'Тест' },
    timer: {
      state: 'run',
      task: { id: 4, mark: 'АР1', title: 'Тестовая задача' },
      startedAt: new Date(2026, 9, 28, 9).toISOString(),
      elapsedSec: 120,
      reason: null,
    },
  };
}
function required(ticket: ReminderTicket | null): ReminderTicket {
  if (!ticket) throw new Error('Ожидалось напоминание');
  return ticket;
}

describe('локальное напоминание об идущем таймере', () => {
  it.each(['00:00', '09:30', '18:30', '23:30'])('принимает время %s', (value) => {
    expect(isReminderTime(value)).toBe(true);
  });
  it.each(['9:30', '24:00', '18:15', '18:60', '18:30:00', ' 18:30', '18:30\n', null, 1830])(
    'не принимает время %s',
    (value) => expect(isReminderTime(value)).toBe(false),
  );

  it('выдаёт в заданную локальную минуту и не выдаёт раньше', () => {
    const reminders = new TimerReminders();
    const state = running();
    expect(reminders.due(state, '18:30', at(28, 18, 29, 59))).toBeNull();
    const ticket = reminders.due(state, '18:30', at());
    expect(ticket).toMatchObject({
      id: 'timer-reminder:1:2026-10-28',
      date: '2026-10-28',
      taskId: 4,
      owner: 1,
      reminderTime: '18:30',
      at: at(),
    });
    expect(reminders.valid(required(ticket), state, '18:30', at())).toBe(true);
  });

  it.each([
    { ready: false },
    { online: false },
    { user: null },
    { timer: { ...running().timer, state: 'pause' as const } },
    { timer: { ...running().timer, state: 'idle' as const } },
    { timer: { ...running().timer, task: null } },
  ])('не напоминает без рабочего состояния %o', (patch) => {
    expect(new TimerReminders().due({ ...running(), ...patch }, '18:30', at())).toBeNull();
  });

  it('при отказе показа повторяет через минуту с тем же id и инвалидирует старый ticket', () => {
    const reminders = new TimerReminders();
    const state = running();
    const first = required(reminders.due(state, '18:30', at()));
    expect(reminders.due(state, '18:30', at())).toBeNull();
    expect(reminders.due(state, '18:30', at() + 59_999)).toBeNull();
    const next = required(reminders.due(state, '18:30', at(28, 18, 31)));
    expect(next.id).toBe(first.id);
    expect(next).not.toBe(first);
    expect(reminders.valid(first, state, '18:30', at(28, 18, 31))).toBe(false);
    expect(reminders.valid(next, state, '18:30', at(28, 18, 31))).toBe(true);
    reminders.shown(first);
    expect(reminders.due(state, '18:30', at(28, 18, 32))).not.toBeNull();
  });

  it('после фактического показа оставляет кнопки валидными и больше не выдаёт день', () => {
    const reminders = new TimerReminders();
    const state = running();
    const ticket = required(reminders.due(state, '18:30', at()));
    reminders.shown(ticket);
    expect(reminders.valid(ticket, state, '18:30', at(28, 18, 31))).toBe(true);
    expect(reminders.due(state, '18:30', at(28, 23, 59, 59))).toBeNull();
    // Даже новый таймер этого же сотрудника не вызывает повтор в тот же день.
    expect(
      reminders.due(
        { ...state, timer: { ...state.timer, task: { id: 5, mark: null, title: 'Другая' } } },
        '18:30',
        at(28, 19),
      ),
    ).toBeNull();
  });

  it('отделяет дни и пользователей, не использует вчерашнюю кнопку после полуночи', () => {
    const reminders = new TimerReminders();
    const state = running();
    const first = required(reminders.due(state, '18:30', at()));
    reminders.shown(first);
    expect(reminders.due(running(2), '18:30', at())).not.toBeNull();
    expect(reminders.valid(first, state, '18:30', at(29, 0))).toBe(false);
    expect(reminders.due(state, '18:30', at(29, 0))).toBeNull();
    expect(reminders.due(state, '18:30', at(29))).toMatchObject({ date: '2026-10-29' });
  });

  it('инвалидирует кнопку при смене owner/задачи/запуска, паузе, offline и настройке', () => {
    const reminders = new TimerReminders();
    const state = running();
    const ticket = required(reminders.due(state, '18:30', at()));
    for (const changed of [
      running(2),
      { ...state, online: false },
      { ...state, ready: false },
      { ...state, timer: { ...state.timer, state: 'pause' as const } },
      { ...state, timer: { ...state.timer, task: { id: 5, mark: null, title: 'Другая' } } },
      { ...state, timer: { ...state.timer, startedAt: new Date(at(28, 10)).toISOString() } },
    ])
      expect(reminders.valid(ticket, changed, '18:30', at())).toBe(false);
    expect(reminders.valid(ticket, state, '19:00', at())).toBe(false);
  });

  it('после reset старый ticket непригоден, показанный день не повторяется при входе', () => {
    const reminders = new TimerReminders();
    const state = running();
    const first = required(reminders.due(state, '18:30', at()));
    reminders.shown(first);
    reminders.reset();
    expect(reminders.valid(first, state, '18:30', at())).toBe(false);
    expect(reminders.due(state, '18:30', at())).toBeNull();
    expect(reminders.due(running(2), '18:30', at())).not.toBeNull();
  });

  it('reset после подавления сбрасывает rate limit и позволяет новое подключение', () => {
    const reminders = new TimerReminders();
    const state = running();
    const first = required(reminders.due(state, '18:30', at()));
    reminders.reset();
    reminders.shown(first);
    const next = required(reminders.due(state, '18:30', at()));
    expect(next).not.toBeNull();
    expect(reminders.valid(first, state, '18:30', at())).toBe(false);
  });

  it('поздний запуск напоминает сегодня, а перевод часов назад не создаёт поток повторов', () => {
    const reminders = new TimerReminders();
    const state = running();
    const ticket = required(reminders.due(state, '18:30', at(28, 20, 0)));
    expect(ticket).not.toBeNull();
    expect(reminders.valid(ticket, state, '18:30', at(28, 19))).toBe(false);
    expect(reminders.due(state, '18:30', at(28, 19))).toBeNull();
    expect(reminders.due(state, '18:30', at(28, 20, 1))).not.toBeNull();
  });

  it('не принимает нечисловое время и негодную настройку', () => {
    const reminders = new TimerReminders();
    for (const now of [NaN, Infinity, Number.MAX_VALUE])
      expect(reminders.due(running(), '18:30', now)).toBeNull();
    expect(reminders.due(running(), '18:15', at())).toBeNull();
  });
});
