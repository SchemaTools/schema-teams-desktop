import type { DesktopState } from '../desktop/state';

const RETRY_MS = 60_000;
const HISTORY_LIMIT = 256;

export interface ReminderTicket {
  readonly id: string;
  readonly owner: number;
  /** Календарный день компьютера, не UTC-день сервера. */
  readonly date: string;
  readonly taskId: number;
  readonly startedAt: string | null;
  readonly at: number;
  readonly reminderTime: string;
}

export function isReminderTime(value: unknown): value is string {
  return typeof value === 'string' && value.length === 5 && /^([01]\d|2[0-3]):(00|30)$/.test(value);
}

function localDay(now: number): string | null {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function eligible(state: DesktopState): boolean {
  return Boolean(
    state.ready && state.online && state.user && state.timer.state === 'run' && state.timer.task,
  );
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

  due(state: DesktopState, time: string, now = Date.now()): ReminderTicket | null {
    const day = localDay(now);
    if (!day || !isReminderTime(time) || !eligible(state) || !state.user || !state.timer.task)
      return null;
    const date = new Date(now);
    const [hours, minutes] = time.split(':').map(Number);
    if (date.getHours() * 60 + date.getMinutes() < (hours ?? 0) * 60 + (minutes ?? 0)) return null;
    const owner = state.user.id;
    const task = state.timer.task;
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
      startedAt: state.timer.startedAt,
      at: now,
      reminderTime: time,
    });
    this.attempts.set(id, now);
    this.issued.set(id, ticket);
    this.trim(this.attempts);
    this.trim(this.issued);
    return ticket;
  }

  valid(ticket: ReminderTicket, state: DesktopState, time: string, now = Date.now()): boolean {
    return Boolean(
      this.issued.get(ticket.id) === ticket &&
      eligible(state) &&
      ticket.owner === state.user?.id &&
      ticket.date === localDay(now) &&
      ticket.reminderTime === time &&
      ticket.taskId === state.timer.task?.id &&
      ticket.startedAt === state.timer.startedAt &&
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
