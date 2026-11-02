import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PluginAutoHolds,
  pluginAutoHoldKey,
  rolledBackBuildHolds,
} from '../../src/main/plugins/autoHolds';
import type { PluginReceipt } from '../../src/main/plugins/transactionTypes';
const roots: string[] = [];
function file() {
  const root = mkdtempSync(join(tmpdir(), 'st-auto-holds-'));
  roots.push(root);
  return join(root, 'holds.json');
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const receipt = (buildId: number): PluginReceipt => ({
  schema: 1,
  id: '00000000-0000-4000-8000-000000000001',
  rootsHash: 'b'.repeat(64),
  scope: { serverHash: 'a'.repeat(64), ownerId: 1 },
  files: [],
  packages: [
    {
      code: 'alpha',
      buildId,
      version: `${buildId}.0`,
      archiveSha256: String(buildId).repeat(64),
      archiveSize: 10,
      descriptorId: 'synthetic',
      revit: [2025, 2026],
    },
  ],
});
describe('durable negative rollback intent', () => {
  it('persists across a new store, separates scope/root/year/build and retains all old holds', () => {
    const name = file(),
      store = new PluginAutoHolds(name),
      keys = rolledBackBuildHolds(receipt(2), receipt(1));
    expect(keys).toHaveLength(2);
    expect(rolledBackBuildHolds(receipt(2), receipt(2))).toEqual([]);
    store.add(keys);
    new PluginAutoHolds(name).add(rolledBackBuildHolds(receipt(3), receipt(1)));
    const restored = new PluginAutoHolds(name).read();
    expect(restored.size).toBe(4);
    expect(restored.has(keys[0] as string)).toBe(true);
    expect(
      restored.has(
        pluginAutoHoldKey('a'.repeat(64), 2, 'b'.repeat(64), 'alpha', 2025, 2, '2'.repeat(64)),
      ),
    ).toBe(false);
    expect(
      restored.has(
        pluginAutoHoldKey('a'.repeat(64), 1, 'c'.repeat(64), 'alpha', 2025, 2, '2'.repeat(64)),
      ),
    ).toBe(false);
  });
  it('malformed, duplicate and oversized persisted states block read and rollback persistence', () => {
    const name = file(),
      store = new PluginAutoHolds(name);
    expect(store.read().size).toBe(0);
    for (const raw of [
      'broken',
      '{}',
      JSON.stringify({ schema: 1, keys: ['a'.repeat(64), 'a'.repeat(64)] }),
      JSON.stringify({ schema: 1, keys: [], extra: true }),
      'x'.repeat(300001),
    ]) {
      writeFileSync(name, raw);
      expect(() => store.read()).toThrow();
      expect(() => store.add(['b'.repeat(64)])).toThrow();
    }
  });
});
