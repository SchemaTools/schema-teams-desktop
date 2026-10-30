import type { ClientSnapshot } from '../../shared/desktop';
type DesktopState = Pick<ClientSnapshot, 'user' | 'timer'>;

export interface AbsenceWarning {
  readonly id: number;
  readonly owner: number;
  readonly from: number;
  readonly to: number;
}

interface PendingAbsence {
  owner: number;
  from: number;
}

// Наблюдает отсутствие сотрудника и хранит предупреждение до подтверждения.
// CAS-команда и её неизменяемый снимок принадлежат ClientHost, не этому наблюдателю.
export class TimerAbsence {
  private locked = false;
  private suspended = false;
  private pending: PendingAbsence | null = null;
  private currentWarning: AbsenceWarning | null = null;
  private nextId = 1;

  get away(): boolean {
    return this.locked || this.suspended;
  }

  get warning(): AbsenceWarning | null {
    return this.currentWarning ? { ...this.currentWarning } : null;
  }

  depart(kind: 'lock' | 'suspend', state: DesktopState, now = Date.now()): void {
    if (kind === 'lock') this.locked = true;
    else this.suspended = true;
    this.observe(state, now);
  }

  return(kind: 'unlock' | 'resume', state: DesktopState, now = Date.now()): void {
    if (kind === 'unlock') this.locked = false;
    else this.suspended = false;
    this.observe(state, now);
    if (this.away || !this.pending) return;

    const { owner, from } = this.pending;
    const previous = this.currentWarning;
    this.currentWarning = {
      id: this.nextId++,
      owner,
      // Пока прежний период не проверен, новое отсутствие не теряет его начало.
      from: previous ? Math.min(previous.from, from) : from,
      to: Math.max(previous?.to ?? from, from, now),
    };
    this.pending = null;
  }

  observe(state: DesktopState, now = Date.now()): void {
    const owner = state.user?.id ?? null;
    if (this.pending && this.pending.owner !== owner) this.pending = null;
    if (this.currentWarning && this.currentWarning.owner !== owner) this.currentWarning = null;
    if (this.away && !this.pending && owner !== null && state.timer?.state === 'run')
      this.pending = { owner, from: now };
  }

  reset(): void {
    // Вход/навигация сбрасывает данные пользователя, но не разблокирует Windows.
    this.pending = null;
    this.currentWarning = null;
  }

  dismiss(): void {
    this.currentWarning = null;
  }
  confirmed(): void {
    this.pending = null;
    this.currentWarning = null;
  }
}
