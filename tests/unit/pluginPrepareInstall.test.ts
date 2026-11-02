import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, sep, basename } from 'node:path';
const { appRoot } = vi.hoisted(() => ({ appRoot: process.cwd() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => appRoot } }));
import {
  preparePluginInstall,
  runPreparedInstall,
  releasePreparedInstall,
  type PrepareInstallOptions,
  type PreparedInstall,
} from '../../src/main/plugins/prepareInstall';
import type { PluginScope, PluginTransactionPlan } from '../../src/main/plugins/transactionTypes';
import type { ApprovedInstallTemplate } from '../../src/main/plugins/layoutPolicy';
import type { PluginCatalog } from '../../src/shared/plugins';
import { PluginTransactions } from '../../src/main/plugins/transaction';
import { makePluginZip, fixtureXml, fixtureGuid, fileHash } from '../helpers/pluginArchiveFixture';
function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error('Missing test fixture');
  return value;
}
async function capturePlan(
  handle: PreparedInstall,
  scope: PluginScope,
): Promise<PluginTransactionPlan> {
  let captured: PluginTransactionPlan | undefined;
  const install = async (plan: PluginTransactionPlan) => {
    captured = plan;
    return { status: 'blocked' as const, reason: 'test-only-inspection' };
  };
  await runPreparedInstall(handle, scope, { install });
  return required(captured);
}
const base = resolve(__dirname, '../../private'),
  roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + sep) || !basename(root).startsWith('prepare-install-'))
      throw Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'prepare-install-'));
  roots.push(root);
  const zip = makePluginZip(
    [2025, 2026].flatMap((year) => [
      { name: `${year}/Plugin.addin`, bytes: fixtureXml('Plugin.dll') },
      {
        name: `${year}/Plugin.dll`,
        bytes: Buffer.from(`INERT SYNTHETIC ${year}, NOT A LOADABLE DLL`),
      },
    ]),
  ).buffer;
  const policy: ApprovedInstallTemplate = {
    policyId: 'synthetic-v1',
    code: 'floor-plans',
    archive: {
      id: 'synthetic-raw',
      files: [2025, 2026].flatMap((year) => [
        { relativePath: `${year}/Plugin.addin`, kind: 'addin' as const },
        { relativePath: `${year}/Plugin.dll`, kind: 'dll' as const },
      ]),
      manifests: [2025, 2026].map((year) => ({
        relativePath: `${year}/Plugin.addin`,
        year: year as 2025 | 2026,
        addIns: [{ addInId: fixtureGuid, assemblyRelativePath: `${year}/Plugin.dll` }],
      })),
    },
    yearFiles: [2025, 2026].map((year) => ({
      year: year as 2025 | 2026,
      paths: [`${year}/Plugin.dll`],
    })),
    manifestTargets: [2025, 2026].map((year) => ({
      year: year as 2025 | 2026,
      sourceRelativePath: `${year}/Plugin.addin`,
      targetBasename: 'Schema.Managed.addin',
    })),
  };
  const catalog: PluginCatalog = {
    tester: false,
    plugins: [
      {
        code: 'floor-plans',
        name: 'Fixture',
        short: 'FP',
        beta: null,
        stable: {
          id: 1,
          version: '1.0',
          verified: true,
          revit: [2025, 2026],
          notes: '',
          requires: [],
          size: zip.length,
          sha256: fileHash(zip),
          url: '/api/desktop/plugins/files/1',
          publishedAt: '2026-11-02T00:00:00.000Z',
        },
      },
    ],
  };
  const state = { live: true, catalog };
  const download = vi.fn(async (_build, _parent: string) => {
    const dir = await mkdtemp(join(_parent, 'download-')),
      path = join(dir, 'archive.zip');
    await writeFile(path, zip);
    return path;
  });
  const verify = vi.fn(async (_path: string, sha256: string) => ({
    v: 1 as const,
    verdict: 'valid' as const,
    reason: 'verified' as const,
    fileSha256: sha256,
    signerDerSha256: 'f'.repeat(64),
    winTrustCode: '00000000',
  }));
  const options: PrepareInstallOptions = {
    scope: { serverHash: 'a'.repeat(64), ownerId: 1 },
    code: 'floor-plans',
    years: [2025, 2026],
    beta: false,
    expectedCurrentId: null,
    local: [],
    templates: [policy],
    publisherPins: ['f'.repeat(64)],
    targetRoot: join(root, 'targets'),
    stagingParent: join(root, 'staging'),
    current: () => state.live,
    readCatalog: async () => structuredClone(state.catalog),
    download,
    verify,
  };
  return { root, policy, catalog, state, options, download, verify };
}
describe('preparation early closed gates', () => {
  it('staging cannot overlap activation roots even with an otherwise approved format', async () => {
    const f = await fixture(),
      read = vi.fn(f.options.readCatalog);
    await expect(
      preparePluginInstall({
        ...f.options,
        readCatalog: read,
        stagingParent: join(f.options.targetRoot, 'staging'),
      }),
    ).rejects.toThrow('overlapping_roots');
    expect(read).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    await expect(readdir(f.options.targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('empty publisher or layout policy performs no catalog/download or staging writes', async () => {
    const f = await fixture(),
      read = vi.fn(f.options.readCatalog);
    await expect(
      preparePluginInstall({ ...f.options, readCatalog: read, publisherPins: [] }),
    ).rejects.toThrow('publisher_not_configured');
    await expect(
      preparePluginInstall({ ...f.options, readCatalog: read, templates: [] }),
    ).rejects.toThrow('unsupported_plugin_layout');
    expect(read).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    await expect(readdir(f.options.stagingParent)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('a forged prepared handle grants no plan or cleanup authority', async () => {
    const f = await fixture();
    await expect(capturePlan({ id: 'forged' }, f.options.scope)).rejects.toThrow();
    expect(
      await releasePreparedInstall({ id: 'forged' }, async () => ({
        pending: false,
        blocked: false,
      })),
    ).toBe(false);
  });
});
describe.skipIf(process.platform !== 'win32')(
  'actual ZIP/XML pipeline with injected publisher oracle, never real plugin execution',
  () => {
    it('holds a lease during core.install and prevents cleanup of journal-referenced sources', async () => {
      const f = await fixture(),
        handle = await preparePluginInstall(f.options);
      let entered = false,
        release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const core = new PluginTransactions({
        targetRoot: f.options.targetRoot,
        dataRoot: join(f.root, 'state'),
        stagingParent: f.options.stagingParent,
        current: () => f.state.live,
        admit: async () => true,
        processes: async () => 'idle',
        pathAllowed: async () => true,
        afterCheckpoint: async (phase) => {
          if (phase === 'intent') {
            entered = true;
            await gate;
          }
        },
      });
      const work = runPreparedInstall(handle, f.options.scope, core);
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        expect(await releasePreparedInstall(handle, () => core.inspect(f.options.scope))).toBe(
          false,
        );
        expect((await readdir(f.options.stagingParent)).length).toBe(1);
        await expect(capturePlan(handle, f.options.scope)).rejects.toThrow('prepared_install_busy');
      } finally {
        release();
      }
      expect((await work).status).toBe('complete');
      expect(await releasePreparedInstall(handle, () => core.inspect(f.options.scope))).toBe(true);
    });
    it('reserves cleanup before delayed inspect so no new handoff can race its deletion', async () => {
      const f = await fixture(),
        handle = await preparePluginInstall(f.options);
      let entered = false,
        release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const cleanup = releasePreparedInstall(handle, async () => {
        entered = true;
        await gate;
        return { pending: false, blocked: false };
      });
      expect(entered).toBe(true);
      await expect(capturePlan(handle, f.options.scope)).rejects.toThrow('prepared_install_busy');
      expect((await readdir(f.options.stagingParent)).length).toBe(1);
      release();
      expect(await cleanup).toBe(true);
      expect(await readdir(f.options.stagingParent)).toEqual([]);
    });
    it('applies the remaining expanded budget inside extraction of the second dependency archive', async () => {
      const f = await fixture(),
        otherGuid = '11111111-2222-3333-4444-555555555555';
      const entries = [2025, 2026].flatMap((year) => [
        { name: `${year}/Plugin.addin`, bytes: fixtureXml('Plugin.dll', otherGuid) },
        { name: `${year}/Plugin.dll`, bytes: Buffer.from('INERT dependency payload ' + year) },
      ]);
      const zip = makePluginZip(entries).buffer,
        expanded = entries.reduce((n, f) => n + f.bytes.length, 0),
        first = required(required(f.catalog.plugins[0]).stable),
        other = {
          ...first,
          id: 2,
          size: zip.length,
          sha256: fileHash(zip),
          url: '/api/desktop/plugins/files/2',
        };
      first.requires = [{ plugin: 'other-plugin', minVersion: '1.0' }];
      f.catalog.plugins.push({
        code: 'other-plugin',
        name: 'Other',
        short: 'OP',
        stable: other,
        beta: null,
      });
      const policy = structuredClone(f.policy);
      policy.code = 'other-plugin';
      policy.policyId = 'other-v1';
      policy.archive = {
        ...policy.archive,
        manifests: policy.archive.manifests.map((m) => ({
          ...m,
          addIns: [{ addInId: otherGuid, assemblyRelativePath: `${m.year}/Plugin.dll` }],
        })),
      };
      f.options.templates = [f.policy, policy];
      f.options.expandedBudgetBytes = expanded + 1;
      const download = f.options.download;
      f.options.download = async (b, p, s) => {
        if (b.id !== 2) return download(b, p, s);
        const dir = await mkdtemp(join(p, 'download-')),
          path = join(dir, 'other.zip');
        await writeFile(path, zip);
        return path;
      };
      await expect(preparePluginInstall(f.options)).rejects.toThrow('zip-total');
      expect(await readdir(f.options.stagingParent)).toEqual([]);
      await expect(readdir(f.options.targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('downloads once for two years, preserves runtime subsets and original XML, and commits through real temp core', async () => {
      const f = await fixture(),
        handle = await preparePluginInstall(f.options);
      const core = new PluginTransactions({
        targetRoot: f.options.targetRoot,
        dataRoot: join(f.root, 'state'),
        stagingParent: f.options.stagingParent,
        current: () => f.state.live,
        admit: async () => true,
        processes: async () => 'idle',
        pathAllowed: async () => true,
      });
      const install = vi.spyOn(core, 'install');
      expect((await runPreparedInstall(handle, f.options.scope, core)).status).toBe('complete');
      const plan = required(install.mock.calls[0]?.[0]);
      expect(f.download).toHaveBeenCalledOnce();
      expect(f.verify).toHaveBeenCalledTimes(2);
      expect(plan.files).toHaveLength(4);
      for (const year of [2025, 2026]) {
        const payload = required(
          plan.files.find((x) => x.kind === 'dll' && x.targetPath.startsWith(`${year}/`)),
        );
        expect(payload.sourcePath).toBe(`${year}/Plugin.dll`);
        expect(await readFile(join(payload.sourceRoot, `${year}/Plugin.addin`))).toEqual(
          fixtureXml('Plugin.dll'),
        );
        const manifest = required(
          plan.files.find((x) => x.kind === 'addin' && x.targetPath.startsWith(`${year}/`)),
        );
        const xml = await readFile(join(manifest.sourceRoot, manifest.sourcePath), 'utf8');
        expect(xml).toContain(join(f.options.targetRoot, ...payload.targetPath.split('/')));
        expect(xml).toContain('Synthetic fixture');
      }
      expect(await releasePreparedInstall(handle, () => core.inspect(f.options.scope))).toBe(true);
      expect(await readdir(f.options.stagingParent)).toEqual([]);
      for (const file of plan.files)
        expect(
          fileHash(await readFile(join(f.options.targetRoot, ...file.targetPath.split('/')))),
        ).toBe(file.sha256);
    });
    it('verifies DLLs of the unselected year and denies preparation when one fails', async () => {
      const f = await fixture();
      f.options.years = [2025];
      f.options.verify = async (path, sha256) => ({
        ...(await f.verify(path, sha256)),
        verdict: path.includes(`${sep}2026${sep}`) ? 'invalid' : 'valid',
      });
      await expect(preparePluginInstall(f.options)).rejects.toThrow('untrusted_plugin_dll');
      expect(await readdir(f.options.stagingParent)).toEqual([]);
      await expect(readdir(f.options.targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('caller metadata/root/selector mutations during download never retarget the captured job', async () => {
      const f = await fixture(),
        target = f.options.targetRoot;
      const real = f.options.download;
      f.options.download = async (b, p, s) => {
        f.options.targetRoot = join(f.root, 'decoy');
        f.options.years = [2026];
        required(f.policy.manifestTargets[0]).targetBasename = 'unapproved.addin';
        return real(b, p, s);
      };
      const handle = await preparePluginInstall(f.options),
        plan = await capturePlan(handle, f.options.scope);
      expect(plan.files.filter((x) => x.kind === 'addin').map((x) => x.targetPath)).toEqual([
        '2025/Schema.Managed.addin',
        '2026/Schema.Managed.addin',
      ]);
      const m = required(plan.files.find((x) => x.kind === 'addin'));
      expect(await readFile(join(m.sourceRoot, m.sourcePath), 'utf8')).toContain(target);
      expect(
        await releasePreparedInstall(handle, async () => ({ pending: false, blocked: false })),
      ).toBe(true);
    });
    it.each(['channel', 'artifact'] as const)(
      'precommit %s change invalidates the one-shot handle',
      async (change) => {
        const f = await fixture();
        f.options.beta = true;
        f.catalog.tester = true;
        const handle = await preparePluginInstall(f.options);
        const b = required(required(f.catalog.plugins[0]).stable);
        if (change === 'channel') {
          required(f.catalog.plugins[0]).stable = null;
          required(f.catalog.plugins[0]).beta = b;
        } else b.sha256 = 'c'.repeat(64);
        await expect(capturePlan(handle, f.options.scope)).rejects.toThrow(
          'plugin_catalog_changed',
        );
        await expect(capturePlan(handle, f.options.scope)).rejects.toThrow('prepared_install_busy');
        expect(
          await releasePreparedInstall(handle, async () => ({ pending: false, blocked: false })),
        ).toBe(true);
      },
    );
    it('late cancellation and pending/corrupt durable state retain staged bytes instead of deleting them', async () => {
      const f = await fixture(),
        controller = new AbortController();
      f.options.signal = controller.signal;
      const handle = await preparePluginInstall(f.options);
      expect(
        await releasePreparedInstall(handle, async () => ({ pending: true, blocked: false })),
      ).toBe(false);
      expect(
        await releasePreparedInstall(handle, async () => ({ pending: false, blocked: true })),
      ).toBe(false);
      expect((await readdir(f.options.stagingParent)).length).toBe(1);
      controller.abort();
      await expect(capturePlan(handle, f.options.scope)).rejects.toThrow('stale_install');
      expect(
        await releasePreparedInstall(handle, async () => ({ pending: false, blocked: false })),
      ).toBe(false);
      expect((await readdir(f.options.stagingParent)).length).toBe(1);
    });
    it('owner/event invalidation after download rejects before extract and cleans only its private job', async () => {
      const f = await fixture(),
        real = f.options.download;
      await mkdir(f.options.stagingParent);
      await writeFile(join(f.options.stagingParent, 'foreign.txt'), 'sentinel');
      f.options.download = async (b, p, s) => {
        const path = await real(b, p, s);
        f.state.live = false;
        return path;
      };
      await expect(preparePluginInstall(f.options)).rejects.toThrow('stale_install');
      expect(await readdir(f.options.stagingParent)).toEqual(['foreign.txt']);
      expect(await readFile(join(f.options.stagingParent, 'foreign.txt'), 'utf8')).toBe('sentinel');
    });
  },
);
