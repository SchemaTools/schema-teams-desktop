// Кто в сети (Teams 0.9.0, п. 4.1): снимок `GET /api/chats/presence` при входе и после
// переподключения сокета, затем — события `chat:presence`. События, пришедшие, пока снимок
// в пути, не теряются: снимок сервера мог быть снят раньше них, поэтому они накладываются
// поверх снимка. Смена входа или выход — всё сбрасывается.

export interface PresenceChange {
  userId: number;
  online: boolean;
  lastSeen: string | null;
}
export interface PresenceSnapshotData {
  online: readonly number[];
  lastSeen: ReadonlyMap<number, string>;
}

export class PresenceTracker {
  private online = new Set<number>();
  private lastSeen = new Map<number, string>();
  /** Номер текущего запроса снимка; события во время запроса копятся в `during`. */
  private flight = 0;
  private during: PresenceChange[] | null = null;
  private generation = 0;

  /** Начать запрос снимка: вернуть метку, которую потом отдать в `accept`. */
  begin(): number {
    this.during = [];
    return ++this.flight;
  }
  /** Снимок пришёл. Устаревший (был новый запрос или сброс) — не принимается. */
  accept(token: number, snapshot: PresenceSnapshotData): boolean {
    if (token !== this.flight || this.during === null) return false;
    const replay = this.during;
    this.during = null;
    this.online = new Set(snapshot.online);
    this.lastSeen = new Map(snapshot.lastSeen);
    for (const change of replay) this.write(change);
    this.generation++;
    return true;
  }
  /** Снимок не получен: события уже применены, ждать больше нечего. */
  fail(token: number): void {
    if (token === this.flight) this.during = null;
  }
  /** Событие сокета; true — что-то изменилось (только тогда окну нужен новый снимок). */
  apply(change: PresenceChange): boolean {
    this.during?.push(change);
    const changed = this.write(change);
    if (changed) this.generation++;
    return changed;
  }
  reset(): void {
    this.flight++;
    this.during = null;
    const had = this.online.size > 0 || this.lastSeen.size > 0;
    this.online = new Set();
    this.lastSeen = new Map();
    if (had) this.generation++;
  }
  /** Растёт при каждом изменении — по нему не отправлять окну одно и то же. */
  get version(): number {
    return this.generation;
  }
  isOnline(userId: number): boolean {
    return this.online.has(userId);
  }
  view(): { online: number[]; lastSeen: Record<string, string> } {
    return {
      online: [...this.online].sort((a, b) => a - b),
      lastSeen: Object.fromEntries([...this.lastSeen].map(([id, at]) => [String(id), at])),
    };
  }
  private write(change: PresenceChange): boolean {
    const wasOnline = this.online.has(change.userId);
    const before = this.lastSeen.get(change.userId) ?? null;
    if (change.online) this.online.add(change.userId);
    else this.online.delete(change.userId);
    // «был(а) в сети» — только известное время; null не стирает прежнее
    if (change.lastSeen !== null) this.lastSeen.set(change.userId, change.lastSeen);
    return wasOnline !== change.online || before !== (this.lastSeen.get(change.userId) ?? null);
  }
}
