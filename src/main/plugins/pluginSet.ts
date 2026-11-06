/**
 * Набор плагинов одним пакетом (решение руководителя 06.11): в реестре Teams один плагин
 * `schema-plugins`, в корне архива — `schema-plugins.json` со списком компонентов:
 *
 *   { "format": 1, "code": "schema-plugins", "version": "1.48",
 *     "components": [ { "id": "floorplans", "title": "Планы этажей", "addin": "SchemaFloorPlans.addin",
 *                       "fixed": false }, … ] }
 *
 * Компонент — файл `.addin` в папке года (`2025/<addin>`, `2026/<addin>`); выбор состава
 * галочками решает, какие записи AddIn попадут в итоговый `.addin` набора.
 *
 * Формат 2 (решение руководителя 06.11 «одинаковое один раз»): одинаковые файлы лежат в
 * архиве один раз — `_shared/<sha256>.<ext>`, а `links` говорит, по каким путям пакета
 * разложить их копии: `{ "2025/SchemaFloorPlans/Schema.Tools.dll": "_shared/<sha256>.dll" }`.
 * В папку версии `_shared` не попадает — там то же дерево, что и у пакета без ссылок.
 */
import { pluginEntryKind, type ExtractedPluginFile } from './archive';
import { safeArchiveRelativePath } from './archivePaths';
export const PLUGIN_SET_CODE = 'schema-plugins';
export const PLUGIN_SET_MANIFEST = 'schema-plugins.json';
export const PLUGIN_SET_MANIFEST_MAX_BYTES = 256 * 1024;
export const PLUGIN_SET_MAX_COMPONENTS = 200;

export interface PluginSetComponent {
  id: string;
  title: string;
  /** Имя файла .addin в папке года (без папок). */
  addin: string;
  /** Без снятия галочки (например, «О наборе»). */
  fixed: boolean;
}
export interface PluginSetManifest {
  format: 1 | 2;
  code: string;
  version: string;
  components: PluginSetComponent[];
  /** Формат 2: путь в пакете → `_shared/<sha256>.<ext>`. У формата 1 — пусто. */
  links: Record<string, string>;
}
export const PLUGIN_SET_SHARED = '_shared';
export const PLUGIN_SET_MAX_LINKS = 4096;
const BLOB = /^_shared\/([0-9a-f]{64})\.([a-z0-9]{1,12})$/;

export const componentId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v);
export const componentTitle = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= 120 &&
  !/[\p{Cc}\p{Cf}]/u.test(v) &&
  v === v.normalize('NFC');
const addinName = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.addin$/i.test(v) && !v.includes('..');

/** Строгий разбор манифеста набора. Любое отступление — отказ (архив собирает бюро). */
export function parsePluginSetManifest(
  bytes: Buffer,
  expected: { code: string; version: string },
): PluginSetManifest {
  if (bytes.length > PLUGIN_SET_MANIFEST_MAX_BYTES) throw Error('manifest_size');
  let text: string;
  try {
    const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
  } catch {
    throw Error('manifest_encoding');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw Error('manifest_json');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('manifest_shape');
  const m = raw as Record<string, unknown>;
  if (m.format !== 1 && m.format !== 2) throw Error('manifest_format');
  const links: Record<string, string> = {};
  if (m.format === 1 && m.links !== undefined) throw Error('manifest_links');
  if (m.format === 2) {
    if (!m.links || typeof m.links !== 'object' || Array.isArray(m.links))
      throw Error('manifest_links');
    const entries = Object.entries(m.links as Record<string, unknown>);
    if (entries.length > PLUGIN_SET_MAX_LINKS) throw Error('manifest_links');
    const seen = new Set<string>();
    for (const [path, blob] of entries) {
      linkPathValid(path);
      if (typeof blob !== 'string') throw Error('manifest_link');
      const match = BLOB.exec(blob);
      if (!match || extension(path) !== match[2]) throw Error('manifest_link');
      if (seen.has(path.toLowerCase())) throw Error('manifest_link_duplicate');
      seen.add(path.toLowerCase());
      links[path] = blob;
    }
    const keys = [...seen];
    for (const a of keys)
      for (const b of keys) if (b.startsWith(`${a}/`)) throw Error('manifest_link_collision');
  }
  if (m.code !== expected.code) throw Error('manifest_code');
  if (m.version !== expected.version) throw Error('manifest_version');
  if (
    !Array.isArray(m.components) ||
    m.components.length < 1 ||
    m.components.length > PLUGIN_SET_MAX_COMPONENTS
  )
    throw Error('manifest_components');
  const components = m.components.map((item): PluginSetComponent => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('manifest_component');
    const c = item as Record<string, unknown>;
    if (
      !componentId(c.id) ||
      !componentTitle(c.title) ||
      !addinName(c.addin) ||
      (c.fixed !== undefined && typeof c.fixed !== 'boolean')
    )
      throw Error('manifest_component');
    return { id: c.id, title: c.title, addin: c.addin, fixed: c.fixed === true };
  });
  if (new Set(components.map((c) => c.id)).size !== components.length)
    throw Error('manifest_duplicate');
  if (new Set(components.map((c) => c.addin.toLowerCase())).size !== components.length)
    throw Error('manifest_duplicate');
  return {
    format: m.format,
    code: expected.code,
    version: expected.version,
    components,
    links,
  };
}
const extension = (path: string) => /\.([a-z0-9]{1,12})$/i.exec(path)?.[1]?.toLowerCase();
/** Путь ссылки — по правилам путей архива, внутри 2025/ или 2026/, не .addin. */
function linkPathValid(path: string): void {
  const kind = pluginEntryKind(path);
  const unicode = /[^\x20-\x7e]/.test(path);
  if (!/^20(25|26)\//.test(path) || !kind || kind === 'addin' || (unicode && kind !== 'data'))
    throw Error('manifest_link');
  try {
    if (safeArchiveRelativePath(path, false, unicode) !== path) throw Error('manifest_link');
  } catch {
    throw Error('manifest_link');
  }
}

export interface PlannedLink {
  path: string;
  blob: string;
  size: number;
  sha256: string;
  kind: ExtractedPluginFile['kind'];
}
/**
 * Сверка ссылок с распакованным архивом: каждый файл в _shared назван своим SHA-256,
 * ссылки ведут на существующие blob-файлы и не пересекаются с файлами архива.
 */
export function planPluginSetLinks(
  manifest: PluginSetManifest,
  files: readonly ExtractedPluginFile[],
): PlannedLink[] {
  const shared = files.filter((f) => f.relativePath.startsWith(`${PLUGIN_SET_SHARED}/`));
  if (manifest.format === 1) return [];
  const blobs = new Map<string, ExtractedPluginFile>();
  for (const f of shared) {
    const match = BLOB.exec(f.relativePath);
    if (!match || match[1] !== f.sha256) throw Error('links_blob');
    blobs.set(f.relativePath, f);
  }
  const real = files
    .filter((f) => !f.relativePath.startsWith(`${PLUGIN_SET_SHARED}/`))
    .map((f) => f.relativePath.toLowerCase());
  const realSet = new Set(real);
  const planned: PlannedLink[] = [];
  for (const [path, blob] of Object.entries(manifest.links)) {
    const file = blobs.get(blob);
    if (!file) throw Error('links_missing_blob');
    const key = path.toLowerCase();
    if (realSet.has(key) || real.some((r) => r.startsWith(`${key}/`) || key.startsWith(`${r}/`)))
      throw Error('links_collision');
    const kind = pluginEntryKind(path);
    if (!kind || kind === 'addin' || kind !== file.kind) throw Error('links_kind');
    planned.push({ path, blob, size: file.size, sha256: file.sha256, kind });
  }
  return planned;
}

/** Выбранные компоненты: обязательные — всегда; остальные — все, кроме снятых. */
export function selectedComponentIds(
  components: readonly { id: string; fixed: boolean }[],
  deselected: readonly string[],
): string[] {
  const off = new Set(deselected);
  return components.filter((c) => c.fixed || !off.has(c.id)).map((c) => c.id);
}

/** Снятые галочки из настроек: только допустимые коды, без повторов, с пределом. */
export function normalizeDeselected(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(componentId))].slice(0, PLUGIN_SET_MAX_COMPONENTS);
}
