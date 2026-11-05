import {
  closeSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { expectedValid, positiveId, utcInstant, type TimerExpected } from '../../shared/time';
import { CorruptStateError, knownKeys, quarantineFile, readRecoverable } from '../quarantine';

export const PAUSE_OUTBOX_MAX_BYTES = 64 * 1024;
export const PAUSE_OUTBOX_MAX_RECORDS = 64;
export const PAUSE_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Допуск на перекалибровку serverNow: запись «из будущего» в пределах 30 с не просрочена. */
export const PAUSE_CLOCK_TOLERANCE_MS = 30_000;
/** Записи чужого сервера, чужого пользователя и старше недели убираются (prune). */
export const PAUSE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface PauseScope {
  readonly serverScopeHash: string;
  readonly ownerId: number;
}
export type PauseEvent = 'lock' | 'suspend' | 'screensaver' | 'query-session-end' | 'session-end';
/** 'cancelled' остаётся только для чтения файлов прежних версий: такие записи убираются. */
export type PauseStatus = 'candidate' | 'pending' | 'unknown' | 'review' | 'cancelled';
export type PauseReviewReason =
  | 'unconfirmed-query'
  | 'expired'
  | 'terminal-http'
  | 'server-error'
  | 'unconfirmed-result'
  | 'stale';
export interface PauseEnvelope extends PauseScope {
  readonly schema: 1;
  readonly expected: Readonly<TimerExpected>;
  readonly at: string;
  readonly key: string;
  readonly eventKind: PauseEvent;
  readonly createdAt: string;
  readonly status: PauseStatus;
  readonly reviewReason?: PauseReviewReason;
}
/** No transport lives here. The caller must refresh authentication/config and inspect CAS first. */
export interface PauseReplayGate {
  readonly authenticated: boolean;
  readonly configFresh: boolean;
  readonly casChecked: boolean;
  readonly timerControl2: boolean;
}
export type PauseOutcome =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'review' }
  | { readonly kind: 'http-failure'; readonly status: number };

export interface PauseOutboxStorage {
  /** Must reject oversized files before reading them. null means ENOENT only. */
  read(): string | null;
  /** Must preserve the previous file on failure before atomic replacement. */
  replace(contents: string): void;
  /** Испорченный файл — в карантин `<имя>.corrupt-<время>`; без метода хранилище блокируется. */
  quarantine?(): string;
}

/** Small synchronous persistence for a session-end callback; no user-profile files in tests. */
export function atomicPauseStorage(file: string): PauseOutboxStorage {
  return {
    read() {
      try {
        const fd = openSync(file, 'r');
        try {
          if (fstatSync(fd).size > PAUSE_OUTBOX_MAX_BYTES)
            throw new CorruptStateError('outbox-size');
          const bytes = Buffer.alloc(PAUSE_OUTBOX_MAX_BYTES + 1);
          let length = 0;
          while (length < bytes.length) {
            const read = readSync(fd, bytes, length, bytes.length - length, null);
            if (!read) break;
            length += read;
          }
          if (length > PAUSE_OUTBOX_MAX_BYTES) throw new CorruptStateError('outbox-size');
          return bytes.subarray(0, length).toString('utf8');
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    replace(contents) {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(temp, 'wx', 0o600);
        writeFileSync(fd, contents, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, file);
      } finally {
        if (fd !== undefined) closeSync(fd);
        try {
          unlinkSync(temp);
        } catch {
          // A successful rename has consumed temp. Never remove the previous outbox.
        }
      }
    },
    quarantine: () => quarantineFile(file),
  };
}

const scopeValid = (scope: PauseScope): boolean =>
  /^[a-f0-9]{64}$/.test(scope.serverScopeHash) && positiveId(scope.ownerId);
const sameScope = (a: PauseScope, b: PauseScope): boolean =>
  a.ownerId === b.ownerId && a.serverScopeHash === b.serverScopeHash;
const sameExpected = (a: Readonly<TimerExpected>, b: Readonly<TimerExpected>): boolean =>
  a.timerId === b.timerId &&
  a.revision === b.revision &&
  a.currentSegmentFrom === b.currentSegmentFrom;
const keyValid = (key: unknown): key is string =>
  typeof key === 'string' && /^[A-Za-z0-9._:-]{8,100}$/.test(key);
const events: readonly string[] = [
  'lock',
  'suspend',
  'screensaver',
  'query-session-end',
  'session-end',
];
const statuses: readonly string[] = ['candidate', 'pending', 'unknown', 'review', 'cancelled'];
const reasons: readonly string[] = [
  'unconfirmed-query',
  'expired',
  'terminal-http',
  'server-error',
  'unconfirmed-result',
  'stale',
];
const freeze = (record: PauseEnvelope): PauseEnvelope =>
  Object.freeze({ ...record, expected: Object.freeze({ ...record.expected }) });

const ENVELOPE_KEYS = [
  'schema',
  'serverScopeHash',
  'ownerId',
  'expected',
  'at',
  'key',
  'eventKind',
  'createdAt',
  'status',
  'reviewReason',
] as const;
/** Поля более новой версии отбрасываются; известные поля проверяются строго. */
function envelopeKnown(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r = knownKeys<Record<string, unknown>>(raw as Record<string, unknown>, ENVELOPE_KEYS);
  if (r.expected && typeof r.expected === 'object' && !Array.isArray(r.expected))
    r.expected = knownKeys(r.expected as Record<string, unknown>, [
      'timerId',
      'revision',
      'currentSegmentFrom',
    ]);
  return r;
}

function envelopeValid(raw: unknown): raw is PauseEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  return (
    Object.keys(r).every((k) => (ENVELOPE_KEYS as readonly string[]).includes(k)) &&
    r.schema === 1 &&
    typeof r.serverScopeHash === 'string' &&
    /^[a-f0-9]{64}$/.test(r.serverScopeHash) &&
    positiveId(r.ownerId) &&
    expectedValid(r.expected) &&
    r.expected.currentSegmentFrom !== null &&
    utcInstant(r.at) &&
    utcInstant(r.createdAt) &&
    Date.parse(r.at) >= Date.parse(r.expected.currentSegmentFrom) &&
    keyValid(r.key) &&
    typeof r.eventKind === 'string' &&
    events.includes(r.eventKind) &&
    typeof r.status === 'string' &&
    statuses.includes(r.status) &&
    (r.status !== 'candidate' || r.eventKind === 'query-session-end') &&
    (r.status === 'review'
      ? typeof r.reviewReason === 'string' && reasons.includes(r.reviewReason)
      : r.reviewReason === undefined)
  );
}

function parseOutbox(text: string): PauseEnvelope[] {
  if (Buffer.byteLength(text, 'utf8') > PAUSE_OUTBOX_MAX_BYTES) throw new Error('size');
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('format');
  const doc = raw as Record<string, unknown>;
  // Лишние поля документа от более новой версии не считаются порчей.
  if (doc.schema !== 1 || !Array.isArray(doc.records)) throw new Error('schema');
  const records: unknown[] = doc.records.map(envelopeKnown);
  if (records.length > PAUSE_OUTBOX_MAX_RECORDS || !records.every(envelopeValid))
    throw new Error('records');
  if (new Set(records.map((r) => r.key)).size !== records.length) throw new Error('duplicate-key');
  return records;
}

/** Single main-process writer. Do not share this file across processes or live store instances. */
export class PauseOutbox {
  private records: readonly PauseEnvelope[] = [];
  private blocked: 'read' | 'write' | null = null;
  private wasRecovered = false;
  private readonly storage: PauseOutboxStorage;
  private readonly now: () => number;
  private readonly newKey: () => string;

  constructor(
    file: string,
    options: {
      storage?: PauseOutboxStorage;
      /** Inject the server-calibrated clock for creation/replay TTL. Local fallback is not server evidence. */
      now?: () => number;
      newKey?: () => string;
    } = {},
  ) {
    this.storage = options.storage ?? atomicPauseStorage(file);
    this.now = options.now ?? Date.now;
    this.newKey = options.newKey ?? randomUUID;
    const loaded = readRecoverable(this.storage, parseOutbox);
    if (loaded.kind === 'blocked') {
      this.blocked = 'read';
      return;
    }
    if (loaded.kind === 'recovered') {
      this.wasRecovered = true;
      return;
    }
    if (!loaded.value) return;
    this.records = loaded.value.map(freeze);
    // A query is not evidence that shutdown happened. Reopening cannot confirm it.
    // Отменённый запрос завершения (прежние версии) места в очереди не занимает.
    if (this.records.some((r) => r.status === 'candidate' || r.status === 'cancelled'))
      this.commit(
        this.records
          .filter((r) => r.status !== 'cancelled')
          .map((r) =>
            r.status === 'candidate'
              ? freeze({ ...r, status: 'review', reviewReason: 'unconfirmed-query' })
              : r,
          ),
      );
  }

  get health(): Readonly<{ blocked: 'read' | 'write' | null; recovered: boolean }> {
    return Object.freeze({ blocked: this.blocked, recovered: this.wasRecovered });
  }

  /** Предупреждение о сброшенной очереди показано и закрыто пользователем. */
  acknowledgeRecovery(): void {
    this.wasRecovered = false;
  }

  list(scope: PauseScope): readonly PauseEnvelope[] {
    if (!scopeValid(scope)) return Object.freeze([]);
    return Object.freeze(this.records.filter((r) => sameScope(r, scope)));
  }

  /**
   * Убирает записи чужого сервера и пользователя (вход сменился) и старше недели.
   * Возвращает число удалённых записей; при сбое записи — 0 и блокировка, как у commit.
   */
  prune(scope: PauseScope, now = Date.now()): number {
    if (this.blocked || !scopeValid(scope) || !Number.isFinite(now)) return 0;
    const kept = this.records.filter(
      (r) => sameScope(r, scope) && now - Date.parse(r.createdAt) <= PAUSE_RETENTION_MS,
    );
    const removed = this.records.length - kept.length;
    return removed && this.commit(kept) ? removed : 0;
  }

  /** Persists before returning a command. null means no durable command was captured. */
  capture(
    scope: PauseScope,
    expected: TimerExpected,
    at: string,
    eventKind: PauseEvent,
  ): PauseEnvelope | null {
    if (
      this.blocked ||
      !scopeValid(scope) ||
      !events.includes(eventKind) ||
      !expectedValid(expected) ||
      expected.currentSegmentFrom === null ||
      !utcInstant(at) ||
      Date.parse(at) < Date.parse(expected.currentSegmentFrom)
    )
      return null;
    const previous = this.records.find(
      (r) =>
        sameScope(r, scope) &&
        sameExpected(r.expected, expected) &&
        ['candidate', 'pending', 'unknown'].includes(r.status),
    );
    if (previous) {
      if (previous.status === 'candidate' && eventKind === 'session-end')
        return this.confirmSessionEnd(scope, previous.key);
      if (previous.status !== 'candidate' || eventKind === 'query-session-end') return previous;
    }
    // Lock/suspend is separate evidence from a cancellable shutdown query. Keep its actual time;
    // the superseded query is removed and does not occupy a queue slot.
    const base =
      previous?.status === 'candidate' ? this.records.filter((r) => r !== previous) : this.records;
    if (base.length >= PAUSE_OUTBOX_MAX_RECORDS) return null;
    const record: PauseEnvelope = {
      schema: 1,
      ...scope,
      expected: { ...expected },
      at,
      key: this.newKey(),
      eventKind,
      createdAt: new Date(this.now()).toISOString(),
      status: eventKind === 'query-session-end' ? 'candidate' : 'pending',
    };
    if (!envelopeValid(record) || this.records.some((r) => r.key === record.key)) return null;
    const frozen = freeze(record);
    return this.commit([...base, frozen]) ? frozen : null;
  }

  confirmSessionEnd(scope: PauseScope, key: string): PauseEnvelope | null {
    const r = this.find(scope, key);
    if (!r || r.status !== 'candidate') return null;
    const next = freeze({ ...r, status: 'pending' });
    return this.replace(r, next) ? next : null;
  }

  /**
   * Завершение Windows отменено (процесс жив, сеанс продолжается): кандидат удаляется
   * без следа — ни предупреждения, ни места в очереди.
   */
  cancelQuery(scope: PauseScope, key: string): boolean {
    const r = this.find(scope, key);
    return !!r && r.status === 'candidate' && this.commit(this.records.filter((v) => v !== r));
  }

  /** Caller explicitly chooses stale review after its fresh CAS observation; never retargets. */
  markStale(scope: PauseScope, key: string): boolean {
    const r = this.find(scope, key);
    return (
      !!r &&
      ['pending', 'unknown'].includes(r.status) &&
      this.replace(r, freeze({ ...r, status: 'review', reviewReason: 'stale' }))
    );
  }

  /** Only identical captured commands. A changed timer never supplies replacement expected/body/key. */
  replay(scope: PauseScope, gate: PauseReplayGate): readonly PauseEnvelope[] {
    if (
      this.blocked ||
      !scopeValid(scope) ||
      !gate.authenticated ||
      !gate.configFresh ||
      !gate.casChecked ||
      !gate.timerControl2
    )
      return Object.freeze([]);
    const now = this.now();
    // Срок — время хранения ключа идемпотентности сервером (24 ч). Запись «из будущего»
    // в пределах допуска — следствие перекалибровки serverNow, а не подделка часов.
    const expired = this.records.filter(
      (r) =>
        sameScope(r, scope) &&
        ['pending', 'unknown'].includes(r.status) &&
        (now - Date.parse(r.createdAt) >= PAUSE_REPLAY_WINDOW_MS ||
          now < Date.parse(r.createdAt) - PAUSE_CLOCK_TOLERANCE_MS),
    );
    if (
      expired.length &&
      !this.commit(
        this.records.map((r) =>
          expired.includes(r) ? freeze({ ...r, status: 'review', reviewReason: 'expired' }) : r,
        ),
      )
    )
      return Object.freeze([]);
    return Object.freeze(
      this.records.filter(
        (r) => sameScope(r, scope) && (r.status === 'pending' || r.status === 'unknown'),
      ),
    );
  }

  /**
   * 4xx — окончательный отказ (review). 5xx и сеть — исход неизвестен: команда остаётся
   * в очереди с тем же ключом идемпотентности и повторяется, пока не истечёт срок replay.
   */
  settle(scope: PauseScope, key: string, outcome: PauseOutcome): boolean {
    const r = this.find(scope, key);
    if (!r || !['pending', 'unknown'].includes(r.status)) return false;
    if (outcome.kind === 'confirmed') return this.commit(this.records.filter((v) => v !== r));
    const terminal =
      outcome.kind === 'http-failure' &&
      Number.isSafeInteger(outcome.status) &&
      outcome.status >= 400 &&
      outcome.status < 500;
    return this.replace(
      r,
      terminal
        ? freeze({ ...r, status: 'review', reviewReason: 'terminal-http' })
        : outcome.kind === 'review'
          ? freeze({ ...r, status: 'review', reviewReason: 'unconfirmed-result' })
          : freeze({ ...r, status: 'unknown' }),
    );
  }

  /** Explicit review dismissal only; foreign records are removed by prune on scope change. */
  dismissReviewed(scope: PauseScope, key: string): boolean {
    const r = this.find(scope, key);
    return (
      !!r &&
      ['review', 'cancelled'].includes(r.status) &&
      this.commit(this.records.filter((v) => v !== r))
    );
  }

  private find(scope: PauseScope, key: string): PauseEnvelope | undefined {
    return !this.blocked && scopeValid(scope)
      ? this.records.find((r) => r.key === key && sameScope(r, scope))
      : undefined;
  }
  private replace(old: PauseEnvelope, next: PauseEnvelope): boolean {
    return this.commit(this.records.map((r) => (r === old ? next : r)));
  }
  private commit(records: readonly PauseEnvelope[]): boolean {
    if (this.blocked) return false;
    const text = JSON.stringify({ schema: 1, records });
    if (Buffer.byteLength(text, 'utf8') > PAUSE_OUTBOX_MAX_BYTES) return false;
    try {
      this.storage.replace(text);
      this.records = records;
      return true;
    } catch {
      // No caller may report confirmed pause/removal after a failed durable commit.
      this.blocked = 'write';
      return false;
    }
  }
}
