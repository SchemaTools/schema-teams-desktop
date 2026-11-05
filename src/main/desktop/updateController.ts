import type { DesktopDraftSummary, DesktopUpdateView } from '../../shared/desktopUpdate';
export type { DesktopDraftSummary, DesktopUpdateView } from '../../shared/desktopUpdate';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { desktopRelease } from '../api/updates';
import { compareVersions, type DesktopRelease } from '../../shared/updates';
import {
  downloadDesktopRelease,
  discardDesktopDownload,
  claimDesktopDownload,
  type DesktopDownloadReceipt,
} from './downloadDesktop';
import {
  desktopPublisherConfigured,
  inspectSignedDesktopFile,
  inspectDownloadedDesktopFile,
  revalidateDesktopPair,
  type DesktopTrustOptions,
  type SignedDesktopFile,
} from './updateTrust';

/** Main-owned lifetime; stamp changes on owner/config/policy/connection changes.
 * document changes on renderer reload, not on React navigation. No auth data in projections.
 */
export interface DesktopUpdateContext {
  readonly stamp: string;
  readonly document: string;
  readonly serverOrigin: string;
  readonly currentVersion: string;
  readonly executable: string;
  readonly packaged: boolean;
  readonly windows: boolean;
}
export interface DesktopQuiescence {
  current(): boolean;
  release(): void;
}
export interface DesktopUpdateControllerOptions {
  context: () => Readonly<DesktopUpdateContext>;
  publisherPins: () => readonly string[];
  stagingRoot: string;
  readLatest: (signal: AbortSignal) => Promise<unknown | null>;
  acquireQuiescence: () => DesktopQuiescence | null;
  /** Fixed main runner, resolves only on spawn; rejects only before spawn.
   * Tests inject a spy. This component never imports or executes a process runner.
   */
  handoff: (ownedInstaller: string) => Promise<void>;
  quit: () => void;
  onChange: (view: DesktopUpdateView) => void;
  /** Журнал: код ошибки подготовки или запуска (`update_*`, `download_*`), без путей и текста ОС. */
  onFailure?: (failure: Readonly<DesktopUpdateFailure>) => void;
  /** Main monotonic clock; test seam only. Wall clock is never an ACK lifetime. */
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  pathAllowed?: DesktopTrustOptions['pathAllowed'];
  verify?: DesktopTrustOptions['verify'];
}
export interface DesktopUpdateFailure {
  readonly stage: 'prepare' | 'launch';
  readonly code: string;
}
interface Offer {
  readonly id: string;
  readonly release: Readonly<DesktopRelease>;
  readonly context: Readonly<DesktopUpdateContext>;
  readonly pins: readonly string[];
}
interface Job {
  readonly id: string;
  readonly offer: Offer;
  readonly abort: AbortController;
  flight?: Promise<DesktopUpdateView>;
  receipt?: DesktopDownloadReceipt;
  baseline?: SignedDesktopFile;
  installer?: SignedDesktopFile;
  acknowledgedRevision?: number;
  challenge?: Readonly<{ id: string; revision: number; dirtyCount: number; expiresAt: number }>;
  acknowledgementExpires?: number;
  handedOff: boolean;
}
const uuid = (s: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s);
const tuple = (r: Readonly<DesktopRelease>) =>
  JSON.stringify([r.version, r.file, r.sha256, r.size, r.url, r.notes]);
const contextKey = (c: Readonly<DesktopUpdateContext>) =>
  JSON.stringify([
    c.stamp,
    c.document,
    c.serverOrigin,
    c.currentVersion,
    c.executable,
    c.packaged,
    c.windows,
  ]);
const summaryKey = (s: DesktopDraftSummary) =>
  JSON.stringify([s.revision, s.dirtyCount, s.editorsOpen, s.busy]);
const blank = (): DesktopUpdateView => ({
  phase: 'idle',
  offerId: null,
  jobId: null,
  version: null,
  fraction: 0,
  challenge: null,
  error: null,
});
const publicError = (error: unknown) => {
  const code = error instanceof Error ? error.message : '';
  return [
    'stale_update',
    'update_environment',
    'update_publisher_unconfigured',
    'update_offer_changed',
    'update_signature_invalid',
    'update_publisher_changed',
    'update_baseline_changed',
    'update_file_changed',
    'update_file_invalid',
    'update_path_invalid',
    'update_busy',
    'update_drafts_changed',
    'update_artifact_busy',
    'update_spawn_failed',
  ].includes(code)
    ? code
    : 'update_failed';
};
/** Код для журнала подробнее публичного: видно, на каком шаге загрузки отказ. */
export const failureCode = (error: unknown): string => {
  const code = error instanceof Error ? error.message : '';
  return /^(?:update|download)_[a-z_]{1,40}$/.test(code) ? code : publicError(error);
};

/** Orchestration core only. Host must bind its lifetime/quiescence and the
 * renderer draft lock before exposing these intents through strict IPC.
 */
export class DesktopUpdateController {
  private readonly o: Readonly<DesktopUpdateControllerOptions>;
  private offer?: Offer;
  private job?: Job;
  private drafts?: { context: string; document: string; summary: Readonly<DesktopDraftSummary> };
  private lastClock = 0;
  private value: DesktopUpdateView = blank();
  private destroyed = false;
  constructor(options: DesktopUpdateControllerOptions) {
    this.o = Object.freeze({ ...options });
  }
  get state(): DesktopUpdateView {
    return Object.freeze({
      ...this.value,
      challenge: this.value.challenge ? Object.freeze({ ...this.value.challenge }) : null,
    });
  }
  /** Call only for a fresh main-owned latest response read in expectedStamp.
   * A late response from a former owner cannot create a new offer.
   */
  setOffer(raw: unknown | null, expectedStamp: string): string | null {
    const context = Object.freeze({ ...this.o.context() });
    if (
      this.destroyed ||
      context.stamp !== expectedStamp ||
      this.value.phase === 'handing-off' ||
      this.value.phase === 'handed-off'
    )
      return null;
    let release: Readonly<DesktopRelease> | undefined;
    try {
      if (raw !== null) {
        const parsed = desktopRelease(raw);
        if (compareVersions(parsed.version, context.currentVersion) === 1)
          release = Object.freeze(parsed);
      }
    } catch {
      /* Invalid/unpublished metadata removes the previous permission. */
    }
    this.invalidate();
    if (!release) return null;
    this.offer = Object.freeze({
      id: randomUUID(),
      release,
      context,
      pins: Object.freeze([...this.o.publisherPins()]),
    });
    this.value = { ...blank(), offerId: this.offer.id, version: release.version };
    this.emit();
    return this.offer.id;
  }
  /** Monotonic summary of ALL drafts, with no text/files sent to main. */
  reportDrafts(document: string, expectedStamp: string, raw: DesktopDraftSummary): boolean {
    const context = Object.freeze({ ...this.o.context() });
    const summary = Object.freeze({ ...raw });
    if (
      this.destroyed ||
      document !== context.document ||
      expectedStamp !== context.stamp ||
      !Number.isSafeInteger(summary.revision) ||
      summary.revision < 0 ||
      !Number.isSafeInteger(summary.dirtyCount) ||
      summary.dirtyCount < 0 ||
      !Number.isSafeInteger(summary.editorsOpen) ||
      summary.editorsOpen < 0 ||
      typeof summary.busy !== 'boolean'
    )
      return false;
    if (this.drafts?.document === document && this.drafts.context === contextKey(context)) {
      const previous = this.drafts.summary;
      if (
        summary.revision < previous.revision ||
        (summary.revision === previous.revision && summaryKey(summary) !== summaryKey(previous))
      )
        return false;
    }
    this.drafts = { document, context: contextKey(context), summary };
    const job = this.job;
    if (
      job?.challenge &&
      summaryKey(summary) !==
        JSON.stringify([job.challenge.revision, job.challenge.dirtyCount, 0, false])
    ) {
      job.challenge = undefined;
      this.value = {
        ...this.value,
        phase: 'ready',
        challenge: null,
        error: 'update_drafts_changed',
      };
      this.emit();
    }
    if (
      job?.acknowledgedRevision !== undefined &&
      summary.revision !== job.acknowledgedRevision &&
      this.value.phase === 'validating'
    )
      this.invalidate();
    return true;
  }
  prepare(offerId: string): Promise<DesktopUpdateView> {
    if (!uuid(offerId) || this.destroyed || this.offer?.id !== offerId)
      return Promise.resolve(this.state);
    if (this.job) return this.job.flight ?? Promise.resolve(this.state);
    const job: Job = {
      id: randomUUID(),
      offer: this.offer,
      abort: new AbortController(),
      handedOff: false,
    };
    this.job = job;
    this.value = {
      ...this.value,
      jobId: job.id,
      phase: 'preparing',
      fraction: 0,
      error: null,
      challenge: null,
    };
    this.emit();
    const flight = this.prepareJob(job).finally(() => {
      if (job.flight === flight) job.flight = undefined;
    });
    job.flight = flight;
    return flight;
  }
  private async prepareJob(job: Job): Promise<DesktopUpdateView> {
    try {
      this.check(job);
      const c = job.offer.context;
      if (!c.windows || !c.packaged) throw Error('update_environment');
      if (!desktopPublisherConfigured(job.offer.pins)) throw Error('update_publisher_unconfigured');
      job.baseline = await inspectSignedDesktopFile(c.executable, this.trust(job));
      this.check(job);
      await this.latestMatches(job);
      job.receipt = await downloadDesktopRelease(job.offer.release, {
        serverOrigin: c.serverOrigin,
        root: this.o.stagingRoot,
        current: () => this.current(job),
        signal: job.abort.signal,
        fetch: this.o.fetch,
        onProgress: (p) => {
          if (this.current(job)) {
            this.value = { ...this.value, fraction: p.fraction };
            this.emit();
          }
        },
      });
      this.check(job);
      job.installer = await inspectDownloadedDesktopFile(job.receipt, this.trust(job));
      this.check(job);
      if (job.installer.signerDerSha256 !== job.baseline.signerDerSha256)
        throw Error('update_publisher_changed');
      await this.latestMatches(job);
      this.check(job);
      this.value = { ...this.value, phase: 'ready', fraction: 1 };
      this.emit();
    } catch (error) {
      await this.fail(job, error, 'prepare');
    }
    return this.state;
  }
  requestLaunch(jobId: string): DesktopUpdateView {
    const job = this.job;
    if (!job || !uuid(jobId) || job.id !== jobId || this.value.phase !== 'ready') return this.state;
    try {
      this.check(job);
      const summary = this.summary(job);
      if (summary.busy || summary.editorsOpen) throw Error('update_busy');
      job.challenge = Object.freeze({
        id: randomUUID(),
        revision: summary.revision,
        dirtyCount: summary.dirtyCount,
        expiresAt: this.clock() + 5 * 60 * 1000,
      });
      this.value = {
        ...this.value,
        phase: 'confirming',
        challenge: {
          id: job.challenge.id,
          revision: summary.revision,
          dirtyCount: summary.dirtyCount,
        },
        error: null,
      };
    } catch (error) {
      this.value = { ...this.value, error: publicError(error) };
      this.report('launch', error);
    }
    this.emit();
    return this.state;
  }
  acknowledge(challengeId: string, decision: 'cancel' | 'discard'): Promise<DesktopUpdateView> {
    const job = this.job;
    if (
      !job ||
      !uuid(challengeId) ||
      job.challenge?.id !== challengeId ||
      this.value.phase !== 'confirming'
    )
      return Promise.resolve(this.state);
    if (decision === 'cancel') {
      job.challenge = undefined;
      this.value = { ...this.value, phase: 'ready', challenge: null };
      this.emit();
      return Promise.resolve(this.state);
    }
    if (decision !== 'discard') return Promise.resolve(this.state);
    const challenge = job.challenge;
    job.challenge = undefined; // Consumed before the first await, including rejected ACKs.
    job.acknowledgedRevision = challenge.revision;
    job.acknowledgementExpires = challenge.expiresAt;
    this.value = { ...this.value, phase: 'validating', challenge: null, error: null };
    this.emit();
    const flight = this.launch(job).finally(() => {
      if (job.flight === flight) job.flight = undefined;
    });
    job.flight = flight;
    return flight;
  }
  private async launch(job: Job): Promise<DesktopUpdateView> {
    let quiescence: DesktopQuiescence | null = null;
    let artifact: ReturnType<typeof claimDesktopDownload> = null;
    try {
      this.check(job);
      const acquired = this.o.acquireQuiescence();
      if (!acquired) throw Error('update_busy');
      quiescence = Object.freeze({
        current: acquired.current.bind(acquired),
        release: acquired.release.bind(acquired),
      });
      if (quiescence.current() !== true) throw Error('update_busy');
      this.check(job);
      if (!job.receipt || !job.baseline || !job.installer) throw Error('update_file_invalid');
      artifact = claimDesktopDownload(job.receipt);
      if (!artifact) throw Error('update_artifact_busy');
      await this.latestMatches(job);
      this.check(job, quiescence);
      await revalidateDesktopPair(job.baseline, job.installer, this.trust(job));
      this.check(job, quiescence);
      // No further await between terminal checks and this one-shot handoff.
      this.value = { ...this.value, phase: 'handing-off' };
      let spawn: Promise<void>;
      try {
        spawn = this.o.handoff(job.receipt.file);
      } catch {
        throw Error('update_spawn_failed');
      }
      this.emit();
      try {
        await spawn;
      } catch {
        throw Error('update_spawn_failed');
      }
      job.handedOff = true;
      artifact.finish(true);
      artifact = null;
      this.value = { ...this.value, phase: 'handed-off', error: null };
      this.emit();
      this.o.quit();
    } catch (error) {
      artifact?.finish(false);
      if (!job.handedOff) await this.fail(job, error, 'launch');
    } finally {
      quiescence?.release();
    }
    return this.state;
  }
  async cancel(jobId: string): Promise<boolean> {
    const job = this.job;
    if (
      !job ||
      !uuid(jobId) ||
      job.id !== jobId ||
      job.handedOff ||
      this.value.phase === 'handing-off'
    )
      return false;
    job.abort.abort();
    this.job = undefined;
    this.value = {
      ...blank(),
      offerId: this.offer?.id ?? null,
      version: this.offer?.release.version ?? null,
    };
    this.emit();
    if (!job.flight && job.receipt) await discardDesktopDownload(job.receipt);
    return true;
  }
  /** Context/renderer invalidation. A handed-off process is beyond cancellation. */
  invalidate(): void {
    const job = this.job;
    if (job && (job.handedOff || this.value.phase === 'handing-off')) return;
    if (job) {
      job.abort.abort();
      if (!job.flight && job.receipt) void discardDesktopDownload(job.receipt);
    }
    this.offer = undefined;
    this.job = undefined;
    this.value = blank();
    this.emit();
  }
  destroy(): void {
    this.invalidate();
    this.destroyed = true;
    this.drafts = undefined;
  }
  private summary(job: Job): Readonly<DesktopDraftSummary> {
    if (
      this.drafts?.document !== job.offer.context.document ||
      this.drafts.context !== contextKey(job.offer.context)
    )
      throw Error('update_drafts_changed');
    return this.drafts.summary;
  }
  private current(job: Job): boolean {
    return (
      !this.destroyed &&
      this.job === job &&
      this.offer === job.offer &&
      !job.abort.signal.aborted &&
      contextKey(this.o.context()) === contextKey(job.offer.context) &&
      JSON.stringify([...this.o.publisherPins()]) === JSON.stringify(job.offer.pins)
    );
  }
  private check(job: Job, quiescence?: DesktopQuiescence): void {
    if (!this.current(job)) throw Error('stale_update');
    if (job.acknowledgedRevision !== undefined) {
      const summary = this.summary(job);
      if (
        summary.revision !== job.acknowledgedRevision ||
        summary.busy ||
        summary.editorsOpen ||
        this.clock() >= (job.acknowledgementExpires ?? 0)
      )
        throw Error('update_drafts_changed');
    }
    if (quiescence && quiescence.current() !== true) throw Error('update_busy');
  }
  private trust(job: Job): DesktopTrustOptions {
    return {
      publisherPins: job.offer.pins,
      current: () => this.current(job),
      signal: job.abort.signal,
      pathAllowed: this.o.pathAllowed,
      verify: this.o.verify,
    };
  }
  private clock(): number {
    const now = this.o.now?.() ?? performance.now();
    if (!Number.isFinite(now) || now < this.lastClock) throw Error('update_drafts_changed');
    this.lastClock = now;
    return now;
  }
  private async latestMatches(job: Job): Promise<void> {
    const raw = await this.o.readLatest(job.abort.signal);
    this.check(job);
    if (raw === null || tuple(desktopRelease(raw)) !== tuple(job.offer.release))
      throw Error('update_offer_changed');
  }
  private async fail(
    job: Job,
    error: unknown,
    stage: DesktopUpdateFailure['stage'],
  ): Promise<void> {
    job.abort.abort();
    if (job.receipt && !job.handedOff) await discardDesktopDownload(job.receipt);
    // Отменённое или заменённое задание — не ошибка обновления.
    if (this.job !== job) return;
    this.report(stage, error);
    this.job = undefined;
    this.value = {
      ...this.value,
      phase: 'error',
      jobId: null,
      challenge: null,
      error: publicError(error),
    };
    this.emit();
  }
  private report(stage: DesktopUpdateFailure['stage'], error: unknown): void {
    try {
      this.o.onFailure?.(Object.freeze({ stage, code: failureCode(error) }));
    } catch {
      /* Журнал не меняет исход обновления. */
    }
  }
  private emit(): void {
    try {
      this.o.onChange(this.state);
    } catch {
      /* View delivery cannot grant or revoke file ownership. */
    }
  }
}
