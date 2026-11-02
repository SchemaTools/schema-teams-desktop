import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PluginUpdateCoordinator,
  type PluginUpdatePorts,
} from '../../src/main/plugins/updateCoordinator';
import type { ManagedPluginsView, PluginBuild, PluginCatalog } from '../../src/shared/plugins';
import type { PluginTransactionResult } from '../../src/main/plugins/transactionTypes';
import type { RevitProcessState } from '../../src/main/plugins/safety';
const build = (id = 2): PluginBuild => ({
  id,
  version: `${id}.0`,
  verified: true,
  revit: [2025, 2026],
  notes: '',
  size: 10,
  sha256: String(id % 10).repeat(64),
  url: `/api/desktop/plugins/files/${id}`,
  publishedAt: '2026-11-03T00:00:00.000Z',
  requires: [],
});
const receipt = (): Extract<PluginTransactionResult, { status: 'complete' }> => ({
  status: 'complete',
  receipt: {
    schema: 1,
    id: '00000000-0000-4000-8000-000000000001',
    scope: { serverHash: 'a'.repeat(64), ownerId: 1 },
    rootsHash: 'b'.repeat(64),
    files: [],
    packages: [],
  },
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const running: PluginUpdateCoordinator[] = [];
function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error('Missing fixture');
  return value;
}
function fixture(automatic = true) {
  const state = {
    owner: 'A' as string | null,
    automatic,
    beta: false,
    mayRun: true,
    revit: 'idle' as RevitProcessState,
    writes: 0,
  };
  const catalog: PluginCatalog = {
    tester: false,
    plugins: [{ code: 'alpha', name: 'Alpha', short: 'AL', stable: build(), beta: null }],
  };
  const local: ManagedPluginsView = {
    status: 'ready',
    installationAvailable: true,
    receiptId: null,
    packages: [],
  };
  const ports: PluginUpdatePorts = {
    context: () =>
      state.owner
        ? {
            key: JSON.stringify([state.owner, state.automatic, state.beta]),
            automatic: state.automatic,
            beta: state.beta,
          }
        : null,
    mayRun: () => state.mayRun,
    inspect: vi.fn(async () => structuredClone(local)),
    years: vi.fn(async () => [2025, 2026] as (2025 | 2026)[]),
    catalog: vi.fn(async () => structuredClone(catalog)),
    install: vi.fn(
      async (code: string, years: (2025 | 2026)[]): Promise<PluginTransactionResult> => {
        if (state.revit !== 'idle')
          return {
            status: 'waiting',
            reason: state.revit === 'busy' ? 'revit_busy' : 'revit_unknown',
          };
        const entry = catalog.plugins.find((p) => p.code === code);
        const selected = state.beta && catalog.tester && entry?.beta ? entry.beta : entry?.stable;
        if (!selected) throw Error('missing');
        state.writes++;
        local.packages = [
          ...local.packages.filter((p) => p.code !== code),
          {
            code,
            version: selected.version,
            years,
            buildId: selected.id,
            archiveSha256: selected.sha256,
          },
        ];
        return receipt();
      },
    ),
    recover: vi.fn(async () => {
      local.status = 'ready';
      return receipt();
    }),
    processes: vi.fn(async () => state.revit),
    cancel: vi.fn(),
    changed: vi.fn(),
  };
  const coordinator = new PluginUpdateCoordinator(ports);
  running.push(coordinator);
  return { state, catalog, local, ports, coordinator };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const c of running.splice(0)) c.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function settle() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}
describe('Plugin update intents — mocked ports only, no OS/files/signature acceptance', () => {
  it('automatic off without explicit intent performs no inspection, catalog or installation', async () => {
    const f = fixture(false);
    await f.coordinator.refresh();
    await settle();
    expect(f.ports.inspect).not.toHaveBeenCalled();
    expect(f.ports.install).not.toHaveBeenCalled();
  });
  it('missing trust/ownership stops before catalog and inventory work', async () => {
    const f = fixture();
    f.local.status = 'unavailable';
    f.local.installationAvailable = false;
    await f.coordinator.refresh();
    await settle();
    expect(f.ports.catalog).not.toHaveBeenCalled();
    expect(f.ports.years).not.toHaveBeenCalled();
    expect(f.state.writes).toBe(0);
    expect(f.coordinator.state.phase).toBe('unavailable');
  });
  it('coalesces duplicate automatic refresh and checks all years with verified-only admission', async () => {
    const f = fixture(),
      held = deferred<PluginCatalog>();
    vi.mocked(f.ports.catalog).mockReturnValueOnce(held.promise);
    const first = f.coordinator.refresh();
    const second = f.coordinator.refresh();
    await Promise.resolve();
    expect(f.coordinator.busy).toBe(true);
    held.resolve(f.catalog);
    await first;
    await second;
    await settle();
    expect(f.ports.install).toHaveBeenCalledExactlyOnceWith(
      'alpha',
      [2025, 2026],
      true,
      expect.objectContaining({ currentId: null, safety: expect.any(String) }),
    );
    expect(f.state.writes).toBe(1);
    expect(f.coordinator.busy).toBe(false);
    expect(f.coordinator.pendingNotices().filter((n) => n.type === 'complete')).toHaveLength(1);
  });
  it('does not auto-install unverified beta or an unverified dependency', async () => {
    const f = fixture();
    f.state.beta = true;
    f.catalog.tester = true;
    required(f.catalog.plugins[0]).beta = { ...build(20), verified: false };
    await f.coordinator.refresh();
    await settle();
    expect(f.ports.install).not.toHaveBeenCalled();
    required(f.catalog.plugins[0]).beta = {
      ...build(20),
      requires: [{ plugin: 'bravo', minVersion: '1.0' }],
    };
    f.catalog.plugins.push({
      code: 'bravo',
      name: 'Bravo',
      short: 'BR',
      stable: build(3),
      beta: { ...build(21), verified: false },
    });
    await f.coordinator.refresh();
    await settle();
    expect(f.ports.install).not.toHaveBeenCalled();
  });
  it('beta needs both tester status and explicit opt-in; verified beta is passed with the same safety gate', async () => {
    const f = fixture();
    f.catalog.tester = true;
    required(f.catalog.plugins[0]).beta = build(20);
    await f.coordinator.refresh();
    await settle();
    expect(f.local.packages[0]?.buildId).toBe(2);
    f.state.beta = true;
    f.coordinator.sync();
    await settle();
    expect(f.local.packages[0]?.buildId).toBe(20);
    expect(f.state.writes).toBe(2);
  });
  it('does not downgrade automatically; equal version with different immutable build still needs verification', async () => {
    const f = fixture();
    f.local.packages = [
      {
        code: 'alpha',
        version: '30.0',
        years: [2025, 2026],
        buildId: 30,
        archiveSha256: 'f'.repeat(64),
      },
    ];
    await f.coordinator.refresh();
    await settle();
    expect(f.state.writes).toBe(0);
    required(f.local.packages[0]).version = '2.0';
    await f.coordinator.refresh();
    await settle();
    expect(f.state.writes).toBe(1);
  });
  it('busy/unknown waiting owns no FS flight and rechecks fresh metadata when processes become idle', async () => {
    const f = fixture();
    f.state.revit = 'busy';
    await f.coordinator.refresh();
    await settle();
    expect(f.coordinator.busy).toBe(false);
    expect(f.coordinator.state.pending).toBe(1);
    const attempts = vi.mocked(f.ports.install).mock.calls.length;
    f.state.revit = 'unknown';
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.ports.install).toHaveBeenCalledTimes(attempts);
    required(f.catalog.plugins[0]).stable = build(4);
    f.state.revit = 'idle';
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(f.local.packages[0]?.buildId).toBe(4);
    expect(f.state.writes).toBe(1);
    expect(f.coordinator.state.pending).toBe(0);
    expect(vi.mocked(f.ports.catalog).mock.calls.length).toBeGreaterThan(1);
  });
  it('manual waiting while automatic is off authorizes only the selected plugin', async () => {
    const f = fixture(false);
    f.catalog.plugins.push({
      code: 'bravo',
      name: 'Bravo',
      short: 'BR',
      stable: build(3),
      beta: null,
    });
    f.state.revit = 'busy';
    expect(await f.coordinator.manual('alpha', [2025])).toMatchObject({
      accepted: true,
      waiting: true,
    });
    expect(f.state.writes).toBe(0);
    f.state.revit = 'idle';
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(f.ports.install).toHaveBeenLastCalledWith('alpha', [2025], false, undefined);
    expect(f.local.packages.map((p) => p.code)).toEqual(['alpha']);
  });
  it('C3: duplicate sequential manual request is a verified already-installed no-op, not eternal waiting', async () => {
    const f = fixture(false);
    expect(await f.coordinator.manual('alpha', [2025])).toMatchObject({ accepted: true });
    expect(await f.coordinator.manual('alpha', [2025])).toMatchObject({ accepted: true });
    expect(f.state.writes).toBe(1);
    expect(f.coordinator.state.pending).toBe(0);
    expect(f.coordinator.state.items[0]).toMatchObject({
      phase: 'complete',
      reason: 'already_installed',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.ports.processes).not.toHaveBeenCalled();
  });
  it('C4: a selected manual year cannot silently disappear before admission', async () => {
    const f = fixture(false);
    vi.mocked(f.ports.years).mockResolvedValue([2025]);
    expect(await f.coordinator.manual('alpha', [2025, 2026])).toMatchObject({ accepted: false });
    expect(f.ports.install).not.toHaveBeenCalled();
    expect(f.coordinator.state.pending).toBe(0);
  });
  it('rechecks inventory after asynchronous catalog read, before starting the controller', async () => {
    const f = fixture(false);
    vi.mocked(f.ports.years).mockResolvedValueOnce([2025, 2026]).mockResolvedValue([2025]);
    expect(await f.coordinator.manual('alpha', [2025, 2026])).toMatchObject({
      accepted: false,
      reason: 'revit_inventory_changed',
    });
    expect(f.ports.install).not.toHaveBeenCalled();
  });
  it('terminal signature/IO error does not loop; an explicit retry may try again', async () => {
    const f = fixture();
    vi.mocked(f.ports.install).mockResolvedValue({ status: 'blocked', reason: 'signature_failed' });
    await f.coordinator.refresh();
    await settle();
    const attempts = vi.mocked(f.ports.install).mock.calls.length;
    await f.coordinator.refresh();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.ports.install).toHaveBeenCalledTimes(attempts);
    await f.coordinator.refresh(true);
    await settle();
    expect(f.ports.install).toHaveBeenCalledTimes(attempts + 1);
  });
  it('revoked beta verification removes an old waiting intent instead of polling it forever', async () => {
    const f = fixture();
    f.catalog.tester = true;
    f.state.beta = true;
    required(f.catalog.plugins[0]).beta = build(20);
    f.state.revit = 'busy';
    await f.coordinator.refresh();
    await settle();
    expect(f.coordinator.state.pending).toBe(1);
    required(required(f.catalog.plugins[0]).beta).verified = false;
    await f.coordinator.refresh();
    await settle();
    expect(f.coordinator.state.pending).toBe(0);
    expect(f.coordinator.pendingNotices()).toEqual([]);
    const calls = vi.mocked(f.ports.processes).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.ports.processes).toHaveBeenCalledTimes(calls);
  });
  it('old owner catalog result is discarded and its slot remains busy until unwind', async () => {
    const f = fixture(),
      held = deferred<PluginCatalog>();
    vi.mocked(f.ports.catalog).mockReturnValueOnce(held.promise);
    const first = f.coordinator.refresh();
    await settle();
    f.state.owner = 'B';
    f.state.automatic = false;
    f.coordinator.sync();
    expect(f.coordinator.busy).toBe(true);
    held.resolve(f.catalog);
    await first;
    await settle();
    expect(f.state.writes).toBe(0);
    expect(f.coordinator.pendingNotices()).toEqual([]);
    expect(f.coordinator.busy).toBe(false);
  });
  it('held Desktop lease denies automatic start; release lets the retained demand recheck', async () => {
    const f = fixture();
    f.state.mayRun = false;
    await f.coordinator.refresh();
    await settle();
    expect(f.ports.inspect).not.toHaveBeenCalled();
    expect(f.coordinator.busy).toBe(false);
    f.state.mayRun = true;
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(f.state.writes).toBe(1);
  });
  it('C1: refresh during mid-job recovery while still busy retains the intent until safe recovery', async () => {
    const f = fixture(false);
    vi.mocked(f.ports.install).mockImplementationOnce(async () => {
      f.local.status = 'recovery';
      f.state.revit = 'busy';
      return { status: 'waiting', reason: 'revit_changed', processInterruption: true };
    });
    expect(await f.coordinator.manual('alpha', [2025])).toMatchObject({
      accepted: true,
      waiting: true,
    });
    vi.mocked(f.ports.recover).mockResolvedValueOnce({ status: 'waiting', reason: 'revit_busy' });
    await f.coordinator.refresh();
    expect(f.coordinator.state.pending).toBe(1);
    expect(f.state.writes).toBe(0);
    f.state.revit = 'idle';
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(f.ports.recover).toHaveBeenCalledTimes(2);
    expect(f.state.writes).toBe(1);
    expect(f.coordinator.state.pending).toBe(0);
  });
  it('a blocked/unknown recovery cannot be counted as rollback or followed by activation', async () => {
    const f = fixture(false);
    vi.mocked(f.ports.install).mockImplementationOnce(async () => {
      f.local.status = 'recovery';
      f.state.revit = 'busy';
      return { status: 'waiting', reason: 'revit_changed', processInterruption: true };
    });
    await f.coordinator.manual('alpha', [2025]);
    vi.mocked(f.ports.recover).mockResolvedValue({
      status: 'recovery',
      reason: 'old_metadata_unknown',
    });
    f.state.revit = 'idle';
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(f.state.writes).toBe(0);
    expect(f.coordinator.state.pending).toBe(0);
    expect(f.coordinator.state.items[0]?.reason).toBe('plugin_recovery_required');
    expect(f.coordinator.pendingNotices().some((n) => n.type === 'complete')).toBe(false);
  });
  it('C2: A read releases only its slot and re-arms a waiting B owner', async () => {
    const f = fixture(false);
    f.state.revit = 'busy';
    await f.coordinator.manual('alpha', [2025]);
    const held = deferred<RevitProcessState>();
    vi.mocked(f.ports.processes).mockReturnValueOnce(held.promise);
    await vi.advanceTimersByTimeAsync(2000);
    f.state.owner = 'B';
    f.coordinator.sync();
    await f.coordinator.manual('alpha', [2025]);
    expect(f.coordinator.state.pending).toBe(1);
    f.state.revit = 'idle';
    held.resolve('idle');
    await settle();
    expect(f.state.writes).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(f.state.writes).toBe(1);
  });
  it('notice shown evidence is separate from creating it, and stale owner cannot retain it', async () => {
    const f = fixture();
    f.state.revit = 'busy';
    await f.coordinator.refresh();
    await settle();
    const notice = f.coordinator.pendingNotices()[0];
    if (!notice) throw Error('missing notice');
    expect(notice.type).toBe('waiting');
    expect(f.coordinator.noticeCurrent(notice)).toBe(true);
    f.coordinator.shown(notice);
    expect(f.coordinator.pendingNotices()).toEqual([]);
    f.state.owner = 'B';
    f.coordinator.sync();
    expect(f.coordinator.noticeCurrent(notice)).toBe(false);
  });
  it('a rolled-back dependency blocks every automatic closure but explicit manual intent bypasses only the hold', async () => {
    const f = fixture();
    f.local.rootsHash = 'b'.repeat(64);
    required(required(f.catalog.plugins[0]).stable).requires = [
      { plugin: 'dependency', minVersion: '1.0' },
    ];
    f.catalog.plugins.push({
      code: 'dependency',
      name: 'Dependency',
      short: 'DE',
      stable: build(3),
      beta: null,
    });
    f.ports.automaticHeld = (_roots, code, _year, b) => code === 'dependency' && b.id === 3;
    await f.coordinator.refresh();
    await settle();
    expect(f.ports.install).not.toHaveBeenCalled();
    expect(f.coordinator.state.items.every((i) => i.reason === 'automatic_rollback_hold')).toBe(
      true,
    );
    expect((await f.coordinator.manual('alpha', [2025])).accepted).toBe(true);
    expect(f.ports.install).toHaveBeenCalledWith('alpha', [2025], false, undefined);
    required(f.catalog.plugins[1]).stable = build(4);
    await f.coordinator.refresh();
    await settle();
    expect(f.ports.install).toHaveBeenCalledWith(
      'dependency',
      [2025, 2026],
      true,
      expect.objectContaining({ currentId: null, safety: expect.any(String) }),
    );
  });
  it('an automatic root never downgrades a newer installed dependency', async () => {
    const f = fixture();
    required(required(f.catalog.plugins[0]).stable).requires = [
      { plugin: 'dependency', minVersion: '1.0' },
    ];
    f.catalog.plugins.push({
      code: 'dependency',
      name: 'Dependency',
      short: 'DE',
      stable: build(3),
      beta: null,
    });
    f.local.packages = [
      {
        code: 'dependency',
        version: '4.0',
        years: [2025, 2026],
        buildId: 4,
        archiveSha256: '4'.repeat(64),
      },
    ];
    await f.coordinator.refresh();
    await settle();
    expect(f.ports.install).not.toHaveBeenCalled();
  });
  it('A3: an exact dependency explicitly reinstalled by the user no longer blocks a new automatic root', async () => {
    const f = fixture();
    f.local.rootsHash = 'b'.repeat(64);
    required(required(f.catalog.plugins[0]).stable).requires = [
      { plugin: 'dependency', minVersion: '1.0' },
    ];
    f.catalog.plugins.push({
      code: 'dependency',
      name: 'Dependency',
      short: 'DE',
      stable: build(3),
      beta: null,
    });
    f.ports.automaticHeld = (_roots, code, _year, b) => code === 'dependency' && b.id === 3;
    await f.coordinator.refresh();
    await settle();
    expect(f.state.writes).toBe(0);
    expect((await f.coordinator.manual('dependency', [2025, 2026])).accepted).toBe(true);
    await f.coordinator.refresh();
    await settle();
    expect(f.ports.install).toHaveBeenCalledWith('dependency', [2025, 2026], false, undefined);
    expect(f.ports.install).toHaveBeenCalledWith('alpha', [2025, 2026], true, expect.any(Object));
    expect(f.state.writes).toBe(2);
  });
  it('unreadable negative intent fails closed for automation while manual still traverses installation admission', async () => {
    const f = fixture();
    f.local.rootsHash = 'b'.repeat(64);
    f.ports.automaticHeld = () => {
      throw Error('local state unavailable');
    };
    await f.coordinator.refresh();
    await settle();
    expect(f.ports.install).not.toHaveBeenCalled();
    expect(f.coordinator.state.items[0]?.phase).toBe('error');
    expect((await f.coordinator.manual('alpha', [2025])).accepted).toBe(true);
  });
});
