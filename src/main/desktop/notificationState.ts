import { app } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

// QUNS_ACCEPTS_NOTIFICATIONS. Не показываем UI при полноэкранном приложении,
// презентации, quiet time, отсутствии пользователя или неизвестном состоянии.
export const notificationStateAllowed = (state: number | null): boolean => state === 5;

export class WindowsNotificationPolicy {
  private cached?: { at: number; answer: Promise<boolean> };

  allows(): Promise<boolean> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < 1000) return this.cached.answer;
    const answer = this.query().then(notificationStateAllowed);
    this.cached = { at: now, answer };
    return answer;
  }

  private query(): Promise<number | null> {
    if (process.platform !== 'win32') return Promise.resolve(null);
    const root = app.isPackaged
      ? app.getAppPath().replace(/\.asar$/, '.asar.unpacked')
      : app.getAppPath();
    const executable = join(root, 'dist/native/notification-state.exe');
    return new Promise((resolve) => {
      execFile(
        executable,
        [],
        { shell: false, windowsHide: true, timeout: 1500, maxBuffer: 128 },
        (error, stdout) => {
          const state = Number(stdout.trim());
          resolve(!error && Number.isInteger(state) && state >= 1 && state <= 7 ? state : null);
        },
      );
    });
  }
}
