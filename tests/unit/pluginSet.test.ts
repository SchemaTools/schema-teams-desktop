import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginInstaller, type InstallerOptions } from '../../src/main/plugins/installer';
import { PluginUpdater, type PluginUpdaterPorts } from '../../src/main/plugins/updater';
import {
  planPluginSetLinks,
  normalizeDeselected,
  parsePluginSetManifest,
  selectedComponentIds,
} from '../../src/main/plugins/pluginSet';
import {
  INNO_SILENT_ARGS,
  innoUninstaller,
  replaceInnoInstall,
  type InnoUninstallInfo,
} from '../../src/main/plugins/legacyInno';
import {
  ensureBureauSettings,
  normalizeBureauValues,
  renderBureauSettings,
} from '../../src/main/plugins/bureauSettings';
import {
  certificateDer,
  derSha256,
  ensureBureauCertificate,
  type CertificateDeps,
} from '../../src/main/plugins/certificate';
import { parseCertStores, parseInnoInfo } from '../../src/main/plugins/setupNative';
import type { PluginBuild, PluginCatalog } from '../../src/shared/plugins';
import { normalizeSettings } from '../../src/main/settings';
import { requestValid } from '../../src/shared/requests';
import type { RevitProcessState } from '../../src/main/plugins/safety';
import {
  fileHash,
  makePluginZip,
  toFormat2,
  type FixtureEntry,
} from '../helpers/pluginArchiveFixture';
import { readdir as readdirAll, stat } from 'node:fs/promises';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '' } }));

const roots: string[] = [];
const updaters: PluginUpdater[] = [];
afterEach(async () => {
  for (const u of updaters.splice(0)) u.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
const SCOPE = PluginInstaller.scope('https://teams.example', 7);
const CODE = 'schema-plugins';

// ── синтетический набор: компоненты в 2025/ и 2026/, json и «Что нового.md» в корне ─────
const GUIDS: Record<string, string> = {
  about: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  floorplans: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
  grids: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  colors: '3d4e5f6a-7b8c-4d9e-8f1a-2b3c4d5e6f7a',
};
const NAMES: Record<string, string> = {
  about: 'SchemaAbout',
  floorplans: 'SchemaFloorPlans',
  grids: 'SchemaGrids',
  colors: 'SchemaColors',
};
function addinXml(name: string, guid: string) {
  return Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><RevitAddIns><AddIn Type="Application"><Name>${name}</Name><Assembly>${name}\\${name}.dll</Assembly><AddInId>${guid}</AddInId><FullClassName>${name}.App</FullClassName><VendorId>TEST</VendorId></AddIn></RevitAddIns>`,
  );
}
function manifest(version: string, ids: string[]) {
  return Buffer.from(
    JSON.stringify({
      format: 1,
      code: CODE,
      version,
      components: ids.map((id) => ({
        id,
        title: id === 'about' ? 'О наборе' : `Плагин «${id}»`,
        addin: `${NAMES[id]}.addin`,
        fixed: id === 'about',
      })),
    }),
  );
}
function setZip(
  version: string,
  ids: string[],
  opts: { manifest?: boolean; format2?: boolean } = {},
) {
  const entries = setEntries(version, ids, opts);
  return makePluginZip(opts.format2 ? toFormat2(entries).entries : entries).buffer;
}
function setEntries(version: string, ids: string[], opts: { manifest?: boolean } = {}) {
  const entries: FixtureEntry[] = [];
  if (opts.manifest !== false)
    entries.push({ name: 'schema-plugins.json', bytes: manifest(version, ids) });
  entries.push({ name: 'Что нового.md', bytes: Buffer.from(`# ${version}\n- Синтетика.\n`) });
  for (const year of [2025, 2026])
    for (const id of ids) {
      const name = NAMES[id] ?? id,
        guid = GUIDS[id] ?? '';
      entries.push({ name: `${year}/${name}.addin`, bytes: addinXml(name, guid) });
      entries.push({
        name: `${year}/${name}/${name}.dll`,
        bytes: Buffer.from(`SYNTHETIC ${name} ${year} ${version}, NEVER LOAD`),
      });
      entries.push({ name: `${year}/${name}/settings.json`, bytes: Buffer.from('{}') });
      // общая библиотека — одинаковая у всех плагинов обоих годов
      entries.push({
        name: `${year}/${name}/Schema.Tools.dll`,
        bytes: Buffer.from(`SYNTHETIC Schema.Tools ${version}, NEVER LOAD`),
      });
    }
  return entries;
}
async function fixture() {
  const root = await temp('plugin-set-');
  const revit = { state: 'idle' as RevitProcessState };
  const options: InstallerOptions = {
    root: join(root, 'local', 'plugins'),
    addinsRoot: join(root, 'roaming', 'Addins'),
    machineAddinsRoot: null,
    trusted: async () => true,
    revit: async () => revit.state,
  };
  return { root, revit, options, installer: new PluginInstaller(options) };
}
let nextBuild = 100;
async function install(
  f: Awaited<ReturnType<typeof fixture>>,
  version: string,
  zip: Buffer,
  deselected: string[] = [],
  years: (2025 | 2026)[] = [2025, 2026],
) {
  const path = join(f.root, `set-${version}-${nextBuild}.zip`);
  await writeFile(path, zip);
  const prepared = await f.installer.prepare({
    scope: SCOPE,
    code: CODE,
    build: { id: nextBuild++, version, sha256: fileHash(zip) },
    archivePath: path,
    years,
    deselected,
  });
  const result = await f.installer.commit(prepared);
  await f.installer.discard(prepared);
  return result;
}
const setAddin = (f: Awaited<ReturnType<typeof fixture>>, year = 2025) =>
  readFile(join(f.options.addinsRoot, String(year), `${CODE}.addin`), 'utf8');
const ids = (xml: string) =>
  [...xml.matchAll(/<AddInId>([^<]+)<\/AddInId>/g)].map((m) => m[1]).sort();

describe('schema-plugins.json', () => {
  it('разбирает манифест набора; fixed по умолчанию false', () => {
    const m = parsePluginSetManifest(manifest('1.48', ['about', 'floorplans']), {
      code: CODE,
      version: '1.48',
    });
    expect(m.components).toEqual([
      { id: 'about', title: 'О наборе', addin: 'SchemaAbout.addin', fixed: true },
      {
        id: 'floorplans',
        title: 'Плагин «floorplans»',
        addin: 'SchemaFloorPlans.addin',
        fixed: false,
      },
    ]);
    const noFixed = Buffer.from(
      JSON.stringify({
        format: 1,
        code: CODE,
        version: '1.48',
        components: [{ id: 'grids', title: 'Оси', addin: 'SchemaGrids.addin' }],
      }),
    );
    expect(
      parsePluginSetManifest(noFixed, { code: CODE, version: '1.48' }).components[0]?.fixed,
    ).toBe(false);
  });
  it.each([
    ['другая версия', { version: '1.47' }],
    ['другой код', { code: 'other-set' }],
    ['формат 2', { format: 2 }],
    ['пустой состав', { components: [] }],
    ['путь в addin', { components: [{ id: 'a1', title: 'A', addin: '..\\x.addin' }] }],
    ['не .addin', { components: [{ id: 'a1', title: 'A', addin: 'x.dll' }] }],
    ['плохой id', { components: [{ id: 'Bad Id', title: 'A', addin: 'x.addin' }] }],
    [
      'повтор id',
      {
        components: [
          { id: 'a1', title: 'A', addin: 'a.addin' },
          { id: 'a1', title: 'B', addin: 'b.addin' },
        ],
      },
    ],
    ['fixed не boolean', { components: [{ id: 'a1', title: 'A', addin: 'a.addin', fixed: 1 }] }],
  ])('отказ: %s', (_name, patch) => {
    const bytes = Buffer.from(
      JSON.stringify({
        format: 1,
        code: CODE,
        version: '1.48',
        components: [{ id: 'a1', title: 'A', addin: 'a.addin' }],
        ...patch,
      }),
    );
    expect(() => parsePluginSetManifest(bytes, { code: CODE, version: '1.48' })).toThrow();
  });
  it('выбор: обязательные всегда, снятые — нет, прочее из настроек отбрасывается', () => {
    const c = [
      { id: 'about', fixed: true },
      { id: 'floorplans', fixed: false },
      { id: 'grids', fixed: false },
    ];
    expect(selectedComponentIds(c, ['about', 'grids'])).toEqual(['about', 'floorplans']);
    expect(normalizeDeselected(['grids', 'grids', 'Bad Id', 5])).toEqual(['grids']);
    expect(normalizeDeselected('grids')).toEqual([]);
  });
});

describe('установка набора одним пакетом', () => {
  it('много .addin в папке года, подпапки плагинов, json и «Что нового.md» в корне — один свой .addin', async () => {
    const f = await fixture();
    expect(await install(f, '1.47', setZip('1.47', ['about', 'floorplans', 'grids']))).toBe(
      'complete',
    );
    for (const year of [2025, 2026]) {
      const xml = await setAddin(f, year);
      expect(ids(xml)).toEqual([GUIDS.about, GUIDS.floorplans, GUIDS.grids].sort());
      expect(xml).toContain(
        join(f.options.root, CODE, '1.47', String(year), 'SchemaGrids', 'SchemaGrids.dll'),
      );
    }
    // прежних .addin по плагинам Desktop не пишет — только свой
    expect(await readdir(join(f.options.addinsRoot, '2025'))).toEqual([`${CODE}.addin`]);
    expect(await readFile(join(f.options.root, CODE, '1.47', 'Что нового.md'), 'utf8')).toContain(
      'Синтетика',
    );
    const [local] = await f.installer.inspect(SCOPE);
    expect(local?.components).toEqual([
      { id: 'about', title: 'О наборе', fixed: true, selected: true },
      { id: 'floorplans', title: 'Плагин «floorplans»', fixed: false, selected: true },
      { id: 'grids', title: 'Плагин «grids»', fixed: false, selected: true },
    ]);
  });
  it('снятые галочки при установке → .addin только с выбранными; fixed снять нельзя', async () => {
    const f = await fixture();
    await install(f, '1.47', setZip('1.47', ['about', 'floorplans', 'grids']), ['grids', 'about']);
    expect(ids(await setAddin(f))).toEqual([GUIDS.about, GUIDS.floorplans].sort());
    const [local] = await f.installer.inspect(SCOPE);
    expect(local?.status).toBe('ok');
    expect(local?.components?.find((c) => c.id === 'grids')?.selected).toBe(false);
  });
  it('смена состава без загрузки: .addin перезаписывается, Revit открыт — не мешает', async () => {
    const f = await fixture();
    await install(f, '1.47', setZip('1.47', ['about', 'floorplans', 'grids']));
    f.revit.state = 'busy';
    expect(await f.installer.select(SCOPE, CODE, ['floorplans'])).toBe('complete');
    expect(ids(await setAddin(f))).toEqual([GUIDS.about, GUIDS.grids].sort());
    expect(ids(await setAddin(f, 2026))).toEqual([GUIDS.about, GUIDS.grids].sort());
    expect(await f.installer.select(SCOPE, CODE, ['floorplans'])).toBe('unchanged');
    const [local] = await f.installer.inspect(SCOPE);
    expect(local?.status).toBe('ok');
    // вернуть галочку
    expect(await f.installer.select(SCOPE, CODE, [])).toBe('complete');
    expect(ids(await setAddin(f))).toHaveLength(3);
  });
  it('обновление сохраняет выбор, новые компоненты новой версии включены; «Вернуть» — с нынешним выбором', async () => {
    const f = await fixture();
    await install(f, '1.47', setZip('1.47', ['about', 'floorplans', 'grids']), ['grids']);
    await install(f, '1.48', setZip('1.48', ['about', 'floorplans', 'grids', 'colors']), ['grids']);
    expect(ids(await setAddin(f))).toEqual([GUIDS.about, GUIDS.floorplans, GUIDS.colors].sort());
    const [local] = await f.installer.inspect(SCOPE);
    expect(local).toMatchObject({ version: '1.48', previous: '1.47', rollbackAvailable: true });
    expect(await f.installer.rollback(SCOPE, CODE, ['floorplans'])).toBe('complete');
    expect(ids(await setAddin(f))).toEqual([GUIDS.about, GUIDS.grids].sort());
    expect(await setAddin(f)).toContain(join(CODE, '1.47', '2025'));
  });
  it('пакет без schema-plugins.json ставит все записи (обратная совместимость), выбирать нечего', async () => {
    const f = await fixture();
    await install(f, '1.47', setZip('1.47', ['floorplans', 'grids'], { manifest: false }), [
      'grids',
    ]);
    expect(ids(await setAddin(f))).toEqual([GUIDS.floorplans, GUIDS.grids].sort());
    const [local] = await f.installer.inspect(SCOPE);
    expect(local?.components).toBeUndefined();
    await expect(f.installer.select(SCOPE, CODE, ['grids'])).rejects.toMatchObject({
      reason: 'selection_unavailable',
    });
  });
  it('испорченный schema-plugins.json — сборка не ставится (package_manifest)', async () => {
    const f = await fixture();
    const zip = makePluginZip([
      { name: 'schema-plugins.json', bytes: Buffer.from('{"format":1') },
      { name: '2025/SchemaGrids.addin', bytes: addinXml('SchemaGrids', GUIDS.grids ?? '') },
      { name: '2025/SchemaGrids/SchemaGrids.dll', bytes: Buffer.from('SYNTHETIC') },
    ]).buffer;
    await expect(install(f, '1.47', zip, [], [2025])).rejects.toMatchObject({
      reason: 'package_manifest',
    });
  });
  it('кириллица разрешена только в именах данных; dll с кириллицей и имя без флага UTF-8 — отказ', async () => {
    const f = await fixture();
    const base = [
      { name: '2025/SchemaGrids.addin', bytes: addinXml('SchemaGrids', GUIDS.grids ?? '') },
      { name: '2025/SchemaGrids/SchemaGrids.dll', bytes: Buffer.from('SYNTHETIC') },
    ];
    await expect(
      install(
        f,
        '1.47',
        makePluginZip([...base, { name: '2025/Библиотека/x.dll', bytes: Buffer.from('x') }]).buffer,
        [],
        [2025],
      ),
    ).rejects.toMatchObject({ reason: 'package_invalid' });
    await expect(
      install(
        f,
        '1.47',
        makePluginZip([...base, { name: 'Что нового.md', bytes: Buffer.from('x'), flags: 0 }])
          .buffer,
        [],
        [2025],
      ),
    ).rejects.toMatchObject({ reason: 'package_invalid' });
    expect(
      await install(
        f,
        '1.47',
        makePluginZip([
          ...base,
          { name: '2025/SchemaGrids/Семейства/Ось.rfa', bytes: Buffer.from('rfa') },
        ]).buffer,
        [],
        [2025],
      ),
    ).toBe('complete');
  });
});

// ── замена прежней установки Inno ─────────────────────────────────────────────
// Пути собираются из частей: в открытом репозитории нет строк вида «\\имя\…».
const BS = '\\';
const LOCAL = win32.join('C:', BS, 'Users', 'user', 'AppData', 'Local');
const UNINSTALLER = win32.join(LOCAL, 'SchemaRevitPlugins', 'unins000.exe');
const TEMP_UNINSTALLER = win32.join('C:', BS, 'Temp', 'unins000.exe');
describe('замена установки Inno', () => {
  it.each([
    [`"${UNINSTALLER}"`, UNINSTALLER],
    [UNINSTALLER, UNINSTALLER],
    [`"${UNINSTALLER.toUpperCase()}"`, UNINSTALLER.toUpperCase()],
  ])('путь удалителя из ключа: %s', (value, expected) => {
    expect(innoUninstaller(value, LOCAL)).toBe(expected);
  });
  it.each([
    win32.join('C:', BS, 'Temp', 'SchemaRevitPlugins', 'unins000.exe'),
    `"${win32.join(LOCAL, 'SchemaRevitPlugins', 'sub', 'unins000.exe')}"`,
    `"${win32.join(LOCAL, 'SchemaRevitPlugins', '..', 'Evil', 'unins000.exe')}"`,
    `"${win32.join(LOCAL, 'SchemaRevitPlugins', 'setup.exe')}"`,
    `"${UNINSTALLER}" /VERYSILENT`,
    [BS, 'server', 'share', 'SchemaRevitPlugins', 'unins000.exe'].join(BS),
    `"${UNINSTALLER}`,
    ['%LOCALAPPDATA%', 'SchemaRevitPlugins', 'unins000.exe'].join(BS),
    `cmd.exe /c "${UNINSTALLER}"`,
  ])('путь вне %%LOCALAPPDATA%%\\SchemaRevitPlugins отклоняется: %s', (value) => {
    expect(innoUninstaller(value, LOCAL)).toBeNull();
  });
  async function legacy(
    key: (InnoUninstallInfo | null)[],
    run: (exe: string, args: readonly string[]) => Promise<number>,
  ) {
    const root = await temp('plugin-inno-'),
      bureauFile = join(root, 'Schema', 'bureau.txt');
    await mkdir(join(root, 'Schema'));
    await writeFile(bureauFile, 'FeedbackFolder=\\\\server\\share\\Обратная связь\r\n');
    const states = [...key];
    const calls: { exe: string; args: readonly string[] }[] = [];
    const result = await replaceInnoInstall({
      localAppData: LOCAL,
      bureauFile,
      readUninstall: async () => {
        const next = states.length > 1 ? states.shift() : states[0];
        return next === undefined ? null : next;
      },
      run: async (exe, args) => {
        calls.push({ exe, args });
        return run(exe, args);
      },
      fileOk: async () => true,
      sleep: async () => {},
      pollMs: 10,
      timeoutMs: 50,
    });
    return { result, calls, bureau: await readFile(bureauFile, 'utf8'), bureauFile };
  }
  it('нет ключа — ничего не запускается', async () => {
    const { result, calls } = await legacy([{ found: false }], async () => 0);
    expect(result).toEqual({ outcome: 'absent' });
    expect(calls).toEqual([]);
  });
  it('удалитель тихо, ждём исчезновения ключа — removed; bureau.txt на месте', async () => {
    const { result, calls, bureau } = await legacy(
      [
        { found: true, uninstallString: `"${UNINSTALLER}"` },
        { found: true, uninstallString: null },
        { found: false },
      ],
      async () => 0,
    );
    expect(result).toEqual({ outcome: 'removed' });
    expect(calls).toEqual([{ exe: UNINSTALLER, args: INNO_SILENT_ARGS }]);
    expect(bureau).toContain('FeedbackFolder=');
  });
  it('удалитель стёр bureau.txt — копия восстанавливается', async () => {
    const root = await temp('plugin-inno-'),
      bureauFile = join(root, 'Schema', 'bureau.txt');
    await mkdir(join(root, 'Schema'));
    await writeFile(bureauFile, 'LibraryFolder=\\\\server\\share\\Библиотека\r\n');
    const states: InnoUninstallInfo[] = [
      { found: true, uninstallString: UNINSTALLER },
      { found: false },
    ];
    const result = await replaceInnoInstall({
      localAppData: LOCAL,
      bureauFile,
      readUninstall: async () => states.shift() ?? { found: false },
      run: async () => {
        await rm(bureauFile);
        return 0;
      },
      fileOk: async () => true,
      sleep: async () => {},
    });
    expect(result).toEqual({ outcome: 'removed' });
    expect(await readFile(bureauFile, 'utf8')).toContain('Библиотека');
  });
  it('путь удалителя вне папки — не запускается, причина legacy_path', async () => {
    const { result, calls } = await legacy(
      [{ found: true, uninstallString: `"${TEMP_UNINSTALLER}"` }],
      async () => 0,
    );
    expect(result).toEqual({ outcome: 'failed', reason: 'legacy_path' });
    expect(calls).toEqual([]);
  });
  it('удалитель вернул ошибку или не запустился — failed; ключ не исчез — timeout', async () => {
    const found: InnoUninstallInfo = { found: true, uninstallString: `"${UNINSTALLER}"` };
    expect((await legacy([found], async () => 5)).result).toEqual({
      outcome: 'failed',
      reason: 'legacy_uninstall',
    });
    expect(
      (
        await legacy([found], async () => {
          throw Error('spawn');
        })
      ).result,
    ).toEqual({ outcome: 'failed', reason: 'legacy_uninstall' });
    expect((await legacy([found], async () => 0)).result).toEqual({
      outcome: 'failed',
      reason: 'legacy_timeout',
    });
    expect((await legacy([null], async () => 0)).result).toEqual({
      outcome: 'failed',
      reason: 'legacy_failed',
    });
  });
  it('ошибка удалителя → установка идёт, прежние .addin перехватываются в legacy', async () => {
    const f = await fixture();
    // прежняя установка Inno: SchemaGrids.addin + папка с DLL в Addins\2025
    const year = join(f.options.addinsRoot, '2025');
    await mkdir(join(year, 'SchemaGrids'), { recursive: true });
    await writeFile(join(year, 'SchemaGrids', 'SchemaGrids.dll'), 'OLD SYNTHETIC');
    await writeFile(join(year, 'SchemaGrids.addin'), addinXml('SchemaGrids', GUIDS.grids ?? ''));
    const failed = await replaceInnoInstall({
      localAppData: LOCAL,
      bureauFile: join(f.root, 'bureau.txt'),
      readUninstall: async () => ({ found: true, uninstallString: `"${UNINSTALLER}"` }),
      run: async () => 1,
      fileOk: async () => true,
      sleep: async () => {},
    });
    expect(failed.outcome).toBe('failed');
    expect(await install(f, '1.48', setZip('1.48', ['about', 'grids']), [], [2025])).toBe(
      'complete',
    );
    expect((await readdir(year)).filter((n) => n.endsWith('.addin'))).toEqual([`${CODE}.addin`]);
    expect((await readdir(join(f.options.root, CODE, 'legacy'))).join()).toContain(
      'SchemaGrids.addin',
    );
  });
  it('вывод помощника реестра разбирается строго', () => {
    expect(parseInnoInfo('{"v":1,"found":false}')).toEqual({ found: false });
    expect(
      parseInnoInfo(
        JSON.stringify({ v: 1, found: true, uninstallString: `"${TEMP_UNINSTALLER}"` }),
      ),
    ).toEqual({ found: true, uninstallString: `"${TEMP_UNINSTALLER}"` });
    expect(parseInnoInfo('{"v":1,"error":true}')).toBeNull();
    expect(parseInnoInfo('{"found":false,"v":1,"x":1}')).toBeNull();
    expect(parseCertStores('{"v":1,"root":true,"trustedPublisher":false}')).toEqual({
      root: true,
      trustedPublisher: false,
    });
    expect(parseCertStores('{"v":1,"root":"yes","trustedPublisher":false}')).toBeNull();
  });
});

describe('bureau.txt', () => {
  const values = normalizeBureauValues({
    feedbackFolder: '\\\\server\\share\\Обратная связь',
    deleteLogFolder: '',
    mcpScenarios: '\\\\<FILE_SERVER>\\x',
    libraryFolder: '\\\\server\\share\\Библиотека',
    settingsFolder: 'a\u0000b',
  });
  it('пустые значения и заглушки не пишутся', () => {
    expect(values).toEqual({
      feedbackFolder: '\\\\server\\share\\Обратная связь',
      libraryFolder: '\\\\server\\share\\Библиотека',
    });
    const text = renderBureauSettings(values) ?? '';
    expect(text.startsWith('\ufeff#')).toBe(true);
    expect(text).toContain('FeedbackFolder=\\\\server\\share\\Обратная связь\r\n');
    expect(text).toContain('LibraryFolder=');
    expect(text).not.toContain('DeleteLogFolder');
    expect(text).not.toContain('McpScenarios');
    expect(renderBureauSettings({})).toBeNull();
  });
  it('пишется только при отсутствии файла; существующий не трогается', async () => {
    const root = await temp('plugin-bureau-'),
      file = join(root, 'Schema', 'bureau.txt');
    expect(await ensureBureauSettings(file, {})).toBe('empty');
    expect(await ensureBureauSettings(file, values)).toBe('written');
    expect(await readFile(file, 'utf8')).toContain('LibraryFolder=');
    const own = 'FeedbackFolder=\\\\server\\Своя папка\r\n';
    await writeFile(file, own);
    expect(await ensureBureauSettings(file, values)).toBe('exists');
    expect(await readFile(file, 'utf8')).toBe(own);
  });
});

describe('сертификат бюро', () => {
  // Синтетический «DER» (SEQUENCE): настоящий сертификат в тестах не нужен — сверяется отпечаток.
  const der = Buffer.concat([Buffer.from([0x30, 0x82, 0x00, 0x60]), Buffer.alloc(96, 7)]);
  const pin = derSha256(der);
  function deps(
    stores: { root: boolean; trustedPublisher: boolean }[],
    patch: Partial<CertificateDeps> = {},
  ) {
    const added: string[] = [],
      queue = [...stores];
    const d: CertificateDeps = {
      certificate: async () => der,
      pins: [pin],
      stores: async () => (queue.length > 1 ? queue.shift() : queue[0]) ?? null,
      addStore: async (store) => {
        added.push(store);
        return 0;
      },
      ...patch,
    };
    return { d, added };
  }
  it('уже доверен — ничего не импортируется', async () => {
    const { d, added } = deps([{ root: true, trustedPublisher: true }]);
    expect(await ensureBureauCertificate(d, { manual: true, prompting: () => {} })).toBe('ok');
    expect(added).toEqual([]);
  });
  it('чужой отпечаток не импортируется никогда', async () => {
    const { d, added } = deps([{ root: false, trustedPublisher: false }], {
      pins: ['0'.repeat(64)],
    });
    expect(await ensureBureauCertificate(d, { manual: true, prompting: () => {} })).toBe('failed');
    expect(added).toEqual([]);
  });
  it('автоматически системный диалог не вызывается — required', async () => {
    const { d, added } = deps([{ root: false, trustedPublisher: false }]);
    expect(await ensureBureauCertificate(d, { manual: false, prompting: () => {} })).toBe(
      'required',
    );
    expect(added).toEqual([]);
  });
  it('по кнопке: подсказка в окне, затем Root и TrustedPublisher', async () => {
    const prompting = vi.fn();
    const { d, added } = deps([
      { root: false, trustedPublisher: false },
      { root: true, trustedPublisher: false },
      { root: true, trustedPublisher: true },
    ]);
    expect(await ensureBureauCertificate(d, { manual: true, prompting })).toBe('ok');
    expect(prompting).toHaveBeenCalledOnce();
    expect(added).toEqual(['Root', 'TrustedPublisher']);
  });
  it('пользователь нажал «Нет» — declined, издатель не трогается', async () => {
    const { d, added } = deps([{ root: false, trustedPublisher: false }], {
      addStore: async (store) => {
        added.push(store);
        return 1223;
      },
    });
    expect(await ensureBureauCertificate(d, { manual: true, prompting: () => {} })).toBe(
      'declined',
    );
    expect(added).toEqual(['Root']);
  });
  it('без сертификата в сборке функция выключена', async () => {
    const { d, added } = deps([{ root: false, trustedPublisher: false }], {
      certificate: async () => null,
    });
    expect(await ensureBureauCertificate(d, { manual: true, prompting: () => {} })).toBe('ok');
    expect(added).toEqual([]);
  });
  it('DER и PEM из .cer', () => {
    expect(certificateDer(der)).toEqual(der);
    const pem = Buffer.from(
      `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`,
    );
    expect(certificateDer(pem)).toEqual(der);
    expect(certificateDer(Buffer.from('not a certificate'.repeat(8)))).toBeNull();
  });
});

describe('очередь: набор, сертификат и прежняя установка', () => {
  async function setup(ports: Partial<PluginUpdaterPorts>, deselected: string[] = []) {
    const f = await fixture();
    const zip = setZip('1.48', ['about', 'floorplans', 'grids']);
    const build: PluginBuild = {
      id: 7,
      version: '1.48',
      verified: true,
      revit: [2025],
      notes: 'Что нового',
      size: zip.length,
      sha256: fileHash(zip),
      url: '/api/desktop/plugins/files/7',
      publishedAt: '2026-11-06T00:00:00.000Z',
      requires: [],
    };
    const catalog: PluginCatalog = {
      tester: false,
      plugins: [
        { code: CODE, name: 'Набор плагинов Schema', short: 'НП', stable: build, beta: null },
      ],
    };
    const settings = { deselected };
    const updater = new PluginUpdater({
      context: () => ({ key: 'k', scope: SCOPE, automatic: true, beta: false, available: true }),
      catalog: () => catalog,
      years: async () => [2025],
      installer: () => f.installer,
      download: async (_b, parent) => {
        await mkdir(parent, { recursive: true });
        const path = join(parent, 'set.zip');
        await writeFile(path, zip);
        return path;
      },
      processes: async () => f.revit.state,
      mayRun: () => true,
      changed: () => {},
      pollMs: 20,
      deselected: () => settings.deselected,
      ...ports,
    });
    updaters.push(updater);
    return { f, updater, settings };
  }
  it('автоматически без доверия к сертификату — certificate_required, без загрузки; по кнопке — ставит', async () => {
    const trust = vi.fn(async (o: { manual: boolean; prompting: () => void }) => {
      if (!o.manual) return 'required' as const;
      o.prompting();
      return 'ok' as const;
    });
    const { f, updater } = await setup({ ensureTrust: trust });
    await updater.refresh();
    await updater.settled();
    expect(updater.state.items[0]).toMatchObject({
      phase: 'error',
      reason: 'certificate_required',
    });
    expect(await f.installer.inspect(SCOPE)).toEqual([]);
    expect(updater.request(CODE, 'install')).toEqual({ accepted: true });
    await updater.settled();
    expect(updater.state.items[0]).toMatchObject({ phase: 'complete' });
    expect(trust).toHaveBeenLastCalledWith(expect.objectContaining({ manual: true }));
  });
  it('первая установка: beforeCommit до записи .addin; предупреждение видно, установка идёт; выбор из настроек', async () => {
    let addinAtCommit: boolean | null = null;
    const { f, updater, settings } = await setup({}, ['grids']);
    const beforeCommit = vi.fn(async (_code: string, first: boolean) => {
      addinAtCommit = await readdir(join(f.options.addinsRoot, '2025'))
        .then((n) => n.length > 0)
        .catch(() => false);
      return first ? 'legacy_uninstall' : null;
    });
    (updater.o as PluginUpdaterPorts).beforeCommit = beforeCommit;
    await updater.refresh();
    await updater.settled();
    expect(beforeCommit).toHaveBeenCalledWith(CODE, true);
    expect(addinAtCommit).toBe(false);
    expect(updater.state.items[0]).toMatchObject({ phase: 'complete', notice: 'legacy_uninstall' });
    expect(ids(await setAddin(f))).toEqual([GUIDS.about, GUIDS.floorplans].sort());
    expect(updater.managed.plugins[0]?.components?.map((c) => [c.id, c.selected])).toEqual([
      ['about', true],
      ['floorplans', true],
      ['grids', false],
    ]);
    settings.deselected = [];
    expect(await updater.select(CODE)).toEqual({ ok: true, applied: true });
    expect(ids(await setAddin(f))).toHaveLength(3);
  });
});

describe('выбор состава: настройки и запрос окна', () => {
  it('настройки компьютера: только допустимые коды плагинов и компонентов', () => {
    expect(
      normalizeSettings({
        pluginDeselected: { 'schema-plugins': ['grids', 'grids', 'Bad'], 'Bad Code': ['x1'] },
      }).pluginDeselected,
    ).toEqual({ 'schema-plugins': ['grids'] });
    expect(normalizeSettings({ pluginDeselected: [] }).pluginDeselected).toBeUndefined();
  });
  it('запрос plugins.components: код, список без повторов, без лишних полей', () => {
    const base = { kind: 'plugins.components', epoch: 1, code: CODE };
    expect(requestValid({ ...base, deselected: ['grids'] })).toBe(true);
    expect(requestValid({ ...base, deselected: [] })).toBe(true);
    expect(requestValid({ ...base, deselected: ['grids', 'grids'] })).toBe(false);
    expect(requestValid({ ...base, deselected: ['../x'] })).toBe(false);
    expect(requestValid({ ...base, deselected: ['grids'], path: 'C:/x' })).toBe(false);
    expect(requestValid({ kind: 'plugins.components', code: CODE, deselected: [] })).toBe(false);
  });
});

// ── формат 2: одинаковое один раз (_shared + links) ─────────────────────────────
const HASH = 'a'.repeat(64);
function manifest2(links: unknown, format = 2) {
  return Buffer.from(
    JSON.stringify({
      format,
      code: CODE,
      version: '1.48',
      components: [{ id: 'grids', title: 'Оси', addin: 'SchemaGrids.addin' }],
      ...(links !== undefined && { links }),
    }),
  );
}
const parse2 = (links: unknown, format = 2) =>
  parsePluginSetManifest(manifest2(links, format), { code: CODE, version: '1.48' });
async function listTree(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdirAll(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(...(await listTree(path, base)));
    else out.push(`${relative(base, path).split(sep).join('/')} ${fileHash(await readFile(path))}`);
  }
  return out.sort();
}
describe('формат 2: links', () => {
  it('разбирает ссылки; формат 1 — без links', () => {
    const m = parse2({ '2025/SchemaGrids/Schema.Tools.dll': `_shared/${HASH}.dll` });
    expect(m.format).toBe(2);
    expect(m.links).toEqual({ '2025/SchemaGrids/Schema.Tools.dll': `_shared/${HASH}.dll` });
    expect(parse2(undefined, 1).links).toEqual({});
    expect(parse2({}).links).toEqual({});
  });
  it.each([
    ['links у формата 1', { '2025/a/b.dll': `_shared/${HASH}.dll` }, 1],
    ['нет links у формата 2', undefined, 2],
    ['links не объект', ['2025/a/b.dll'], 2],
    ['путь вне 2025/2026', { 'x/b.dll': `_shared/${HASH}.dll` }, 2],
    ['путь в корне', { 'b.dll': `_shared/${HASH}.dll` }, 2],
    ['другой год', { '2024/a/b.dll': `_shared/${HASH}.dll` }, 2],
    ['выход наверх', { '2025/../b.dll': `_shared/${HASH}.dll` }, 2],
    ['пустой сегмент', { '2025/a//b.dll': `_shared/${HASH}.dll` }, 2],
    ['обратная косая', { [['2025', 'a', 'b.dll'].join(BS)]: `_shared/${HASH}.dll` }, 2],
    ['.addin', { '2025/a.addin': `_shared/${HASH}.addin` }, 2],
    ['исполняемый', { '2025/a/b.exe': `_shared/${HASH}.exe` }, 2],
    ['кириллица у dll', { '2025/a/Ось.dll': `_shared/${HASH}.dll` }, 2],
    ['значение не _shared', { '2025/a/b.dll': `2025/x/${HASH}.dll` }, 2],
    ['хеш прописными', { '2025/a/b.dll': `_shared/${'A'.repeat(64)}.dll` }, 2],
    ['короткий хеш', { '2025/a/b.dll': '_shared/abc.dll' }, 2],
    ['расширение не совпадает', { '2025/a/b.dll': `_shared/${HASH}.json` }, 2],
    [
      'повтор без учёта регистра',
      { '2025/a/b.dll': `_shared/${HASH}.dll`, '2025/A/B.dll': `_shared/${HASH}.dll` },
      2,
    ],
    [
      'файл и папка',
      {
        '2025/a/b.json': `_shared/${HASH}.json`,
        '2025/a/b.json/c.json': `_shared/${HASH}.json`,
      },
      2,
    ],
  ])('отказ: %s', (_name, links, format) => {
    expect(() => parse2(links, format)).toThrow();
  });
  it('сверка с архивом: blob назван своим хешем, существует, не пересекается с файлами', () => {
    const blob = Buffer.from('SHARED');
    const sha = fileHash(blob);
    const file = (relativePath: string, sha256 = sha) => ({
      relativePath,
      size: blob.length,
      sha256,
      kind: relativePath.endsWith('.dll') ? ('dll' as const) : ('data' as const),
    });
    const ok = parse2({ '2025/a/b.dll': `_shared/${sha}.dll` });
    expect(planPluginSetLinks(ok, [file(`_shared/${sha}.dll`)])).toEqual([
      { path: '2025/a/b.dll', blob: `_shared/${sha}.dll`, size: 6, sha256: sha, kind: 'dll' },
    ]);
    // содержимое blob не совпадает с хешем в имени
    expect(() => planPluginSetLinks(ok, [file(`_shared/${sha}.dll`, HASH)])).toThrow('links_blob');
    // ссылка на отсутствующий blob
    expect(() => planPluginSetLinks(ok, [file(`_shared/${HASH}.dll`, HASH)])).toThrow(
      'links_missing_blob',
    );
    // путь ссылки занят настоящим файлом архива
    expect(() =>
      planPluginSetLinks(ok, [file(`_shared/${sha}.dll`), file('2025/A/B.dll')]),
    ).toThrow('links_collision');
    expect(() =>
      planPluginSetLinks(ok, [file(`_shared/${sha}.dll`), file('2025/a/b.dll/c.json')]),
    ).toThrow('links_collision');
  });
  it('установка из пакета с links даёт то же дерево, что из пакета без links; _shared не кладётся', async () => {
    const list = ['about', 'floorplans', 'grids'];
    const f1 = await fixture(),
      f2 = await fixture();
    const plain = setZip('1.48', list),
      packed = setZip('1.48', list, { format2: true });
    expect(packed.length).toBeLessThan(plain.length);
    expect(toFormat2(setEntries('1.48', list)).links).toHaveProperty([
      '2025/SchemaGrids/Schema.Tools.dll',
    ]);
    expect(await install(f1, '1.48', plain)).toBe('complete');
    expect(await install(f2, '1.48', packed)).toBe('complete');
    const tree1 = await listTree(join(f1.options.root, CODE, '1.48')),
      tree2 = await listTree(join(f2.options.root, CODE, '1.48'));
    // отличается только schema-plugins.json (format и links)
    const strip = (t: string[]) => t.filter((l) => !l.startsWith('schema-plugins.json '));
    expect(strip(tree2)).toEqual(strip(tree1));
    expect(tree2.some((l) => l.startsWith('_shared/'))).toBe(false);
    expect(tree2).toContainEqual(expect.stringMatching(/^2026\/SchemaAbout\/Schema\.Tools\.dll /));
    expect(ids(await setAddin(f2))).toEqual(ids(await setAddin(f1)));
    expect((await f2.installer.inspect(SCOPE))[0]?.status).toBe('ok');
    // разложенная копия пропала — «повреждён»
    await rm(join(f2.options.root, CODE, '1.48', '2025', 'SchemaGrids', 'Schema.Tools.dll'));
    expect((await f2.installer.inspect(SCOPE))[0]?.status).toBe('damaged');
  });
  it('Assembly в .addin может указывать на dll из links', async () => {
    const f = await fixture();
    const entries = setEntries('1.48', ['grids']).map((e) =>
      e.name.endsWith('SchemaGrids.dll')
        ? { ...e, bytes: Buffer.from('SAME DLL IN BOTH YEARS, NEVER LOAD') }
        : e,
    );
    const { entries: packed, links } = toFormat2(entries);
    expect(links).toHaveProperty(['2025/SchemaGrids/SchemaGrids.dll']);
    expect(await install(f, '1.48', makePluginZip(packed).buffer)).toBe('complete');
    expect(await setAddin(f)).toContain(
      join(f.options.root, CODE, '1.48', '2025', 'SchemaGrids', 'SchemaGrids.dll'),
    );
  });
  it('испорченный blob — сборка не ставится; подпись проверяется и у dll в _shared', async () => {
    const f = await fixture();
    const { entries } = toFormat2(setEntries('1.48', ['grids']));
    const broken = entries.map((e) =>
      e.name.startsWith('_shared/') && e.name.endsWith('.dll')
        ? { ...e, bytes: Buffer.from('TAMPERED') }
        : e,
    );
    await expect(install(f, '1.48', makePluginZip(broken).buffer)).rejects.toMatchObject({
      reason: 'package_manifest',
    });
    const checked: string[] = [];
    const g = await fixture();
    const installer = new PluginInstaller({
      ...g.options,
      trusted: async (path) => {
        const rel = relative(g.root, path).split(sep);
        checked.push(rel.join('/'));
        return !rel.includes('_shared');
      },
    });
    const zip = makePluginZip(entries).buffer;
    const path = join(g.root, 'p.zip');
    await writeFile(path, zip);
    await expect(
      installer.prepare({
        scope: SCOPE,
        code: CODE,
        build: { id: 999, version: '1.48', sha256: fileHash(zip) },
        archivePath: path,
        years: [2025, 2026],
      }),
    ).rejects.toMatchObject({ reason: 'signature' });
    expect(checked.some((c) => c.includes('/_shared/'))).toBe(true);
  });
});
