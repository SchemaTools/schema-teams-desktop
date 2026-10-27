import { app } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
  parseNotificationState,
  notificationStateAllowed,
  type NotificationState,
} from './notificationPolicy';

export class WindowsNotificationPolicy {
  private pending?: Promise<boolean>;
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  allows(): Promise<boolean> {
    // Делим только выполняющийся запрос. Завершённое разрешение не кэшируем:
    // пользователь мог включить «Не беспокоить» сразу после прошлого события.
    if (this.pending) return this.pending;
    const answer = this.query()
      .then(notificationStateAllowed)
      .catch(() => false)
      .finally(() => {
        if (this.pending === answer) this.pending = undefined;
      });
    this.pending = answer;
    return answer;
  }

  private query(): Promise<NotificationState | null> {
    if (this.platform !== 'win32') return Promise.resolve(null);
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
          resolve(error ? null : parseNotificationState(stdout));
        },
      );
    });
  }
}
