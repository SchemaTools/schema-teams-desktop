import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, normalizeSettings, SettingsStore, ZOOM_MAX } from '../../src/main/settings';

const tmp = () => mkdtempSync(join(tmpdir(), 'st-'));

describe('normalizeSettings', () => {
  it('пустое и мусор — настройки по умолчанию, автозапуск включён', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULTS);
    expect(normalizeSettings('x')).toEqual(DEFAULTS);
    expect(DEFAULTS.autostart).toBe(true);
  });
  it('негодные поля отбрасываются, масштаб ограничивается', () => {
    const s = normalizeSettings({
      autostart: 'да',
      zoomLevel: 99,
      window: { bounds: { x: 1, y: 2, width: 'w' }, maximized: true },
      extra: 1,
    });
    expect(s.autostart).toBe(true);
    expect(s.zoomLevel).toBe(ZOOM_MAX);
    expect(s.window).toEqual({ maximized: true });
    expect(s).not.toHaveProperty('extra');
  });
  it('настройки времени мигрируют независимо и принимают только получасовые значения', () => {
    for (const reminderTime of ['24:00', '9:00', '18:15', null, 1830])
      expect(normalizeSettings({ timer: { reminderTime } }).timer.reminderTime).toBe('18:30');
    expect(
      normalizeSettings({ timer: { reminderTime: '09:00', pauseOnLock: false } }).timer,
    ).toEqual({ reminderTime: '09:00', pauseOnLock: false, askOnUnlock: true });
    const first = normalizeSettings(null);
    first.timer.reminderTime = '08:00';
    expect(normalizeSettings(null).timer.reminderTime).toBe('18:30');
  });
});

describe('SettingsStore', () => {
  it('сохраняет и читает после перезапуска', () => {
    const file = join(tmp(), 'sub', 'settings.json');
    new SettingsStore(file).update({ autostart: false, trayHintShown: true });
    const again = new SettingsStore(file).get();
    expect(again.autostart).toBe(false);
    expect(again.trayHintShown).toBe(true);
  });
  it('испорченный файл не роняет приложение', () => {
    const file = join(tmp(), 'settings.json');
    writeFileSync(file, '{ не json');
    expect(new SettingsStore(file).get()).toEqual(DEFAULTS);
  });
  it('пишет читаемый JSON', () => {
    const file = join(tmp(), 'settings.json');
    new SettingsStore(file).update({ zoomLevel: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8')).zoomLevel).toBe(1);
  });
});
