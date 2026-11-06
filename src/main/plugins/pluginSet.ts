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
 */
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
  format: 1;
  code: string;
  version: string;
  components: PluginSetComponent[];
}

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
  if (m.format !== 1) throw Error('manifest_format');
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
  return { format: 1, code: expected.code, version: expected.version, components };
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
