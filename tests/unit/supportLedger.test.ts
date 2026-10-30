import { describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import {
  SupportLedger,
  type SupportStorage,
  type SupportIntent,
} from '../../src/main/diagnostics/ledger';
const scope = { serverHash: 'a'.repeat(64), ownerId: 1 };
const firstAt = '2026-10-31T04:00:00.000Z';
const input = () => ({
  ...scope,
  previewId: randomUUID(),
  chatId: 9,
  payload: { text: 'Проверка', fileIds: [30] },
  files: [{ fileId: 30, name: 'report.zip', size: 100, sha256: 'b'.repeat(64) }],
  firstAt,
  retryNotAfter: '2026-11-01T03:58:00.000Z',
});
function fixture() {
  let text: string | null = null,
    fail = false;
  const storage: SupportStorage = {
    read: () => text,
    replace: (next) => {
      if (fail) throw Error('disk');
      text = next;
    },
  };
  return {
    storage,
    get text() {
      return text;
    },
    set text(v: string | null) {
      text = v;
    },
    set fail(v: boolean) {
      fail = v;
    },
    ledger: new SupportLedger(storage),
  };
}
const required = <T>(v: T | null): T => {
  if (v === null) throw Error('missing');
  return v;
};
describe('Durable support final intent', () => {
  it('persists immutable key/body before network and treats restart intent as unknown', () => {
    const f = fixture(),
      data = input(),
      r = required(f.ledger.begin(data));
    data.payload.text = 'Изменённый текст';
    data.payload.fileIds.push(90);
    expect(JSON.parse(required(f.text)).records[0].payload).toEqual({
      text: 'Проверка',
      fileIds: [30],
    });
    expect(f.ledger.locked(scope)).toBe(true);
    const restored = new SupportLedger(f.storage),
      after = required(restored.current(scope));
    expect(after).toMatchObject({
      key: r.key,
      payload: r.payload,
      status: 'unresolved',
      mayHaveCommitted: true,
      firstAt: r.firstAt,
      retryNotAfter: r.retryNotAfter,
    });
    expect(restored.begin(input())).toBeNull();
  });
  it('only first proven refusal can release the lock; unknown then refusal retains it', () => {
    const f = fixture(),
      r = required(f.ledger.begin(input()));
    expect(f.ledger.reject(scope, r.id, false)).toBe(true);
    expect(f.ledger.locked(scope)).toBe(false);
    const second = required(f.ledger.begin(input()));
    f.ledger.unknown(scope, second.id);
    f.ledger.reject(scope, second.id, false);
    expect(f.ledger.current(scope)).toMatchObject({ status: 'review', mayHaveCommitted: true });
    expect(f.ledger.locked(scope)).toBe(true);
  });
  it('fixed conservative deadline and rollback never permit a retry outside the server window', () => {
    const f = fixture(),
      r = required(f.ledger.begin(input()));
    f.ledger.unknown(scope, r.id);
    expect(f.ledger.retryAllowed(r, Date.parse(firstAt))).toBe(true);
    for (const now of [
      NaN,
      Date.parse(firstAt) - 1,
      Date.parse(r.retryNotAfter),
      Date.parse(r.retryNotAfter) + 1,
    ])
      expect(f.ledger.retryAllowed(r, now)).toBe(false);
    const restarted = new SupportLedger(f.storage);
    expect(restarted.current(scope)?.retryNotAfter).toBe(r.retryNotAfter);
    expect(restarted.begin(input())).toBeNull();
  });
  it('receipt must be durably saved; failed persistence retains original unresolved bytes', () => {
    const f = fixture(),
      r = required(f.ledger.begin(input()));
    f.ledger.unknown(scope, r.id);
    const before = f.text;
    f.fail = true;
    expect(f.ledger.confirm(scope, r.id, { chatId: 9, messageId: 80 })).toBe(false);
    expect(f.ledger.healthy).toBe(false);
    expect(f.text).toBe(before);
    expect(f.ledger.begin(input())).toBeNull();
    f.fail = false;
    const restart = new SupportLedger(f.storage);
    expect(restart.current(scope)?.key).toBe(r.key);
    expect(restart.locked(scope)).toBe(true);
  });
  it('failed final-intent write does not expose an unsaved request', () => {
    const f = fixture();
    f.fail = true;
    expect(f.ledger.begin(input())).toBeNull();
    expect(f.text).toBeNull();
    expect(f.ledger.healthy).toBe(false);
  });
  it('scope isolates body and receipt, resolved records remain tombstones', () => {
    const f = fixture(),
      r = required(f.ledger.begin(input()));
    expect(f.ledger.current({ ...scope, ownerId: 2 })).toBeNull();
    expect(f.ledger.current({ ...scope, serverHash: 'c'.repeat(64) })).toBeNull();
    expect(f.ledger.confirm({ ...scope, ownerId: 2 }, r.id, { chatId: 9, messageId: 4 })).toBe(
      false,
    );
    f.ledger.unknown(scope, r.id);
    expect(f.ledger.resolve(scope, r.id)).toBe(true);
    expect(f.ledger.locked(scope)).toBe(false);
    const next = required(f.ledger.begin(input()));
    expect(next.key).not.toBe(r.key);
    expect(
      JSON.parse(required(f.text)).records.some(
        (x: SupportIntent) => x.id === r.id && x.status === 'resolved',
      ),
    ).toBe(true);
  });
  it('corrupt/oversized/array-coerced data is blocked rather than replaced with empty healthy state', () => {
    const seed = fixture();
    required(seed.ledger.begin(input()));
    for (const bad of [
      '{',
      ' '.repeat(512 * 1024 + 1),
      JSON.stringify({ schema: 1, records: [], extra: 1 }),
    ]) {
      const f = fixture();
      f.text = bad;
      const ledger = new SupportLedger(f.storage);
      expect(ledger.healthy).toBe(false);
      expect(ledger.begin(input())).toBeNull();
      expect(f.text).toBe(bad);
    }
    for (const field of ['serverHash', 'key', 'status', 'reason']) {
      const f = fixture(),
        raw = JSON.parse(required(seed.text));
      raw.records[0][field] = [raw.records[0][field]];
      raw.sha256 = createHash('sha256').update(JSON.stringify(raw.records)).digest('hex');
      f.text = JSON.stringify(raw);
      expect(new SupportLedger(f.storage).healthy).toBe(false);
    }
  });
  it('rejects contradictory terminal latch states even with a valid file checksum', () => {
    const seed = fixture();
    required(seed.ledger.begin(input()));
    for (const status of ['intent', 'rejected']) {
      const f = fixture(),
        raw = JSON.parse(required(seed.text));
      raw.records[0].status = status;
      raw.records[0].mayHaveCommitted = true;
      raw.sha256 = createHash('sha256').update(JSON.stringify(raw.records)).digest('hex');
      f.text = JSON.stringify(raw);
      expect(new SupportLedger(f.storage).healthy).toBe(false);
    }
  });
  it('detects valid-JSON text corruption before restoring the frozen payload', () => {
    const seed = fixture();
    required(seed.ledger.begin(input()));
    const f = fixture(),
      raw = JSON.parse(required(seed.text));
    raw.records[0].payload.text = 'Незаметно изменённый текст';
    f.text = JSON.stringify(raw);
    expect(new SupportLedger(f.storage).healthy).toBe(false);
  });
  it('late operations cannot resurrect a resolved/confirmed tombstone over a new attempt', () => {
    const f = fixture(),
      first = required(f.ledger.begin(input()));
    f.ledger.unknown(scope, first.id);
    f.ledger.resolve(scope, first.id);
    const next = required(f.ledger.begin(input())),
      before = f.text;
    expect(f.ledger.reject(scope, first.id, true)).toBe(false);
    expect(f.ledger.unknown(scope, first.id)).toBe(false);
    expect(f.ledger.confirm(scope, first.id, { chatId: 9, messageId: 80 })).toBe(false);
    expect(f.text).toBe(before);
    expect(f.ledger.current(scope)?.id).toBe(next.id);
    expect(new SupportLedger(f.storage).healthy).toBe(true);
  });
});
