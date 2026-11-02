import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  PluginTransactions,
  type PluginTransactionOptions,
} from '../../src/main/plugins/transaction';
import {
  packageKey,
  receiptValid,
  PluginTransactionStore,
} from '../../src/main/plugins/transactionStore';
import { nodePathSafe } from '../../src/main/plugins/transactionFs';
import { ownedFile } from '../../src/main/plugins/transactionPlan';
import type {
  PluginReceipt,
  PluginTransactionPlan,
  InstalledPluginPackage,
  PluginScope,
  PluginTransactionJournal,
} from '../../src/main/plugins/transactionTypes';
const base = resolve(__dirname, '../../private'),
  roots: string[] = [];
const scope: PluginScope = { serverHash: 'a'.repeat(64), ownerId: 1 };
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
function required<T>(v: T | null | undefined): T {
  if (v == null) throw Error('Missing fixture');
  return v;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + sep) || !root.includes('plugin-txn-core-'))
      throw Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'plugin-txn-core-'));
  roots.push(root);
  const state = { owner: 1, process: 'idle' as 'idle' | 'busy' | 'unknown' };
  const options: PluginTransactionOptions = {
    targetRoot: join(root, 'targets'),
    dataRoot: join(root, 'state'),
    stagingParent: join(root, 'staging'),
    current: (s) => s.ownerId === state.owner && s.serverHash === scope.serverHash,
    admit: vi.fn(async () => true),
    processes: async () => state.process,
    pathAllowed: async () => true,
  };
  const make = (patch: Partial<PluginTransactionOptions> = {}) =>
    new PluginTransactions({ ...options, ...patch });
  let buildId = 0;
  async function bundle(code: string, version: string, years: (2025 | 2026)[], groupId: string) {
    const sourceRoot = join(options.stagingParent, randomUUID());
    await mkdir(sourceRoot, { recursive: true });
    const pkg: InstalledPluginPackage = {
        code,
        buildId: ++buildId,
        version,
        archiveSha256: digest(code + version),
        archiveSize: 100,
        revit: years,
        descriptorId: 'fixture-v1',
      },
      files: PluginTransactionPlan['files'] = [];
    for (const year of years) {
      const dllTarget = `${year}/managed/${groupId}/${code}/Plugin.dll`,
        addinTarget = `${year}/${code}.addin`;
      const idHex = digest(`${code}-${year}`).slice(0, 32),
        guid = `${idHex.slice(0, 8)}-${idHex.slice(8, 12)}-${idHex.slice(12, 16)}-${idHex.slice(16, 20)}-${idHex.slice(20)}`;
      const dll = `INERT-NOT-A-PE ${code} ${version} ${year}`,
        addin = `<RevitAddIns><AddIn Type="Command"><Name>${code}</Name><Assembly>${join(options.targetRoot, ...dllTarget.split('/'))}</Assembly><AddInId>${guid}</AddInId></AddIn></RevitAddIns>`;
      for (const [sourcePath, targetPath, kind, bytes] of [
        [`${year}.addin`, addinTarget, 'addin', addin],
        [`${year}.dll`, dllTarget, 'dll', dll],
      ] as const) {
        await writeFile(join(sourceRoot, sourcePath), bytes);
        files.push({
          packageKey: packageKey(pkg),
          sourceRoot,
          sourcePath,
          targetPath,
          kind,
          sha256: digest(bytes),
          size: Buffer.byteLength(bytes),
          ...(kind === 'addin' && { addInIds: [guid] }),
        });
      }
    }
    return { pkg, files };
  }
  async function plan(
    specs: { code: string; version: string; years: (2025 | 2026)[] }[],
    expectedCurrentId: string | null = null,
  ) {
    const id = randomUUID(),
      files: PluginTransactionPlan['files'] = [],
      packages: InstalledPluginPackage[] = [],
      replace: PluginTransactionPlan['replace'] = [];
    for (const s of specs) {
      const b = await bundle(s.code, s.version, s.years, id);
      files.push(...b.files);
      packages.push(b.pkg);
      replace.push(...s.years.map((year) => ({ code: s.code, year })));
    }
    return {
      id,
      scope: structuredClone(scope),
      files,
      packages,
      replace,
      expectedCurrentId,
    } satisfies PluginTransactionPlan;
  }
  const receipt = async (): Promise<PluginReceipt> =>
    JSON.parse(await readFile(join(options.dataRoot, 'receipt.json'), 'utf8')).payload;
  const bytes = (target: string) =>
    readFile(join(options.targetRoot, ...target.split('/')), 'utf8');
  return { root, options, state, make, plan, receipt, bytes };
}
async function installed(f: Awaited<ReturnType<typeof fixture>>) {
  const p = await f.plan([
    { code: 'floor-plans', version: '1.0', years: [2025, 2026] },
    { code: 'other-plugin', version: '4.0', years: [2025] },
  ]);
  expect((await f.make().install(p)).status).toBe('complete');
  return p;
}
describe('actual filesystem recoverable plugin transactions', () => {
  it(
    'journaled owned manifest rename removes the old activation and rollback restores it',
    { timeout: 15000 },
    async () => {
      const f = await fixture(),
        old = await installed(f),
        before = await readFile(join(f.options.dataRoot, 'receipt.json')),
        manifest = await f.bytes('2025/floor-plans.addin'),
        update = await f.plan([{ code: 'floor-plans', version: '2.0', years: [2025] }], old.id);
      const addin = required(update.files.find((f) => f.kind === 'addin'));
      addin.targetPath = '2025/renamed.addin';
      addin.addInIds = [randomUUID()];
      expect((await f.make().install(update)).status).toBe('complete');
      await expect(f.bytes('2025/floor-plans.addin')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await f.make().rollback(scope, update.id)).status).toBe('complete');
      expect(await readFile(join(f.options.dataRoot, 'receipt.json'))).toEqual(before);
      expect(await f.bytes('2025/floor-plans.addin')).toBe(manifest);
      await expect(
        readFile(join(f.options.targetRoot, '2025/renamed.addin')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
  it('adding a new plugin can roll back the whole set and remove only its owned manifest', async () => {
    const f = await fixture(),
      a = await f.plan([{ code: 'floor-plans', version: '1.0', years: [2025] }]);
    expect((await f.make().install(a)).status).toBe('complete');
    const b = await f.plan([{ code: 'other-plugin', version: '1.0', years: [2025] }], a.id);
    expect((await f.make().install(b)).status).toBe('complete');
    expect((await f.make().rollback(scope, b.id)).status).toBe('complete');
    expect((await f.receipt()).id).toBe(a.id);
    await expect(f.bytes('2025/other-plugin.addin')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.bytes('2025/floor-plans.addin')).toContain('floor-plans');
  });
  it('rollback removes an added dependency while preserving other plugin/year and foreign sentinel', async () => {
    const f = await fixture(),
      a = await installed(f),
      before = await f.receipt();
    await writeFile(join(f.options.targetRoot, '2025/foreign.addin'), 'FOREIGN');
    const b = await f.plan(
      [
        { code: 'floor-plans', version: '2.0', years: [2025] },
        { code: 'dependency-lib', version: '1.0', years: [2025] },
      ],
      a.id,
    );
    expect((await f.make().install(b)).status).toBe('complete');
    expect((await f.make().rollback(scope, b.id)).status).toBe('complete');
    expect(await f.receipt()).toEqual(before);
    for (const file of before.files)
      expect(digest(await f.bytes(file.targetPath))).toBe(file.sha256);
    await expect(f.bytes('2025/dependency-lib.addin')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.bytes('2025/foreign.addin')).toBe('FOREIGN');
  });
  it.each(['unlink', 'metadata', 'complete'] as const)(
    'rollback crash after %s recovers the coherent before-or-committed dependency set',
    async (fault) => {
      const f = await fixture(),
        a = await installed(f),
        b = await f.plan(
          [
            { code: 'floor-plans', version: '2.0', years: [2025] },
            { code: 'dependency-lib', version: '1.0', years: [2025] },
          ],
          a.id,
        );
      expect((await f.make().install(b)).status).toBe('complete');
      const before = await f.receipt();
      const failed = await f
        .make({
          afterWrite: async (p) => {
            if (fault === 'unlink' && p === '2025/dependency-lib.addin')
              throw Error('loss after unlink');
          },
          afterCheckpoint: async (phase) => {
            if (phase === fault) throw Error('loss after checkpoint');
          },
        })
        .rollback(scope, b.id);
      expect(failed.status).toBe('recovery');
      expect((await f.make().recover(scope)).status).toBe('complete');
      const recovered = await f.receipt();
      expect(recovered.id).toBe(fault === 'complete' ? a.id : b.id);
      for (const file of recovered.files)
        expect(digest(await f.bytes(file.targetPath))).toBe(file.sha256);
      if (fault === 'complete')
        await expect(f.bytes('2025/dependency-lib.addin')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      else expect(recovered).toEqual(before);
    },
  );
  it('recovery interrupted after restoring removed dependency is repeatable and refuses foreign bytes', async () => {
    const f = await fixture(),
      a = await installed(f),
      b = await f.plan([{ code: 'dependency-lib', version: '1.0', years: [2025] }], a.id);
    expect((await f.make().install(b)).status).toBe('complete');
    expect(
      (
        await f
          .make({
            afterWrite: async (p) => {
              if (p === '2025/dependency-lib.addin') throw Error('loss');
            },
          })
          .rollback(scope, b.id)
      ).status,
    ).toBe('recovery');
    expect(
      (
        await f
          .make({
            afterWrite: async (p) => {
              if (p === '2025/dependency-lib.addin') throw Error('loss during restore');
            },
          })
          .recover(scope)
      ).status,
    ).toBe('recovery');
    expect((await f.make().recover(scope)).status).toBe('complete');
    expect((await f.receipt()).id).toBe(b.id);
    const journal = join(f.options.dataRoot, 'journal.json');
    expect(
      (
        await f
          .make({
            afterWrite: async (p) => {
              if (p === '2025/dependency-lib.addin') throw Error('loss');
            },
          })
          .rollback(scope, b.id)
      ).status,
    ).toBe('recovery');
    await writeFile(join(f.options.targetRoot, '2025/dependency-lib.addin'), 'foreign replacement');
    const stored = await readFile(journal);
    expect((await f.make().recover(scope)).status).toBe('recovery');
    expect(await readFile(journal)).toEqual(stored);
    expect(await f.bytes('2025/dependency-lib.addin')).toBe('foreign replacement');
  });
  it.each(['busy', 'unknown', 'stale'] as const)(
    'revoked current policy or Revit %s before unlink preserves the owned dependency',
    async (mode) => {
      const f = await fixture(),
        a = await installed(f),
        b = await f.plan([{ code: 'dependency-lib', version: '1.0', years: [2025] }], a.id);
      expect((await f.make().install(b)).status).toBe('complete');
      const before = await f.bytes('2025/dependency-lib.addin');
      let live = true;
      const result = await f
        .make({
          current: (s) => live && f.options.current(s),
          afterCheckpoint: async (phase) => {
            if (phase === 'addin') {
              if (mode === 'stale') live = false;
              else f.state.process = mode;
            }
          },
        })
        .rollback(scope, b.id);
      expect(result.status).toBe(mode === 'stale' ? 'recovery' : 'waiting');
      expect(await f.bytes('2025/dependency-lib.addin')).toBe(before);
      f.state.process = 'idle';
      expect((await f.make().recover(scope)).status).toBe('complete');
    },
  );
  it('recovery admission receives exact backup sources and denied trust never restores an activation', async () => {
    const f = await fixture(),
      a = await installed(f),
      b = await f.plan([{ code: 'dependency-lib', version: '1.0', years: [2025] }], a.id);
    expect((await f.make().install(b)).status).toBe('complete');
    expect(
      (
        await f
          .make({
            afterWrite: async (p) => {
              if (p === '2025/dependency-lib.addin') throw Error('loss');
            },
          })
          .rollback(scope, b.id)
      ).status,
    ).toBe('recovery');
    const journal = JSON.parse(await readFile(join(f.options.dataRoot, 'journal.json'), 'utf8'))
      .payload as PluginTransactionJournal;
    const admitted = vi.fn(async (request: Parameters<PluginTransactionOptions['admit']>[0]) => {
      expect(request.receipt?.id).toBe(b.id);
      expect(request.sources.length).toBe(journal.previous?.files.length);
      expect(
        request.sources.every(
          (s) =>
            s.sourceRoot === join(f.options.dataRoot, 'backups', journal.id) &&
            s.sourcePath === s.targetPath,
        ),
      ).toBe(true);
      return false;
    });
    expect((await f.make({ admit: admitted }).recover(scope)).status).toBe('recovery');
    expect(admitted).toHaveBeenCalledOnce();
    await expect(f.bytes('2025/dependency-lib.addin')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.make().recover(scope)).status).toBe('complete');
  });
  it('a schema1 journal and missing manifest without a removal intent remain blocked unchanged', async () => {
    const f = await fixture(),
      a = await installed(f),
      b = await f.plan([{ code: 'dependency-lib', version: '1.0', years: [2025] }], a.id);
    expect((await f.make().install(b)).status).toBe('complete');
    expect(
      (
        await f
          .make({
            afterCheckpoint: async (phase) => {
              if (phase === 'backed-up') throw Error('loss');
            },
          })
          .rollback(scope, b.id)
      ).status,
    ).toBe('recovery');
    const path = join(f.options.dataRoot, 'journal.json'),
      record = JSON.parse(await readFile(path, 'utf8')).payload as PluginTransactionJournal;
    await rm(join(f.options.targetRoot, '2025/dependency-lib.addin'));
    expect((await f.make().recover(scope)).status).toBe('recovery');
    const store = new PluginTransactionStore(f.options.dataRoot, nodePathSafe);
    await store.write('journal', { ...record, schema: 1 });
    const old = await readFile(path);
    expect((await f.make().recover(scope)).status).toBe('recovery');
    expect(await readFile(path)).toEqual(old);
  });
  it.skipIf(process.platform !== 'win32')(
    'actual Windows sharing lock denies manifest deletion and preserves recoverable journal',
    async () => {
      const f = await fixture(),
        a = await installed(f),
        b = await f.plan([{ code: 'dependency-lib', version: '1.0', years: [2025] }], a.id);
      expect((await f.make().install(b)).status).toBe('complete');
      const path = join(f.options.targetRoot, '2025/dependency-lib.addin'),
        bytes = await readFile(path);
      const source = join(f.root, 'Hold.cs'),
        executable = join(f.root, 'Hold.exe'),
        ready = join(f.root, 'ready'),
        release = join(f.root, 'release');
      await writeFile(
        source,
        'using System;using System.IO;using System.Threading;class Hold{static void Main(string[] a){using(var f=new FileStream(a[0],FileMode.Open,FileAccess.Read,FileShare.Read)){File.WriteAllText(a[1],"ready");var end=DateTime.UtcNow.AddSeconds(15);while(!File.Exists(a[2])&&DateTime.UtcNow<end)Thread.Sleep(20);}}}',
      );
      execFileSync(
        join(
          process.env.WINDIR ?? 'C:\\Windows',
          'Microsoft.NET',
          'Framework64',
          'v4.0.30319',
          'csc.exe',
        ),
        ['/nologo', '/target:exe', `/out:${executable}`, source],
        { windowsHide: true, shell: false, timeout: 10000 },
      );
      const child = execFile(executable, [path, ready, release], {
        windowsHide: true,
        shell: false,
        timeout: 20000,
      });
      const ended = new Promise<void>((yes, no) => {
        child.once('error', no);
        child.once('exit', () => yes());
      });
      try {
        await vi.waitFor(async () => expect(await readFile(ready, 'utf8')).toBe('ready'));
        expect((await f.make().rollback(scope, b.id)).status).toBe('recovery');
        expect(await readFile(path)).toEqual(bytes);
      } finally {
        await writeFile(release, 'release');
        await ended;
      }
      expect((await f.make().recover(scope)).status).toBe('complete');
      expect((await f.receipt()).id).toBe(b.id);
    },
  );
  it('duplicate builds of one code/year are rejected by both selected-plan and persisted receipt parser', async () => {
    const f = await fixture(),
      p = await f.plan([{ code: 'floor-plans', version: '1.0', years: [2025] }]),
      second = { ...required(p.packages[0]), buildId: 999, version: '2.0' },
      extra = p.files.map((file) => ({
        ...file,
        packageKey: packageKey(second),
        targetPath: file.kind === 'addin' ? '2025/extra.addin' : `2025/managed/${p.id}/extra.dll`,
        ...(file.kind === 'addin' && { addInIds: [randomUUID()] }),
      }));
    p.packages.push(second);
    p.files.push(...extra);
    expect((await f.make().install(p)).status).toBe('blocked');
    expect(f.options.admit).not.toHaveBeenCalled();
    await expect(readdir(f.options.targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const malformed: PluginReceipt = {
      schema: 1,
      id: p.id,
      scope: p.scope,
      rootsHash: f.make().rootsHash,
      files: p.files.map(ownedFile),
      packages: p.packages,
    };
    expect(receiptValid(malformed)).toBe(false);
    const store = new PluginTransactionStore(f.options.dataRoot, nodePathSafe);
    await store.write('receipt', malformed);
    const raw = await readFile(join(f.options.dataRoot, 'receipt.json'));
    expect((await f.make().inspect(scope)).blocked).toBe(true);
    expect(await readFile(join(f.options.dataRoot, 'receipt.json'))).toEqual(raw);
  });
  it('updates selected package/year while retaining other managed packages, years and foreign files; DLL before addin', async () => {
    const f = await fixture(),
      old = await installed(f),
      before = await f.receipt();
    await writeFile(join(f.options.targetRoot, 'foreign.txt'), 'foreign sentinel');
    const update = await f.plan([{ code: 'floor-plans', version: '2.0', years: [2025] }], old.id),
      order: string[] = [];
    const result = await f
      .make({
        afterWrite: async (p) => {
          order.push(p);
        },
      })
      .install(update);
    expect(result.status).toBe('complete');
    expect(order.at(-1)).toBe('2025/floor-plans.addin');
    expect(order[0]).toMatch(/\.dll$/);
    const next = await f.receipt();
    expect(next.packages.map((p) => [p.code, p.version, p.revit])).toEqual(
      expect.arrayContaining([
        ['floor-plans', '1.0', [2026]],
        ['other-plugin', '4.0', [2025]],
        ['floor-plans', '2.0', [2025]],
      ]),
    );
    for (const file of before.files.filter(
      (file) => file.targetPath.startsWith('2026/') || file.packageKey.startsWith('other-plugin:'),
    ))
      expect(digest(await f.bytes(file.targetPath))).toBe(file.sha256);
    expect(await readFile(join(f.options.targetRoot, 'foreign.txt'), 'utf8')).toBe(
      'foreign sentinel',
    );
    const undone = await f.make().rollback(scope, next.id);
    expect(undone.status).toBe('complete');
    expect((await f.receipt()).id).toBe(before.id);
    for (const file of before.files)
      expect(digest(await f.bytes(file.targetPath))).toBe(file.sha256);
  });
  it.each(['intent', 'backed-up', 'payload', 'addin', 'metadata', 'complete'] as const)(
    'reopen after checkpoint %s preserves a coherent whole-set receipt and actual bytes',
    async (phase) => {
      const f = await fixture(),
        old = await installed(f),
        before = await f.receipt(),
        update = await f.plan(
          [{ code: 'floor-plans', version: '2.0', years: [2025, 2026] }],
          old.id,
        );
      const failed = await f
        .make({
          afterCheckpoint: async (p) => {
            if (p === phase) throw Error('simulated process loss');
          },
        })
        .install(update);
      expect(failed.status).toBe('recovery');
      expect((await f.make().recover(scope)).status).toBe('complete');
      const recovered = await f.receipt();
      expect(recovered.id).toBe(phase === 'complete' ? update.id : before.id);
      for (const file of recovered.files)
        expect(digest(await f.bytes(file.targetPath))).toBe(file.sha256);
    },
  );
  it('partial addin activation is restored before new payload cleanup even when caller arrays put addin first', async () => {
    const f = await fixture(),
      old = await installed(f),
      oldManifest = await f.bytes('2025/floor-plans.addin'),
      update = await f.plan([{ code: 'floor-plans', version: '2.0', years: [2025, 2026] }], old.id);
    expect(update.files[0]?.kind).toBe('addin');
    const failed = await f
      .make({
        afterWrite: async (p) => {
          if (p === '2025/floor-plans.addin') throw Error('simulated crash');
        },
      })
      .install(update);
    expect(failed.status).toBe('recovery');
    const order: string[] = [];
    const recovered = await f
      .make({
        afterWrite: async (p) => {
          order.push(p);
          if (p.endsWith('.dll')) expect(await f.bytes('2025/floor-plans.addin')).toBe(oldManifest);
        },
      })
      .recover(scope);
    expect(recovered.status).toBe('complete');
    expect(order[0]).toBe('2025/floor-plans.addin');
  });
  it('busy/unknown wait before mutation; Revit appearing after payload never activates addin and recovery waits too', async () => {
    const f = await fixture(),
      initial = await f.plan([{ code: 'floor-plans', version: '1.0', years: [2025] }]);
    for (const state of ['busy', 'unknown'] as const) {
      f.state.process = state;
      expect((await f.make().install(initial)).status).toBe('waiting');
      await expect(readFile(join(f.options.dataRoot, 'journal.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    f.state.process = 'idle';
    expect((await f.make().install(initial)).status).toBe('complete');
    const old = await f.bytes('2025/floor-plans.addin'),
      update = await f.plan([{ code: 'floor-plans', version: '2.0', years: [2025] }], initial.id);
    expect(
      (
        await f
          .make({
            afterWrite: async (p) => {
              if (p.endsWith('.dll')) f.state.process = 'busy';
            },
          })
          .install(update)
      ).status,
    ).toBe('waiting');
    expect(await f.bytes('2025/floor-plans.addin')).toBe(old);
    const journal = await readFile(join(f.options.dataRoot, 'journal.json'));
    expect((await f.make().recover(scope)).status).toBe('waiting');
    expect(await readFile(join(f.options.dataRoot, 'journal.json'))).toEqual(journal);
    f.state.process = 'idle';
    expect((await f.make().recover(scope)).status).toBe('complete');
  });
  it('foreign matching target is never adopted; denied publisher policy writes nothing', async () => {
    const f = await fixture(),
      p = await f.plan([{ code: 'floor-plans', version: '1.0', years: [2025] }]);
    await mkdir(join(f.options.targetRoot, '2025'), { recursive: true });
    await writeFile(join(f.options.targetRoot, '2025/floor-plans.addin'), 'foreign');
    expect((await f.make().install(p)).status).toBe('blocked');
    expect(await f.bytes('2025/floor-plans.addin')).toBe('foreign');
    expect(await f.make({ admit: async () => false }).install(p)).toEqual({
      status: 'blocked',
      reason: 'admission_denied',
    });
    await expect(readdir(f.options.dataRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('freezes absolute roots and callback references before a held admission await', async () => {
    const f = await fixture(),
      p = await f.plan([{ code: 'floor-plans', version: '1.0', years: [2025] }]);
    let allow!: (v: boolean) => void;
    const admitted = new Promise<boolean>((r) => {
        allow = r;
      }),
      enter = vi.fn(async () => admitted),
      options = { ...f.options, admit: enter },
      engine = new PluginTransactions(options),
      work = engine.install(p);
    await vi.waitFor(() => expect(enter).toHaveBeenCalled());
    options.targetRoot = join(f.root, 'decoy');
    options.dataRoot = join(f.root, 'decoy-state');
    options.processes = async () => 'unknown';
    allow(true);
    expect((await work).status).toBe('complete');
    expect((await f.receipt()).id).toBe(p.id);
    await expect(readdir(options.targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => new PluginTransactions({ ...f.options, targetRoot: 'relative' })).toThrow(
      'invalid_roots',
    );
  });
  it('late old-host journal rename cannot replace new-host receipt/journal after scope disposal', async () => {
    const f = await fixture(),
      a = await f.plan([{ code: 'floor-plans', version: '1.0', years: [2025] }]),
      b = await f.plan([{ code: 'other-plugin', version: '2.0', years: [2025] }]);
    b.scope.ownerId = 2;
    let release!: () => void,
      held = false,
      journalGuards = 0;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const old = f.make({
        pathAllowed: async (p) => {
          if (p === join(f.options.dataRoot, 'journal.json') && ++journalGuards === 4) {
            held = true;
            await gate;
          }
          return true;
        },
      }),
      work = old.install(a);
    await vi.waitFor(() => expect(held).toBe(true));
    old.dispose();
    f.state.owner = 2;
    const replacement = f.make();
    expect((await replacement.install(b)).status).toBe('complete');
    const receiptBytes = await readFile(join(f.options.dataRoot, 'receipt.json'));
    release();
    expect((await work).status).toBe('blocked');
    expect(await readFile(join(f.options.dataRoot, 'receipt.json'))).toEqual(receiptBytes);
    expect((await replacement.inspect(b.scope)).receipt?.id).toBe(b.id);
    await expect(readFile(join(f.options.dataRoot, 'journal.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('a revoked previous generation or corrupt backup never activates through rollback', async () => {
    const f = await fixture(),
      a = await installed(f),
      b = await f.plan([{ code: 'floor-plans', version: '2.0', years: [2025] }], a.id);
    expect((await f.make().install(b)).status).toBe('complete');
    const before = await f.bytes('2025/floor-plans.addin');
    expect(
      (await f.make({ admit: async (r) => r.purpose !== 'rollback' }).rollback(scope, b.id)).status,
    ).toBe('blocked');
    expect(await f.bytes('2025/floor-plans.addin')).toBe(before);
    const record = JSON.parse(
      await readFile(join(f.options.dataRoot, 'previous.json'), 'utf8'),
    ).payload;
    const file = required(record.receipt.files[0]) as { targetPath: string };
    await writeFile(
      join(f.options.dataRoot, 'backups', record.backupId, ...file.targetPath.split('/')),
      'corrupt',
    );
    expect((await f.make().rollback(scope, b.id)).status).toBe('blocked');
    expect(await f.bytes('2025/floor-plans.addin')).toBe(before);
  });
  it.skipIf(process.platform !== 'win32')(
    'actual readonly receipt rename failure retains old bytes and verified backup until explicit recovery',
    async () => {
      const f = await fixture(),
        a = await installed(f),
        before = await readFile(join(f.options.dataRoot, 'receipt.json')),
        b = await f.plan([{ code: 'floor-plans', version: '2.0', years: [2025] }], a.id),
        path = join(f.options.dataRoot, 'receipt.json');
      try {
        const failed = await f
          .make({
            afterCheckpoint: async (phase) => {
              if (phase === 'metadata') await chmod(path, 0o444);
            },
          })
          .install(b);
        expect(failed.status).toBe('recovery');
        expect(await readFile(path)).toEqual(before);
      } finally {
        await chmod(path, 0o600);
      }
      expect((await f.make().recover(scope)).status).toBe('complete');
      expect((await f.receipt()).id).toBe(a.id);
    },
  );
});
