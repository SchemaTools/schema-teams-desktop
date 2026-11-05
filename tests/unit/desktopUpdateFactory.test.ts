import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopUpdateControllerOptions } from '../../src/main/desktop/updateController';
const f = vi.hoisted(() => ({
  captured: undefined as DesktopUpdateControllerOptions | undefined,
  spawn: vi.fn(),
  quit: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: f.spawn }));
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => (key === 'exe' ? 'own-app.exe' : 'own-data'),
    getVersion: () => '0.12.0',
    isPackaged: true,
    quit: f.quit,
  },
  net: { fetch: f.fetch },
}));
vi.mock('../../src/main/desktop/updateController', () => ({
  DesktopUpdateController: class {
    readonly fixtureOnly = true;
    constructor(options: DesktopUpdateControllerOptions) {
      f.captured = options;
    }
  },
}));
import {
  createProductionDesktopUpdateController,
  desktopUpdatesRoot,
} from '../../src/main/desktop/updateFactory';
afterEach(() => {
  vi.clearAllMocks();
  f.captured = undefined;
});
function factory() {
  createProductionDesktopUpdateController(
    Object.assign(
      {
        context: () => ({ stamp: 'A', document: 'doc-A', serverOrigin: 'http://localhost:43210' }),
        readLatest: async () => null,
        acquireQuiescence: () => null,
        onChange: vi.fn(),
      },
      {
        verify: vi.fn(),
        publisherPins: () => ['a'.repeat(64)],
        handoff: vi.fn(),
        stagingRoot: 'external',
        now: () => -1,
      },
    ),
  );
  if (!f.captured) throw Error('missing options');
  return f.captured;
}
function child() {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  f.spawn.mockReturnValue(child);
  return child;
}
describe('Папка загрузок обновлений', () => {
  const local = join(process.cwd(), 'local-app-data-fixture');
  const profile = join(process.cwd(), 'roaming-fixture', 'Schema Teams');
  it('лежит в LOCALAPPDATA под именем профиля, а не в перемещаемом userData', () => {
    expect(desktopUpdatesRoot({ LOCALAPPDATA: local }, profile)).toBe(
      join(local, 'Schema Teams', 'desktop-updates'),
    );
  });
  it.each([undefined, '', 'relative-path'])(
    'без годной LOCALAPPDATA (%s) — прежнее место в userData',
    (value) => {
      expect(desktopUpdatesRoot({ LOCALAPPDATA: value }, profile)).toBe(
        join(profile, 'desktop-updates'),
      );
    },
  );
});
describe('Fixed production updater adapter: mocked constructor and process boundary only', () => {
  it('uses only its own executable/version/root and the fixed bureau publisher policy', () => {
    const o = factory();
    expect(o.context()).toEqual({
      stamp: 'A',
      document: 'doc-A',
      serverOrigin: 'http://localhost:43210',
      executable: 'own-app.exe',
      currentVersion: '0.12.0',
      packaged: true,
      windows: process.platform === 'win32',
    });
    expect(o.publisherPins()).toEqual([
      'd944e76a16374738c475a425fe0ab9eae7cb470cf27371c63b2f19e9d256d51a',
    ]);
    expect(o.stagingRoot).toBe(desktopUpdatesRoot());
    expect(o.verify).toBeUndefined();
    expect(o.pathAllowed).toBeUndefined();
    expect(o.now).toBeUndefined();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('waits for spawn and passes only exact owned path with fixed empty args and shell=false', async () => {
    const o = factory(),
      c = child(),
      done = vi.fn(),
      flight = o.handoff('owned-inert-fixture.exe').then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled();
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith('owned-inert-fixture.exe', [], {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    c.emit('spawn');
    await flight;
    expect(c.unref).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();
    expect(f.quit).not.toHaveBeenCalled(); // Only the controller decides to quit after success.
  });
  it('rejects error before spawn without exposing OS details or quitting', async () => {
    const o = factory(),
      c = child(),
      flight = o.handoff('owned-inert-fixture.exe');
    const checked = expect(flight).rejects.toThrow('update_spawn_failed');
    c.emit('error', Error('private system path'));
    await checked;
    expect(c.unref).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled();
  });
  it('synchronous spawn failure rejects and does not quit', async () => {
    const o = factory();
    f.spawn.mockImplementationOnce(() => {
      throw Error('injected');
    });
    await expect(o.handoff('owned-inert-fixture.exe')).rejects.toThrow('injected');
    expect(f.quit).not.toHaveBeenCalled();
  });
  it('post-spawn unref/error does not turn a started installer into a deletable failed artifact', async () => {
    const o = factory(),
      c = child();
    c.unref.mockImplementation(() => {
      throw Error('injected');
    });
    const flight = o.handoff('owned-inert-fixture.exe');
    c.emit('spawn');
    await flight;
    expect(() => c.emit('error', Error('later'))).not.toThrow();
    expect(f.quit).not.toHaveBeenCalled();
  });
});
