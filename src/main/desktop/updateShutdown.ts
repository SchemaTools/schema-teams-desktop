export interface ShutdownLease {
  current(): boolean;
  release(): void;
}
/** Process-wide: replacing a Host must never abandon an in-progress handoff. */
export class UpdateShutdown {
  private owner?: symbol;
  get locked(): boolean {
    return this.owner !== undefined;
  }
  assertMayReplace(): void {
    if (this.locked) throw Error('update_in_progress');
  }
  acquire(ready: () => boolean): ShutdownLease | null {
    const safe = () => {
      try {
        return ready() === true;
      } catch {
        return false;
      }
    };
    if (this.owner || !safe()) return null;
    const owner = Symbol('update-shutdown');
    this.owner = owner;
    let released = false;
    return Object.freeze({
      current: () => !released && this.owner === owner && safe(),
      release: () => {
        if (released) return;
        released = true;
        if (this.owner === owner) this.owner = undefined;
      },
    });
  }
}
export const desktopShutdown = new UpdateShutdown();
