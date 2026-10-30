import { comparePluginVersions, type PluginCatalog, type PluginBuild } from '../../shared/plugins';
import { pluginCatalog } from '../api/plugins';
export interface PluginPlan {
  year: 2025 | 2026;
  builds: { code: string; build: PluginBuild }[];
}
export interface LocalPluginEvidence {
  plugin: string;
  version: string | null;
  years: number[];
}
/** Only current desktop catalog IDs are candidates. Unknown local versions never satisfy a dependency. */
export function planPlugins(
  catalog: PluginCatalog,
  code: string,
  year: 2025 | 2026,
  beta: boolean,
  local: readonly LocalPluginEvidence[] = [],
): PluginPlan {
  catalog = pluginCatalog(catalog);
  if (year !== 2025 && year !== 2026) throw Error('unsupported_revit');
  const visiting = new Set<string>(),
    chosen = new Map<string, PluginBuild>();
  const select = (name: string, min?: string) => {
    if (local.some((p) => p.plugin === name && p.years.includes(year) && p.version === null))
      throw Error('installed_version_unknown');
    if (visiting.has(name)) throw Error('dependency_cycle');
    const prior = chosen.get(name);
    if (prior) {
      if (min && comparePluginVersions(prior.version, min) < 0) throw Error('dependency_version');
      return;
    }
    const p = catalog.plugins.find((p) => p.code === name);
    if (!p) throw Error('dependency_missing');
    const candidates = [
      ...(beta && catalog.tester && p.beta ? [p.beta] : []),
      ...(p.stable ? [p.stable] : []),
    ].filter((b) => b.revit.includes(year) && (!min || comparePluginVersions(b.version, min) >= 0));
    const b = candidates[0];
    if (!b) throw Error('dependency_incompatible');
    visiting.add(name);
    for (const r of b.requires) select(r.plugin, r.minVersion);
    visiting.delete(name);
    chosen.set(name, structuredClone(b));
  };
  select(code);
  return { year, builds: [...chosen].map(([code, build]) => ({ code, build })) };
}
export function planPluginYears(
  catalog: PluginCatalog,
  code: string,
  years: readonly (2025 | 2026)[],
  beta: boolean,
  local: readonly LocalPluginEvidence[] = [],
): PluginPlan[] {
  if (years.length < 1 || years.length > 2 || new Set(years).size !== years.length)
    throw Error('unsupported_revit');
  return years.map((year) => planPlugins(catalog, code, year, beta, local));
}
