import {
  createReadStream,
  renameSync,
  mkdirSync,
  unlinkSync,
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  type BigIntStats,
} from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { join, resolve, isAbsolute, dirname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function relativeSafe(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1024 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /[\p{Cc}\p{Cf}\p{Cs}:*?"<>|]/u.test(value)
  )
    return false;
  return value
    .split('/')
    .every(
      (p) =>
        p.length > 0 &&
        p.length <= 200 &&
        p !== '.' &&
        p !== '..' &&
        !/[. ]$/.test(p) &&
        !/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p),
    );
}
export const key = (path: string) => path.toLowerCase();
export function ownedPath(root: string, relative: string): string {
  if (
    typeof root !== 'string' ||
    root.length > 32760 ||
    !isAbsolute(root) ||
    root.includes('\0') ||
    !relativeSafe(relative)
  )
    throw Error('unsafe_path');
  const base = resolve(root),
    target = resolve(base, ...relative.split('/'));
  if (!key(target).startsWith(key(base + sep))) throw Error('unsafe_path');
  return target;
}
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
export async function existingFile(path: string): Promise<{ sha256: string; size: number } | null> {
  try {
    return await hashFile(path);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null;
    throw e;
  }
}
/** Only exact owned manifests, bounded reads and no await between final liveness and unlink. */
export async function removeOwnedManifest(
  path: string,
  expected: { sha256: string; size: number },
  guard: (path: string) => Promise<void>,
  current: () => boolean,
): Promise<void> {
  if (
    !sha(expected.sha256) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 1 ||
    expected.size > 1024 * 1024
  )
    throw Error('invalid_manifest');
  await guard(path);
  if (!current()) throw Error('stale_scope');
  const original = lstatSync(path, { bigint: true });
  if (
    !original.isFile() ||
    original.isSymbolicLink() ||
    original.nlink !== 1n ||
    original.size !== BigInt(expected.size)
  )
    throw Error('target_changed');
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== original.dev || opened.ino !== original.ino) throw Error('target_changed');
    const bytes = Buffer.alloc(expected.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, count);
      if (!n) break;
      count += n;
    }
    if (
      count !== expected.size ||
      createHash('sha256').update(bytes.subarray(0, count)).digest('hex') !== expected.sha256
    )
      throw Error('target_changed');
  } finally {
    closeSync(fd);
  }
  const final = lstatSync(path, { bigint: true });
  if (
    !final.isFile() ||
    final.isSymbolicLink() ||
    final.dev !== original.dev ||
    final.ino !== original.ino ||
    final.size !== original.size
  )
    throw Error('target_changed');
  if (!current()) throw Error('stale_scope');
  unlinkSync(path);
}
/** Copy+fsync to exclusive sibling, verify bytes, then single-file rename. Never removes the old target first. */
export async function atomicCopy(
  source: string,
  target: string,
  expected: { sha256: string; size: number },
  guard: (path: string) => Promise<void>,
  current: () => boolean = () => true,
): Promise<void> {
  await guard(source);
  await guard(target);
  const before = await hashFile(source);
  if (before.sha256 !== expected.sha256 || before.size !== expected.size)
    throw Error('source_changed');
  if (!current()) throw Error('stale_scope');
  mkdirSync(dirname(target), { recursive: true });
  await guard(target);
  if (!current()) throw Error('stale_scope');
  const temp = join(dirname(target), `.schema-${randomUUID()}.part`);
  let file: Awaited<ReturnType<typeof open>> | undefined,
    id: { dev: bigint; ino: bigint } | undefined;
  const own = () => {
    try {
      const stat = lstatSync(temp, { bigint: true });
      return stat.isFile() && !stat.isSymbolicLink() && id?.dev === stat.dev && id.ino === stat.ino;
    } catch {
      return false;
    }
  };
  try {
    file = await open(temp, 'wx', 0o600);
    id = await file.stat({ bigint: true });
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(source)) {
      if (!current()) throw Error('stale_scope');
      size += chunk.length;
      if (size > expected.size) throw Error('source_changed');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        if (!current()) throw Error('stale_scope');
        const r = await file.write(chunk, offset, chunk.length - offset);
        if (!r.bytesWritten) throw Error('write_failed');
        offset += r.bytesWritten;
      }
    }
    if (size !== expected.size || hash.digest('hex') !== expected.sha256)
      throw Error('source_changed');
    if (!current()) throw Error('stale_scope');
    await file.sync();
    await file.close();
    file = undefined;
    const copied = await hashFile(temp);
    if (copied.sha256 !== expected.sha256 || copied.size !== expected.size)
      throw Error('copy_changed');
    await guard(target);
    if (!current()) throw Error('stale_scope');
    if (!own()) throw Error('copy_changed');
    renameSync(temp, target);
  } finally {
    await file?.close().catch(() => {});
    if (current() && own())
      try {
        unlinkSync(temp);
      } catch {
        // Preserve the operation outcome; an owned orphan can be inspected later.
      }
  }
}
