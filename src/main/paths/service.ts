import { shell } from 'electron';
type DesktopOpenPathResult = 'ok' | 'unavailable' | 'blocked';
import type { Logger } from '../logger';
import { validateUncPath, pathNeedsReveal } from './validate';
import { PathProbe, type PathKind } from './probe';
import { PathDialog } from './dialog';

interface Options {
  log: Pick<Logger, 'info'>;
  probe?: Pick<PathProbe, 'inspect' | 'cancelAll'>;
  dialog?: Pick<PathDialog, 'show' | 'close' | 'destroy'>;
  shell?: Pick<typeof shell, 'openPath' | 'showItemInFolder'>;
}
export class PathService {
  private generation = 0;
  private destroyed = false;
  private readonly pending = new Map<string, Promise<DesktopOpenPathResult>>();
  private readonly probe: Pick<PathProbe, 'inspect' | 'cancelAll'>;
  private readonly dialog: Pick<PathDialog, 'show' | 'close' | 'destroy'>;
  private readonly shell: Pick<typeof shell, 'openPath' | 'showItemInFolder'>;
  constructor(private readonly o: Options) {
    this.probe = o.probe ?? new PathProbe();
    this.dialog = o.dialog ?? new PathDialog();
    this.shell = o.shell ?? shell;
  }
  open(input: { path: string; reveal: boolean }): Promise<DesktopOpenPathResult> {
    const path = validateUncPath(input.path);
    if (!path || this.destroyed || typeof input.reveal !== 'boolean') {
      this.o.log.info('открытие пути', { result: 'blocked', reason: 'invalid-or-closed' });
      return Promise.resolve('blocked');
    }
    const key = `${path.toLowerCase()}\0${input.reveal}`;
    const previous = this.pending.get(key);
    if (previous) return previous;
    const request = this.perform(path, input.reveal, this.generation)
      .then((result) => {
        this.o.log.info('открытие пути', { path, result });
        return result;
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }
  private async perform(
    path: string,
    reveal: boolean,
    generation: number,
  ): Promise<DesktopOpenPathResult> {
    const current = () => !this.destroyed && generation === this.generation;
    let kind: PathKind | null;
    try {
      kind = await this.probe.inspect(path);
    } catch {
      kind = null;
    }
    if (!current()) return 'blocked';
    if (!kind) {
      this.dialog.show(path);
      return 'unavailable';
    }
    try {
      if (reveal || pathNeedsReveal(path, kind)) {
        this.shell.showItemInFolder(path);
        return reveal ? 'ok' : 'blocked';
      }
      const error = await this.shell.openPath(path);
      if (!current()) return 'blocked';
      if (!error) return 'ok';
    } catch {
      /* Только результат; сырой текст OS-ошибки не попадает в журнал/страницу. */
    }
    if (current()) this.dialog.show(path);
    return 'unavailable';
  }
  reset(): void {
    this.generation++;
    this.probe.cancelAll();
    this.pending.clear();
    this.dialog.close();
  }
  destroy(): void {
    this.destroyed = true;
    this.reset();
    this.dialog.destroy();
  }
}
