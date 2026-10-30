export interface AutostartBackend {
  isPackaged: boolean;
  setLoginItemSettings: (settings: { openAtLogin: boolean; args: string[] }) => void;
}
/** Isolated test profiles must never register their temporary EXE in Windows startup. */
export function autostartAvailable(backend: AutostartBackend, isolatedProfile?: string): boolean {
  return backend.isPackaged && !isolatedProfile;
}
export function applyAutostart(
  backend: AutostartBackend,
  enabled: boolean,
  isolatedProfile?: string,
): void {
  if (autostartAvailable(backend, isolatedProfile))
    backend.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}
