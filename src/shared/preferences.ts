export type PreferencesTab = 'general' | 'notifications' | 'plugins' | 'time' | 'about';
export interface LocalPreferences {
  autostart: boolean;
  autostartAvailable: boolean;
  theme: 'system' | 'light' | 'dark';
  notifications: { enabled: boolean; sound: boolean; preview: boolean };
}
export interface PreferencesPatch {
  autostart?: boolean;
  theme?: LocalPreferences['theme'];
  notifications?: Partial<LocalPreferences['notifications']>;
}
export const preferenceTabs: PreferencesTab[] = [
  'general',
  'notifications',
  'plugins',
  'time',
  'about',
];
export function preferencesPatchValid(raw: unknown): raw is PreferencesPatch {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const x = raw as Record<string, unknown>,
    keys = Object.keys(x);
  if (!keys.length || keys.some((k) => !['autostart', 'theme', 'notifications'].includes(k)))
    return false;
  if ('autostart' in x && typeof x.autostart !== 'boolean') return false;
  if (
    'theme' in x &&
    (typeof x.theme !== 'string' || !['system', 'light', 'dark'].includes(x.theme))
  )
    return false;
  if ('notifications' in x) {
    if (
      typeof x.notifications !== 'object' ||
      x.notifications === null ||
      Array.isArray(x.notifications)
    )
      return false;
    const entries = Object.entries(x.notifications);
    if (
      !entries.length ||
      entries.some(
        ([key, value]) =>
          !['enabled', 'sound', 'preview'].includes(key) || typeof value !== 'boolean',
      )
    )
      return false;
  }
  return true;
}
