import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
const { appRoot } = vi.hoisted(() => ({ appRoot: process.cwd() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => appRoot } }));
import {
  PluginController,
  createProductionPluginController,
  type PluginControllerOptions,
  type PluginJobContext,
} from '../../src/main/plugins/controller';
import type { PluginBuild, PluginCatalog } from '../../src/shared/plugins';
import type { ApprovedInstallTemplate } from '../../src/main/plugins/layoutPolicy';
import { makePluginZip, fixtureXml, fixtureGuid, fileHash } from '../helpers/pluginArchiveFixture';
const base = resolve(__dirname, '../../private'),
  roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + sep) || !root.includes('controller-test-'))
      throw Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error('Fixture');
  return value;
}
async function fixture() {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'controller-test-'));
  roots.push(root);
  const context: PluginJobContext = {
    scope: { serverHash: 'a'.repeat(64), ownerId: 1 },
    token: 'session-config-catalog-pref-1',
    beta: false,
    targetRoot: join(root, 'user'),
    dataRoot: join(root, 'state'),
    stagingParent: join(root, 'stage'),
    scanRoots: [2025, 2026].flatMap((year) => [
      { year: year as 2025 | 2026, path: join(root, 'user', String(year)) },
      { year: year as 2025 | 2026, path: join(root, 'machine', String(year)) },
    ]),
  };
  const policy: ApprovedInstallTemplate = {
    policyId: 'synthetic',
    code: 'floor-plans',
    archive: {
      id: 'raw',
      files: [
        { relativePath: 'Plugin.dll', kind: 'dll' },
        { relativePath: 'Plugin.addin', kind: 'addin' },
      ],
      manifests: [
        {
          relativePath: 'Plugin.addin',
          year: 2025,
          addIns: [{ addInId: fixtureGuid, assemblyRelativePath: 'Plugin.dll' }],
        },
      ],
    },
    yearFiles: [{ year: 2025, paths: ['Plugin.dll'] }],
    manifestTargets: [
      { year: 2025, sourceRelativePath: 'Plugin.addin', targetBasename: 'Schema.addin' },
    ],
  };
  const bytes = (id: number) =>
    makePluginZip([
      { name: 'Plugin.addin', bytes: fixtureXml('Plugin.dll') },
      { name: 'Plugin.dll', bytes: Buffer.from(`INERT TEST PAYLOAD ${id}, NOT LOADABLE`) },
    ]).buffer;
  const build = (id: number): PluginBuild => ({
    id,
    version: `${id}.0`,
    verified: true,
    revit: [2025],
    requires: [],
    notes: '',
    publishedAt: '2026-11-02T00:00:00.000Z',
    url: `/api/desktop/plugins/files/${id}`,
    size: bytes(id).length,
    sha256: fileHash(bytes(id)),
  });
  const catalog: PluginCatalog = {
    tester: false,
    plugins: [{ code: 'floor-plans', name: 'Fixture', short: 'FP', stable: build(1), beta: null }],
  };
  const state = { context: context as PluginJobContext | null };
  const readCatalog = vi.fn(async () => structuredClone(catalog)),
    download = vi.fn(async (b: PluginBuild, parent: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw Error('aborted');
      const dir = await mkdtemp(join(parent, 'archive-')),
        path = join(dir, 'package.zip');
      await writeFile(path, bytes(b.id));
      return path;
    }),
    verify = vi.fn(async (_path: string, hash: string) => ({
      v: 1 as const,
      verdict: 'valid' as const,
      reason: 'verified' as const,
      fileSha256: hash,
      signerDerSha256: 'f'.repeat(64),
      winTrustCode: '00000000',
    }));
  const options: PluginControllerOptions = {
    context: () => state.context,
    readCatalog,
    download,
    policy: () => ({ templates: [policy], publisherPins: ['f'.repeat(64)] }),
    processes: async () => 'idle',
    pathAllowed: async () => true,
    verify,
  };
  const next = (id: number) => {
    required(catalog.plugins[0]).stable = build(id);
  };
  return { root, context, state, options, catalog, download, readCatalog, verify, next };
}
describe('production plugin factory early gates', () => {
  it('empty server trust performs no catalog, download or filesystem setup', async () => {
    const f = await fixture(),
      controller = createProductionPluginController(f.options);
    expect(await controller.install('floor-plans', [2025])).toEqual({
      status: 'blocked',
      reason: 'plugin_trust_unconfigured',
    });
    expect(f.readCatalog).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
    expect(await controller.inspect()).toEqual({
      status: 'unavailable',
      installationAvailable: false,
      receiptId: null,
      packages: [],
    });
    expect(await readdir(f.root)).toEqual([]);
  });
  it('busy Revit waits before any catalog, staging or download', async () => {
    const f = await fixture(),
      controller = new PluginController({ ...f.options, processes: async () => 'busy' });
    expect(await controller.install('floor-plans', [2025])).toEqual({
      status: 'waiting',
      reason: 'revit_busy',
    });
    expect(f.readCatalog).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  });
});
describe.skipIf(process.platform !== 'win32')(
  'explicit controller: real temp ZIP, XML, transaction; injected signer/process/path oracle',
  () => {
    it(
      'installs, upgrades a hidden previous build, blocks hidden rollback, and restores authorized backup',
      { timeout: 15000 },
      async () => {
        const f = await fixture(),
          controller = new PluginController(f.options),
          first = await controller.install('floor-plans', [2025]);
        expect(first.status).toBe('complete');
        if (first.status !== 'complete') throw Error(first.reason);
        const xml = await readFile(join(f.context.targetRoot, '2025', 'Schema.addin'), 'utf8');
        expect(xml).toContain(first.receipt.id);
        expect(await readdir(f.context.stagingParent)).toEqual([]);
        expect(await controller.inspect()).toEqual({
          status: 'ready',
          installationAvailable: true,
          receiptId: first.receipt.id,
          packages: [{ code: 'floor-plans', version: '1.0', years: [2025] }],
        });
        f.next(2);
        const upgraded = await controller.install('floor-plans', [2025]);
        expect(upgraded.status).toBe('complete');
        if (upgraded.status !== 'complete') throw Error(upgraded.reason);
        expect(upgraded.receipt.packages[0]?.version).toBe('2.0');
        expect((await controller.rollback(upgraded.receipt.id)).status).toBe('blocked');
        expect(await readFile(join(f.context.dataRoot, 'receipt.json'), 'utf8')).toContain(
          upgraded.receipt.id,
        );
        f.next(1);
        const restored = await controller.rollback(upgraded.receipt.id);
        expect(restored.status).toBe('complete');
        if (restored.status === 'complete')
          expect(restored.receipt.packages[0]?.version).toBe('1.0');
      },
    );
    it('denies foreign GUID collisions before writing activation or journal', async () => {
      const f = await fixture(),
        machine = join(f.root, 'machine', '2025');
      await mkdir(machine, { recursive: true });
      const foreign = join(machine, 'DifferentName.addin'),
        xml = fixtureXml('Foreign.dll');
      await writeFile(foreign, xml);
      expect((await new PluginController(f.options).install('floor-plans', [2025])).status).toBe(
        'blocked',
      );
      expect(await readFile(foreign)).toEqual(xml);
      await expect(readFile(join(f.context.dataRoot, 'journal.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        readFile(join(f.context.targetRoot, '2025', 'Schema.addin')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('denies a changed fresh catalog at core admission after preparation', async () => {
      const f = await fixture();
      let reads = 0;
      f.options.readCatalog = async () => {
        if (++reads === 3) f.next(2);
        return structuredClone(f.catalog);
      };
      expect((await new PluginController(f.options).install('floor-plans', [2025])).status).toBe(
        'blocked',
      );
      await expect(readFile(join(f.context.dataRoot, 'journal.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    it('freezes callbacks, coalesces no extra jobs, and rejects stale context after download', async () => {
      const f = await fixture();
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      f.options.download = async (...args) => {
        await gate;
        return f.download(...args);
      };
      const controller = new PluginController(f.options),
        work = controller.install('floor-plans', [2025]);
      await vi.waitFor(() => expect(f.readCatalog).toHaveBeenCalled());
      expect(await controller.install('floor-plans', [2025])).toEqual({
        status: 'blocked',
        reason: 'busy',
      });
      f.options.context = () => null; // Constructor captured the original callback.
      f.context.token = 'new-generation';
      release();
      expect((await work).status).toBe('blocked');
      await expect(readFile(join(f.context.dataRoot, 'receipt.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    it('explicit invalidation during download never activates old prepared bytes', async () => {
      const f = await fixture();
      f.options.download = async (...args) => {
        const path = await f.download(...args);
        controller.invalidate();
        return path;
      };
      const controller = new PluginController(f.options);
      expect((await controller.install('floor-plans', [2025])).status).toBe('blocked');
      await expect(readFile(join(f.context.dataRoot, 'receipt.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    it('latches a background process-reader rejection while an asynchronous verifier is waiting', async () => {
      const f = await fixture();
      let reads = 0;
      f.options.processes = async () => {
        if (++reads > 1) throw Error('process query unavailable');
        return 'idle';
      };
      f.options.verify = async (...args) => {
        await vi.waitFor(() => expect(reads).toBeGreaterThan(1), { timeout: 2000 });
        return f.verify(...args);
      };
      expect((await new PluginController(f.options).install('floor-plans', [2025])).status).toBe(
        'blocked',
      );
      await expect(readFile(join(f.context.dataRoot, 'journal.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        readFile(join(f.context.targetRoot, '2025', 'Schema.addin')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('retains pending staging and recovers a first install after a process guard failure', async () => {
      const f = await fixture();
      let interrupt = true;
      f.options.processes = async () => {
        try {
          const j = JSON.parse(await readFile(join(f.context.dataRoot, 'journal.json'), 'utf8'));
          if (interrupt && j.payload.phase === 'payload') return 'unknown';
        } catch {
          /* no pending journal */
        }
        return 'idle';
      };
      const controller = new PluginController(f.options),
        result = await controller.install('floor-plans', [2025]);
      expect(result.status).toBe('recovery');
      expect((await readdir(f.context.stagingParent)).length).toBe(1);
      interrupt = false;
      expect(await controller.recover()).toEqual({
        status: 'blocked',
        reason: 'rolled_back_empty',
      });
      await expect(readFile(join(f.context.dataRoot, 'journal.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    it('blocks changed previous owned bytes before journal creation during upgrade', async () => {
      const f = await fixture(),
        controller = new PluginController(f.options),
        first = await controller.install('floor-plans', [2025]);
      if (first.status !== 'complete') throw Error('Fixture install');
      const dll = required(first.receipt.files.find((x) => x.kind === 'dll'));
      await writeFile(join(f.context.targetRoot, ...dll.targetPath.split('/')), 'changed');
      f.next(2);
      expect((await controller.install('floor-plans', [2025])).status).toBe('blocked');
      await expect(readFile(join(f.context.dataRoot, 'journal.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(f.context.dataRoot, 'receipt.json'), 'utf8')).toContain(
        first.receipt.id,
      );
      expect((await controller.inspect()).status).toBe('blocked');
    });
    it('recovers an interrupted upgrade only after the previous build has current authorization', async () => {
      const f = await fixture();
      let interrupt = false;
      f.options.processes = async () => {
        try {
          const j = JSON.parse(await readFile(join(f.context.dataRoot, 'journal.json'), 'utf8'));
          if (interrupt && j.payload.phase === 'addin') return 'unknown';
        } catch {
          /* no journal */
        }
        return 'idle';
      };
      const controller = new PluginController(f.options),
        first = await controller.install('floor-plans', [2025]);
      if (first.status !== 'complete') throw Error('Fixture install');
      f.next(2);
      interrupt = true;
      expect((await controller.install('floor-plans', [2025])).status).toBe('recovery');
      interrupt = false;
      expect((await controller.recover()).status).toBe('recovery');
      expect((await readdir(f.context.stagingParent)).length).toBe(1);
      f.next(1);
      const restored = await controller.recover();
      expect(restored.status).toBe('complete');
      if (restored.status === 'complete') expect(restored.receipt.id).toBe(first.receipt.id);
      await expect(readFile(join(f.context.dataRoot, 'journal.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);
