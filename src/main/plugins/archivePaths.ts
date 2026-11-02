import { lstat, realpath, readdir, unlink, rmdir } from 'node:fs/promises';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';

export class PluginArchiveError extends Error {
  constructor(public readonly code: string) {
    super(`Plugin archive rejected: ${code}`);
    this.name = 'PluginArchiveError';
  }
}
export function reject(code: string): never {
  throw new PluginArchiveError(code);
}

/** Deliberately bounded ASCII Win32 subset; unsupported Unicode is rejected, not guessed. */
export function safeArchiveRelativePath(value: string, directory = false): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 240 ||
    /[^\x20-\x7e]/.test(value) ||
    /[\\:<>"|?*]/.test(value) ||
    value.startsWith('/')
  )
    reject('path');
  const path = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = path.split('/');
  if (
    segments.length > 16 ||
    segments.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        part.length > 100 ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(\.|$)/i.test(part),
    )
  )
    reject('path');
  return path;
}

export function containedPath(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) reject('containment');
  return full;
}

function key(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** No symlink/junction ancestor and no canonical alias. Caller supplies an existing private parent. */
export async function assertOrdinaryDirectory(path: string): Promise<void> {
  const full = resolve(path);
  if (!isAbsolute(path)) reject('parent');
  let current = parse(full).root;
  for (const part of full.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject('reparse');
  }
  if (key(await realpath(full)) !== key(full)) reject('canonical');
}

/** Called only with this invocation's freshly created root and known parent.
 * No recursive rm: inspect every node and never descend into links/junctions.
 */
export async function removeOwnedTree(root: string, parent: string): Promise<void> {
  if (
    resolve(root) !== containedPath(resolve(parent), root) ||
    !relative(parent, root).startsWith('schema-plugin-') ||
    relative(parent, root).includes(sep)
  )
    reject('cleanup-ownership');
  await assertOrdinaryDirectory(parent);
  async function remove(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) reject('cleanup-reparse');
    if (stat.isDirectory()) {
      await assertOrdinaryDirectory(path);
      for (const name of await readdir(path)) await remove(containedPath(path, name));
      await rmdir(path);
    } else if (stat.isFile()) await unlink(path);
    else reject('cleanup-type');
  }
  await remove(root);
}
