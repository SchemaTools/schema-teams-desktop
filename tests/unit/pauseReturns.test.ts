import { describe, expect, it } from 'vitest';
import { PauseReturns, type PauseReturn } from '../../src/main/timer/pauseReturns';
import type { PauseOutboxStorage } from '../../src/main/timer/pauseOutbox';
const record = (): PauseReturn => ({
  serverScopeHash: 'a'.repeat(64),
  ownerId: 1,
  key: 'return-fixture',
  expected: { timerId: 7, revision: 2, currentSegmentFrom: null },
  at: '2026-10-30T04:00:00.000Z',
  returnedAt: null,
  returnKind: null,
  delivery: 'pending',
});
const memory = (): PauseOutboxStorage => {
  let text: string | null = null;
  return {
    read: () => text,
    replace: (next) => {
      text = next;
    },
  };
};
describe('Durable return delivery state', () => {
  it('keeps the same pending intent across crash-between-files and only records actual show', () => {
    const storage = memory(),
      first = new PauseReturns('memory', storage),
      item = record();
    expect(first.put(item)).toBe(true);
    const restored = new PauseReturns('memory', storage);
    expect(restored.list(item)).toEqual([item]);
    expect(restored.shown(item, item.key)).toBe(true);
    expect(restored.put(item)).toBe(true);
    expect(new PauseReturns('memory', storage).list(item)[0]?.delivery).toBe('shown');
  });
  it('does not let a foreign owner/server mark or dismiss another record', () => {
    const store = new PauseReturns('memory', memory()),
      item = record();
    store.put(item);
    for (const scope of [
      { ...item, ownerId: 2 },
      { ...item, serverScopeHash: 'b'.repeat(64) },
    ]) {
      expect(store.list(scope)).toEqual([]);
      expect(store.shown(scope, item.key)).toBe(false);
      expect(store.dismiss(scope, item.key)).toBe(false);
    }
    expect(store.dismiss(item, item.key)).toBe(true);
    expect(store.list(item)).toEqual([]);
  });
  it('failed atomic delivery write preserves the pending file and blocks false confirmation', () => {
    const disk = memory(),
      first = new PauseReturns('memory', disk),
      item = record();
    first.put(item);
    const broken = new PauseReturns('memory', {
      read: disk.read,
      replace: () => {
        throw Error('full');
      },
    });
    expect(broken.shown(item, item.key)).toBe(false);
    expect(broken.healthy).toBe(false);
    expect(new PauseReturns('memory', disk).list(item)).toEqual([item]);
  });
  it.each(['{}', '[{"token":"secret"}]', '[null]'])(
    'retains malformed file %s and reports blocked store',
    (text) => {
      let replaced = false;
      const store = new PauseReturns('memory', {
        read: () => text,
        replace: () => {
          replaced = true;
        },
      });
      expect(store.healthy).toBe(false);
      expect(store.put(record())).toBe(false);
      expect(replaced).toBe(false);
    },
  );
});

it('freezes the first return time through delayed policy and restart', () => {
  const disk = memory(),
    store = new PauseReturns('memory', disk),
    item = record();
  store.put(item);
  expect(store.returned(item, item.key, '2026-10-30T04:10:00.000Z')).toBe(true);
  expect(store.returned(item, item.key, '2026-10-30T04:50:00.000Z')).toBe(true);
  expect(new PauseReturns('memory', disk).list(item)[0]?.returnedAt).toBe(
    '2026-10-30T04:10:00.000Z',
  );
});
it.each(['serverScopeHash', 'key'] as const)('rejects array coercion for primitive %s', (field) => {
  const text = JSON.stringify([{ ...record(), [field]: [record()[field]] }]);
  let replaced = false;
  const store = new PauseReturns('memory', {
    read: () => text,
    replace: () => {
      replaced = true;
    },
  });
  expect(store.healthy).toBe(false);
  expect(replaced).toBe(false);
});

it('preserves restart connection evidence without claiming an observed unlock event', () => {
  const disk = memory(),
    store = new PauseReturns('memory', disk),
    item = record();
  store.put(item);
  store.returned(item, item.key, '2026-10-30T04:30:00.000Z', 'connection');
  expect(new PauseReturns('memory', disk).list(item)[0]).toMatchObject({
    returnedAt: '2026-10-30T04:30:00.000Z',
    returnKind: 'connection',
  });
});

it('upgrades a pending scheduled-wake or connection bound only when actual unlock is observed, then freezes through DND', () => {
  const disk = memory(),
    store = new PauseReturns('memory', disk),
    item = record();
  store.put(item);
  store.returned(item, item.key, '2026-10-30T04:10:00.000Z', 'wake');
  store.returned(item, item.key, '2026-10-30T04:30:00.000Z', 'unlock');
  store.returned(item, item.key, '2026-10-30T04:50:00.000Z', 'unlock');
  expect(store.list(item)[0]).toMatchObject({
    returnKind: 'unlock',
    returnedAt: '2026-10-30T04:30:00.000Z',
  });
});
