export const PLUGIN_MAX_BYTES = 200 * 1024 * 1024;
export interface PluginBuild {
  id: number;
  version: string;
  verified: boolean;
  revit: number[];
  notes: string;
  size: number;
  sha256: string;
  url: string;
  publishedAt: string;
  requires: { plugin: string; minVersion: string }[];
}
export interface PluginEntry {
  code: string;
  name: string;
  short: string;
  stable: PluginBuild | null;
  beta: PluginBuild | null;
}
export interface PluginCatalog {
  tester: boolean;
  plugins: PluginEntry[];
}
export interface PluginsState {
  status: 'unavailable' | 'loading' | 'ready' | 'error';
  catalog: PluginCatalog | null;
  error: string | null;
  checkedAt: number | null;
  beta: boolean;
  autoUpdate: boolean;
}
export const PLUGIN_INSTALL_BLOCKED = 'Установка недоступна: доверенный издатель не настроен.';
export const pluginCode = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(v);
export const pluginVersion = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{1,4}\.\d{1,4}(?:\.\d{1,6})?$/.test(v);
export function comparePluginVersions(a: string, b: string): number {
  if (!pluginVersion(a) || !pluginVersion(b)) throw Error('invalid_version');
  const aa = a.split('.').map(Number),
    bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
