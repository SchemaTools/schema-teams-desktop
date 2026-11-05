import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginInstaller } from '../../src/main/plugins/installer';
import { PluginUpdater, type PluginUpdaterContext } from '../../src/main/plugins/updater';
import type { PluginBuild, PluginCatalog } from '../../src/shared/plugins';
import type { RevitProcessState } from '../../src/main/plugins/safety';
import { fileHash, fixtureGuid, fixtureXml, makePluginZip } from '../helpers/pluginArchiveFixture';

const roots: string[] = [];
const updaters: PluginUpdater[] = [];
afterEach(async () => {
  for (const u of updaters.splice(0)) u.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const guidTools = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
const zips = new Map<number, Buffer>();
let nextId = 1;
function build(version: string, id = fixtureGuid, patch: Partial<PluginBuild> = {}): PluginBuild {
  const zip =
    id === guidTools
      ? makePluginZip([
          { name: 'Schema.Tools.dll', bytes: Buffer.from(`SYNTHETIC TOOLS ${version}`) },
        ]).buffer
      : makePluginZip([
          { name: 'Plugin.addin', bytes: fixtureXml('Plugin.dll', id) },
          { name: 'Plugin.dll', bytes: Buffer.from(`SYNTHETIC ${id} ${version}`) },
        ]).buffer;
  const buildId = nextId++;
  zips.set(buildId, zip);
  return {
    id: buildId,
    version,
    verified: true,
    revit: [2025],
    notes: '',
    size: zip.length,
    sha256: fileHash(zip),
    url: `/api/desktop/plugins/files/${buildId}`,
    publishedAt: '2026-11-05T00:00:00.000Z',
    requires: [],
    ...patch,
  };
}
const entry = (code: string, stable: PluginBuild | null, beta: PluginBuild | null = null) => ({
  code,
  name: `Плагин ${code}`,
  short: 'ПЛ',
  stable,
  beta,
});
async function setup(catalog: PluginCatalog | null, context: Partial<PluginUpdaterContext> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-updater-'));
  roots.push(root);
  const env = {
    revit: 'idle' as RevitProcessState,
    catalog,
    downloads: 0,
    context: {
      key: 'login-1',
      scope: PluginInstaller.scope('https://teams.example', 7),
      automatic: true,
      beta: false,
      available: true,
      ...context,
    } as PluginUpdaterContext | null,
    changes: 0,
  };
  const options = {
    root: join(root, 'local'),
    addinsRoot: join(root, 'Addins'),
    machineAddinsRoot: null,
    trusted: async () => true,
    revit: async () => env.revit,
  };
  let installer = new PluginInstaller(options);
  const updater = new PluginUpdater({
    context: () => env.context,
    catalog: () => env.catalog,
    years: async () => [2025],
    installer: () => installer,
    download: async (b, parent) => {
      env.downloads++;
      await mkdir(parent, { recursive: true });
      const path = join(parent, `download-${b.id}.zip`);
      await writeFile(path, zips.get(b.id) ?? Buffer.alloc(0));
      return path;
    },
    processes: async () => env.revit,
    mayRun: () => true,
    changed: () => {
      env.changes++;
    },
    pollMs: 20,
  });
  updaters.push(updater);
  return {
    env,
    updater,
    options,
    get installer() {
      return installer;
    },
    restart() {
      installer = new PluginInstaller(options);
    },
  };
}
const addin = (options: { addinsRoot: string }, code: string) =>
  readFile(join(options.addinsRoot, '2025', `${code}.addin`), 'utf8');
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('timeout');
}

describe('plugin update queue', () => {
  it('Revit open → waiting (no download, one notice); after closing it installs and reports', async () => {
    const t = await setup({ tester: false, plugins: [entry('floor-plans', build('1.43'))] });
    t.env.revit = 'busy';
    await t.updater.refresh();
    expect(t.updater.state).toMatchObject({ phase: 'waiting', pending: 1, revitOpen: true });
    expect(t.updater.state.items[0]).toMatchObject({
      code: 'floor-plans',
      phase: 'waiting',
      version: '1.43',
    });
    expect(t.env.downloads).toBe(0);
    const [waiting] = t.updater.pendingNotices();
    expect(waiting).toMatchObject({ type: 'waiting', items: [{ name: 'Плагин floor-plans' }] });
    if (!waiting) throw Error('notice');
    t.updater.shown(waiting);
    await t.updater.refresh();
    expect(t.updater.pendingNotices()).toEqual([]);
    t.env.revit = 'idle';
    await until(() => t.updater.state.items[0]?.phase === 'complete');
    await t.updater.settled();
    expect(t.env.downloads).toBe(1);
    expect(t.updater.noticeCurrent(waiting)).toBe(false);
    expect(t.updater.pendingNotices()).toMatchObject([{ type: 'complete' }]);
    expect(t.updater.managed.plugins).toMatchObject([
      { code: 'floor-plans', version: '1.43', status: 'ok' },
    ]);
  });
  it('interrupted 1.0→2.0 is finished after restart before login, with no catalog at all', async () => {
    const one = build('1.0'),
      two = build('2.0');
    const t = await setup({ tester: false, plugins: [entry('floor-plans', one)] });
    await t.updater.refresh();
    await t.updater.settled();
    t.env.catalog = { tester: false, plugins: [entry('floor-plans', two)] };
    await rm(join(t.options.addinsRoot, '2025'), { recursive: true });
    await writeFile(join(t.options.addinsRoot, '2025'), 'blocker');
    await t.updater.refresh();
    await t.updater.settled();
    expect(await t.installer.pending()).toMatchObject({ version: '2.0' });
    await unlink(join(t.options.addinsRoot, '2025'));
    t.restart();
    t.env.context = null;
    t.env.catalog = null;
    await t.updater.refresh();
    expect(await t.installer.pending()).toBeNull();
    expect(await addin(t.options, 'floor-plans')).toContain(join('floor-plans', '2.0'));
  });
  it('a catalog event and a reconnect during the disk write do not abort it', async () => {
    const t = await setup({ tester: false, plugins: [entry('floor-plans', build('1.0'))] });
    const installer = t.installer,
      original = installer.commit.bind(installer);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    installer.commit = async (prepared) => {
      await gate;
      return original(prepared);
    };
    const run = t.updater.refresh();
    await until(() => t.updater.state.items[0]?.phase === 'installing' && t.env.downloads === 1);
    // desktop:plugins → новое чтение каталога; переподключение → тот же вход.
    t.env.catalog = { tester: false, plugins: [entry('floor-plans', build('1.1'))] };
    void t.updater.refresh();
    t.updater.sync();
    release();
    await run;
    await t.updater.settled();
    expect(t.updater.managed.plugins[0]?.version).toBe('1.1');
    expect(t.env.downloads).toBe(2);
  });
  it('«Вернуть» A after B was updated last returns A and holds A’s build from auto-update', async () => {
    const a1 = build('1.0'),
      a2 = build('2.0'),
      b1 = build('1.0', guidTools.replace('3c', '4d')),
      b2 = build('2.0', guidTools.replace('3c', '4d'));
    const t = await setup({ tester: false, plugins: [entry('alpha', a1), entry('bravo', b1)] });
    await t.updater.refresh();
    await t.updater.settled();
    t.env.catalog = { tester: false, plugins: [entry('alpha', a2)] };
    await t.updater.refresh();
    await t.updater.settled();
    t.env.catalog = { tester: false, plugins: [entry('alpha', a2), entry('bravo', b2)] };
    await t.updater.refresh();
    await t.updater.settled();
    expect(t.updater.managed.plugins.length).toBe(2);
    expect(t.updater.request('alpha', 'rollback')).toEqual({ accepted: true });
    await until(() => t.updater.state.items.find((i) => i.code === 'alpha')?.phase === 'complete');
    await t.updater.settled();
    const view = t.updater.managed.plugins;
    expect(view.find((p) => p.code === 'alpha')).toMatchObject({ version: '1.0', held: true });
    expect(view.find((p) => p.code === 'bravo')).toMatchObject({ version: '2.0' });
    const downloads = t.env.downloads;
    await t.updater.refresh(true);
    await t.updater.settled();
    expect(t.env.downloads).toBe(downloads);
    expect(t.updater.request('alpha', 'install')).toEqual({ accepted: true });
    await until(() => t.updater.managed.plugins.find((p) => p.code === 'alpha')?.version === '2.0');
  });
  it('dependency Schema.Tools is installed first; an incompatible combination is not installed', async () => {
    const tools = build('2.1', guidTools);
    const plan = build('1.43', fixtureGuid, {
      requires: [{ plugin: 'schema-tools', minVersion: '2.0' }],
    });
    const t = await setup({
      tester: false,
      plugins: [entry('floor-plans', plan), entry('schema-tools', tools)],
    });
    await t.updater.refresh();
    await t.updater.settled();
    expect(t.updater.managed.plugins.map((p) => [p.code, p.version])).toEqual([
      ['schema-tools', '2.1'],
      ['floor-plans', '1.43'],
    ]);
    expect(t.env.downloads).toBe(2);
    const bad = build('1.44', fixtureGuid, {
      requires: [{ plugin: 'schema-tools', minVersion: '3.0' }],
    });
    t.env.catalog = {
      tester: false,
      plugins: [entry('floor-plans', bad), entry('schema-tools', tools)],
    };
    await t.updater.refresh();
    await t.updater.settled();
    expect(t.updater.state.items.find((i) => i.code === 'floor-plans')).toMatchObject({
      phase: 'error',
      reason: 'plugin_dependency_unavailable',
    });
    expect(t.updater.managed.plugins.find((p) => p.code === 'floor-plans')?.version).toBe('1.43');
  });
  it('removed .addin is restored by auto-update locally, without a download', async () => {
    const t = await setup({ tester: false, plugins: [entry('floor-plans', build('1.0'))] });
    await t.updater.refresh();
    await t.updater.settled();
    await unlink(join(t.options.addinsRoot, '2025', 'floor-plans.addin'));
    await t.updater.refresh();
    await t.updater.settled();
    expect(t.updater.managed.plugins[0]?.status).toBe('ok');
    expect(t.env.downloads).toBe(1);
  });
  it('no automatic downgrade, unverified builds only by hand, failures not retried until «Проверить»', async () => {
    const t = await setup({ tester: false, plugins: [entry('floor-plans', build('2.0'))] });
    await t.updater.refresh();
    await t.updater.settled();
    t.env.catalog = { tester: false, plugins: [entry('floor-plans', build('1.0'))] };
    await t.updater.refresh();
    await t.updater.settled();
    expect(t.updater.managed.plugins[0]?.version).toBe('2.0');
    t.env.catalog = {
      tester: true,
      plugins: [entry('floor-plans', build('2.0'), build('2.1', fixtureGuid, { verified: false }))],
    };
    t.env.context = { ...(t.env.context as PluginUpdaterContext), beta: true };
    const before = t.env.downloads;
    await t.updater.refresh();
    await t.updater.settled();
    expect(t.env.downloads).toBe(before);
    expect(t.updater.managed.plugins[0]?.version).toBe('2.0');
    expect(t.updater.request('floor-plans', 'install')).toEqual({ accepted: true });
    await t.updater.settled();
    expect(t.updater.managed.plugins[0]?.version).toBe('2.1');
    t.options.trusted = async () => false;
    t.env.catalog = { tester: false, plugins: [entry('floor-plans', build('3.0'))] };
    t.env.context = { ...(t.env.context as PluginUpdaterContext), beta: false };
    await t.updater.refresh();
    await t.updater.settled();
    expect(t.updater.state.items[0]).toMatchObject({ phase: 'error', reason: 'signature' });
    const failed = t.env.downloads;
    await t.updater.refresh();
    await t.updater.settled();
    expect(t.env.downloads).toBe(failed);
    await t.updater.refresh(true);
    await t.updater.settled();
    expect(t.env.downloads).toBe(failed + 1);
  });
  it('without a trusted publisher nothing is downloaded and a manual install is refused', async () => {
    const t = await setup(
      { tester: false, plugins: [entry('floor-plans', build('1.0'))] },
      { available: false },
    );
    await t.updater.refresh();
    await t.updater.settled();
    expect(t.env.downloads).toBe(0);
    expect(t.updater.request('floor-plans', 'install')).toEqual({
      accepted: false,
      reason: 'plugin_trust_unconfigured',
    });
  });
  it('another login drops queued requests and notices of the previous one', async () => {
    const t = await setup({ tester: false, plugins: [entry('floor-plans', build('1.0'))] });
    t.env.revit = 'busy';
    await t.updater.refresh();
    const [ticket] = t.updater.pendingNotices();
    if (!ticket) throw Error('notice');
    t.env.context = { ...(t.env.context as PluginUpdaterContext), key: 'login-2' };
    t.updater.sync();
    expect(t.updater.noticeCurrent(ticket)).toBe(false);
    expect(t.updater.state.items).toEqual([]);
  });
});
