import { createReadStream, type BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
/** Общие проверки путей и файлов для плагинов и обновлений приложения. */
export const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const key = (path: string) => path.toLowerCase();
/**
 * Компонент не переадресован, если realpath отличается от него только написанием:
 * регистром или коротким именем Windows 8.3 (`C:\Users\ABCDEF~1`). Тогда realpath
 * лежит в той же (уже развёрнутой) родительской папке и это тот же объект ФС —
 * совпадают том и номер файла у lstat без перехода по ссылке. У junction и
 * симлинка lstat даёт сам объект-ссылку, а не цель, поэтому номер не совпадёт;
 * корень тома (в том числе диск subst) по-прежнему сравнивается только точно.
 */
async function sameObjectAlias(cursor: string, actual: string, own: BigIntStats): Promise<boolean> {
  const parent = dirname(cursor);
  if (parent === cursor) return false;
  if (key(dirname(actual)) !== key(resolve(await realpath(parent)))) return false;
  const target = await lstat(actual, { bigint: true });
  // Номер 0 (ФС без номеров файлов) не доказывает тождество.
  return (
    own.ino !== 0n && !target.isSymbolicLink() && own.ino === target.ino && own.dev === target.dev
  );
}
/** Ни один существующий компонент пути не ссылка, не junction и не переадресован. */
export async function nodePathSafe(path: string): Promise<void> {
  let cursor = resolve(path);
  while (true) {
    try {
      // На Windows lstat помечает isSymbolicLink и симлинки, и junction (точки монтирования).
      const s = await lstat(cursor, { bigint: true });
      if (s.isSymbolicLink()) throw Error('reparse_path');
      const actual = resolve(await realpath(cursor));
      if (key(actual) !== key(cursor) && !(await sameObjectAlias(cursor, actual, s)))
        throw Error('reparse_path');
    } catch (e) {
      if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'ENOENT') throw e;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
export async function hashFile(
  path: string,
  limit = 1024 * 1024 * 1024,
): Promise<{ sha256: string; size: number }> {
  await nodePathSafe(path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > limit) throw Error('invalid_file');
  const h = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    size += bytes.length;
    if (size > limit) throw Error('invalid_file');
    h.update(bytes);
  }
  if (size !== stat.size) throw Error('file_changed');
  return { sha256: h.digest('hex'), size };
}
