import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { app } from 'electron';
export type RevitProcessState = 'idle' | 'busy' | 'unknown';
async function query(args: string[]): Promise<unknown> {
  if (platform() !== 'win32') return null;
  const base = app.isPackaged ? `${app.getAppPath()}.unpacked` : app.getAppPath();
  return new Promise((resolve) => {
    try {
      execFile(
        join(base, 'dist/native/plugin-safety.exe'),
        args,
        { shell: false, windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 65536 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          try {
            const text = stdout.trim(),
              v: unknown = JSON.parse(text);
            resolve(JSON.stringify(v) === text ? v : null);
          } catch {
            resolve(null);
          }
        },
      );
    } catch {
      resolve(null);
    }
  });
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export async function readRevitProcesses(): Promise<RevitProcessState> {
  const r = await query(['processes']);
  if (
    !object(r) ||
    r.v !== 1 ||
    Object.keys(r).sort().join(',') !== 'pids,state,v' ||
    !Array.isArray(r.pids) ||
    r.pids.length > 4096 ||
    !r.pids.every((p) => typeof p === 'number' && Number.isSafeInteger(p) && p > 0) ||
    new Set(r.pids).size !== r.pids.length
  )
    return 'unknown';
  if (r.state === 'idle' && r.pids.length === 0) return 'idle';
  if (r.state === 'busy' && r.pids.length > 0) return 'busy';
  return 'unknown';
}
export async function windowsPathSafe(path: string): Promise<boolean> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 32760 || path.includes('\0'))
    return false;
  const r = await query(['path', path]);
  return (
    object(r) && Object.keys(r).sort().join(',') === 'state,v' && r.v === 1 && r.state === 'safe'
  );
}
