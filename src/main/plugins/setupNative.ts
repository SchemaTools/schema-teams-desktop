import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import type { InnoUninstallInfo } from './legacyInno';

/**
 * Помощник native/PluginSetup.cs (только чтение): ключ удаления Inno и наличие сертификата
 * бюро в хранилищах пользователя. Вывод — каноничный JSON в ASCII; всё прочее — null.
 */
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function canonical(stdout: string): unknown {
  if (Buffer.byteLength(stdout, 'utf8') > 16384) return null;
  try {
    const text = stdout.trim(),
      v: unknown = JSON.parse(text);
    return JSON.stringify(v) === text ? v : null;
  } catch {
    return null;
  }
}
export function parseInnoInfo(stdout: string): InnoUninstallInfo | null {
  const r = canonical(stdout);
  if (!object(r) || r.v !== 1) return null;
  const keys = Object.keys(r).sort().join(',');
  if (keys === 'found,v' && r.found === false) return { found: false };
  if (
    keys === 'found,uninstallString,v' &&
    r.found === true &&
    (r.uninstallString === null ||
      (typeof r.uninstallString === 'string' && r.uninstallString.length <= 4096))
  )
    return { found: true, uninstallString: r.uninstallString };
  return null;
}
export function parseCertStores(
  stdout: string,
): { root: boolean; trustedPublisher: boolean } | null {
  const r = canonical(stdout);
  if (
    !object(r) ||
    r.v !== 1 ||
    Object.keys(r).sort().join(',') !== 'root,trustedPublisher,v' ||
    typeof r.root !== 'boolean' ||
    typeof r.trustedPublisher !== 'boolean'
  )
    return null;
  return { root: r.root, trustedPublisher: r.trustedPublisher };
}
function query(args: string[]): Promise<string | null> {
  if (platform() !== 'win32') return Promise.resolve(null);
  const base = app.isPackaged ? `${app.getAppPath()}.unpacked` : app.getAppPath();
  return new Promise((resolve) => {
    try {
      execFile(
        join(base, 'dist/native/plugin-setup.exe'),
        args,
        { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 16384 },
        (error, stdout) => resolve(error ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}
export async function readInnoUninstall(): Promise<InnoUninstallInfo | null> {
  const out = await query(['inno']);
  return out === null ? null : parseInnoInfo(out);
}
export async function readCertStores(
  sha256: string,
): Promise<{ root: boolean; trustedPublisher: boolean } | null> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
  const out = await query(['cert', sha256]);
  return out === null ? null : parseCertStores(out);
}
