import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  PluginInstaller,
  type InstallerOptions,
  type PreparedPlugin,
} from '../../src/main/plugins/installer';
import type { RevitProcessState } from '../../src/main/plugins/safety';
import { fileHash, fixtureGuid, fixtureXml, makePluginZip } from '../helpers/pluginArchiveFixture';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const SCOPE = PluginInstaller.scope('https://teams.example', 7);
const OTHER = PluginInstaller.scope('https://teams.example', 8);
const guidB = '5d1f4a3c-2b6e-4c8d-9a0f-1e2d3c4b5a69';
async function fixture(base?: string) {
  const root = base ?? (await mkdtemp(join(tmpdir(), 'plugin-installer-')));
  roots.push(root);
  const revit = { state: 'idle' as RevitProcessState };
  const options: InstallerOptions = {
    root: join(root, 'local', 'plugins'),
    addinsRoot: join(root, 'roaming', 'Addins'),
    machineAddinsRoot: join(root, 'machine', 'Addins'),
    trusted: async () => true,
    revit: async () => revit.state,
  };
  return { root, revit, options, installer: new PluginInstaller(options) };
}
/** Синтетический архив сборки: .addin и «DLL» с текстом версии (не загружаемый код). */
function pkg(version: string, id = fixtureGuid, extra: { name: string; bytes: Buffer }[] = []) {
  return makePluginZip([
    { name: 'Plugin.addin', bytes: fixtureXml('Plugin.dll', id) },
    { name: 'Plugin.dll', bytes: Buffer.from(`SYNTHETIC ${id} ${version}, NEVER LOAD`) },
    ...extra,
  ]).buffer;
}
let buildId = 1;
async function prepare(
  f: Awaited<ReturnType<typeof fixture>>,
  code: string,
  version: string,
  zip: Buffer = pkg(version),
  years: (2025 | 2026)[] = [2025],
  scope = SCOPE,
): Promise<PreparedPlugin> {
  const path = join(f.root, `${code}-${version}-${buildId}.zip`);
  await writeFile(path, zip);
  return f.installer.prepare({
    scope,
    code,
    build: { id: buildId++, version, sha256: fileHash(zip) },
    archivePath: path,
    years,
  });
}
async function install(
  f: Awaited<ReturnType<typeof fixture>>,
  code: string,
  version: string,
  zip?: Buffer,
  years?: (2025 | 2026)[],
  scope?: string,
) {
  const prepared = await prepare(f, code, version, zip, years, scope);
  const result = await f.installer.commit(prepared);
  await f.installer.discard(prepared);
  return result;
}
const addin = (f: Awaited<ReturnType<typeof fixture>>, code: string, year = 2025) =>
  readFile(join(f.options.addinsRoot, String(year), `${code}.addin`), 'utf8');
const versions = async (f: Awaited<ReturnType<typeof fixture>>, code: string) =>
  (await readdir(join(f.options.root, code))).filter((n) => /^\d/.test(n)).sort();

describe('plugin installation by TZ 8.3', () => {
  it('installs into <plugin>\\<version> and writes <plugin>.addin pointing there; staging is clean', async () => {
    const f = await fixture();
    expect(await install(f, 'floor-plans', '1.0')).toBe('complete');
    const xml = await addin(f, 'floor-plans');
    expect(xml).toContain(join(f.options.root, 'floor-plans', '1.0', 'Plugin.dll'));
    expect(xml).toContain(`<AddInId>${fixtureGuid}</AddInId>`);
    expect(await readdir(join(f.options.root, 'staging'))).toEqual([]);
    expect(await f.installer.inspect(SCOPE)).toMatchObject([
      { code: 'floor-plans', version: '1.0', status: 'ok', previous: null, years: [2025] },
    ]);
  });
  it('keeps exactly one previous version; older ones are removed after a successful install', async () => {
    const f = await fixture();
    for (const v of ['1.0', '2.0', '3.0']) await install(f, 'floor-plans', v);
    expect(await versions(f, 'floor-plans')).toEqual(['2.0', '3.0']);
    expect((await f.installer.inspect(SCOPE))[0]).toMatchObject({
      version: '3.0',
      previous: '2.0',
      rollbackAvailable: true,
    });
  });
  it('a version needed by another login on this Windows account is not removed', async () => {
    const f = await fixture();
    await install(f, 'floor-plans', '1.0', undefined, undefined, OTHER);
    for (const v of ['2.0', '3.0', '4.0']) await install(f, 'floor-plans', v);
    expect(await versions(f, 'floor-plans')).toEqual(['1.0', '3.0', '4.0']);
  });
  it('«Вернуть» A after B was updated last returns A, not the last operation', async () => {
    const f = await fixture();
    await install(f, 'alpha', '1.0');
    await install(f, 'alpha', '2.0');
    await install(f, 'beta-tool', '1.0', pkg('1.0', guidB));
    await install(f, 'beta-tool', '2.0', pkg('2.0', guidB));
    expect(await f.installer.rollback(SCOPE, 'alpha')).toBe('complete');
    const state = await f.installer.inspect(SCOPE);
    expect(state.find((p) => p.code === 'alpha')).toMatchObject({
      version: '1.0',
      previous: '2.0',
      held: { buildId: expect.any(Number) },
    });
    expect(state.find((p) => p.code === 'beta-tool')).toMatchObject({ version: '2.0' });
    expect(await addin(f, 'alpha')).toContain(join('alpha', '1.0', 'Plugin.dll'));
    expect(await addin(f, 'beta-tool')).toContain(join('beta-tool', '2.0', 'Plugin.dll'));
  });
  it('rollback works without any server: only local files and the state file', async () => {
    const f = await fixture();
    await install(f, 'alpha', '1.0');
    await install(f, 'alpha', '2.0');
    const restarted = new PluginInstaller(f.options);
    expect(await restarted.rollback(SCOPE, 'alpha')).toBe('complete');
    await expect(restarted.rollback(OTHER, 'alpha')).rejects.toThrow('rollback_unavailable');
  });
  it('Dynamo-like foreign .addin (DBApplication, unknown tags, other AddInId) does not block', async () => {
    const f = await fixture();
    const dir = join(f.options.addinsRoot, '2025');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'Dynamo.addin'),
      `<?xml version="1.0"?><RevitAddIns><AddIn Type="DBApplication"><Assembly>C:/Dynamo/Loader.dll</Assembly><AddInId>${guidB}</AddInId><FullClassName>Dynamo.Loader</FullClassName><Weird a="1"><X/></Weird></AddIn></RevitAddIns>`,
    );
    await writeFile(join(dir, 'Broken.addin'), Buffer.from([0, 255, 1, 2]));
    expect(await install(f, 'floor-plans', '1.0')).toBe('complete');
    expect((await readdir(dir)).sort()).toEqual([
      'Broken.addin',
      'Dynamo.addin',
      'floor-plans.addin',
    ]);
  });
  it('removed .addin → «disabled»; reinstall rewrites it locally without download', async () => {
    const f = await fixture();
    await install(f, 'floor-plans', '1.0');
    const before = await addin(f, 'floor-plans');
    await unlink(join(f.options.addinsRoot, '2025', 'floor-plans.addin'));
    expect((await f.installer.inspect(SCOPE))[0]?.status).toBe('disabled');
    expect(await f.installer.repair(SCOPE, 'floor-plans')).toBe('complete');
    expect(await addin(f, 'floor-plans')).toBe(before);
    expect((await f.installer.inspect(SCOPE))[0]?.status).toBe('ok');
  });
  it('a deleted version file → «damaged»: repair asks for a download, a new install fixes it', async () => {
    const f = await fixture();
    await install(f, 'floor-plans', '1.0');
    await unlink(join(f.options.root, 'floor-plans', '1.0', 'Plugin.dll'));
    expect((await f.installer.inspect(SCOPE))[0]?.status).toBe('damaged');
    expect(await f.installer.repair(SCOPE, 'floor-plans')).toBe('download');
    expect(await install(f, 'floor-plans', '1.0')).toBe('complete');
    expect((await f.installer.inspect(SCOPE))[0]?.status).toBe('ok');
  });
  it('Revit running: nothing outside staging changes; after closing the install goes through', async () => {
    const f = await fixture();
    await install(f, 'floor-plans', '1.0');
    f.revit.state = 'busy';
    const prepared = await prepare(f, 'floor-plans', '2.0');
    expect(await f.installer.commit(prepared)).toBe('waiting');
    expect(await versions(f, 'floor-plans')).toEqual(['1.0']);
    expect(await addin(f, 'floor-plans')).toContain(join('floor-plans', '1.0'));
    await f.installer.discard(prepared);
    f.revit.state = 'unknown';
    expect(await install(f, 'floor-plans', '2.0')).toBe('waiting');
    f.revit.state = 'idle';
    expect(await install(f, 'floor-plans', '2.0')).toBe('complete');
  });
  it('Revit appeared while the folder was being moved: version folder rolled back, .addin untouched', async () => {
    const f = await fixture();
    await install(f, 'floor-plans', '1.0');
    let calls = 0;
    f.options.revit = async () => (++calls === 1 ? 'idle' : 'busy');
    expect(await install(f, 'floor-plans', '2.0')).toBe('waiting');
    expect(await versions(f, 'floor-plans')).toEqual(['1.0']);
    expect(await addin(f, 'floor-plans')).toContain(join('floor-plans', '1.0'));
    expect(await f.installer.pending()).toBeNull();
  });
  it('unsigned DLL → «signature», nothing installed', async () => {
    const f = await fixture();
    f.options.trusted = async () => false;
    await expect(prepare(f, 'floor-plans', '1.0')).rejects.toMatchObject({
      reason: 'signature',
      detail: 'Plugin.dll',
    });
    expect(await readdir(join(f.options.root, 'staging'))).toEqual([]);
    await expect(lstat(join(f.options.addinsRoot, '2025'))).rejects.toThrow();
  });
  it('per-year folders 2025/ and 2026/ give a separate .addin per Revit version', async () => {
    const f = await fixture();
    const zip = makePluginZip([
      { name: '2025/Plugin.addin', bytes: fixtureXml('Plugin\\Plugin.dll') },
      { name: '2025/Plugin/Plugin.dll', bytes: Buffer.from('SYNTHETIC 2025') },
      { name: '2026/Plugin.addin', bytes: fixtureXml('Plugin\\Plugin.dll') },
      { name: '2026/Plugin/Plugin.dll', bytes: Buffer.from('SYNTHETIC 2026') },
    ]).buffer;
    expect(await install(f, 'floor-plans', '1.0', zip, [2025, 2026])).toBe('complete');
    expect(await addin(f, 'floor-plans', 2025)).toContain(
      join('1.0', '2025', 'Plugin', 'Plugin.dll'),
    );
    expect(await addin(f, 'floor-plans', 2026)).toContain(
      join('1.0', '2026', 'Plugin', 'Plugin.dll'),
    );
    await expect(prepare(f, 'other', '1.0', zip.subarray(0), [2025])).resolves.toBeTruthy();
  });
  it('library package without .addin (Schema.Tools) installs files only', async () => {
    const f = await fixture();
    const zip = makePluginZip([
      { name: 'Schema.Tools.dll', bytes: Buffer.from('SYNTHETIC LIB') },
    ]).buffer;
    expect(await install(f, 'schema-tools', '2.0', zip)).toBe('complete');
    expect(await readdir(join(f.options.root, 'schema-tools', '2.0'))).toEqual([
      'Schema.Tools.dll',
    ]);
    await expect(addin(f, 'schema-tools')).rejects.toThrow();
    expect((await f.installer.inspect(SCOPE))[0]?.status).toBe('ok');
  });
  it('reserved names cannot be plugin folders', async () => {
    const f = await fixture();
    for (const code of ['staging', 'state', 'legacy'])
      await expect(prepare(f, code, '1.0')).rejects.toMatchObject({ reason: 'package_invalid' });
  });
});

describe('existing bureau installations (TZ 8: taking over)', () => {
  async function legacy(f: Awaited<ReturnType<typeof fixture>>, id = fixtureGuid) {
    const dir = join(f.options.addinsRoot, '2025');
    await mkdir(join(dir, 'FloorPlans'), { recursive: true });
    await writeFile(join(dir, 'FloorPlans', 'FloorPlans.dll'), 'SYNTHETIC LEGACY');
    await writeFile(
      join(dir, 'Schema.FloorPlans.addin'),
      fixtureXml('FloorPlans\\FloorPlans.dll', id),
    );
    return dir;
  }
  it('same AddInId with a bureau-signed assembly: old .addin moves to legacy, ours is written', async () => {
    const f = await fixture();
    const dir = await legacy(f);
    expect(await install(f, 'floor-plans', '1.0')).toBe('complete');
    expect((await readdir(dir)).sort()).toEqual(['FloorPlans', 'floor-plans.addin']);
    const kept = await readdir(join(f.options.root, 'floor-plans', 'legacy'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^2025-.*Schema\.FloorPlans\.addin$/);
  });
  it('same AddInId with an unsigned assembly: clear reason with the file name, nothing changed', async () => {
    const f = await fixture();
    const dir = await legacy(f);
    f.options.trusted = async (path) => !path.includes('FloorPlans');
    await expect(install(f, 'floor-plans', '1.0')).rejects.toMatchObject({
      reason: 'addin_conflict',
      detail: 'Schema.FloorPlans.addin',
    });
    expect((await readdir(dir)).sort()).toEqual(['FloorPlans', 'Schema.FloorPlans.addin']);
    expect(await f.installer.pending()).toBeNull();
    await expect(lstat(join(f.options.root, 'floor-plans', '1.0'))).rejects.toThrow();
  });
  it('machine-wide registration with the same AddInId cannot be changed without admin rights', async () => {
    const f = await fixture();
    const dir = join(f.options.machineAddinsRoot ?? '', '2025');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'AllUsers.addin'), fixtureXml('C:/Plugins/Plugin.dll'));
    await expect(install(f, 'floor-plans', '1.0')).rejects.toMatchObject({
      reason: 'addin_conflict_machine',
      detail: 'AllUsers.addin',
    });
  });
  it('our own .addin written for another login is simply replaced', async () => {
    const f = await fixture();
    await install(f, 'floor-plans', '1.0', undefined, undefined, OTHER);
    expect(await install(f, 'floor-plans', '2.0')).toBe('complete');
    await expect(lstat(join(f.options.root, 'floor-plans', 'legacy'))).rejects.toThrow();
  });
});

describe('interrupted operations finish or roll back by themselves, without a server', () => {
  it('update 1.0→2.0 interrupted after the folder move: a restarted app finishes it', async () => {
    const f = await fixture();
    await install(f, 'floor-plans', '1.0');
    // .addin не записать (на месте папки года — файл): журнал остаётся на шаге .addin.
    await rm(join(f.options.addinsRoot, '2025'), { recursive: true });
    await writeFile(join(f.options.addinsRoot, '2025'), 'blocker');
    await expect(install(f, 'floor-plans', '2.0')).rejects.toThrow();
    expect(await f.installer.pending()).toEqual({ code: 'floor-plans', version: '2.0' });
    await unlink(join(f.options.addinsRoot, '2025'));
    const restarted = new PluginInstaller(f.options);
    f.revit.state = 'busy';
    expect(await restarted.recover()).toBe('waiting');
    f.revit.state = 'idle';
    expect(await restarted.recover()).toBe('complete');
    expect(await addin(f, 'floor-plans')).toContain(join('floor-plans', '2.0'));
    expect((await restarted.inspect(SCOPE))[0]).toMatchObject({ version: '2.0', previous: '1.0' });
    expect(await restarted.pending()).toBeNull();
    expect(await readdir(join(f.options.root, 'staging'))).toEqual([]);
  });
  it('interrupted during the move of the same version: the previous folder comes back', async () => {
    const f = await fixture();
    await install(f, 'floor-plans', '1.0');
    const before = await readFile(join(f.options.root, 'floor-plans', '1.0', 'Plugin.dll'));
    const crashing = new PluginInstaller(f.options) as unknown as {
      undoMove: () => Promise<void>;
      commit: PluginInstaller['commit'];
      prepare: PluginInstaller['prepare'];
    };
    let calls = 0;
    f.options.revit = async () => (++calls === 2 ? 'busy' : 'idle');
    crashing.undoMove = async () => {
      throw Error('process killed');
    };
    const zip = pkg('1.0', fixtureGuid, [{ name: 'readme.txt', bytes: Buffer.from('new') }]);
    const path = join(f.root, 'same.zip');
    await writeFile(path, zip);
    const prepared = await crashing.prepare({
      scope: SCOPE,
      code: 'floor-plans',
      build: { id: 99, version: '1.0', sha256: fileHash(zip) },
      archivePath: path,
      years: [2025],
    });
    await expect(crashing.commit(prepared)).rejects.toThrow('process killed');
    f.options.revit = async () => 'idle';
    const restarted = new PluginInstaller(f.options);
    expect(await restarted.recover()).toBe('rolled_back');
    expect(await readFile(join(f.options.root, 'floor-plans', '1.0', 'Plugin.dll'))).toEqual(
      before,
    );
    await expect(lstat(join(f.options.root, 'floor-plans', '1.0', 'readme.txt'))).rejects.toThrow();
    expect((await restarted.inspect(SCOPE))[0]).toMatchObject({ version: '1.0', status: 'ok' });
  });
  it('a corrupt state or journal file is set aside instead of blocking forever', async () => {
    const f = await fixture();
    await install(f, 'floor-plans', '1.0');
    await writeFile(join(f.options.root, 'journal.json'), '{broken');
    await writeFile(join(f.options.root, 'state', `${SCOPE}.json`), '{"v":1,"plugins":[{}]}');
    const restarted = new PluginInstaller(f.options);
    expect(await restarted.recover()).toBe('none');
    expect(await restarted.inspect(SCOPE)).toEqual([]);
    const names = await readdir(f.options.root);
    expect(names.some((n) => n.startsWith('journal.json.corrupt-'))).toBe(true);
    expect(await install(f, 'floor-plans', '1.0')).toBe('complete');
  });
});

describe.runIf(process.platform === 'win32')('Windows short 8.3 path', () => {
  it('a root given by its short name installs, inspects and rolls back', async () => {
    const base = await mkdtemp(join(tmpdir(), 'plugin-installer-'));
    const long = join(base, 'Long profile folder name');
    await mkdir(long);
    const short = spawnSync(
      'cmd.exe',
      ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`],
      {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      },
    ).stdout.trim();
    roots.push(base);
    if (!/~[0-9]+$/.test(short)) return;
    const f = await fixture(short);
    expect(await install(f, 'floor-plans', '1.0')).toBe('complete');
    expect(await install(f, 'floor-plans', '2.0')).toBe('complete');
    expect((await f.installer.inspect(SCOPE))[0]?.status).toBe('ok');
    expect(await f.installer.rollback(SCOPE, 'floor-plans')).toBe('complete');
  });
});
