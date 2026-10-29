import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preferencesPatchValid } from '../../src/shared/preferences';
import { requestValid } from '../../src/shared/requests';
import { SettingsStore } from '../../src/main/settings';
import { applyAutostart, autostartAvailable } from '../../src/main/desktop/autostart';
describe('Local preferences: narrow schema and durable state', () => {
  it.each([
    { autostart: false },
    { theme: 'dark' },
    { notifications: { enabled: false } },
    { notifications: { sound: false, preview: true } },
  ])('accepts only supported settings %j', (patch) => {
    expect(preferencesPatchValid(patch)).toBe(true);
    expect(requestValid({ kind: 'settings.patch', patch })).toBe(true);
  });
  it.each([
    {},
    null,
    [],
    { serverUrl: 'https://example.test' },
    { token: 'secret' },
    { timerReminderSeen: {} },
    { autostart: 1 },
    { theme: {} },
    { theme: 'blue' },
    { notifications: {} },
    { notifications: { enabled: 'yes' } },
    { notifications: { sound: false, path: 'private' } },
    { notifications: [] },
  ])('rejects unsupported input %j', (patch) => {
    expect(preferencesPatchValid(patch)).toBe(false);
    expect(requestValid({ kind: 'settings.patch', patch })).toBe(false);
  });
  it('device settings and logs accept no hidden path/URL/epoch fields', () => {
    expect(requestValid({ kind: 'settings.open', tab: 'about' })).toBe(true);
    expect(requestValid({ kind: 'settings.read' })).toBe(true);
    expect(requestValid({ kind: 'logs.open' })).toBe(true);
    for (const value of [
      { kind: 'logs.open', path: 'private' },
      { kind: 'logs.open', epoch: 1 },
      { kind: 'settings.open', tab: 'secret' },
      { kind: 'settings.read', url: 'https://example.test' },
    ])
      expect(requestValid(value)).toBe(false);
  });
  it('failed disk write preserves both in-memory and saved settings', () => {
    const folder = mkdtempSync(join(tmpdir(), 'stdesk-pref-store-')),
      path = join(folder, 'settings.json'),
      store = new SettingsStore(path);
    store.update({ theme: 'dark' });
    const before = readFileSync(path, 'utf8');
    mkdirSync(`${path}.tmp`);
    expect(() => store.update({ theme: 'light', autostart: false })).toThrow();
    expect(store.get().theme).toBe('dark');
    expect(store.get().autostart).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(new SettingsStore(path).get().theme).toBe('dark');
  });
});
describe('Windows autostart uses the established hidden argument and excludes fixtures', () => {
  it('installed application applies on/off with --hidden', () => {
    const backend = { isPackaged: true, setLoginItemSettings: vi.fn() };
    expect(autostartAvailable(backend)).toBe(true);
    applyAutostart(backend, true);
    applyAutostart(backend, false);
    expect(backend.setLoginItemSettings.mock.calls).toEqual([
      [{ openAtLogin: true, args: ['--hidden'] }],
      [{ openAtLogin: false, args: ['--hidden'] }],
    ]);
  });
  it('development and isolated packaged profiles never write Windows startup', () => {
    const backend = { isPackaged: false, setLoginItemSettings: vi.fn() };
    applyAutostart(backend, true);
    expect(autostartAvailable(backend)).toBe(false);
    backend.isPackaged = true;
    applyAutostart(backend, true, 'C:/fixture-profile');
    expect(autostartAvailable(backend, 'C:/fixture-profile')).toBe(false);
    expect(backend.setLoginItemSettings).not.toHaveBeenCalled();
  });
});
