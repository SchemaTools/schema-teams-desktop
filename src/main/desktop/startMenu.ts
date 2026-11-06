// Плитка в «Пуске» (решение руководителя 06.11.2026). Windows не даёт программам закреплять себя
// на начальном экране (команда «Закрепить» из программы — отказ в доступе), поэтому приложение
// только показывает свой ярлык в Проводнике, а закрепляет сотрудник сам. Путь — единственный:
// ярлык, который создаёт установщик для текущего пользователя (electron-builder: perMachine false,
// shortcutName «Schema Teams»). Окно путь не передаёт и не получает.
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const START_SHORTCUT_NAME = 'Schema Teams.lnk';

/**
 * `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Schema Teams.lnk`. Переменную APPDATA Windows
 * задаёт каждому сеансу (как LOCALAPPDATA в localData.ts); без неё — папка appData Electron.
 */
export function startShortcutPath(env: NodeJS.ProcessEnv, appData: string): string {
  const roaming = env.APPDATA && isAbsolute(env.APPDATA) ? env.APPDATA : appData;
  return join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', START_SHORTCUT_NAME);
}

export interface StartMenuOptions {
  path: () => string;
  reveal: (path: string) => void;
  exists?: (path: string) => boolean;
}

export class StartMenuShortcut {
  constructor(private readonly o: StartMenuOptions) {}

  /** Есть ли ярлык установщика: без него (запуск без установки) кнопку не показываем. */
  status(): { shortcut: boolean } {
    return { shortcut: this.present() !== null };
  }

  /** Открыть Проводник с выделенным ярлыком; false — ярлыка нет. */
  reveal(): boolean {
    const path = this.present();
    if (path === null) return false;
    this.o.reveal(path);
    return true;
  }

  private present(): string | null {
    try {
      const path = this.o.path();
      return (this.o.exists ?? existsSync)(path) ? path : null;
    } catch {
      return null;
    }
  }
}
