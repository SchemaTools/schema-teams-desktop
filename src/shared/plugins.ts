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
  notifyInstalled?: boolean;
  workflow?: PluginWorkflowState;
  managed?: ManagedPluginsView;
}
/** Установленные плагины этого входа — по файлам на диске, без сервера. */
export interface InstalledPluginView {
  code: string;
  version: string;
  years: (2025 | 2026)[];
  /** disabled — .addin убран или изменён; damaged — файлы версии пропали или изменены. */
  status: 'ok' | 'disabled' | 'damaged';
  previous: string | null;
  rollbackAvailable: boolean;
  /** После «Вернуть» автообновление этой сборки остановлено. */
  held: boolean;
}
export interface ManagedPluginsView {
  /** Доверенный издатель настроен — ставить можно. */
  available: boolean;
  /** Доводится прерванная операция (ждёт закрытия Revit). */
  recovering: boolean;
  plugins: InstalledPluginView[];
}
export interface PluginWorkItem {
  code: string;
  name: string;
  version: string;
  from?: string;
  years: (2025 | 2026)[];
  kind: 'install' | 'rollback';
  phase: 'waiting' | 'downloading' | 'installing' | 'complete' | 'error';
  reason?: string;
  /** Только имя файла .addin или .dll — для понятной причины ошибки. */
  detail?: string;
}
export interface PluginWorkflowState {
  phase: 'idle' | 'waiting';
  active: boolean;
  /** Revit открыт в этом сеансе Windows при последней проверке. */
  revitOpen: boolean;
  pending: number;
  items: PluginWorkItem[];
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
