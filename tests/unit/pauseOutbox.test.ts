import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicPauseStorage,
  PAUSE_OUTBOX_MAX_BYTES,
  PAUSE_OUTBOX_MAX_RECORDS,
  PAUSE_REPLAY_WINDOW_MS,
  PAUSE_CLOCK_TOLERANCE_MS,
  PAUSE_RETENTION_MS,
  PauseOutbox,
  type PauseReplayGate,
} from '../../src/main/timer/pauseOutbox';

const dirs: string[] = [];
const scope = { serverScopeHash: 'a'.repeat(64), ownerId: 17 };
const expected = {
  timerId: 41,
  revision: 3,
  currentSegmentFrom: '2026-10-30T10:00:00.000Z',
};
const at = '2026-10-30T10:15:00.000Z';
const clock = Date.parse(at);
const gate: PauseReplayGate = {
  authenticated: true,
  configFresh: true,
  casChecked: true,
  timerControl2: true,
};
it('restores the exact screensaver pause envelope; unknown future event preserves bytes and blocks writes', () => {
  let text: string | null = null,
    writes = 0;
  const storage = {
    read: () => text,
    replace: (next: string) => {
      text = next;
      writes++;
    },
  };
  const first = new PauseOutbox('memory', {
    storage,
    now: () => clock,
    newKey: () => 'screensaver-once',
  });
  const r = first.capture(scope, expected, at, 'screensaver');
  expect(r).toMatchObject({ eventKind: 'screensaver', at, key: 'screensaver-once' });
  expect(new PauseOutbox('memory', { storage, now: () => clock }).list(scope)).toEqual([r]);
  text = required<string>(text).replace('"eventKind":"screensaver"', '"eventKind":"future-event"');
  const original = text,
    count = writes;
  const future = new PauseOutbox('memory', { storage, now: () => clock });
  expect(future.health.blocked).toBe('read');
  expect(future.capture(scope, expected, at, 'lock')).toBeNull();
  expect(text).toBe(original);
  expect(writes).toBe(count);
});
function required<T>(value: T | null): T {
  if (value === null) throw new Error('Expected a durably captured record');
  return value;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pause-outbox-test-'));
  dirs.push(dir);
  const file = join(dir, 'outbox.json');
  const quarantined = () =>
    readdirSync(dir)
      .filter((name) => name.startsWith('outbox.json.corrupt-20'))
      .map((name) => readFileSync(join(dir, name), 'utf8'));
  let now = clock;
  let key = 0;
  const options = { now: () => now, newKey: () => `operation-${++key}` };
  return {
    file,
    quarantined,
    options,
    open: () => new PauseOutbox(file, options),
    tick: (ms: number) => {
      now += ms;
    },
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (!dir.startsWith(join(tmpdir(), 'pause-outbox-test-'))) throw new Error('unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('durable PauseOutbox, main process only', () => {
  it('persists an immutable minimal envelope before exposing it and reopens identically', () => {
    const f = fixture(),
      box = f.open();
    const input = { ...expected };
    const record = box.capture(scope, input, at, 'lock');
    expect(record).toMatchObject({ schema: 1, ...scope, expected, at, status: 'pending' });
    expect(JSON.parse(readFileSync(f.file, 'utf8')).records).toEqual([record]);
    input.timerId = 999;
    expect(record?.expected.timerId).toBe(41);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record?.expected)).toBe(true);
    expect(f.open().replay(scope, gate)).toEqual([record]);
    expect(Object.keys(record ?? {}).sort()).toEqual(
      [
        'schema',
        'serverScopeHash',
        'ownerId',
        'expected',
        'at',
        'key',
        'eventKind',
        'createdAt',
        'status',
      ].sort(),
    );
  });

  it('retries unknown outcome after reopen with exactly the original key, expected and time', () => {
    const f = fixture(),
      box = f.open();
    const first = box.capture(scope, expected, at, 'lock');
    expect(first).not.toBeNull();
    expect(box.settle(scope, required(first).key, { kind: 'unknown' })).toBe(true);
    f.tick(60_000);
    const replay = f.open().replay(scope, gate)[0];
    expect(replay).toEqual({ ...first, status: 'unknown' });
    expect({ key: replay?.key, expected: replay?.expected, at: replay?.at }).toEqual({
      key: first?.key,
      expected: first?.expected,
      at: first?.at,
    });
  });

  it('replays the identical key after server commit but crash before local acknowledgement', () => {
    const f = fixture();
    const original = f.open().capture(scope, expected, at, 'lock');
    // The transport committed, but this process died without calling settle.
    expect(f.open().replay(scope, gate)).toEqual([original]);
    const reopened = f.open();
    expect(reopened.settle(scope, required(original).key, { kind: 'confirmed' })).toBe(true);
    expect(f.open().list(scope)).toEqual([]);
  });

  it.each(['authenticated', 'configFresh', 'casChecked', 'timerControl2'] as const)(
    'does not expose replay until the caller supplies fresh %s',
    (field) => {
      const f = fixture(),
        box = f.open();
      box.capture(scope, expected, at, 'lock');
      expect(f.open().replay(scope, { ...gate, [field]: false })).toEqual([]);
      expect(f.open().list(scope)).toHaveLength(1);
    },
  );

  it('deduplicates lock, suspend, query and confirmed session end on the captured operation', () => {
    const f = fixture(),
      box = f.open();
    const original = box.capture(scope, expected, at, 'lock');
    for (const event of ['lock', 'suspend', 'query-session-end', 'session-end'] as const)
      expect(box.capture(scope, expected, '2026-10-30T10:16:00.000Z', event)).toEqual(original);
    expect(box.list(scope)).toHaveLength(1);
  });

  it('never sends a query candidate before explicit session-end confirmation', () => {
    const f = fixture(),
      box = f.open();
    const candidate = box.capture(scope, expected, at, 'query-session-end');
    expect(box.replay(scope, gate)).toEqual([]);
    expect(box.settle(scope, required(candidate).key, { kind: 'confirmed' })).toBe(false);
    expect(box.confirmSessionEnd(scope, required(candidate).key)).toEqual({
      ...candidate,
      status: 'pending',
    });
    expect(f.open().replay(scope, gate)[0]).toEqual({ ...candidate, status: 'pending' });
  });

  it('keeps an unconfirmed query as durable review after restart, never guesses shutdown', () => {
    const f = fixture(),
      box = f.open();
    const candidate = box.capture(scope, expected, at, 'query-session-end');
    const reopened = f.open();
    expect(reopened.replay(scope, gate)).toEqual([]);
    expect(reopened.list(scope)).toEqual([
      { ...candidate, status: 'review', reviewReason: 'unconfirmed-query' },
    ]);
    expect(reopened.confirmSessionEnd(scope, required(candidate).key)).toBeNull();
    expect(f.open().list(scope)).toEqual(reopened.list(scope));
  });

  it('cancels a query durably and permits a later independent departure', () => {
    const f = fixture(),
      box = f.open();
    const candidate = box.capture(scope, expected, at, 'query-session-end');
    expect(box.cancelQuery(scope, required(candidate).key)).toBe(true);
    const reopened = f.open();
    expect(reopened.replay(scope, gate)).toEqual([]);
    const departure = reopened.capture(scope, expected, '2026-10-30T10:17:00.000Z', 'suspend');
    expect(departure?.key).not.toBe(candidate?.key);
    expect(departure?.at).toBe('2026-10-30T10:17:00.000Z');
    expect(f.open().replay(scope, gate)).toEqual([departure]);
  });

  it.each(['lock', 'suspend'] as const)(
    'preserves orphan-query review without suppressing a later real %s on the same timer',
    (eventKind) => {
      const f = fixture();
      const candidate = f.open().capture(scope, expected, at, 'query-session-end');
      const reopened = f.open();
      const review = reopened.list(scope)[0];
      expect(review).toEqual({ ...candidate, status: 'review', reviewReason: 'unconfirmed-query' });
      const realAt = '2026-10-30T10:17:00.000Z';
      const departure = reopened.capture(scope, expected, realAt, eventKind);
      expect(departure).toMatchObject({ expected, at: realAt, eventKind, status: 'pending' });
      expect(departure?.key).not.toBe(candidate?.key);
      expect(reopened.list(scope)).toEqual([review, departure]);
      expect(f.open().replay(scope, gate)).toEqual([departure]);
      expect(f.open().list(scope)[0]).toEqual(review);
    },
  );

  it('does not backdate a real lock to an earlier cancellable query', () => {
    const f = fixture(),
      box = f.open();
    const candidate = box.capture(scope, expected, at, 'query-session-end');
    const lock = box.capture(scope, expected, '2026-10-30T10:17:00.000Z', 'lock');
    expect(lock?.key).not.toBe(candidate?.key);
    expect(lock?.at).toBe('2026-10-30T10:17:00.000Z');
    // Заменённый запрос завершения убран: не занимает место и не даёт предупреждения.
    expect(box.list(scope)).toEqual([lock]);
    expect(f.open().replay(scope, gate)).toEqual([lock]);
  });

  it('removes a cancelled query without trace and frees its slot', () => {
    const f = fixture(),
      box = f.open();
    for (let i = 0; i < PAUSE_OUTBOX_MAX_RECORDS - 1; i++)
      box.capture(scope, { ...expected, timerId: 100 + i }, at, 'lock');
    const candidate = required(box.capture(scope, expected, at, 'query-session-end'));
    expect(box.cancelQuery(scope, candidate.key)).toBe(true);
    expect(f.open().list(scope)).toHaveLength(PAUSE_OUTBOX_MAX_RECORDS - 1);
    expect(
      f
        .open()
        .list(scope)
        .some((r) => r.key === candidate.key),
    ).toBe(false);
    expect(box.capture(scope, { ...expected, timerId: 999 }, at, 'lock')).not.toBeNull();
  });

  it('drops cancelled records written by an older version on reopen', () => {
    const f = fixture();
    const record = required(f.open().capture(scope, expected, at, 'query-session-end'));
    writeFileSync(
      f.file,
      JSON.stringify({ schema: 1, records: [{ ...record, status: 'cancelled' }] }),
    );
    expect(f.open().list(scope)).toEqual([]);
    expect(JSON.parse(readFileSync(f.file, 'utf8')).records).toEqual([]);
  });

  it.each([400, 401, 403, 409, 429])(
    'persists HTTP %s as review, not confirmed or retried',
    (status) => {
      const f = fixture(),
        box = f.open();
      const record = box.capture(scope, expected, at, 'lock');
      expect(box.settle(scope, required(record).key, { kind: 'http-failure', status })).toBe(true);
      const reopened = f.open();
      expect(reopened.replay(scope, gate)).toEqual([]);
      expect(reopened.list(scope)[0]).toMatchObject({
        status: 'review',
        reviewReason: 'terminal-http',
      });
      expect(reopened.settle(scope, required(record).key, { kind: 'confirmed' })).toBe(false);
    },
  );

  it('keeps network outcome unknown and expires without rotating the idempotency key', () => {
    const f = fixture(),
      box = f.open();
    const original = box.capture(scope, expected, at, 'lock');
    box.settle(scope, required(original).key, { kind: 'unknown' });
    f.tick(PAUSE_REPLAY_WINDOW_MS - 1);
    expect(box.replay(scope, gate)).toHaveLength(1);
    f.tick(1);
    expect(box.replay(scope, gate)).toEqual([]);
    expect(f.open().list(scope)[0]).toEqual({
      ...original,
      status: 'review',
      reviewReason: 'expired',
    });
  });

  it('isolates users and server hashes for listing, replay, settlement and dismissal', () => {
    const f = fixture(),
      box = f.open();
    const record = box.capture(scope, expected, at, 'lock');
    const otherOwner = { ...scope, ownerId: 18 };
    const otherServer = { ...scope, serverScopeHash: 'b'.repeat(64) };
    box.capture(otherOwner, expected, at, 'lock');
    box.capture(otherServer, expected, at, 'lock');
    expect(box.list(scope)).toEqual([record]);
    expect(box.settle(otherOwner, required(record).key, { kind: 'confirmed' })).toBe(false);
    expect(box.markStale(otherServer, required(record).key)).toBe(false);
    expect(box.dismissReviewed(otherOwner, required(record).key)).toBe(false);
    box.settle(scope, required(record).key, { kind: 'confirmed' });
    const reopened = f.open();
    expect(reopened.list(scope)).toEqual([]);
    expect(reopened.replay(otherOwner, gate)).toHaveLength(1);
    expect(reopened.replay(otherServer, gate)).toHaveLength(1);
  });

  it('retains captured timer A when current timer B exists; stale review never retargets', () => {
    const f = fixture(),
      box = f.open();
    const a = box.capture(scope, expected, at, 'lock');
    const bExpected = { ...expected, timerId: 99, revision: 1 };
    const b = box.capture(scope, bExpected, '2026-10-30T10:16:00.000Z', 'lock');
    expect(box.markStale(scope, required(a).key)).toBe(true);
    expect(f.open().list(scope)[0]).toEqual({ ...a, status: 'review', reviewReason: 'stale' });
    expect(f.open().replay(scope, gate)).toEqual([b]);
    expect(box.dismissReviewed(scope, required(a).key)).toBe(true);
    expect(f.open().list(scope)).toEqual([b]);
  });

  it.each(['{bad', '{"schema":2,"records":[]}', '{"schema":1,"records":{}}'])(
    'quarantines corrupt data %s, keeps its bytes and starts empty with a one-time warning',
    (contents) => {
      const f = fixture();
      writeFileSync(f.file, contents);
      const box = f.open();
      expect(box.health).toEqual({ blocked: null, recovered: true });
      expect(f.quarantined()).toEqual([contents]);
      expect(box.list(scope)).toEqual([]);
      const record = box.capture(scope, expected, at, 'lock');
      expect(record).not.toBeNull();
      expect(f.open().list(scope)).toEqual([record]);
      expect(f.open().health.recovered).toBe(false);
      box.acknowledgeRecovery();
      expect(box.health.recovered).toBe(false);
    },
  );

  it('ignores unknown keys from a newer version instead of treating them as corruption', () => {
    const f = fixture();
    const record = required(f.open().capture(scope, expected, at, 'lock'));
    writeFileSync(
      f.file,
      JSON.stringify({
        schema: 1,
        records: [{ ...record, origin: 'newer', expected: { ...expected, extra: 1 } }],
        generation: 2,
      }),
    );
    const box = f.open();
    expect(box.health).toEqual({ blocked: null, recovered: false });
    expect(box.list(scope)).toEqual([record]);
    expect(f.quarantined()).toEqual([]);
  });

  it('a disk read failure blocks without quarantine; a storage without quarantine stays blocked', () => {
    const contents = '{bad';
    let renamed = 0;
    const failing = new PauseOutbox('memory', {
      storage: {
        read: () => {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        },
        replace: () => undefined,
        quarantine: () => String(++renamed),
      },
    });
    expect(failing.health.blocked).toBe('read');
    expect(renamed).toBe(0);
    const legacy = new PauseOutbox('memory', {
      storage: { read: () => contents, replace: () => undefined },
    });
    expect(legacy.health).toEqual({ blocked: 'read', recovered: false });
    const brokenRename = new PauseOutbox('memory', {
      storage: {
        read: () => contents,
        replace: () => undefined,
        quarantine: () => {
          throw new Error('EPERM');
        },
      },
    });
    expect(brokenRename.health.blocked).toBe('read');
  });

  it('quarantines malformed envelopes and an oversized file without losing their bytes', () => {
    const f = fixture();
    const record = f.open().capture(scope, expected, at, 'lock');
    const badRecords = [
      { ...record, expected: { ...expected, revision: -1 } },
      { ...record, status: 'confirmed' },
      { ...record, status: 'review', reviewReason: 'invented' },
    ];
    const kept: string[] = [];
    for (const bad of badRecords) {
      const contents = JSON.stringify({ schema: 1, records: [bad] });
      writeFileSync(f.file, contents);
      expect(f.open().health.recovered).toBe(true);
      kept.push(contents);
    }
    const tooBig = ' '.repeat(PAUSE_OUTBOX_MAX_BYTES + 1);
    writeFileSync(f.file, tooBig);
    expect(f.open().health).toEqual({ blocked: null, recovered: true });
    expect(f.quarantined().sort()).toEqual([...kept, tooBig].sort());
  });

  it('does not lose existing commands or claim capture/removal when durable write fails', () => {
    const f = fixture();
    const original = f.open().capture(scope, expected, at, 'lock');
    const bytes = readFileSync(f.file, 'utf8');
    const storage = {
      ...atomicPauseStorage(f.file),
      replace() {
        throw new Error('disk full');
      },
    };
    const box = new PauseOutbox(f.file, { ...f.options, storage });
    expect(box.settle(scope, required(original).key, { kind: 'confirmed' })).toBe(false);
    expect(box.health.blocked).toBe('write');
    expect(box.list(scope)).toEqual([original]);
    expect(box.capture(scope, { ...expected, timerId: 55 }, at, 'suspend')).toBeNull();
    expect(box.replay(scope, gate)).toEqual([]);
    expect(readFileSync(f.file, 'utf8')).toBe(bytes);
    expect(f.open().replay(scope, gate)).toEqual([original]);
  });

  it('keeps an orphan candidate blocked if persisting its review state fails on reopen', () => {
    const f = fixture();
    const original = f.open().capture(scope, expected, at, 'query-session-end');
    const bytes = readFileSync(f.file, 'utf8');
    const storage = {
      ...atomicPauseStorage(f.file),
      replace() {
        throw new Error('disk full');
      },
    };
    const box = new PauseOutbox(f.file, { ...f.options, storage });
    expect(box.health.blocked).toBe('write');
    expect(box.list(scope)).toEqual([original]);
    expect(box.replay(scope, gate)).toEqual([]);
    expect(readFileSync(f.file, 'utf8')).toBe(bytes);
    expect(f.open().list(scope)[0]?.reviewReason).toBe('unconfirmed-query');
  });

  it('does not expire or dismiss records belonging to another scope', () => {
    const f = fixture(),
      box = f.open();
    const foreign = { ...scope, ownerId: 18 };
    const record = box.capture(foreign, expected, at, 'lock');
    f.tick(PAUSE_REPLAY_WINDOW_MS + 1);
    expect(box.replay(scope, gate)).toEqual([]);
    expect(box.list(foreign)).toEqual([record]);
    expect(box.dismissReviewed(scope, required(record).key)).toBe(false);
    expect(f.open().list(foreign)).toEqual([record]);
  });

  it('bounds record count without deleting earlier commands', () => {
    const f = fixture(),
      box = f.open();
    for (let i = 0; i < PAUSE_OUTBOX_MAX_RECORDS; i++)
      expect(box.capture(scope, { ...expected, timerId: 100 + i }, at, 'lock')).not.toBeNull();
    expect(box.capture(scope, { ...expected, timerId: 1000 }, at, 'lock')).toBeNull();
    expect(f.open().list(scope)).toHaveLength(PAUSE_OUTBOX_MAX_RECORDS);
  });

  it('rejects invalid captures, quarantines duplicate keys and expires far-future records', () => {
    const f = fixture(),
      box = f.open();
    expect(
      box.capture({ ...scope, serverScopeHash: 'https://example.test' }, expected, at, 'lock'),
    ).toBeNull();
    expect(box.capture(scope, { ...expected, currentSegmentFrom: null }, at, 'lock')).toBeNull();
    expect(box.capture(scope, expected, '2026-10-30T09:00:00.000Z', 'lock')).toBeNull();
    box.capture(scope, expected, at, 'lock');
    const raw = JSON.parse(readFileSync(f.file, 'utf8')) as { records: unknown[] };
    raw.records.push(raw.records[0]);
    writeFileSync(f.file, JSON.stringify(raw));
    expect(f.open().health.recovered).toBe(true);
    writeFileSync(f.file, JSON.stringify({ schema: 1, records: raw.records.slice(0, 1) }));
    // Перекалибровка serverNow на несколько секунд назад — не повод снимать команду.
    f.tick(-PAUSE_CLOCK_TOLERANCE_MS);
    expect(f.open().replay(scope, gate)).toHaveLength(1);
    f.tick(-1);
    expect(f.open().replay(scope, gate)).toEqual([]);
    expect(f.open().list(scope)[0]?.reviewReason).toBe('expired');
  });

  it('prunes foreign server/owner and week-old records, keeping the current scope', () => {
    const f = fixture(),
      box = f.open();
    const own = required(box.capture(scope, expected, at, 'lock'));
    box.capture({ ...scope, ownerId: 18 }, expected, at, 'lock');
    box.capture({ ...scope, serverScopeHash: 'b'.repeat(64) }, expected, at, 'lock');
    expect(box.prune(scope, clock)).toBe(2);
    expect(f.open().list({ ...scope, ownerId: 18 })).toEqual([]);
    expect(f.open().list(scope)).toEqual([own]);
    expect(box.prune(scope, clock + PAUSE_RETENTION_MS)).toBe(0);
    expect(box.prune(scope, clock + PAUSE_RETENTION_MS + 1)).toBe(1);
    expect(f.open().list(scope)).toEqual([]);
  });
});

it.each([500, 503, 599])(
  'HTTP %s keeps the command unknown and replays it with the same key within the window',
  (status) => {
    const f = fixture(),
      box = f.open(),
      record = required(box.capture(scope, expected, at, 'lock'));
    box.settle(scope, record.key, { kind: 'http-failure', status });
    expect(f.open().list(scope)[0]).toEqual({ ...record, status: 'unknown' });
    expect(f.open().replay(scope, gate)).toEqual([{ ...record, status: 'unknown' }]);
    f.tick(PAUSE_REPLAY_WINDOW_MS);
    expect(f.open().replay(scope, gate)).toEqual([]);
    expect(f.open().list(scope)[0]).toMatchObject({ key: record.key, reviewReason: 'expired' });
  },
);
