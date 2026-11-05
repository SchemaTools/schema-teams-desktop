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
});

describe('SettingsStore', () => {
  it('смена темы не теряет настройки пробного таймера прежней сборки', () => {
    const file = join(tmp(), 'settings.json');
    writeFileSync(
      file,
      JSON.stringify({ timer: { pauseOnLock: false, askOnUnlock: false, reminderTime: '17:00' } }),
    );
    new SettingsStore(file).update({ theme: 'dark' });
    expect(new SettingsStore(file).get().timer).toEqual({
      pauseOnLock: false,
      askOnUnlock: false,
      reminderTime: '17:00',
    });
  });
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

describe('Ревью PR #6: таймеры, запущенные с этого компьютера', () => {
  it('хранит только «хеш:пользователь:таймер», без повторов, не больше 32', () => {
    const hash = 'a'.repeat(64);
    const many = Array.from({ length: 40 }, (_, i) => `${hash}:1:${i + 1}`);
    const s = normalizeSettings({
      timerStartedHere: [`${hash}:1:5`, `${hash}:1:5`, 'bad', `${hash}:0:5`, 7, ...many],
    });
    expect(s.timerStartedHere).toHaveLength(32);
    expect(s.timerStartedHere.at(-1)).toBe(`${hash}:1:40`);
    expect(s.timerStartedHere.every((k) => k.startsWith(`${hash}:1:`))).toBe(true);
    expect(DEFAULTS.timerStartedHere).toEqual([]);
  });
});
