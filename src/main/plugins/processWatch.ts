import type { RevitProcessState } from './safety';
/** Demand-only guard for one install/recovery job. A busy/unknown observation latches until explicit restart. */
export class PluginProcessWatch {
  private readonly readProcess: () => Promise<RevitProcessState>;
  private readonly current: () => boolean;
  private generation = 0;
  private active = false;
  private timer?: NodeJS.Timeout;
  private flight?: Promise<RevitProcessState>;
  private unsafe: RevitProcessState = 'idle';
  constructor(o: {
    read: () => Promise<RevitProcessState>;
    current: () => boolean;
    intervalMs?: number;
  }) {
    this.readProcess = o.read;
    this.current = o.current;
    this.interval = Math.max(250, Math.min(5000, o.intervalMs ?? 500));
  }
  private readonly interval: number;
  async start(): Promise<RevitProcessState> {
    this.stop();
    this.active = true;
    this.unsafe = 'idle';
    return this.read();
  }
  read(): Promise<RevitProcessState> {
    if (!this.active || !this.current()) return Promise.resolve('unknown');
    if (this.unsafe !== 'idle') return Promise.resolve(this.unsafe);
    if (this.flight) return this.flight;
    const generation = this.generation;
    const flight = (async () => {
      let state: RevitProcessState = 'unknown';
      try {
        const value = await this.readProcess();
        if (value === 'idle' || value === 'busy') state = value;
      } catch {
        /* Unknown prevents any continuation. */
      }
      if (!this.active || generation !== this.generation || !this.current())
        return 'unknown' as const;
      if (state !== 'idle') this.unsafe = state;
      return state;
    })().finally(() => {
      if (this.flight === flight) {
        this.flight = undefined;
        if (this.active && generation === this.generation && this.current()) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            void this.read();
          }, this.interval);
        }
      }
    });
    this.flight = flight;
    return flight;
  }
  stop(): void {
    this.active = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.flight = undefined;
  }
}
