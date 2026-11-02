import type { ApiResult } from '../../shared/client';
import { desktopRelease } from '../api/updates';
import {
  compareVersions,
  initialUpdateState,
  type DesktopRelease,
  type UpdateState,
} from '../../shared/updates';
export const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
interface Options {
  enabled: boolean;
  currentVersion: string;
  read: () => Promise<ApiResult<DesktopRelease | null>>;
  onChange: (state: UpdateState) => void;
  /** Main-only full metadata. Never added to the public UpdateState. */
  onOffer?: (release: Readonly<DesktopRelease> | null, lifetime: string) => void;
  lifetime?: () => string;
}
export class UpdateChecker {
  private value: UpdateState;
  private flight?: Promise<UpdateState>;
  private bootTimer?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private generation = 0;
  private readonly o: Readonly<Options>;
  constructor(o: Options) {
    this.o = Object.freeze({ ...o });
    this.value = initialUpdateState(o.enabled);
  }
  get state(): UpdateState {
    return {
      ...this.value,
      available: this.value.available ? { ...this.value.available } : null,
      published: this.value.published ? { ...this.value.published } : null,
    };
  }
  start(): void {
    if (this.destroyed || this.timer || !this.o.enabled) return;
    this.bootTimer = setTimeout(() => void this.check(), 0);
    this.timer = setInterval(() => void this.check(), UPDATE_INTERVAL);
  }
  check(): Promise<UpdateState> {
    clearTimeout(this.bootTimer);
    if (this.destroyed || !this.o.enabled) return Promise.resolve(this.state);
    if (this.flight) return this.flight;
    const lifetime = this.o.lifetime?.() ?? '',
      generation = this.generation;
    this.o.onOffer?.(null, lifetime);
    this.value = { ...this.value, status: 'checking', error: null };
    this.emit();
    const flight = this.read(lifetime, generation).finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    this.flight = flight;
    return flight;
  }
  private current(lifetime: string, generation: number): boolean {
    return (
      !this.destroyed && generation === this.generation && lifetime === (this.o.lifetime?.() ?? '')
    );
  }
  private async read(lifetime: string, generation: number): Promise<UpdateState> {
    try {
      let result = await this.o.read();
      if (this.current(lifetime, generation) && !result.ok && result.code === 'stale_session')
        result = await this.o.read();
      if (!this.current(lifetime, generation)) return this.state;
      if (!result.ok) {
        this.value = {
          ...this.value,
          status: 'error',
          error: ['invalid_data', 'payload_too_large'].includes(result.code)
            ? 'Сведения об обновлении не прошли проверку.'
            : 'Не удалось проверить обновления. Повторите после восстановления связи.',
        };
      } else if (result.data === null) {
        this.value = {
          ...this.value,
          status: 'unpublished',
          available: null,
          published: null,
          checkedAt: Date.now(),
          error: null,
        };
      } else {
        const release = desktopRelease(result.data);
        const comparison = compareVersions(release.version, this.o.currentVersion);
        if (comparison === null)
          this.value = {
            ...this.value,
            status: 'error',
            error: 'Не удалось сравнить версии приложения.',
          };
        else
          this.value = {
            ...this.value,
            status: comparison > 0 ? 'available' : 'current',
            published: {
              version: release.version,
              notes: release.notes,
              size: release.size,
            },
            available:
              comparison > 0
                ? { version: release.version, notes: release.notes, size: release.size }
                : null,
            checkedAt: Date.now(),
            error: null,
          };
        if (comparison === 1) this.o.onOffer?.(Object.freeze(release), lifetime);
      }
    } catch {
      if (this.current(lifetime, generation))
        this.value = {
          ...this.value,
          status: 'error',
          error: 'Не удалось проверить обновления. Повторите позже.',
        };
    }
    if (this.current(lifetime, generation)) this.emit();
    return this.state;
  }
  later(version: string): boolean {
    if (this.destroyed || this.value.available?.version !== version) return false;
    this.value = { ...this.value, dismissedVersion: version };
    this.emit();
    return true;
  }
  private emit(): void {
    this.o.onChange(this.state);
  }
  /** A context change may start a new read without waiting for a stale flight. */
  reset(preserveDisplay = false): void {
    if (this.destroyed) return;
    this.generation++;
    this.flight = undefined;
    this.value = preserveDisplay
      ? {
          ...this.value,
          status:
            this.value.status !== 'checking'
              ? this.value.status
              : this.value.available
                ? 'available'
                : this.value.published
                  ? 'current'
                  : this.o.enabled
                    ? 'idle'
                    : 'unconfigured',
        }
      : initialUpdateState(this.o.enabled);
    this.o.onOffer?.(null, this.o.lifetime?.() ?? '');
    this.emit();
  }
  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.bootTimer);
    clearInterval(this.timer);
    this.o.onOffer?.(null, this.o.lifetime?.() ?? '');
  }
}
