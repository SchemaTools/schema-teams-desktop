export interface ReleaseInfo {
  version: string;
  notes: string;
  size: number;
}
export interface DesktopRelease extends ReleaseInfo {
  file: string;
  sha256: string;
  url: string;
}
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'current' | 'unpublished' | 'error' | 'unconfigured';
  available: ReleaseInfo | null;
  published?: ReleaseInfo | null;
  checkedAt: number | null;
  error: string | null;
  dismissedVersion: string | null;
}
export const releaseVersionValid = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value);
export function compareVersions(a: string, b: string): number | null {
  if (!releaseVersionValid(a) || !releaseVersionValid(b)) return null;
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta > 0 ? 1 : -1;
  }
  return 0;
}
export const initialUpdateState = (enabled = true): UpdateState => ({
  status: enabled ? 'idle' : 'unconfigured',
  available: null,
  published: null,
  checkedAt: null,
  error: null,
  dismissedVersion: null,
});
