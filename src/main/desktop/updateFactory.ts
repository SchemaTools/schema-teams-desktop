import { app, net } from 'electron';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  DesktopUpdateController,
  type DesktopUpdateContext,
  type DesktopQuiescence,
  type DesktopUpdateView,
} from './updateController';
import { APPROVED_DESKTOP_PUBLISHER_DER_SHA256 } from './updateTrust';

interface Options {
  context: () => Pick<DesktopUpdateContext, 'stamp' | 'document' | 'serverOrigin'>;
  readLatest: (signal: AbortSignal) => Promise<unknown | null>;
  acquireQuiescence: () => DesktopQuiescence | null;
  onChange: (view: DesktopUpdateView) => void;
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
/** There are no trust/runner/path/arguments overrides from env, settings or IPC.
 * Only main supplies lifetime, the public latest read and the shutdown lease.
 */
export function createProductionDesktopUpdateController(options: Options): DesktopUpdateController {
  const { context, readLatest, acquireQuiescence, onChange } = options;
  return new DesktopUpdateController({
    context: () => ({
      ...context(),
      executable: app.getPath('exe'),
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
      windows: process.platform === 'win32',
    }),
    publisherPins: () => APPROVED_DESKTOP_PUBLISHER_DER_SHA256,
    stagingRoot: join(app.getPath('userData'), 'desktop-updates'),
    readLatest,
    acquireQuiescence,
    onChange,
    fetch: (url, init) => net.fetch(url instanceof URL ? url.href : url, init),
    handoff,
    quit: () => app.quit(),
  });
}
