import { existsSync, renameSync } from 'node:fs';

/**
 * Карантин испорченного файла состояния: файл не удаляется, а переименовывается
 * в `<имя>.corrupt-<время>`, чтобы его можно было разобрать вручную. Возвращает
 * новое имя; ошибка переименования пробрасывается — тогда хранилище остаётся
 * заблокированным и прежний файл не перезаписывается.
 */
export function quarantineFile(file: string, now = Date.now()): string {
  const stamp = new Date(Number.isFinite(now) ? now : Date.now())
    .toISOString()
    .replace(/[:.]/g, '-');
  // Прежний карантин не затирается: rename в Windows заменяет существующий файл.
  let target = `${file}.corrupt-${stamp}`;
  for (let n = 1; existsSync(target); n++) target = `${file}.corrupt-${stamp}-${n}`;
  renameSync(file, target);
  return target;
}

/** Ошибка содержимого (размер, разбор, схема), а не чтения диска. */
export class CorruptStateError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CorruptStateError';
  }
}

/** Оставляет только известные ключи: поля более новой версии не считаются порчей. */
export function knownKeys<T extends object>(
  raw: Record<string, unknown>,
  keys: readonly string[],
): T {
  const result: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(raw, key)) result[key] = raw[key];
  return result as T;
}

export interface RecoverableStorage {
  /** null — файла нет; CorruptStateError — испорченное содержимое; прочее — сбой диска. */
  read(): string | null;
  quarantine?(): string;
}
export type Recovered<T> =
  { kind: 'ok'; value: T | null } | { kind: 'recovered' } | { kind: 'blocked' };

/**
 * Чтение файла состояния с карантином. Сбой диска (нет доступа, файл занят) — не повод
 * сбрасывать данные: хранилище блокируется. Испорченное содержимое переименовывается
 * в `<имя>.corrupt-<время>`, и работа начинается с пустого состояния. Если карантин
 * не удался или хранилище его не умеет — тоже блокировка, прежний файл не трогается.
 */
export function readRecoverable<T>(
  storage: RecoverableStorage,
  parse: (text: string) => T,
): Recovered<T> {
  const quarantine = (): Recovered<T> => {
    if (!storage.quarantine) return { kind: 'blocked' };
    try {
      storage.quarantine();
      return { kind: 'recovered' };
    } catch {
      return { kind: 'blocked' };
    }
  };
  let text: string | null;
  try {
    text = storage.read();
  } catch (error) {
    return error instanceof CorruptStateError ? quarantine() : { kind: 'blocked' };
  }
  if (text === null) return { kind: 'ok', value: null };
  try {
    return { kind: 'ok', value: parse(text) };
  } catch {
    return quarantine();
  }
}
