import type { ApiResult } from '../../shared/client';
import type { PluginCatalog, PluginsState } from '../../shared/plugins';
interface Options {
  context: () => string | null;
  read: () => Promise<ApiResult<PluginCatalog>>;
  changed: () => void;
  now?: () => number;
}
/** One read in flight; push invalidation hides old metadata before the replacement read. */
export class PluginCatalogService {
  state: PluginsState = {
    status: 'unavailable',
    catalog: null,
    error: null,
    checkedAt: null,
    beta: false,
    autoUpdate: true,
  };
  private generation = 0;
  private scope: string | null = null;
  private flight?: Promise<void>;
  private again = false;
  private attempted = -Infinity;
  constructor(private readonly o: Options) {}
  reset(): void {
    this.generation++;
    this.scope = null;
    this.flight = undefined;
    this.again = false;
    this.attempted = -Infinity;
    this.state = {
      ...this.state,
      status: 'unavailable',
      catalog: null,
      error: null,
      checkedAt: null,
    };
  }
  invalidate(): void {
    this.generation++;
    this.state = { ...this.state, status: 'loading', catalog: null, checkedAt: null };
    this.attempted = -Infinity;
    this.o.changed();
    if (this.flight) this.again = true;
    else void this.refresh(true);
  }
  async refresh(force = false): Promise<void> {
    const scope = this.o.context();
    if (!scope) {
      if (this.scope !== null || this.state.status !== 'unavailable') {
        this.reset();
        this.o.changed();
      }
      return;
    }
    if (this.scope !== scope) {
      this.reset();
      this.scope = scope;
    }
    if (this.flight) return this.flight;
    const now = (this.o.now ?? Date.now)();
    if (!force && now - this.attempted < (this.state.status === 'ready' ? 6 * 3600000 : 60000))
      return;
    this.attempted = now;
    const generation = this.generation;
    this.state = { ...this.state, status: 'loading', error: null };
    this.o.changed();
    const flight = (async () => {
      try {
        const result = await this.o.read();
        if (generation !== this.generation || scope !== this.o.context()) return;
        this.state = result.ok
          ? {
              ...this.state,
              status: 'ready',
              catalog: result.data,
              error: null,
              checkedAt: (this.o.now ?? Date.now)(),
            }
          : { ...this.state, status: 'error', catalog: null, error: result.error, checkedAt: null };
        this.o.changed();
      } catch {
        if (generation === this.generation && scope === this.o.context()) {
          this.state = {
            ...this.state,
            status: 'error',
            catalog: null,
            error: 'Не удалось прочитать каталог плагинов.',
            checkedAt: null,
          };
          this.o.changed();
        }
      }
    })().finally(() => {
      if (this.flight === flight) {
        this.flight = undefined;
        if (this.again) {
          this.again = false;
          void this.refresh(true);
        }
      }
    });
    this.flight = flight;
    return flight;
  }
}
