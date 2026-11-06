import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StartMenuShortcut, startShortcutPath } from '../../src/main/desktop/startMenu';
import { requestValid } from '../../src/shared/requests';

const ROAMING = resolve('/', 'Users', 'Иванова', 'AppData', 'Roaming');
const LNK = join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Schema Teams.lnk');

describe('ярлык «Пуска»', () => {
  it('путь — ярлык установщика в %APPDATA%, без переменной — appData Electron', () => {
    expect(startShortcutPath({ APPDATA: ROAMING }, '/unused')).toBe(LNK);
    expect(startShortcutPath({}, ROAMING)).toBe(LNK);
    // относительная переменная не принимается
    expect(startShortcutPath({ APPDATA: 'relative' }, ROAMING)).toBe(LNK);
  });

  it('показывает в Проводнике только существующий ярлык', () => {
    const reveal = vi.fn();
    const present = new StartMenuShortcut({ path: () => LNK, reveal, exists: (p) => p === LNK });
    expect(present.status()).toEqual({ shortcut: true });
    expect(present.reveal()).toBe(true);
    expect(reveal).toHaveBeenCalledExactlyOnceWith(LNK);

    const missing = new StartMenuShortcut({ path: () => LNK, reveal, exists: () => false });
    expect(missing.status()).toEqual({ shortcut: false });
    expect(missing.reveal()).toBe(false);
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('ошибка чтения — как отсутствие ярлыка', () => {
    const reveal = vi.fn();
    const broken = new StartMenuShortcut({
      path: () => LNK,
      reveal,
      exists: () => {
        throw Error('private-path');
      },
    });
    expect(broken.status()).toEqual({ shortcut: false });
    expect(broken.reveal()).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('запросы окна — без пути и лишних полей', () => {
    expect(requestValid({ kind: 'startMenu.status' })).toBe(true);
    expect(requestValid({ kind: 'startMenu.reveal' })).toBe(true);
    for (const raw of [
      { kind: 'startMenu.reveal', path: 'C:/Windows/System32' },
      { kind: 'startMenu.reveal', epoch: 1 },
      { kind: 'startMenu.status', shortcut: true },
      { kind: 'startMenu.pin' },
    ])
      expect(requestValid(raw)).toBe(false);
  });
});
