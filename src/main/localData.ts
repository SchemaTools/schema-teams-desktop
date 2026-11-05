import { basename, isAbsolute, join } from 'node:path';

/**
 * Папка в %LOCALAPPDATA%, а не в перемещаемом профиле Roaming: большие файлы
 * (установщик, сборки плагинов) не должны уезжать с профилем на сервер. В Electron 44
 * нет app.getPath для Local (sessionData по умолчанию совпадает с userData), а путь
 * «appData\..\Local» ломается при перенаправлении Roaming, поэтому берётся переменная
 * LOCALAPPDATA, которую Windows задаёт каждому сеансу. Имя подпапки — как у профиля
 * (`Schema Teams`). Без переменной — папка в userData.
 */
export function localDataPath(name: string, env: NodeJS.ProcessEnv, userData: string): string {
  const local = env.LOCALAPPDATA;
  return local && isAbsolute(local) ? join(local, basename(userData), name) : join(userData, name);
}
