import type { PluginCatalog } from '../../shared/plugins';
import type { PluginPlan } from './planner';
export interface AutomaticPluginAdmission {
  currentId: string | null;
  safety: string;
}
/** Shared main-only binding. Display text never authorizes release identity. */
export function pluginPlanSafety(plans: readonly PluginPlan[], catalog: PluginCatalog): string {
  return JSON.stringify(
    plans.map((p) => ({
      year: p.year,
      builds: p.builds.map(({ code, build: b }) => ({
        code,
        channel:
          catalog.plugins.find((p) => p.code === code)?.beta?.id === b.id ? 'beta' : 'stable',
        id: b.id,
        version: b.version,
        verified: b.verified,
        sha256: b.sha256,
        size: b.size,
        url: b.url,
        revit: [...b.revit].sort(),
        requires: [...b.requires].sort((a, b) => a.plugin.localeCompare(b.plugin)),
      })),
    })),
  );
}
