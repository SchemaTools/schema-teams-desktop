import type { ClientSnapshot } from '../../shared/desktop';
import { isoDay, positiveId } from '../../shared/time';
type DesktopState = Pick<ClientSnapshot, 'user' | 'timer' | 'timerReady' | 'connection'>;

const RETRY_MS = 60_000;
const HISTORY_LIMIT = 256;

export interface ReminderTicket {
  readonly id: string;
  readonly owner: number;
  /** Календарный день бюро (часовой пояс из настроек сервера), без пояса — день компьютера. */
  readonly date: string;
  readonly taskId: number;
  readonly startedAt: string | null;
  readonly at: number;
  readonly reminderTime: string;
}

export function isReminderTime(value: unknown): value is string {
  return typeof value === 'string' && value.length === 5 && /^([01]\d|2[0-3]):(00|30)$/.test(value);
}

/**
 * День и минута суток в часовом поясе бюро — как у утренней сводки (ТЗ 5.5).
 * Без пояса (настройки бюро ещё не прочитаны) — часы компьютера.
 */
export function bureauClock(
  now: number,
  timeZone?: string | null,
): { date: string; minutes: number } | null {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  if (!timeZone) {
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return isoDay(day) ? { date: day, minutes: date.getHours() * 60 + date.getMinutes() } : null;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    const minutes = Number(get('hour')) * 60 + Number(get('minute'));
    return isoDay(day) && Number.isInteger(minutes) ? { date: day, minutes } : null;
  } catch {
    return null;
  }
}

function eligible(state: DesktopState): boolean {
  return Boolean(
    state.timerReady && state.connection === 'online' && state.user && state.timer?.state === 'run',
  );
}

/**
 * ТЗ 9.5: напоминание «если таймер идёт» в 18:30. Таймер, запущенный после времени
 * напоминания, напоминания сразу при запуске не получает: он должен быть запущен
 * не позже этого времени сегодня (или в прошлые дни).
 */
function runningAtReminder(
  startedAt: string | undefined,
  today: string,
  reminderMinutes: number,
  timeZone?: string | null,
): boolean {
  const started = startedAt ? bureauClock(Date.parse(startedAt), timeZone) : null;
  if (!started) return false;
  return started.date < today || (started.date === today && started.minutes <= reminderMinutes);
}

/**
 * Локальное напоминание, без команд таймера и обещания серверного CAS.
 * shown вызывается только после фактического показа, поэтому отказ системной
 * политики оставляет следующую попытку доступной через минуту.
 */
export class TimerReminders {
  private readonly attempts = new Map<string, number>();
  private readonly issued = new Map<string, ReminderTicket>();
  private readonly seen = new Set<string>();

  remember(owner: number, date: string): void {
    if (!positiveId(owner) || !isoDay(date)) return;
    this.seen.add(`timer-reminder:${owner}:${date}`);
    while (this.seen.size > HISTORY_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  due(
    state: DesktopState,
    time: string,
    now = Date.now(),
    timeZone?: string | null,
  ): ReminderTicket | null {
    const clock = bureauClock(now, timeZone);
    if (!clock || !isReminderTime(time) || !eligible(state) || !state.user || !state.timer?.task)
      return null;
    const [hours, minutes] = time.split(':').map(Number);
    const reminderMinutes = (hours ?? 0) * 60 + (minutes ?? 0);
    if (clock.minutes < reminderMinutes) return null;
    if (!runningAtReminder(state.timer.startedAt, clock.date, reminderMinutes, timeZone))
      return null;
    const owner = state.user.id;
    const task = state.timer.task;
    const day = clock.date;
    const id = `timer-reminder:${owner}:${day}`;
    if (this.seen.has(id)) return null;
    const previous = this.attempts.get(id);
    // При переводе часов назад не выдаём поток повторов, пока не пройдёт минута.
    if (previous !== undefined && now - previous < RETRY_MS) return null;
    const ticket: ReminderTicket = Object.freeze({
      id,
      owner,
      date: day,
      taskId: task.id,
      startedAt: state.timer?.startedAt,
      at: now,
      reminderTime: time,
    });
    this.attempts.set(id, now);
    this.issued.set(id, ticket);
    this.trim(this.attempts);
    this.trim(this.issued);
    return ticket;
  }

  valid(
    ticket: ReminderTicket,
    state: DesktopState,
    time: string,
    now = Date.now(),
    timeZone?: string | null,
  ): boolean {
    return Boolean(
      this.issued.get(ticket.id) === ticket &&
      eligible(state) &&
      ticket.owner === state.user?.id &&
      ticket.date === bureauClock(now, timeZone)?.date &&
      ticket.reminderTime === time &&
      ticket.taskId === state.timer?.task.id &&
      ticket.startedAt === state.timer?.startedAt &&
      now >= ticket.at,
    );
  }

  shown(ticket: ReminderTicket): void {
    if (this.issued.get(ticket.id) !== ticket) return;
    this.seen.add(ticket.id);
    while (this.seen.size > HISTORY_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  /** Выход/перезагрузка моста инвалидируют UI, но не возвращают уже показанный день. */
  reset(): void {
    this.attempts.clear();
    this.issued.clear();
  }

  private trim<T>(map: Map<string, T>): void {
    while (map.size > HISTORY_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
