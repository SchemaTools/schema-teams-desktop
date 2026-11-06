import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pluginCode, pluginVersion } from '../../shared/plugins';
import {
  discardExtractedArchive,
  extractPluginArchive,
  type ExtractedPluginArchive,
} from './archive';
import { removeTree } from './archivePaths';
import {
  ADDIN_MAX_BYTES,
  parseOwnAddin,
  renderAddinEntries,
  resolveAssembly,
  resolvedEntry,
  resolvedEntryValid,
  softAddinEntries,
  type ResolvedAddinEntry,
} from './addin';
import { hashFile, key, nodePathSafe, sha } from './fsSafe';
import type { RevitProcessState } from './safety';
import {
  PLUGIN_SET_MANIFEST,
  componentId,
  componentTitle,
  parsePluginSetManifest,
  selectedComponentIds,
  type PluginSetManifest,
} from './pluginSet';

/**
 * Установка плагинов по ТЗ 8.3 — один плагин за операцию:
 *
 *   %LOCALAPPDATA%\Schema Teams\plugins\
 *     staging\            временные папки распаковки (чистятся при запуске и после операции)
 *     state\<scope>.json  что установлено для пары «сервер + пользователь»
 *     journal.json        незавершённая операция (одна): по нему приложение само
 *                         доводит или откатывает её после сбоя, без сервера
 *     <плагин>\<версия>\  содержимое архива; хранится текущая и одна предыдущая
 *     <плагин>\legacy\    прежние .addin бюро, принятые под управление
 *
 * Порядок: архив проверяется и распаковывается в staging (Revit может работать),
 * затем при закрытом Revit папка переносится в <плагин>\<версия> одним переименованием
 * и последним пишется %APPDATA%\Autodesk\Revit\Addins\<год>\<плагин>.addin.
 */
export type Year = 2025 | 2026;
export interface FileRecord {
  path: string;
  size: number;
  sha256: string;
}
export interface VersionRecord {
  version: string;
  buildId: number;
  archiveSha256: string;
  years: Year[];
  /** Файлы папки версии (пути относительно неё, через «/»). */
  files: FileRecord[];
  /** Итоговые .addin по годам; у библиотеки (Schema.Tools без .addin) — пусто. */
  addins: { year: Year; xml: string }[];
  /** AddInId всех AddIn сборки — по ним ищутся прежние установки и конфликты. */
  ids: string[];
  /**
   * Набор плагинов (schema-plugins.json): компоненты, записи AddIn по годам и выбранные
   * компоненты. По ним .addin перезаписывается при смене состава без загрузки.
   */
  components?: ComponentRecord[];
  parts?: AddinPart[];
  selected?: string[];
}
export interface ComponentRecord {
  id: string;
  title: string;
  fixed: boolean;
}
export interface AddinPart {
  year: Year;
  /** null — .addin, которого нет в schema-plugins.json: ставится всегда. */
  component: string | null;
  entries: ResolvedAddinEntry[];
}
export interface PluginRecord {
  code: string;
  current: VersionRecord;
  previous: VersionRecord | null;
  /** «Вернуть» запретило автообновлению ставить эту сборку снова. */
  held: { buildId: number; archiveSha256: string } | null;
}
interface ScopeState {
  v: 1;
  plugins: PluginRecord[];
}
interface Journal {
  v: 1;
  id: string;
  scope: string;
  kind: 'install' | 'rollback';
  code: string;
  phase: 'move' | 'addin';
  /** Запись плагина после успешного завершения. */
  result: PluginRecord;
  /** Запись до операции — для отката переноса и уборки своих .addin. */
  before: PluginRecord | null;
  /** Прежняя папка той же версии, отодвинутая в staging (при откате — вернуть). */
  aside: string | null;
  legacy: { source: string; backup: string }[];
}
export interface PreparedPlugin {
  readonly scope: string;
  readonly code: string;
  readonly record: VersionRecord;
  readonly archive: ExtractedPluginArchive;
}
export type InstalledStatus = 'ok' | 'disabled' | 'damaged';
export interface InstalledPlugin {
  code: string;
  version: string;
  buildId: number;
  archiveSha256: string;
  years: Year[];
  status: InstalledStatus;
  previous: string | null;
  /** Предыдущая версия цела и её можно вернуть без сервера. */
  rollbackAvailable: boolean;
  held: { buildId: number; archiveSha256: string } | null;
  /** Компоненты набора установленной версии и выбор (только у пакета с schema-plugins.json). */
  components?: { id: string; title: string; fixed: boolean; selected: boolean }[];
}
export interface InstallerOptions {
  /** %LOCALAPPDATA%\Schema Teams\plugins (без переменной — userData\plugins). */
  root: string;
  /** %APPDATA%\Autodesk\Revit\Addins */
  addinsRoot: string;
  /** %ProgramData%\Autodesk\Revit\Addins — только чтение, для конфликтов. */
  machineAddinsRoot: string | null;
  /** Подпись Authenticode сертификатом бюро (списки доверия — в main, не из каталога). */
  trusted: (path: string, sha256: string) => Promise<boolean>;
  /** Revit в своём сеансе Windows. 'unknown' считается занятым. */
  revit: () => Promise<RevitProcessState>;
}
/** Ошибка с кодом причины для журнала и окна; detail — только имя файла .addin. */
export class PluginInstallError extends Error {
  constructor(
    readonly reason: string,
    readonly detail?: string,
  ) {
    super(reason);
    this.name = 'PluginInstallError';
  }
}
const fail = (reason: string, detail?: string): never => {
  throw new PluginInstallError(reason, detail);
};
const RESERVED = new Set(['staging', 'state', 'legacy']);
const scopeValid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const yearValid = (v: unknown): v is Year => v === 2025 || v === 2026;
const missing = (e: unknown) =>
  !!e && typeof e === 'object' && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
const displayName = (name: string) =>
  name.length <= 100 && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : 'файл .addin';

function fileValid(v: unknown): v is FileRecord {
  const f = v as FileRecord;
  return (
    !!f &&
    typeof f.path === 'string' &&
    f.path.length > 0 &&
    f.path.length <= 1024 &&
    !f.path.split('/').some((p) => !p || p === '.' || p === '..') &&
    Number.isSafeInteger(f.size) &&
    f.size >= 0 &&
    sha(f.sha256)
  );
}
function versionValid(v: unknown): v is VersionRecord {
  const r = v as VersionRecord;
  return (
    !!r &&
    pluginVersion(r.version) &&
    Number.isSafeInteger(r.buildId) &&
    r.buildId > 0 &&
    sha(r.archiveSha256) &&
    Array.isArray(r.years) &&
    r.years.every(yearValid) &&
    Array.isArray(r.files) &&
    r.files.length <= 4096 &&
    r.files.every(fileValid) &&
    Array.isArray(r.addins) &&
    r.addins.every(
      (a) => yearValid(a.year) && typeof a.xml === 'string' && a.xml.length <= ADDIN_MAX_BYTES,
    ) &&
    Array.isArray(r.ids) &&
    r.ids.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)) &&
    setValid(r)
  );
}
/** Поля набора — все вместе или ни одного (записи прежних версий приложения — без них). */
function setValid(r: VersionRecord): boolean {
  if (r.components === undefined && r.parts === undefined && r.selected === undefined) return true;
  if (!Array.isArray(r.components) || !Array.isArray(r.parts) || !Array.isArray(r.selected))
    return false;
  const ids = new Set(r.components.map((c) => c?.id));
  return (
    r.components.length <= 200 &&
    ids.size === r.components.length &&
    r.components.every(
      (c) => !!c && componentId(c.id) && componentTitle(c.title) && typeof c.fixed === 'boolean',
    ) &&
    r.parts.length <= 1024 &&
    r.parts.every(
      (p) =>
        !!p &&
        yearValid(p.year) &&
        (p.component === null || ids.has(p.component)) &&
        Array.isArray(p.entries) &&
        p.entries.length <= 32 &&
        p.entries.every(resolvedEntryValid),
    ) &&
    r.selected.every((id) => typeof id === 'string' && ids.has(id))
  );
}
/** .addin по годам из записей набора: компоненты вне выбора не попадают. */
function renderParts(parts: readonly AddinPart[], selected: readonly string[]) {
  const chosen = new Set(selected),
    addins: VersionRecord['addins'] = [];
  for (const year of [...new Set(parts.map((p) => p.year))].sort()) {
    const entries = parts
      .filter((p) => p.year === year && (p.component === null || chosen.has(p.component)))
      .flatMap((p) => p.entries);
    if (entries.length) addins.push({ year, xml: renderAddinEntries(entries) });
  }
  return addins;
}
/** Та же версия с другим выбором компонентов (без изменения файлов версии). */
function withSelection(record: VersionRecord, deselected: readonly string[]): VersionRecord {
  if (!record.components || !record.parts) return record;
  const selected = selectedComponentIds(record.components, deselected);
  return { ...record, selected, addins: renderParts(record.parts, selected) };
}
function recordValid(v: unknown): v is PluginRecord {
  const r = v as PluginRecord;
  return (
    !!r &&
    pluginCode(r.code) &&
    versionValid(r.current) &&
    (r.previous === null || versionValid(r.previous)) &&
    (r.held === null ||
      (!!r.held && Number.isSafeInteger(r.held.buildId) && sha(r.held.archiveSha256)))
  );
}
function journalValid(v: unknown): v is Journal {
  const j = v as Journal;
  return (
    !!j &&
    j.v === 1 &&
    typeof j.id === 'string' &&
    scopeValid(j.scope) &&
    (j.kind === 'install' || j.kind === 'rollback') &&
    pluginCode(j.code) &&
    (j.phase === 'move' || j.phase === 'addin') &&
    recordValid(j.result) &&
    j.result.code === j.code &&
    (j.before === null || (recordValid(j.before) && j.before.code === j.code)) &&
    (j.aside === null || typeof j.aside === 'string') &&
    Array.isArray(j.legacy) &&
    j.legacy.every((l) => typeof l.source === 'string' && typeof l.backup === 'string')
  );
}
/** Запись файла целиком: временный файл рядом, fsync, одно переименование поверх. */
async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(data, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
}
async function readSmall(path: string, limit = ADDIN_MAX_BYTES): Promise<Buffer | null> {
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.size > limit) return null;
    return await readFile(path);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

export class PluginInstaller {
  private readonly hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  private serial: Promise<unknown> = Promise.resolve();
  constructor(readonly o: InstallerOptions) {}
  get stagingRoot(): string {
    return join(this.o.root, 'staging');
  }
  private get journalPath(): string {
    return join(this.o.root, 'journal.json');
  }
  private statePath(scope: string): string {
    if (!scopeValid(scope)) fail('scope');
    return join(this.o.root, 'state', `${scope}.json`);
  }
  versionDir(code: string, version: string): string {
    if (!pluginCode(code) || RESERVED.has(code) || !pluginVersion(version)) fail('package_invalid');
    return join(this.o.root, code, version);
  }
  addinPath(code: string, year: Year): string {
    return join(this.o.addinsRoot, String(year), `${code}.addin`);
  }
  /** Операции с диском — строго по одной. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work, work);
    this.serial = run.catch(() => {});
    return run;
  }

  // ── состояние ───────────────────────────────────────────────────────────
  private async readJson(path: string): Promise<unknown> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if (missing(e)) return undefined;
      throw e;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  /** Испорченный файл не блокирует плагины навсегда: он откладывается в .corrupt-<время>. */
  private async quarantine(path: string): Promise<void> {
    await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
  }
  async readState(scope: string): Promise<ScopeState> {
    const path = this.statePath(scope),
      raw = await this.readJson(path);
    if (raw === undefined) return { v: 1, plugins: [] };
    const s = raw as ScopeState;
    if (!s || s.v !== 1 || !Array.isArray(s.plugins) || !s.plugins.every(recordValid)) {
      await this.quarantine(path);
      return { v: 1, plugins: [] };
    }
    return s;
  }
  private async writeState(scope: string, state: ScopeState): Promise<void> {
    await nodePathSafe(this.o.root);
    await writeAtomic(this.statePath(scope), JSON.stringify(state));
  }
  private async readJournal(): Promise<Journal | null> {
    const raw = await this.readJson(this.journalPath);
    if (raw === undefined) return null;
    if (!journalValid(raw)) {
      // Без журнала довести операцию нельзя; плагин покажется повреждённым/отключённым
      // и переустановится — это лучше, чем вечная блокировка.
      await this.quarantine(this.journalPath);
      return null;
    }
    return raw;
  }
  private async writeJournal(journal: Journal): Promise<void> {
    await writeAtomic(this.journalPath, JSON.stringify(journal));
  }
  async pending(): Promise<{ code: string; version: string } | null> {
    const journal = await this.readJournal();
    return journal ? { code: journal.code, version: journal.result.current.version } : null;
  }

  // ── проверка установленного ────────────────────────────────────────────
  private async fileIntact(dir: string, file: FileRecord): Promise<boolean> {
    const path = join(dir, ...file.path.split('/'));
    try {
      const s = await stat(path);
      if (!s.isFile() || s.size !== file.size) return false;
      const cached = this.hashes.get(key(path));
      if (cached && cached.size === s.size && cached.mtimeMs === s.mtimeMs)
        return cached.sha256 === file.sha256;
      const { sha256 } = await hashFile(path, 512 * 1024 * 1024);
      this.hashes.set(key(path), { size: s.size, mtimeMs: s.mtimeMs, sha256 });
      return sha256 === file.sha256;
    } catch {
      return false;
    }
  }
  private async versionIntact(code: string, record: VersionRecord): Promise<boolean> {
    const dir = this.versionDir(code, record.version);
    for (const file of record.files) if (!(await this.fileIntact(dir, file))) return false;
    return true;
  }
  private async addinsIntact(code: string, record: VersionRecord): Promise<boolean> {
    for (const addin of record.addins) {
      const bytes = await readSmall(this.addinPath(code, addin.year));
      if (!bytes || bytes.toString('utf8') !== addin.xml) return false;
    }
    return true;
  }
  /** Что установлено для этого входа и в каком состоянии (по файлам на диске, без сервера). */
  inspect(scope: string): Promise<InstalledPlugin[]> {
    return this.exclusive(async () => {
      const state = await this.readState(scope),
        result: InstalledPlugin[] = [];
      for (const p of state.plugins) {
        const files = await this.versionIntact(p.code, p.current),
          addins = files && (await this.addinsIntact(p.code, p.current));
        result.push({
          code: p.code,
          version: p.current.version,
          buildId: p.current.buildId,
          archiveSha256: p.current.archiveSha256,
          years: [...p.current.years],
          status: !files ? 'damaged' : addins ? 'ok' : 'disabled',
          previous: p.previous?.version ?? null,
          rollbackAvailable: !!p.previous && (await this.versionIntact(p.code, p.previous)),
          held: p.held,
          ...(p.current.components && {
            components: p.current.components.map((c) => ({
              ...c,
              selected: c.fixed || !!p.current.selected?.includes(c.id),
            })),
          }),
        });
      }
      return result;
    });
  }

  // ── подготовка (Revit может работать) ──────────────────────────────────
  /** Распаковать и проверить архив в staging. Ничего вне staging не меняет. */
  prepare(request: {
    scope: string;
    code: string;
    build: { id: number; version: string; sha256: string };
    archivePath: string;
    years: Year[];
    signal?: AbortSignal;
    /** Снятые галочки набора (настройки компьютера); новые компоненты включены. */
    deselected?: readonly string[];
  }): Promise<PreparedPlugin> {
    const { scope, code, archivePath, signal } = request,
      build = { ...request.build },
      deselected = [...(request.deselected ?? [])],
      years = [...new Set(request.years)].filter(yearValid).sort();
    return this.exclusive(async () => {
      if (!scopeValid(scope) || !years.length || !sha(build.sha256)) fail('package_invalid');
      const versionDir = this.versionDir(code, build.version);
      await mkdir(this.stagingRoot, { recursive: true });
      await nodePathSafe(this.stagingRoot);
      let archive: ExtractedPluginArchive;
      try {
        archive = await extractPluginArchive({
          archivePath,
          expectedSha256: build.sha256,
          stagingParent: this.stagingRoot,
          signal,
        });
      } catch {
        return fail('package_invalid');
      }
      try {
        const files = new Map(archive.files.map((f) => [f.relativePath.toLowerCase(), f]));
        // Набор плагинов: schema-plugins.json в корне описывает компоненты (галочки).
        const manifestFile = files.get(PLUGIN_SET_MANIFEST);
        let manifest: PluginSetManifest | null = null;
        if (manifestFile)
          try {
            manifest = parsePluginSetManifest(
              await readFile(join(archive.contentRoot, ...manifestFile.relativePath.split('/'))),
              { code, version: build.version },
            );
          } catch {
            return fail('package_manifest');
          }
        // Папки 2025/ и 2026/ — отдельные сборки под каждый год; без них содержимое общее.
        const perYear = archive.files.some((f) => /^20\d\d\//.test(f.relativePath));
        const parts: AddinPart[] = [],
          ids = new Set<string>();
        for (const year of years) {
          const prefix = perYear ? `${year}/` : '';
          if (perYear && !archive.files.some((f) => f.relativePath.startsWith(prefix)))
            fail('package_year_missing', String(year));
          const manifests = archive.files.filter(
            (f) =>
              f.kind === 'addin' &&
              f.relativePath.startsWith(prefix) &&
              !f.relativePath.slice(prefix.length).includes('/'),
          );
          const seen = new Set<string>();
          for (const addinFile of manifests) {
            const name = basename(addinFile.relativePath);
            const bytes = await readFile(
              join(archive.contentRoot, ...addinFile.relativePath.split('/')),
            );
            let parsed: ReturnType<typeof parseOwnAddin>;
            try {
              parsed = parseOwnAddin(bytes);
            } catch {
              return fail('package_addin', name);
            }
            const entries: ResolvedAddinEntry[] = [];
            for (const entry of parsed) {
              let assembly: string;
              try {
                assembly = resolveAssembly(addinFile.relativePath, entry.assembly);
              } catch {
                return fail('package_addin', name);
              }
              const file = files.get(assembly.toLowerCase());
              if (!file || file.kind !== 'dll' || !file.relativePath.startsWith(prefix))
                return fail('package_addin', name);
              if (seen.has(entry.addInId)) fail('package_addin', name);
              seen.add(entry.addInId);
              entries.push(resolvedEntry(entry, join(versionDir, ...file.relativePath.split('/'))));
              ids.add(entry.addInId);
            }
            const component =
              manifest?.components.find((c) => c.addin.toLowerCase() === name.toLowerCase())?.id ??
              null;
            parts.push({ year, component, entries });
          }
        }
        const components = manifest?.components.map(({ id, title, fixed }) => ({
          id,
          title,
          fixed,
        }));
        const selected = components ? selectedComponentIds(components, deselected) : [];
        const addins = renderParts(parts, components ? selected : []);
        // ТЗ 8.3: каждая DLL подписана сертификатом бюро; иначе не ставим.
        for (const file of archive.files.filter((f) => f.kind === 'dll'))
          if (
            !(await this.o.trusted(
              join(archive.contentRoot, ...file.relativePath.split('/')),
              file.sha256,
            ))
          )
            fail('signature', basename(file.relativePath));
        return Object.freeze({
          scope,
          code,
          archive,
          record: {
            version: build.version,
            buildId: build.id,
            archiveSha256: build.sha256,
            years,
            files: archive.files.map((f) => ({
              path: f.relativePath,
              size: f.size,
              sha256: f.sha256,
            })),
            addins,
            ids: [...ids].sort(),
            ...(components && { components, parts, selected }),
          },
        });
      } catch (error) {
        await discardExtractedArchive(archive).catch(() => {});
        throw error;
      }
    });
  }
  async discard(prepared: PreparedPlugin): Promise<void> {
    await discardExtractedArchive(prepared.archive).catch(() => {});
  }

  // ── прежние и чужие .addin ─────────────────────────────────────────────
  private async listAddins(dir: string): Promise<string[]> {
    try {
      const names: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (names.length >= 512) break;
        if (entry.isFile() && /\.addin$/i.test(entry.name)) names.push(entry.name);
      }
      return names.sort();
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
  }
  /**
   * Чужие .addin читаются мягко: мешает только тот же AddInId или наше имя файла.
   * Прежняя установка бюро (сборка подписана сертификатом бюро) принимается под
   * управление: её .addin откладывается в <плагин>\legacy, вместо него пишется наш.
   */
  private async conflicts(
    code: string,
    record: VersionRecord,
    known: readonly (VersionRecord | null)[],
  ): Promise<Journal['legacy']> {
    const ids = new Set(record.ids),
      legacy: Journal['legacy'] = [];
    for (const year of record.years) {
      const userDir = join(this.o.addinsRoot, String(year));
      for (const name of await this.listAddins(userDir)) {
        const path = join(userDir, name),
          own = key(name) === key(`${code}.addin`),
          bytes = await readSmall(path);
        if (
          own &&
          bytes &&
          known.some((r) =>
            r?.addins.some((a) => a.year === year && a.xml === bytes.toString('utf8')),
          )
        )
          continue;
        const entries = bytes ? softAddinEntries(bytes) : [];
        const matching = own ? entries : entries.filter((e) => ids.has(e.addInId));
        if (!own && !matching.length) continue;
        const assemblies = matching.map((e) => e.assembly);
        if (!assemblies.length || assemblies.some((a) => !a))
          fail('addin_conflict', displayName(name));
        let ours = own;
        for (const raw of assemblies as string[]) {
          // В .addin путь записан по-windowsовски; на других системах (CI) «\» — не разделитель.
          const assembly = raw.replace(/[\\/]/g, sep),
            target = isAbsolute(assembly) ? resolve(assembly) : resolve(userDir, assembly),
            inside = relative(resolve(this.o.root), target);
          if (!inside || inside.startsWith('..') || isAbsolute(inside)) ours = false;
          let hash: { sha256: string };
          try {
            hash = await hashFile(target, 200 * 1024 * 1024);
          } catch {
            return fail('addin_conflict', displayName(name));
          }
          if (!(await this.o.trusted(target, hash.sha256)))
            fail('addin_conflict', displayName(name));
        }
        // Наш же .addin, записанный для другого входа, просто заменяется.
        if (own && ours) continue;
        legacy.push({
          source: path,
          backup: join(this.o.root, code, 'legacy', `${year}-${randomUUID().slice(0, 8)}-${name}`),
        });
      }
      if (this.o.machineAddinsRoot) {
        const machineDir = join(this.o.machineAddinsRoot, String(year));
        for (const name of await this.listAddins(machineDir)) {
          const bytes = await readSmall(join(machineDir, name));
          if (bytes && softAddinEntries(bytes).some((e) => ids.has(e.addInId)))
            fail('addin_conflict_machine', displayName(name));
        }
      }
    }
    return legacy;
  }

  // ── применение ─────────────────────────────────────────────────────────
  private async revitIdle(): Promise<boolean> {
    try {
      return (await this.o.revit()) === 'idle';
    } catch {
      return false;
    }
  }
  /**
   * Перенести подготовленную версию и записать .addin. Revit работает — 'waiting'
   * (ничего вне staging не изменено). После записи журнала операция не зависит
   * ни от сети, ни от событий сокета: прерванную доведёт recover().
   */
  commit(prepared: PreparedPlugin): Promise<'complete' | 'waiting'> {
    return this.exclusive(async () => {
      if (await this.readJournal()) fail('journal_pending');
      if (!(await this.revitIdle())) return 'waiting';
      const { scope, code, record } = prepared,
        state = await this.readState(scope),
        before = state.plugins.find((p) => p.code === code) ?? null;
      const legacy = await this.conflicts(code, record, [
        before?.current ?? null,
        before?.previous ?? null,
      ]);
      const versionDir = this.versionDir(code, record.version);
      await mkdir(dirname(versionDir), { recursive: true });
      await nodePathSafe(dirname(versionDir));
      let exists = false;
      try {
        exists = (await lstat(versionDir)).isDirectory();
      } catch (e) {
        if (!missing(e)) throw e;
      }
      const sameVersion = before?.current.version === record.version;
      const journal: Journal = {
        v: 1,
        id: randomUUID(),
        scope,
        kind: 'install',
        code,
        phase: 'move',
        result: {
          code,
          current: record,
          previous: sameVersion ? (before?.previous ?? null) : (before?.current ?? null),
          held: null,
        },
        before,
        aside: exists ? join(this.stagingRoot, `aside-${randomUUID()}`) : null,
        legacy,
      };
      await this.writeJournal(journal);
      if (journal.aside) await rename(versionDir, journal.aside);
      await rename(prepared.archive.contentRoot, versionDir);
      // Revit появился, пока переносили папку: .addin ещё не тронут — откатываем.
      if (!(await this.revitIdle())) {
        await this.undoMove(journal);
        await unlink(this.journalPath);
        return 'waiting';
      }
      journal.phase = 'addin';
      await this.writeJournal(journal);
      await this.finish(journal);
      await this.discard(prepared);
      return 'complete';
    });
  }
  /**
   * Откат переноса. Прежняя папка той же версии отодвигается в aside до переноса новой,
   * поэтому: aside есть — в папке версии новое содержимое (убрать) и aside вернуть;
   * aside запланирован, но его нет — прежняя папка не трогалась и остаётся.
   */
  private async undoMove(journal: Journal): Promise<void> {
    const versionDir = this.versionDir(journal.code, journal.result.current.version);
    const asideExists = !!journal.aside && !!(await lstat(journal.aside).catch(() => null));
    if (journal.aside && !asideExists) return;
    try {
      await removeTree(versionDir);
    } catch (e) {
      if (!missing(e)) throw e;
    }
    if (journal.aside) await rename(journal.aside, versionDir);
  }
  /** Довести операцию после записи журнала. Каждый шаг можно безопасно повторить. */
  private async finish(journal: Journal): Promise<void> {
    for (const item of journal.legacy) {
      if (!(await lstat(item.source).catch(() => null))) continue;
      await mkdir(dirname(item.backup), { recursive: true });
      // Roaming может лежать на другом томе: копия и удаление вместо переименования.
      await copyFile(item.source, item.backup);
      await unlink(item.source);
    }
    const next = journal.result.current;
    for (const addin of next.addins) {
      const target = this.addinPath(journal.code, addin.year);
      await mkdir(dirname(target), { recursive: true });
      await nodePathSafe(dirname(target));
      await writeAtomic(target, addin.xml);
    }
    // Годы, где наш .addin больше не нужен (новая сборка не для этой версии Revit или библиотека).
    for (const old of [journal.before?.current, journal.before?.previous])
      for (const addin of old?.addins ?? [])
        if (!next.addins.some((a) => a.year === addin.year)) {
          const target = this.addinPath(journal.code, addin.year),
            bytes = await readSmall(target);
          if (bytes?.toString('utf8') === addin.xml) await unlink(target);
        }
    const state = await this.readState(journal.scope);
    state.plugins = [...state.plugins.filter((p) => p.code !== journal.code), journal.result];
    await this.writeState(journal.scope, state);
    await unlink(this.journalPath);
    if (journal.aside) await removeTree(journal.aside).catch(() => {});
    await this.cleanupVersions(journal.code).catch(() => {});
  }

  /** После сбоя или перезапуска: довести (journal на шаге .addin) или откатить (перенос). */
  recover(): Promise<'none' | 'complete' | 'rolled_back' | 'waiting'> {
    return this.exclusive(async () => {
      const journal = await this.readJournal();
      if (!journal) return 'none';
      if (!(await this.revitIdle())) return 'waiting';
      if (journal.phase === 'move') {
        await this.undoMove(journal);
        await unlink(this.journalPath);
        await this.cleanupStagingNow();
        return 'rolled_back';
      }
      await this.finish(journal);
      await this.cleanupStagingNow();
      return 'complete';
    });
  }

  /** «Вернуть»: .addin переключается на предыдущую версию из папки, сервер не нужен. */
  rollback(
    scope: string,
    code: string,
    deselected?: readonly string[],
  ): Promise<'complete' | 'waiting'> {
    return this.exclusive(async () => {
      if (await this.readJournal()) fail('journal_pending');
      const record = (await this.readState(scope)).plugins.find((p) => p.code === code);
      if (!record?.previous) return fail('rollback_unavailable');
      if (!(await this.versionIntact(code, record.previous))) fail('rollback_unavailable');
      if (!(await this.revitIdle())) return 'waiting';
      // Набор возвращается с нынешним выбором компонентов.
      const target = deselected ? withSelection(record.previous, deselected) : record.previous;
      const legacy = await this.conflicts(code, target, [record.current, record.previous]);
      const journal: Journal = {
        v: 1,
        id: randomUUID(),
        scope,
        kind: 'rollback',
        code,
        phase: 'addin',
        result: {
          code,
          current: target,
          previous: record.current,
          held: { buildId: record.current.buildId, archiveSha256: record.current.archiveSha256 },
        },
        before: record,
        aside: null,
        legacy,
      };
      await this.writeJournal(journal);
      await this.finish(journal);
      return 'complete';
    });
  }
  /**
   * «Переустановить» без сервера, если файлы версии целы (пользователь или антивирус
   * убрал .addin). Файлы повреждены — 'download': нужна загрузка из каталога.
   */
  repair(scope: string, code: string): Promise<'complete' | 'waiting' | 'download'> {
    return this.exclusive(async () => {
      if (await this.readJournal()) fail('journal_pending');
      const record = (await this.readState(scope)).plugins.find((p) => p.code === code);
      if (!record || !(await this.versionIntact(code, record.current))) return 'download';
      if (!(await this.revitIdle())) return 'waiting';
      const legacy = await this.conflicts(code, record.current, [record.current, record.previous]);
      const journal: Journal = {
        v: 1,
        id: randomUUID(),
        scope,
        kind: 'install',
        code,
        phase: 'addin',
        result: record,
        before: record,
        aside: null,
        legacy,
      };
      await this.writeJournal(journal);
      await this.finish(journal);
      return 'complete';
    });
  }

  /**
   * Смена состава набора без загрузки: свой .addin перезаписывается только с выбранными
   * компонентами из уже установленной папки версии. Revit подхватит после перезапуска,
   * поэтому открытый Revit не мешает. 'unchanged' — выбор уже такой.
   */
  select(
    scope: string,
    code: string,
    deselected: readonly string[],
  ): Promise<'complete' | 'unchanged'> {
    return this.exclusive(async () => {
      if (await this.readJournal()) fail('journal_pending');
      const record = (await this.readState(scope)).plugins.find((p) => p.code === code);
      if (!record?.current.components || !record.current.parts)
        return fail('selection_unavailable');
      if (!(await this.versionIntact(code, record.current))) return fail('selection_unavailable');
      const next = withSelection(record.current, deselected);
      if (
        JSON.stringify(next.selected) === JSON.stringify(record.current.selected) &&
        (await this.addinsIntact(code, record.current))
      )
        return 'unchanged';
      const journal: Journal = {
        v: 1,
        id: randomUUID(),
        scope,
        kind: 'install',
        code,
        phase: 'addin',
        result: { ...record, current: next },
        before: record,
        aside: null,
        legacy: [],
      };
      await this.writeJournal(journal);
      await this.finish(journal);
      return 'complete';
    });
  }

  // ── уборка ─────────────────────────────────────────────────────────────
  /** Хранятся текущая и одна предыдущая версия; нужные другим входам — тоже. */
  private async cleanupVersions(code: string): Promise<void> {
    const keep = new Set<string>();
    const stateDir = join(this.o.root, 'state');
    let names: string[] = [];
    try {
      names = (await readdir(stateDir)).filter((n) => /^[a-f0-9]{32}\.json$/.test(n));
    } catch (e) {
      if (!missing(e)) throw e;
    }
    for (const name of names) {
      const state = await this.readState(name.slice(0, 32));
      for (const p of state.plugins.filter((p) => p.code === code))
        for (const r of [p.current, p.previous]) if (r) keep.add(r.version);
    }
    const pluginDir = join(this.o.root, code);
    for (const entry of await readdir(pluginDir, { withFileTypes: true }).catch(() => []))
      if (entry.isDirectory() && pluginVersion(entry.name) && !keep.has(entry.name))
        await removeTree(join(pluginDir, entry.name)).catch(() => {});
  }
  private async cleanupStagingNow(): Promise<void> {
    if (await this.readJournal()) return;
    await nodePathSafe(this.o.root);
    for (const entry of await readdir(this.stagingRoot).catch(() => []))
      await removeTree(join(this.stagingRoot, entry)).catch(() => {});
  }
  /** При запуске и после операции: временные папки не копятся. */
  cleanupStaging(): Promise<void> {
    return this.exclusive(() => this.cleanupStagingNow());
  }
  /** Убрать версии, которые больше не нужны ни одному входу. */
  cleanup(): Promise<void> {
    return this.exclusive(async () => {
      if (await this.readJournal()) return;
      for (const entry of await readdir(this.o.root, { withFileTypes: true }).catch(() => []))
        if (entry.isDirectory() && pluginCode(entry.name) && !RESERVED.has(entry.name))
          await this.cleanupVersions(entry.name).catch(() => {});
    });
  }
  /** Код области для пары «сервер + пользователь». */
  static scope(serverOrigin: string, ownerId: number): string {
    return createHash('sha256').update(`${serverOrigin}\n${ownerId}`).digest('hex').slice(0, 32);
  }
}
