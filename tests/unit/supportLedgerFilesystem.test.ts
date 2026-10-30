import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SUPPORT_LEDGER_LIMIT,
  SupportLedger,
  supportStorage,
} from '../../src/main/diagnostics/ledger';

const privateRoot = resolve(__dirname, '../../private');
const roots: string[] = [];
const scope = { serverHash: 'a'.repeat(64), ownerId: 1 };
const input = (owner = scope) => ({
  ...owner,
  previewId: randomUUID(),
  chatId: 9,
  payload: { text: 'Synthetic filesystem test', fileIds: [30] },
  files: [{ fileId: 30, name: 'fixture.zip', size: 100, sha256: 'b'.repeat(64) }],
  firstAt: '2026-10-31T04:00:00.000Z',
  retryNotAfter: '2026-11-01T03:58:00.000Z',
});
function fixture() {
  mkdirSync(privateRoot, { recursive: true });
  const root = mkdtempSync(join(privateRoot, 'support-ledger-fs-'));
  roots.push(root);
  const file = join(root, 'journal', 'support.json');
  return { root, file, open: () => new SupportLedger(supportStorage(file)) };
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw Error('Expected saved fixture record');
  return value;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(privateRoot), resolve(root));
    if (!rel || rel.startsWith('..') || resolve(root) === resolve(privateRoot))
      throw Error('Refusing cleanup outside owned private test root');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SupportLedger real filesystem storage', () => {
  it('persists intent before return and reopens with identical key/body/time as unknown', () => {
    const f = fixture();
    const ledger = f.open();
    const data = input();
    const record = required(ledger.begin(data));
    const bytes = readFileSync(f.file);
    expect(JSON.parse(bytes.toString()).records).toEqual([record]);
    data.payload.text = 'Changed after begin';
    data.payload.fileIds.push(99);
    expect(readFileSync(f.file)).toEqual(bytes);

    const reopened = f.open();
    const unknown = required(reopened.current(scope));
    expect(unknown).toEqual({
      ...record,
      status: 'unresolved',
      mayHaveCommitted: true,
      reason: 'unknown',
    });
    const persisted = readFileSync(f.file);
    expect(JSON.parse(persisted.toString()).records).toEqual([unknown]);
    expect(reopened.begin(input())).toBeNull();
    expect(f.open().current(scope)).toEqual(unknown);
    expect(readFileSync(f.file)).toEqual(persisted);
    expect(readdirSync(join(f.root, 'journal'))).toEqual(['support.json']);
  });

  it('stores confirmed receipt across reopen without rewriting or losing frozen payload', () => {
    const f = fixture();
    const ledger = f.open();
    const record = required(ledger.begin(input()));
    expect(ledger.confirm(scope, record.id, { chatId: 9, messageId: 80 })).toBe(true);
    const bytes = readFileSync(f.file);
    const reopened = f.open();
    expect(reopened.healthy).toBe(true);
    expect(reopened.current(scope)).toEqual({
      ...record,
      status: 'confirmed',
      mayHaveCommitted: true,
      receipt: { chatId: 9, messageId: 80 },
    });
    expect(reopened.locked(scope)).toBe(false);
    expect(readFileSync(f.file)).toEqual(bytes);
  });

  it.each(['malformed', 'checksum', 'oversized'] as const)(
    'blocks %s journal without changing even one byte or creating a replacement',
    (kind) => {
      const f = fixture();
      const ledger = f.open();
      required(ledger.begin(input()));
      const raw = JSON.parse(readFileSync(f.file, 'utf8'));
      raw.records[0].payload.text = 'Checksum no longer matches';
      const bad = Buffer.from(
        kind === 'malformed'
          ? '{broken\u0000'
          : kind === 'oversized'
            ? 'x'.repeat(SUPPORT_LEDGER_LIMIT + 1)
            : JSON.stringify(raw),
      );
      writeFileSync(f.file, bad);
      const reopened = f.open();
      expect(reopened.healthy).toBe(false);
      expect(reopened.locked(scope)).toBe(true);
      expect(reopened.begin(input())).toBeNull();
      expect(readFileSync(f.file)).toEqual(bad);
      expect(readdirSync(join(f.root, 'journal'))).toEqual(['support.json']);
    },
  );

  it('real rename failure blocks writes, preserves prior bytes and foreign sentinel, cleans temp', () => {
    const f = fixture();
    const ledger = f.open();
    const record = required(ledger.begin(input()));
    expect(ledger.unknown(scope, record.id)).toBe(true);
    const previous = readFileSync(f.file);
    const backup = join(f.root, 'journal', 'original.json');
    // Change the target after the ledger read: rename over this nonempty directory must fail.
    renameSync(f.file, backup);
    mkdirSync(f.file);
    const sentinel = join(f.file, 'foreign.bin');
    const foreign = Buffer.from([0, 255, 19, 128]);
    writeFileSync(sentinel, foreign);
    expect(ledger.confirm(scope, record.id, { chatId: 9, messageId: 80 })).toBe(false);
    expect(ledger.healthy).toBe(false);
    expect(ledger.current(scope)).toMatchObject({ key: record.key, status: 'unresolved' });
    expect(ledger.begin(input())).toBeNull();
    expect(readFileSync(backup)).toEqual(previous);
    expect(readFileSync(sentinel)).toEqual(foreign);
    expect(readdirSync(join(f.root, 'journal')).sort()).toEqual(['original.json', 'support.json']);
    expect(readdirSync(f.file)).toEqual(['foreign.bin']);
    expect(f.open().healthy).toBe(false);
    expect(readFileSync(backup)).toEqual(previous);
    expect(readFileSync(sentinel)).toEqual(foreign);
  });

  it('retains other owner/server records when reopening and updating one receipt', () => {
    const f = fixture();
    const owners = [scope, { ...scope, ownerId: 2 }, { ...scope, serverHash: 'c'.repeat(64) }];
    const ledger = f.open();
    const records = owners.map((owner) => required(ledger.begin(input(owner))));
    const reopened = f.open();
    const before = owners.map((owner) => required(reopened.current(owner)));
    expect(reopened.current({ ...scope, ownerId: 3 })).toBeNull();
    expect(reopened.confirm(scope, required(records[0]).id, { chatId: 9, messageId: 90 })).toBe(
      true,
    );
    const persisted = JSON.parse(readFileSync(f.file, 'utf8')).records;
    expect(persisted).toHaveLength(3);
    expect(persisted.slice(1)).toEqual(before.slice(1));
    const again = f.open();
    expect(again.current(required(owners[1]))).toEqual(before[1]);
    expect(again.current(required(owners[2]))).toEqual(before[2]);
    expect(again.current(scope)).toMatchObject({ receipt: { chatId: 9, messageId: 90 } });
    expect(readdirSync(join(f.root, 'journal'))).toEqual(['support.json']);
  });
});
