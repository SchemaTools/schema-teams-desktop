import { app, net } from 'electron';
import { localDataPath } from '../localData';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { rmdir } from 'node:fs/promises';
import { cleanupDesktopDownloads } from './downloadDesktop';
import {
  DesktopUpdateController,
  type DesktopUpdateContext,
  type DesktopQuiescence,
  type DesktopUpdateView,
  type DesktopUpdateFailure,
} from './updateController';
import { APPROVED_DESKTOP_PUBLISHER_DER_SHA256 } from './updateTrust';

interface Options {
  context: () => Pick<DesktopUpdateContext, 'stamp' | 'document' | 'serverOrigin'>;
  readLatest: (signal: AbortSignal) => Promise<unknown | null>;
  acquireQuiescence: () => DesktopQuiescence | null;
  onChange: (view: DesktopUpdateView) => void;
  onFailure?: (failure: Readonly<DesktopUpdateFailure>) => void;
}
/** The core calls this only after trust and explicit ACK. Resolving means spawn,
 * never installed. No command string, silent switch or inherited stdio.
 */
function handoff(ownedInstaller: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let spawned = false;
    const child = spawn(ownedInstaller, [], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', () => {
      if (!spawned) reject(Error('update_spawn_failed'));
    });
    child.once('spawn', () => {
      spawned = true;
      try {
        child.unref();
      } catch {
        /* Spawn already happened: never report a pre-spawn failure. */
      }
      resolve();
    });
  });
}
/** Папка загрузок обновлений — в %LOCALAPPDATA% (см. localDataPath), без переменной — в userData. */
export function desktopUpdatesRoot(
  env: NodeJS.ProcessEnv = process.env,
  userData = app.getPath('userData'),
): string {
  return localDataPath('desktop-updates', env, userData);
}
/** При запуске: старые загрузки в новой папке и в прежней (Roaming) удаляются. */
export async function cleanupDesktopUpdateStaging(): Promise<void> {
  const legacy = join(app.getPath('userData'), 'desktop-updates');
  await cleanupDesktopDownloads(desktopUpdatesRoot());
  if (legacy !== desktopUpdatesRoot()) {
    await cleanupDesktopDownloads(legacy);
    // Пустая прежняя папка больше не нужна; непустая (чужое содержимое) остаётся.
    await rmdir(legacy).catch(() => {});
  }
}
/** There are no trust/runner/path/arguments overrides from env, settings or IPC.
 * Only main supplies lifetime, the public latest read and the shutdown lease.
 */
export function createProductionDesktopUpdateController(options: Options): DesktopUpdateController {
  const { context, readLatest, acquireQuiescence, onChange, onFailure } = options;
  return new DesktopUpdateController({
    context: () => ({
      ...context(),
      executable: app.getPath('exe'),
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
      windows: process.platform === 'win32',
    }),
    publisherPins: () => APPROVED_DESKTOP_PUBLISHER_DER_SHA256,
    stagingRoot: desktopUpdatesRoot(),
    readLatest,
    acquireQuiescence,
    onChange,
    onFailure,
    fetch: (url, init) => net.fetch(url instanceof URL ? url.href : url, init),
    handoff,
    quit: () => app.quit(),
  });
}
