import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';

export type PathKind = 'file' | 'directory';
export const PATH_STAT_TIMEOUT_MS = 3000;
type Child = Pick<UtilityProcess, 'on' | 'postMessage' | 'kill'>;

export class PathProbe {
  private readonly pending = new Set<() => void>();
  private readonly children = new Set<Child>();
  constructor(
    private readonly createChild: () => Child = () =>
      utilityProcess.fork(join(__dirname, 'statWorker.js'), [], {
        stdio: 'ignore',
        serviceName: 'Schema Teams — проверка пути',
        partition: 'path-stat',
      }),
  ) {}

  inspect(path: string): Promise<PathKind | null> {
    // Зависший SMB-запрос не занимает общий пул fs главного процесса.
    if (this.children.size >= 2) return Promise.resolve(null);
    return new Promise((resolve) => {
      let child: Child | undefined;
      let settled = false;
      const terminate = () => {
        try {
          child?.kill();
        } catch {
          /* Ждём подтверждённый exit. */
        }
      };
      const finish = (kind: PathKind | null, kill = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(cancel);
        if (kill) terminate();
        resolve(kind);
      };
      const cancel = () => finish(null);
      const timer = setTimeout(cancel, PATH_STAT_TIMEOUT_MS);
      this.pending.add(cancel);
      try {
        child = this.createChild();
        const started = child;
        this.children.add(started);
        child.on('spawn', () => {
          if (settled) terminate();
        });
        child.on('message', (value: unknown) =>
          finish(value === 'file' || value === 'directory' ? value : null),
        );
        child.on('exit', () => {
          this.children.delete(started);
          finish(null, false);
        });
        child.on('error', cancel);
        child.postMessage({ path });
      } catch {
        cancel();
      }
    });
  }
  cancelAll(): void {
    const liveChildren = [...this.children];
    for (const cancel of [...this.pending]) cancel();
    for (const child of liveChildren) {
      if (this.children.has(child)) {
        try {
          child.kill();
        } catch {
          /* Слот не освобождаем до exit. */
        }
      }
    }
  }
}
