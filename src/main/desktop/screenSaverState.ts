import { execFile } from 'node:child_process';
import { join } from 'node:path';

export type ScreenSaverState = 'running' | 'stopped' | 'unknown';
export interface ScreenSaverSample {
  state: ScreenSaverState;
  /** Completion-time monotonic observation, never an OS transition timestamp. */
  observedMono: number;
}
export interface ScreenSaverReader {
  read(): Promise<ScreenSaverSample>;
  invalidate(): void;
  dispose(): void;
}
export const SCREEN_SAVER_OPTIONS = {
  shell: false,
  windowsHide: true,
  timeout: 1500,
  maxBuffer: 128,
} as const;
export type ScreenSaverRunner = (
  executable: string,
  args: string[],
  options: typeof SCREEN_SAVER_OPTIONS,
  done: (error: Error | null, stdout: string | Buffer) => void,
) => { kill(): unknown };
export function parseScreenSaverState(text: string | Buffer): ScreenSaverState {
  if (Buffer.byteLength(text) > 128) return 'unknown';
  try {
    const compact = text.toString().trim();
    const value: unknown = JSON.parse(compact);
    // Our fixed helper emits compact JSON. Reject ambiguous duplicate keys and
    // alternate encodings instead of letting JSON.parse silently choose a winner.
    if (JSON.stringify(value) !== compact) return 'unknown';
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
    const v = value as Record<string, unknown>;
    return Object.keys(v).length === 2 &&
      v.v === 1 &&
      (v.state === 'running' || v.state === 'stopped' || v.state === 'unknown')
      ? v.state
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
interface Flight {
  generation: number;
  promise: Promise<ScreenSaverSample>;
  child?: { kill(): unknown };
  reject(error: Error): void;
}
/** Options are trusted main-process app metadata, never IPC or renderer input. */
export class WindowsScreenSaverReader implements ScreenSaverReader {
  private generation = 0;
  private disposed = false;
  private flight?: Flight;
  private readonly executable: string;
  constructor(
    private readonly app: { appPath: string; isPackaged: boolean; platform?: NodeJS.Platform },
    private readonly runner: ScreenSaverRunner = execFile,
    private readonly mono: () => number = () => performance.now(),
  ) {
    const root = app.isPackaged ? app.appPath.replace(/\.asar$/, '.asar.unpacked') : app.appPath;
    this.executable = join(root, 'dist/native/screen-saver-state.exe');
  }
  read(): Promise<ScreenSaverSample> {
    if (this.disposed) return Promise.reject(Error('screensaver-disposed'));
    if (this.flight) {
      if (this.flight.generation === this.generation) return this.flight.promise;
      // A killed old query must finish before a fresh child can start.
      return this.flight.promise.catch(() => undefined).then(() => this.read());
    }
    if ((this.app.platform ?? process.platform) !== 'win32')
      return Promise.resolve({ state: 'unknown', observedMono: this.mono() });
    let finish!: (sample: ScreenSaverSample) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ScreenSaverSample>((yes, no) => {
      finish = yes;
      reject = no;
    });
    const flight: Flight = { generation: this.generation, promise, reject };
    this.flight = flight;
    const done = (error: Error | null, stdout: string | Buffer) => {
      if (this.flight !== flight) return;
      this.flight = undefined;
      if (this.disposed || flight.generation !== this.generation) {
        reject(Error('screensaver-invalidated'));
        return;
      }
      finish({
        state: error ? 'unknown' : parseScreenSaverState(stdout),
        observedMono: this.mono(),
      });
    };
    try {
      flight.child = this.runner(this.executable, [], SCREEN_SAVER_OPTIONS, done);
    } catch {
      done(Error('screensaver-exec'), '');
    }
    return promise;
  }
  invalidate(): void {
    this.generation++;
    try {
      this.flight?.child?.kill();
    } catch {
      // The bounded exec timeout still owns termination; never accept this old generation.
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.flight?.reject(Error('screensaver-disposed'));
  }
}

/** App lifecycle only, no scheduled task; cadence starts AFTER each bounded read. */
export class ScreenSaverPoller<Context = undefined> {
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private active = false;
  private suspended = false;
  private busy = false;
  private freshWanted = false;
  private disposed = false;
  constructor(
    private readonly reader: ScreenSaverReader,
    private readonly publish: (sample: ScreenSaverSample, context: Context) => void,
    private readonly capture: () => Context = () => undefined as Context,
  ) {}
  start(): void {
    if (this.disposed) return;
    this.active = true;
    this.fresh();
  }
  fresh(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.reader.invalidate();
    this.freshWanted = true;
    if (this.active && !this.suspended && !this.busy) void this.tick();
  }
  suspend(): void {
    this.suspended = true;
    this.fresh();
  }
  resume(): void {
    if (this.disposed) return;
    this.suspended = false;
    this.fresh();
  }
  stop(): void {
    this.active = false;
    this.fresh();
  }
  private async tick(): Promise<void> {
    if (!this.active || this.suspended || this.busy) return;
    this.busy = true;
    this.freshWanted = false;
    const generation = this.generation;
    const context = this.capture();
    try {
      const sample = await this.reader.read();
      if (this.active && !this.suspended && generation === this.generation)
        this.publish(sample, context);
    } catch {
      // Invalidated result is discarded, never published as a stopped sample.
    } finally {
      this.busy = false;
      if (this.active && !this.suspended) {
        this.timer = setTimeout(() => void this.tick(), this.freshWanted ? 0 : 2000);
        this.timer.unref?.();
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.reader.dispose();
  }
}
