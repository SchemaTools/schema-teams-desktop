import type { ApiResult } from '../../shared/client';
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
}
export class UpdateChecker {
  private value: UpdateState;
  private flight?: Promise<UpdateState>;
  private bootTimer?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  constructor(private readonly o: Options) {
    this.value = initialUpdateState(o.enabled);
  }
  get state(): UpdateState {
    return { ...this.value, available: this.value.available ? { ...this.value.available } : null };
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
    this.value = { ...this.value, status: 'checking', error: null };
    this.emit();
    const flight = this.read().finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    this.flight = flight;
    return flight;
  }
  private async read(): Promise<UpdateState> {
    try {
      let result = await this.o.read();
      if (!this.destroyed && !result.ok && result.code === 'stale_session')
        result = await this.o.read();
      if (this.destroyed) return this.state;
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
          checkedAt: Date.now(),
          error: null,
        };
      } else {
        const comparison = compareVersions(result.data.version, this.o.currentVersion);
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
            available:
              comparison > 0
                ? { version: result.data.version, notes: result.data.notes, size: result.data.size }
                : null,
            checkedAt: Date.now(),
            error: null,
          };
      }
    } catch {
      if (!this.destroyed)
        this.value = {
          ...this.value,
          status: 'error',
          error: 'Не удалось проверить обновления. Повторите позже.',
        };
    }
    if (!this.destroyed) this.emit();
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
  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.bootTimer);
    clearInterval(this.timer);
  }
}
