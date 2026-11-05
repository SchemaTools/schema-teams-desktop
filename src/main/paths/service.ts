import { shell } from 'electron';
type DesktopOpenPathResult = 'ok' | 'unavailable' | 'blocked';
import type { Logger } from '../logger';
import { validateUncPath, pathNeedsReveal, uncHost } from './validate';
import { PathProbe, type PathKind } from './probe';
import { PathDialog, confirmForeignHost } from './dialog';

interface Options {
  log: Pick<Logger, 'info'>;
  probe?: Pick<PathProbe, 'inspect' | 'cancelAll'>;
  dialog?: Pick<PathDialog, 'show' | 'close' | 'destroy'>;
  shell?: Pick<typeof shell, 'openPath' | 'showItemInFolder'>;
  /** Сервер бюро или сервер Teams: к нему можно обращаться без вопроса. */
  trusted?: (host: string) => boolean;
  /** Вопрос «Это не сервер бюро…»; true — пользователь явно разрешил. */
  confirm?: (host: string) => Promise<boolean>;
}
export class PathService {
  private generation = 0;
  private destroyed = false;
  private readonly pending = new Map<string, Promise<DesktopOpenPathResult>>();
  private readonly probe: Pick<PathProbe, 'inspect' | 'cancelAll'>;
  private readonly dialog: Pick<PathDialog, 'show' | 'close' | 'destroy'>;
  private readonly shell: Pick<typeof shell, 'openPath' | 'showItemInFolder'>;
  private readonly trusted: (host: string) => boolean;
  private readonly confirm: (host: string) => Promise<boolean>;
  constructor(private readonly o: Options) {
    this.probe = o.probe ?? new PathProbe();
    this.dialog = o.dialog ?? new PathDialog();
    this.shell = o.shell ?? shell;
    // Без списка доверенным не считается никто: любой путь — только с подтверждением.
    this.trusted = o.trusted ?? (() => false);
    this.confirm = o.confirm ?? confirmForeignHost;
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
    const note: { reason?: string } = {};
    const request = this.perform(path, input.reveal, this.generation, note)
      .then((result) => {
        this.o.log.info('открытие пути', { path, result, ...note });
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
    note: { reason?: string },
  ): Promise<DesktopOpenPathResult> {
    const current = () => !this.destroyed && generation === this.generation;
    // До ответа пользователя к чужому хосту нет ни stat, ни Shell: любое обращение
    // по SMB уже отправило бы ему NTLM-ответ учётной записи сотрудника.
    const host = uncHost(path);
    if (!host) return 'blocked';
    if (!this.trusted(host)) {
      let allowed: boolean;
      try {
        allowed = (await this.confirm(host)) === true;
      } catch {
        allowed = false;
      }
      note.reason = allowed ? 'foreign-host-confirmed' : 'foreign-host-declined';
      if (!allowed || !current()) return 'blocked';
    }
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
