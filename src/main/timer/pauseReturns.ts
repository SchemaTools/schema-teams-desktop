import { atomicPauseStorage, type PauseScope, type PauseOutboxStorage } from './pauseOutbox';
import { expectedValid, utcInstant, type TimerExpected } from '../../shared/time';

export interface PauseReturn extends PauseScope {
  key: string;
  expected: TimerExpected;
  at: string;
  returnedAt: string | null;
  returnKind: 'unlock' | 'wake' | 'connection' | null;
  delivery: 'pending' | 'shown';
}
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
        (r.returnKind === 'unlock' || r.returnKind === 'wake' || r.returnKind === 'connection')) &&
    ['pending', 'shown'].includes(r.delivery)
  );
};
const sameScope = (a: PauseScope, b: PauseScope) =>
  a.serverScopeHash === b.serverScopeHash && a.ownerId === b.ownerId;
/** Separate durable delivery evidence; removing an acknowledged outbox command must not lose it. */
export class PauseReturns {
  private records: PauseReturn[] = [];
  private blocked = false;
  private storage: PauseOutboxStorage;
  constructor(file: string, storage = atomicPauseStorage(file)) {
    this.storage = storage;
    try {
      const text = storage.read();
      if (text === null) return;
      const raw: unknown = JSON.parse(text);
      if (
        !Array.isArray(raw) ||
        raw.length > 64 ||
        !raw.every(valid) ||
        new Set(raw.map((r) => r.key)).size !== raw.length
      )
        throw Error('invalid');
      this.records = raw;
    } catch {
      this.blocked = true;
    }
  }
  get healthy(): boolean {
    return !this.blocked;
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
    returnKind: 'unlock' | 'wake' | 'connection' = 'unlock',
  ): boolean {
    const record = this.records.find((r) => sameScope(r, scope) && r.key === key);
    if (!record || !utcInstant(at)) return false;
    if (
      record.returnedAt !== null &&
      !(returnKind === 'unlock' && record.returnKind !== 'unlock' && record.delivery === 'pending')
    )
      return true;
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
