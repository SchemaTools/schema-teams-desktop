import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  parseScreenSaverState,
  SCREEN_SAVER_OPTIONS,
  ScreenSaverPoller,
  SCREEN_SAVER_CHECK_MS,
  SCREEN_SAVER_IDLE_S,
  SCREEN_SAVER_LATCHED_MS,
  SCREEN_SAVER_READ_MS,
  WindowsScreenSaverReader,
  type ScreenSaverRunner,
} from '../../src/main/desktop/screenSaverState';
import { ScreenSaverObserver } from '../../src/main/desktop/screenSaverObserver';

function fixture() {
  const calls: {
    path: string;
    args: string[];
    options: typeof SCREEN_SAVER_OPTIONS;
    done: (error: Error | null, text: string) => void;
    kill: ReturnType<typeof vi.fn>;
  }[] = [];
  const runner: ScreenSaverRunner = (path, args, options, done) => {
    const call = { path, args, options, done, kill: vi.fn() };
    calls.push(call);
    return call;
  };
  let now = 100;
  const reader = new WindowsScreenSaverReader(
    { appPath: '/controlled/app.asar', isPackaged: true, platform: 'win32' },
    runner,
    () => now,
  );
  function done(state = 'stopped', index = calls.length - 1) {
    const call = calls[index];
    if (!call) throw Error('Missing query');
    call.done(null, JSON.stringify({ v: 1, state }));
  }
  return { reader, calls, done, time: (value: number) => (now = value) };
}
afterEach(() => vi.useRealTimers());

describe('Synthetic screensaver protocol and controlled reader', () => {
  const ambiguous = [
    '{"v":1,"state":"running","state":"stopped"}',
    '{"v":1,"state":"stopped","state":"running"}',
    '{"v":2,"v":1,"state":"stopped"}',
    '{"v":1,"v":2,"state":"stopped"}',
    '{"v":1,"v":1,"state":"stopped"}',
    '{"v":1,"state":"running","state":"running"}',
    '{"v":2,"v":1,"state":"running","state":"stopped"}',
    '{ "v": 1, "state": "stopped" }',
  ];
  it.each(ambiguous)(
    'rejects noncanonical/duplicate keys and retains positive latch: %s',
    (text) => {
      const o = new ScreenSaverObserver();
      o.sample({ state: 'running', observedMono: 1 }, o.token);
      expect(parseScreenSaverState(text)).toBe('unknown');
      expect(
        o.sample({ state: parseScreenSaverState(text), observedMono: 2 }, o.token),
      ).toMatchObject({
        absent: true,
        fresh: false,
        transition: null,
      });
      expect(o.returnAllowed).toBe(false);
    },
  );
  it('accepts the actual compact helper format with surrounding whitespace/newline and Buffer', () => {
    expect(parseScreenSaverState(' \r\n{"v":1,"state":"running"}\r\n')).toBe('running');
    expect(parseScreenSaverState(Buffer.from('{"v":1,"state":"stopped"}\r\n'))).toBe('stopped');
  });
  it.each(['running', 'stopped', 'unknown'] as const)('parses strict %s', (state) => {
    expect(parseScreenSaverState(JSON.stringify({ v: 1, state }))).toBe(state);
  });
  it.each([
    'null',
    '[]',
    '{',
    '{"v":2,"state":"running"}',
    '{"v":1,"state":true}',
    '{"v":1,"state":["running"]}',
    '{"v":1,"state":"stopped","extra":1}',
    '{"v":1,"state":"stopped"}{}',
    ' '.repeat(129),
  ])('invalid protocol never becomes stopped: %s', (text) => {
    expect(parseScreenSaverState(text)).toBe('unknown');
  });
  it('uses fixed unpacked path, no args, bounds, singleflight and completion-time stamp', async () => {
    const f = fixture();
    const first = f.reader.read();
    expect(f.reader.read()).toBe(first);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({
      path: join('/controlled/app.asar.unpacked', 'dist/native/screen-saver-state.exe'),
      args: [],
      options: { shell: false, windowsHide: true, timeout: 1500, maxBuffer: 128 },
    });
    f.time(950);
    f.done('running');
    expect(await first).toEqual({ state: 'running', observedMono: 950 });
    const second = f.reader.read();
    expect(f.calls).toHaveLength(2);
    f.done();
    expect((await second).state).toBe('stopped');
  });
  it('missing helper, negative exit, timeout or buffer failure returns unknown and can retry', async () => {
    const f = fixture();
    for (const code of ['ENOENT', 'exit1', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
      const pending = f.reader.read();
      f.calls.at(-1)?.done(Error(code), '{"v":1,"state":"stopped"}');
      expect((await pending).state).toBe('unknown');
    }
    expect(f.calls).toHaveLength(4);
    const pending = f.reader.read();
    f.done('running');
    expect((await pending).state).toBe('running');
  });
  it('non-Windows never starts a helper', async () => {
    const runner = vi.fn();
    const reader = new WindowsScreenSaverReader(
      { appPath: '/main-only', isPackaged: false, platform: 'linux' },
      runner,
      () => 8,
    );
    expect(await reader.read()).toEqual({ state: 'unknown', observedMono: 8 });
    expect(runner).not.toHaveBeenCalled();
  });
  it('invalidation rejects late stopped and waits for old callback before spawning fresh', async () => {
    const f = fixture();
    const old = f.reader.read();
    const rejected = expect(old).rejects.toThrow('invalidated');
    f.reader.invalidate();
    expect(f.calls[0]?.kill).toHaveBeenCalledOnce();
    const fresh = f.reader.read();
    expect(f.calls).toHaveLength(1);
    f.done('stopped');
    await rejected;
    await Promise.resolve();
    expect(f.calls).toHaveLength(2);
    f.done('running');
    expect((await fresh).state).toBe('running');
  });
  it('dispose cancels the owned child and publishes no late result', async () => {
    const f = fixture();
    const pending = f.reader.read();
    const rejected = expect(pending).rejects.toThrow('disposed');
    f.reader.dispose();
    await rejected;
    expect(f.calls[0]?.kill).toHaveBeenCalledOnce();
    f.done('stopped');
    await expect(f.reader.read()).rejects.toThrow('disposed');
    expect(f.calls).toHaveLength(1);
  });
});

describe('Demand-driven main polling (synthetic process results)', () => {
  it('does nothing until start; without cadence reads every 15 s after completion, never overlapping', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const publish = vi.fn();
    const poller = new ScreenSaverPoller(f.reader, publish);
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.calls).toHaveLength(0);
    poller.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.calls).toHaveLength(1);
    f.done('running');
    await vi.advanceTimersByTimeAsync(SCREEN_SAVER_READ_MS - 1);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    poller.stop();
    f.done();
    await vi.advanceTimersByTimeAsync(60000);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(2);
    poller.dispose();
  });
  it('with cadence starts the helper only while idle or latched; explicit fresh always reads', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const publish = vi.fn();
    let idle = 0,
      latched = false;
    const poller = new ScreenSaverPoller(f.reader, publish, () => undefined, {
      idleSeconds: () => idle,
      latched: () => latched,
    });
    poller.start();
    // Старт — внеочередное чтение.
    expect(f.calls).toHaveLength(1);
    f.done('stopped');
    // Пользователь активен: за 10 минут помощник не запускается ни разу.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.calls).toHaveLength(1);
    // Блокировка/пробуждение — fresh(): чтение сразу, независимо от бездействия.
    poller.fresh();
    expect(f.calls).toHaveLength(2);
    f.done('stopped');
    // Бездействие ≥ 55 с: чтение не чаще раза в 15 с.
    idle = SCREEN_SAVER_IDLE_S;
    await vi.advanceTimersByTimeAsync(SCREEN_SAVER_READ_MS - 1);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(3);
    f.done('running');
    latched = true;
    // Заставка идёт, ввода нет: раз в минуту.
    await vi.advanceTimersByTimeAsync(SCREEN_SAVER_LATCHED_MS - SCREEN_SAVER_CHECK_MS);
    expect(f.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(SCREEN_SAVER_CHECK_MS);
    expect(f.calls).toHaveLength(4);
    f.done('running');
    // Ввод пользователя сбросил бездействие — ближайшая проверка читает окончание заставки.
    idle = 0;
    await vi.advanceTimersByTimeAsync(SCREEN_SAVER_CHECK_MS);
    expect(f.calls).toHaveLength(5);
    f.done('stopped');
    latched = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.calls).toHaveLength(5);
    expect(publish).toHaveBeenCalledTimes(5);
    poller.dispose();
  });
  it('suspend discards pending false; resume requests immediate fresh, dispose removes timeout', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const publish = vi.fn();
    const poller = new ScreenSaverPoller(f.reader, publish);
    poller.start();
    poller.suspend();
    f.done('stopped');
    await vi.advanceTimersByTimeAsync(5000);
    expect(publish).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
    poller.resume();
    expect(f.calls).toHaveLength(2);
    f.done('running');
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledOnce();
    poller.dispose();
    poller.start();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.calls).toHaveLength(2);
  });
});

describe('Pure observed absence layers (not real OS transitions)', () => {
  it('a stopped sample before lock does not authorize immediate unlock return without a new read', () => {
    const o = new ScreenSaverObserver();
    o.sample({ state: 'stopped', observedMono: 1 }, o.token);
    o.explicit('lock', true, 2);
    o.explicit('lock', false, 3);
    expect(o.returnAllowed).toBe(false);
    expect(o.sample({ state: 'stopped', observedMono: 4 }, o.token)?.transition).toBe('return');
  });
  function saver(
    observer: ScreenSaverObserver,
    state: 'running' | 'stopped' | 'unknown',
    time: number,
  ) {
    return observer.sample({ state, observedMono: time }, observer.token);
  }
  it('SS→lock→SSfalse→unlock returns only at aggregate clear', () => {
    const o = new ScreenSaverObserver();
    expect(saver(o, 'running', 5)?.transition).toBe('departure');
    expect(o.explicit('lock', true, 6)?.transition).toBeNull();
    expect(saver(o, 'stopped', 7)?.transition).toBeNull();
    expect(o.returnAllowed).toBe(false);
    expect(o.explicit('lock', false, 8)).toMatchObject({
      transition: 'return',
      source: 'lock',
      observedMono: 8,
    });
  });
  it('lock→SStrue→unlock→unknown→SSfalse keeps latch; repeated positives do not depart twice', () => {
    const o = new ScreenSaverObserver();
    expect(o.explicit('lock', true, 1)?.transition).toBe('departure');
    expect(saver(o, 'running', 2)?.transition).toBeNull();
    expect(saver(o, 'running', 3)?.transition).toBeNull();
    expect(o.explicit('lock', false, 4)?.transition).toBeNull();
    expect(saver(o, 'unknown', 5)?.absent).toBe(true);
    expect(saver(o, 'unknown', 6)?.transition).toBeNull();
    expect(saver(o, 'stopped', 7)).toMatchObject({
      transition: 'return',
      source: 'screensaver',
      observedMono: 7,
    });
  });
  it('SS/suspend/wake while locked/unlock waits for fresh clear without backdating', () => {
    const o = new ScreenSaverObserver();
    saver(o, 'running', 1);
    o.explicit('suspend', true, 2);
    o.explicit('lock', true, 3);
    o.explicit('suspend', false, 20);
    saver(o, 'stopped', 21);
    expect(o.returnAllowed).toBe(false);
    expect(o.explicit('lock', false, 30)?.observedMono).toBe(30);
    expect(o.returnAllowed).toBe(true);
  });
  it('resume requires fresh sample, late pre-lock/stale-context/rollback results are discarded', () => {
    const o = new ScreenSaverObserver();
    saver(o, 'stopped', 1);
    const old = o.token;
    o.explicit('lock', true, 2);
    expect(o.sample({ state: 'stopped', observedMono: 9 }, old)).toBeNull();
    o.explicit('suspend', true, 3);
    o.explicit('suspend', false, 4);
    expect(o.explicit('lock', false, 5)?.transition).toBeNull();
    expect(saver(o, 'stopped', 6)?.transition).toBe('return');
    const context = o.token;
    o.invalidate();
    expect(o.sample({ state: 'running', observedMono: 7 }, context)).toBeNull();
    expect(saver(o, 'running', 4)).toBeNull();
    expect(saver(o, 'running', NaN)).toBeNull();
  });
  it('startup/restored pending return requires fresh stopped; unknown alone never invents departure', () => {
    const o = new ScreenSaverObserver(true);
    expect(o.returnAllowed).toBe(false);
    expect(saver(o, 'unknown', 1)?.transition).toBeNull();
    expect(saver(o, 'stopped', 2)?.transition).toBe('return');
    expect(saver(o, 'stopped', 3)?.transition).toBeNull();
    const fresh = new ScreenSaverObserver();
    expect(saver(fresh, 'unknown', 5)?.transition).toBeNull();
    expect(fresh.returnAllowed).toBe(false);
  });
});
