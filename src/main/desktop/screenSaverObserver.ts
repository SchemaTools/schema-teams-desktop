import type { ScreenSaverSample } from './screenSaverState';

export type AbsenceLayer = 'lock' | 'suspend' | 'screensaver';
export interface AbsenceObservation {
  absent: boolean;
  fresh: boolean;
  transition: 'departure' | 'return' | null;
  source: AbsenceLayer;
  observedMono: number;
}
/** Pure observed-state layering. No timer identity, clock conversion, network or auto-resume. */
export class ScreenSaverObserver {
  private locked = false;
  private suspended = false;
  private saver = false;
  private fresh = false;
  private generation = 0;
  private lastMono = -Infinity;
  private departureOpen: boolean;
  constructor(restoredPendingReturn = false) {
    this.departureOpen = restoredPendingReturn;
  }
  get token(): number {
    return this.generation;
  }
  get absent(): boolean {
    return this.locked || this.suspended || this.saver;
  }
  get returnAllowed(): boolean {
    return !this.absent && this.fresh;
  }
  /** Capture before await; any lock/suspend/context change invalidates an older sample. */
  invalidate(): void {
    this.generation++;
    this.fresh = false;
  }
  explicit(
    layer: 'lock' | 'suspend',
    active: boolean,
    observedMono: number,
  ): AbsenceObservation | null {
    if (!Number.isFinite(observedMono) || observedMono < this.lastMono) return null;
    this.generation++;
    if (layer === 'lock') this.locked = active;
    else this.suspended = active;
    // A sample from before lock cannot prove the saver stopped during it.
    // A fresh sample taken while locked can still establish the other layer;
    // unlock itself never clears a known saver latch. Sleep always invalidates.
    if (layer === 'suspend' || active) this.fresh = false;
    this.lastMono = observedMono;
    return this.result(layer, observedMono);
  }
  sample(sample: ScreenSaverSample, token: number): AbsenceObservation | null {
    if (
      token !== this.generation ||
      !Number.isFinite(sample.observedMono) ||
      sample.observedMono < this.lastMono
    )
      return null;
    this.lastMono = sample.observedMono;
    if (sample.state === 'unknown') this.fresh = false;
    else {
      this.saver = sample.state === 'running';
      this.fresh = true;
    }
    return this.result('screensaver', sample.observedMono);
  }
  private result(source: AbsenceLayer, observedMono: number): AbsenceObservation {
    const absent = this.absent;
    let transition: AbsenceObservation['transition'] = null;
    if (absent && !this.departureOpen) {
      this.departureOpen = true;
      transition = 'departure';
    } else if (!absent && this.fresh && this.departureOpen) {
      this.departureOpen = false;
      transition = 'return';
    }
    return {
      absent,
      fresh: this.fresh,
      transition,
      source,
      observedMono,
    };
  }
}
