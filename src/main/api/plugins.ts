import {
  PLUGIN_MAX_BYTES,
  pluginCode,
  pluginVersion,
  type PluginCatalog,
  type PluginBuild,
} from '../../shared/plugins';
import { positiveId, utcInstant } from '../../shared/time';
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('invalid_plugins');
  return v as Record<string, unknown>;
};
const text = (v: unknown, max: number, empty = false): string => {
  if (
    typeof v !== 'string' ||
    v.length > max ||
    (!empty && !v.trim()) ||
    /[\p{Cc}\p{Cf}]/u.test(v.replace(/[\r\n\t]/g, ''))
  )
    throw Error('invalid_plugins');
  return v;
};
function build(v: unknown, stable: boolean): PluginBuild | null {
  if (v === null) return null;
  const b = obj(v);
  if (
    !positiveId(b.id) ||
    !pluginVersion(b.version) ||
    typeof b.verified !== 'boolean' ||
    (stable && !b.verified) ||
    !Array.isArray(b.revit) ||
    b.revit.length < 1 ||
    b.revit.length > 10 ||
    !b.revit.every((y) => Number.isInteger(y) && y >= 2019 && y <= 2099) ||
    new Set(b.revit).size !== b.revit.length ||
    !Number.isSafeInteger(b.size) ||
    Number(b.size) <= 0 ||
    Number(b.size) > PLUGIN_MAX_BYTES ||
    typeof b.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(b.sha256) ||
    b.url !== `/api/desktop/plugins/files/${b.id}` ||
    !utcInstant(b.publishedAt) ||
    !Array.isArray(b.requires) ||
    b.requires.length > 20
  )
    throw Error('invalid_plugins');
  const requires = b.requires.map((raw) => {
    const r = obj(raw);
    if (!pluginCode(r.plugin) || !pluginVersion(r.minVersion)) throw Error('invalid_plugins');
    return { plugin: r.plugin, minVersion: r.minVersion };
  });
  if (new Set(requires.map((r) => r.plugin)).size !== requires.length)
    throw Error('invalid_plugins');
  return {
    id: b.id,
    version: b.version,
    verified: b.verified,
    revit: [...b.revit],
    notes: text(b.notes, 10000, true),
    size: Number(b.size),
    sha256: b.sha256.toLowerCase(),
    url: b.url as string,
    publishedAt: b.publishedAt,
    requires,
  };
}
export function pluginCatalog(v: unknown): PluginCatalog {
  const c = obj(v);
  if (typeof c.tester !== 'boolean' || !Array.isArray(c.plugins) || c.plugins.length > 500)
    throw Error('invalid_plugins');
  const plugins = c.plugins.map((raw) => {
    const p = obj(raw);
    if (!pluginCode(p.code)) throw Error('invalid_plugins');
    const stable = build(p.stable, true),
      beta = build(p.beta, false);
    if (!c.tester && beta) throw Error('invalid_plugins');
    const short = text(p.short, 6);
    if ([...short].length < 2 || [...short].length > 3 || /\s/.test(short))
      throw Error('invalid_plugins');
    return { code: p.code, name: text(p.name, 80), short, stable, beta };
  });
  if (new Set(plugins.map((p) => p.code)).size !== plugins.length) throw Error('invalid_plugins');
  const ids = plugins.flatMap((p) => [p.stable?.id, p.beta?.id].filter(positiveId));
  if (new Set(ids).size !== ids.length) throw Error('invalid_plugins');
  return { tester: c.tester, plugins };
}
