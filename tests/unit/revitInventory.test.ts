import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevitInventoryService, scanRevit } from '../../src/main/desktop/revitInventory';
import { SettingsStore } from '../../src/main/settings';
import { requestValid } from '../../src/shared/requests';
const dir = () => mkdtempSync(join(tmpdir(), 'revit-inventory-'));
afterEach(() => vi.useRealTimers());
describe('Read-only Revit inventory', () => {
  it('reports standard executable evidence and manifests, without reading their content or returning paths', async () => {
    const root = dir(),
      roots = {
        programFiles: join(root, 'programs'),
        appData: join(root, 'user'),
        programData: join(root, 'all'),
      };
    const install = join(roots.programFiles, 'Autodesk', 'Revit 2025');
    mkdirSync(install, { recursive: true });
    writeFileSync(join(install, 'Revit.exe'), 'fixture only');
    const addins = join(roots.appData, 'Autodesk', 'Revit', 'Addins', '2025');
    mkdirSync(addins, { recursive: true });
    writeFileSync(join(addins, 'Schema.Tools.addin'), 'not XML and never executed');
    writeFileSync(join(addins, 'other.dll'), 'ignored');
    mkdirSync(join(addins, 'directory.addin'));
    const result = await scanRevit(roots);
    expect(result.years[0]).toMatchObject({
      year: 2025,
      executable: 'found',
      addins: [
        { scope: 'user', status: 'ok', names: ['Schema.Tools.addin'], truncated: false },
        { scope: 'machine', status: 'missing', names: [] },
      ],
    });
    expect(result.years[1]?.executable).toBe('notFound');
    expect(JSON.stringify(result)).not.toContain(root);
    expect(readFileSync(join(addins, 'Schema.Tools.addin'), 'utf8')).toBe(
      'not XML and never executed',
    );
  });
  it('marks unavailable roots separately from missing directories', async () => {
    const result = await scanRevit({ programFiles: '', appData: '', programData: '' });
    expect(
      result.years.every(
        (y) => y.executable === 'unavailable' && y.addins.every((a) => a.status === 'unavailable'),
      ),
    ).toBe(true);
  });
  it('bounds manifest lists and excludes unsafe file labels', async () => {
    const root = dir(),
      path = join(root, 'Autodesk', 'Revit', 'Addins', '2026');
    mkdirSync(path, { recursive: true });
    for (let i = 0; i < 205; i++)
      writeFileSync(join(path, `Plugin-${String(i).padStart(3, '0')}.addin`), '');
    const result = await scanRevit({ programFiles: '', appData: root, programData: '' });
    expect(result.years[1]?.addins[0]).toMatchObject({ status: 'ok', truncated: true });
    expect(result.years[1]?.addins[0]?.names).toHaveLength(200);
  });
  it('coalesces reads, caches for a minute and keeps caller mutations out of the cache', async () => {
    vi.useFakeTimers();
    const value = { checkedAt: Date.now(), years: [] },
      read = vi.fn().mockResolvedValue(value),
      service = new RevitInventoryService(read);
    const [a, b] = await Promise.all([service.inspect(), service.inspect()]);
    expect(read).toHaveBeenCalledTimes(1);
    a.checkedAt = 0;
    b.checkedAt = 1;
    expect((await service.inspect()).checkedAt).toBe(value.checkedAt);
    await service.inspect(true);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    await service.inspect();
    expect(read).toHaveBeenCalledTimes(3);
  });
});
describe('Setup persistence and RPC', () => {
  it('requires setup in a fresh profile and migrates existing profiles without interrupting their work', () => {
    const root = dir(),
      fresh = new SettingsStore(join(root, 'fresh.json'));
    expect(fresh.get().onboardingComplete).toBe(false);
    const file = join(root, 'old.json');
    writeFileSync(file, JSON.stringify({ theme: 'dark', autostart: false }));
    const old = new SettingsStore(file);
    expect(old.get()).toMatchObject({ onboardingComplete: true, theme: 'dark', autostart: false });
    old.update({ theme: 'light' });
    expect(new SettingsStore(file).get().onboardingComplete).toBe(true);
  });
  it('an interrupted setup stays pending after restart', () => {
    const file = join(dir(), 'settings.json'),
      store = new SettingsStore(file);
    store.update({ onboardingComplete: false, theme: 'dark' });
    expect(new SettingsStore(file).get().onboardingComplete).toBe(false);
  });
  it('exposes fixed inventory/open commands and only a scoped completion flag with autostart', () => {
    expect(requestValid({ kind: 'setup.inventory' })).toBe(true);
    expect(requestValid({ kind: 'setup.open' })).toBe(true);
    expect(requestValid({ kind: 'setup.finish', epoch: 3, autostart: false })).toBe(true);
    for (const raw of [
      { kind: 'setup.inventory', path: 'arbitrary' },
      { kind: 'setup.finish', autostart: true },
      { kind: 'setup.finish', epoch: 3, autostart: 'yes' },
      { kind: 'setup.finish', epoch: 3, autostart: true, onboardingComplete: true },
    ])
      expect(requestValid(raw)).toBe(false);
  });
});
