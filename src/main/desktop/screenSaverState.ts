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

/** Дешёвая проверка бездействия — без запуска процесса (powerMonitor). */
export const SCREEN_SAVER_CHECK_MS = 5000;
/** Помощник запускается не чаще раза в 15 с, пока пользователь бездействует. */
export const SCREEN_SAVER_READ_MS = 15000;
/** Пока заставка замечена, опрос без признаков возврата — раз в минуту. */
export const SCREEN_SAVER_LATCHED_MS = 60000;
/** Минимальный тайм-аут заставки Windows — 1 мин; раньше заставка сама не включится. */
export const SCREEN_SAVER_IDLE_S = 55;
export interface ScreenSaverCadence {
  /** Секунды без ввода пользователя (powerMonitor.getSystemIdleTime). */
  idleSeconds(): number;
  /** Заставка уже замечена: нужен опрос, чтобы увидеть её окончание. */
  latched(): boolean;
}

/**
 * App lifecycle only, no scheduled task; cadence starts AFTER each bounded read.
 * С cadence помощник запускается только при признаках бездействия (≥ 55 с без ввода)
 * или пока заставка замечена; явные события (блокировка, сон, пробуждение) вызывают
 * fresh() — внеочередное чтение. Без cadence — чтение раз в SCREEN_SAVER_READ_MS.
 */
export class ScreenSaverPoller<Context = undefined> {
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private active = false;
  private suspended = false;
  private busy = false;
  private freshWanted = false;
  private disposed = false;
  /** Время с последнего чтения в мс, считается по проверкам (без часов). */
  private sinceRead = 0;
  constructor(
    private readonly reader: ScreenSaverReader,
    private readonly publish: (sample: ScreenSaverSample, context: Context) => void,
    private readonly capture: () => Context = () => undefined as Context,
    private readonly cadence?: ScreenSaverCadence,
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
  private shouldRead(): boolean {
    if (this.freshWanted || !this.cadence) return true;
    let idle: number, latched: boolean;
    try {
      idle = this.cadence.idleSeconds();
      latched = this.cadence.latched();
    } catch {
      return this.sinceRead >= SCREEN_SAVER_READ_MS;
    }
    if (!Number.isFinite(idle)) idle = 0;
    // Заставка замечена: ввод пользователя (бездействие сброшено) — признак её окончания.
    if (latched) return idle < SCREEN_SAVER_IDLE_S || this.sinceRead >= SCREEN_SAVER_LATCHED_MS;
    return idle >= SCREEN_SAVER_IDLE_S && this.sinceRead >= SCREEN_SAVER_READ_MS;
  }
  private schedule(ms: number): void {
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }
  private async tick(): Promise<void> {
    if (!this.active || this.suspended || this.busy) return;
    if (!this.shouldRead()) {
      this.sinceRead += SCREEN_SAVER_CHECK_MS;
      this.schedule(SCREEN_SAVER_CHECK_MS);
      return;
    }
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
        const next = this.freshWanted
          ? 0
          : this.cadence
            ? SCREEN_SAVER_CHECK_MS
            : SCREEN_SAVER_READ_MS;
        this.sinceRead = next;
        this.schedule(next);
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.reader.dispose();
  }
}
