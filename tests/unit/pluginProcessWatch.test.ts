import { describe, it, expect, vi, afterEach } from 'vitest';
import { PluginProcessWatch } from '../../src/main/plugins/processWatch';
afterEach(() => vi.useRealTimers());
describe('demand-only plugin process guard', () => {
  it('does not poll until start; coalesces in-flight queries and polls only after completion', async () => {
    vi.useFakeTimers();
    let resolve!: (v: 'idle') => void;
    const read = vi.fn(
        () =>
          new Promise<'idle'>((r) => {
            resolve = r;
          }),
      ),
      watch = new PluginProcessWatch({ read, current: () => true, intervalMs: 500 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(read).not.toHaveBeenCalled();
    const first = watch.start(),
      same = watch.read();
    expect(read).toHaveBeenCalledTimes(1);
    resolve('idle');
    expect(await first).toBe('idle');
    expect(await same).toBe('idle');
    await vi.advanceTimersByTimeAsync(499);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    watch.stop();
    resolve('idle');
  });
  it('busy and unknown latch until a new explicit job start, never automatically resume', async () => {
    const read = vi
      .fn<() => Promise<'idle' | 'busy' | 'unknown'>>()
      .mockResolvedValueOnce('busy')
      .mockResolvedValueOnce('idle')
      .mockRejectedValueOnce(Error('query'));
    const watch = new PluginProcessWatch({ read, current: () => true });
    expect(await watch.start()).toBe('busy');
    expect(await watch.read()).toBe('busy');
    expect(read).toHaveBeenCalledTimes(1);
    expect(await watch.start()).toBe('idle');
    expect(await watch.read()).toBe('unknown');
    expect(await watch.read()).toBe('unknown');
    watch.stop();
  });
  it('late idle after stop/current invalidation cannot bless another job or reschedule polling', async () => {
    vi.useFakeTimers();
    let resolve!: (v: 'idle') => void,
      current = true;
    const read = vi.fn(
        () =>
          new Promise<'idle'>((r) => {
            resolve = r;
          }),
      ),
      watch = new PluginProcessWatch({ read, current: () => current });
    const work = watch.start();
    watch.stop();
    current = false;
    resolve('idle');
    expect(await work).toBe('unknown');
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await watch.read()).toBe('unknown');
  });
});
