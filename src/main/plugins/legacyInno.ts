import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
import { nodePathSafe } from './fsSafe';

/**
 * Замена прежней установки плагинов (Inno «Schema Revit Plugins») при первой установке
 * набора — решение руководителя 06.11. Удалитель запускается только тот, путь которого из
 * ключа удаления указывает прямо в %LOCALAPPDATA%\SchemaRevitPlugins\ (защита от подмены
 * ключа), через execFile без shell. Отказ или ошибка установку не ломают: прежние .addin
 * перехватывает установщик (переносит в legacy), причина показывается в окне.
 */
export const INNO_APP_ID = '{151FB371-4F8E-49BE-8DDE-E90DCD5C3809}';
/** Ключ удаления (читает native/PluginSetup.cs). */
export const INNO_UNINSTALL_KEY = [
  'HKCU',
  'Software',
  'Microsoft',
  'Windows',
  'CurrentVersion',
  'Uninstall',
  `${INNO_APP_ID}_is1`,
].join('\\');
export const INNO_FOLDER = 'SchemaRevitPlugins';
export const INNO_SILENT_ARGS = Object.freeze(['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);

/** Ключ удаления: нет ключа, есть (со строкой удаления или без), или прочитать не удалось (null). */
export type InnoUninstallInfo = { found: false } | { found: true; uninstallString: string | null };
export type LegacyReason = 'legacy_failed' | 'legacy_path' | 'legacy_uninstall' | 'legacy_timeout';
export type LegacyResult =
  { outcome: 'absent' } | { outcome: 'removed' } | { outcome: 'failed'; reason: LegacyReason };

export interface LegacyInnoDeps {
  /** %LOCALAPPDATA% */
  localAppData: string;
  /** %APPDATA%\Schema\bureau.txt — сохранить копию и вернуть, если удалитель её тронул. */
  bureauFile: string;
  readUninstall(): Promise<InnoUninstallInfo | null>;
  /** Запуск удалителя без shell; код выхода. Исключение — не запустился. */
  run(exe: string, args: readonly string[]): Promise<number>;
  /** Файл существует, обычный, без ссылок и junction на пути. */
  fileOk?(path: string): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * Путь удалителя из UninstallString: в кавычках или без, только `unins###.exe` прямо в
 * %LOCALAPPDATA%\SchemaRevitPlugins. Иначе null — такой exe не запускается.
 */
export function innoUninstaller(uninstallString: string, localAppData: string): string | null {
  if (typeof uninstallString !== 'string' || uninstallString.length > 1024) return null;
  if (!win32.isAbsolute(localAppData) || localAppData.startsWith('\\\\')) return null;
  const text = uninstallString.trim();
  let path: string;
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    if (end < 0 || text.slice(end + 1).trim()) return null;
    path = text.slice(1, end);
  } else path = text;
  if (
    !path ||
    /["%<>|*?\0]/.test(path) ||
    /[\p{Cc}]/u.test(path) ||
    path.includes('/') ||
    path.startsWith('\\\\') ||
    !/^[A-Za-z]:\\/.test(path) ||
    path.split('\\').some((part) => part === '..' || part === '.')
  )
    return null;
  const normalized = win32.normalize(path);
  if (normalized.toLowerCase() !== path.toLowerCase()) return null;
  if (!/^unins\d{3}\.exe$/i.test(win32.basename(normalized))) return null;
  const folder = win32.join(win32.normalize(localAppData), INNO_FOLDER);
  if (win32.dirname(normalized).toLowerCase() !== folder.toLowerCase()) return null;
  return normalized;
}

async function defaultFileOk(path: string): Promise<boolean> {
  try {
    await nodePathSafe(path);
    const s = await lstat(path);
    return s.isFile() && !s.isSymbolicLink();
  } catch {
    return false;
  }
}
async function readBureau(path: string): Promise<Buffer | null> {
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.size > 64 * 1024) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

export async function replaceInnoInstall(deps: LegacyInnoDeps): Promise<LegacyResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    pollMs = deps.pollMs ?? 1000,
    timeoutMs = deps.timeoutMs ?? 120_000,
    fileOk = deps.fileOk ?? defaultFileOk;
  const info = await deps.readUninstall().catch(() => null);
  if (!info) return { outcome: 'failed', reason: 'legacy_failed' };
  if (!info.found) return { outcome: 'absent' };
  const exe = info.uninstallString
    ? innoUninstaller(info.uninstallString, deps.localAppData)
    : null;
  if (!exe || !(await fileOk(exe))) return { outcome: 'failed', reason: 'legacy_path' };
  const bureau = await readBureau(deps.bureauFile);
  try {
    let code: number;
    try {
      code = await deps.run(exe, INNO_SILENT_ARGS);
    } catch {
      return { outcome: 'failed', reason: 'legacy_uninstall' };
    }
    // Удалитель Inno перезапускает себя из временной папки — ждём исчезновения ключа.
    for (let waited = 0; ; waited += pollMs) {
      const after = await deps.readUninstall().catch(() => null);
      if (after && !after.found) return { outcome: 'removed' };
      if (code !== 0) return { outcome: 'failed', reason: 'legacy_uninstall' };
      if (waited >= timeoutMs) return { outcome: 'failed', reason: 'legacy_timeout' };
      await sleep(pollMs);
    }
  } finally {
    if (bureau) {
      const now = await readBureau(deps.bureauFile);
      if (!now || !now.equals(bureau)) {
        await mkdir(dirname(deps.bureauFile), { recursive: true }).catch(() => {});
        await writeFile(deps.bureauFile, bureau).catch(() => {});
      }
    }
  }
}
