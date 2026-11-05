import {
  atomicPauseStorage,
  PAUSE_RETENTION_MS,
  type PauseScope,
  type PauseOutboxStorage,
} from './pauseOutbox';
import { expectedValid, utcInstant, type TimerExpected } from '../../shared/time';
import { knownKeys, readRecoverable } from '../quarantine';

export type PauseReturnKind = 'unlock' | 'wake' | 'screensaver' | 'connection';
export interface PauseReturn extends PauseScope {
  key: string;
  expected: TimerExpected;
  at: string;
  returnedAt: string | null;
  returnKind: PauseReturnKind | null;
  delivery: 'pending' | 'shown';
}
const RETURN_KEYS = [
  'serverScopeHash',
  'ownerId',
  'key',
  'expected',
  'at',
  'returnedAt',
  'returnKind',
  'delivery',
] as const;
const valid = (raw: unknown): raw is PauseReturn => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as PauseReturn;
  return (
    Object.keys(r).length === 8 &&
    typeof r.serverScopeHash === 'string' &&
    /^[a-f0-9]{64}$/.test(r.serverScopeHash) &&
    Number.isSafeInteger(r.ownerId) &&
    r.ownerId > 0 &&
    typeof r.key === 'string' &&
    /^[A-Za-z0-9._:-]{8,100}$/.test(r.key) &&
    expectedValid(r.expected) &&
    r.expected.currentSegmentFrom === null &&
    utcInstant(r.at) &&
    (r.returnedAt === null
      ? r.returnKind === null
      : utcInstant(r.returnedAt) &&
        Date.parse(r.returnedAt) >= Date.parse(r.at) &&
        (r.returnKind === 'unlock' ||
          r.returnKind === 'wake' ||
          r.returnKind === 'screensaver' ||
          r.returnKind === 'connection')) &&
    ['pending', 'shown'].includes(r.delivery)
  );
};
/** Поля более новой версии отбрасываются; известные проверяются строго. */
const known = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r = knownKeys<Record<string, unknown>>(raw as Record<string, unknown>, RETURN_KEYS);
  if (r.expected && typeof r.expected === 'object' && !Array.isArray(r.expected))
    r.expected = knownKeys(r.expected as Record<string, unknown>, [
      'timerId',
      'revision',
      'currentSegmentFrom',
    ]);
  return r;
};
const parse = (text: string): PauseReturn[] => {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw) || raw.length > 64) throw Error('invalid');
  const records: unknown[] = raw.map(known);
  if (!records.every(valid) || new Set(records.map((r) => r.key)).size !== records.length)
    throw Error('invalid');
  return records;
};
const sameScope = (a: PauseScope, b: PauseScope) =>
  a.serverScopeHash === b.serverScopeHash && a.ownerId === b.ownerId;
/** Separate durable delivery evidence; removing an acknowledged outbox command must not lose it. */
export class PauseReturns {
  private records: PauseReturn[] = [];
  private blocked = false;
  private wasRecovered = false;
  private storage: PauseOutboxStorage;
  constructor(file: string, storage = atomicPauseStorage(file)) {
    this.storage = storage;
    const loaded = readRecoverable(storage, parse);
    if (loaded.kind === 'blocked') this.blocked = true;
    else if (loaded.kind === 'recovered') this.wasRecovered = true;
    else if (loaded.value) this.records = loaded.value;
  }
  get healthy(): boolean {
    return !this.blocked;
  }
  /** Файл был испорчен, отправлен в карантин и начат заново; сбрасывается подтверждением. */
  get recovered(): boolean {
    return this.wasRecovered;
  }
  acknowledgeRecovery(): void {
    this.wasRecovered = false;
  }
  list(scope: PauseScope): PauseReturn[] {
    return structuredClone(this.records.filter((r) => sameScope(r, scope)));
  }
  put(record: PauseReturn): boolean {
    if (!valid(record)) return false;
    const existing = this.records.find((r) => r.key === record.key);
    if (existing) return sameScope(existing, record);
    return this.records.length < 64 && this.commit([...this.records, structuredClone(record)]);
  }
  shown(scope: PauseScope, key: string): boolean {
    return (
      this.records.some((r) => sameScope(r, scope) && r.key === key) &&
      this.commit(
        this.records.map((r) =>
          sameScope(r, scope) && r.key === key ? { ...r, delivery: 'shown' } : r,
        ),
      )
    );
  }
  returned(
    scope: PauseScope,
    key: string,
    at: string,
    returnKind: PauseReturnKind = 'unlock',
  ): boolean {
    const record = this.records.find((r) => sameScope(r, scope) && r.key === key);
    if (!record || !utcInstant(at)) return false;
    // The Host records only aggregate-clear boundaries. A later source cannot
    // rewrite this observation while a notification is delayed by policy.
    if (record.returnedAt !== null) return true;
    const returnedAt = new Date(Math.max(Date.parse(record.at), Date.parse(at))).toISOString();
    return this.commit(
      this.records.map((r) => (r === record ? { ...r, returnedAt, returnKind } : r)),
    );
  }
  dismiss(scope: PauseScope, key: string): boolean {
    return (
      this.records.some((r) => sameScope(r, scope) && r.key === key) &&
      this.commit(this.records.filter((r) => !(sameScope(r, scope) && r.key === key)))
    );
  }
  /**
   * Снимает записи своего входа, чья пауза уже закончилась (продолжена, завершена,
   * сброшена — из трея, окна, сайта или с другого компьютера). Решает `ended` по свежему
   * снимку сервера. Возвращает число снятых записей.
   */
  settleEnded(scope: PauseScope, ended: (record: PauseReturn) => boolean): number {
    if (this.blocked) return 0;
    const kept = this.records.filter((r) => !sameScope(r, scope) || !ended(r));
    const removed = this.records.length - kept.length;
    return removed && this.commit(kept) ? removed : 0;
  }
  /** Убирает записи чужого сервера и пользователя и старше недели. */
  prune(scope: PauseScope, now = Date.now()): number {
    if (this.blocked || !Number.isFinite(now)) return 0;
    const kept = this.records.filter(
      (r) => sameScope(r, scope) && now - Date.parse(r.at) <= PAUSE_RETENTION_MS,
    );
    const removed = this.records.length - kept.length;
    return removed && this.commit(kept) ? removed : 0;
  }
  private commit(records: PauseReturn[]): boolean {
    if (this.blocked) return false;
    try {
      this.storage.replace(JSON.stringify(records));
      this.records = records;
      return true;
    } catch {
      this.blocked = true;
      return false;
    }
  }
}
