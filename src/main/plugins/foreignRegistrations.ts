import { lstat, opendir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { inspectPluginManifest } from './addinManifest';
import { hashFile, key, nodePathSafe, sha } from './transactionFs';

type Year = 2025 | 2026;
export interface ForeignRegistrationOptions {
  /** Main-owned per-user AND machine Addins directories for each selected year. */
  roots: readonly { year: Year; path: string }[];
  desired: readonly { year: Year; addInId: string }[];
  /** Only previously verified receipts may exempt exact known bytes. */
  owned: readonly { year: Year; path: string; sha256: string; size: number }[];
  current: () => boolean;
  pathAllowed: (path: string) => Promise<boolean>;
  inspect?: typeof inspectPluginManifest;
  signal?: AbortSignal;
}
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const missing = (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT';
const yearValid = (year: number) => year === 2025 || year === 2026;
async function boundedEntries(path: string): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  const directory = await opendir(path, { bufferSize: 32 });
  for await (const entry of directory) {
    if (entries.length === 512) throw Error('plugin_directory_limit');
    entries.push(entry);
  }
  return entries;
}

/** Read-only, bounded top-level Revit registration scan. Unsupported XML fails closed.
 * This is an admission observation, not an OS lock against subsequent external changes.
 */
export async function verifyNoForeignAddinIds(
  options: ForeignRegistrationOptions,
): Promise<boolean> {
  try {
    const roots = structuredClone(options.roots),
      desired = structuredClone(options.desired),
      owned = structuredClone(options.owned),
      current = options.current,
      pathAllowed = options.pathAllowed,
      inspect = options.inspect ?? inspectPluginManifest,
      signal = options.signal ?? new AbortController().signal,
      started = performance.now();
    const check = () => {
      if (signal?.aborted || current() !== true || performance.now() - started > 15000)
        throw Error('stale_plugin_scan');
    };
    const guard = async (path: string) => {
      check();
      if ((await pathAllowed(path)) !== true) throw Error('unsafe_plugin_path');
      check();
      await nodePathSafe(path);
      check();
    };
    if (
      roots.length < 1 ||
      roots.length > 4 ||
      desired.length < 1 ||
      desired.length > 128 ||
      owned.length > 128 ||
      roots.some((r) => !yearValid(r.year) || !isAbsolute(r.path) || r.path.includes('\0')) ||
      desired.some(
        (d) =>
          !yearValid(d.year) ||
          !guid.test(d.addInId) ||
          /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(d.addInId),
      ) ||
      owned.some(
        (o) =>
          !yearValid(o.year) ||
          !isAbsolute(o.path) ||
          !sha(o.sha256) ||
          !Number.isSafeInteger(o.size) ||
          o.size < 1 ||
          o.size > 1024 * 1024,
      )
    )
      return false;
    const rootKeys = roots.map((r) => `${r.year}:${key(resolve(r.path))}`),
      ids = desired.map((d) => `${d.year}:${d.addInId}`),
      ownKeys = owned.map((o) => `${o.year}:${key(resolve(o.path))}`);
    if (
      new Set(rootKeys).size !== roots.length ||
      new Set(ids).size !== desired.length ||
      new Set(ownKeys).size !== owned.length ||
      desired.some((d) => !roots.some((r) => r.year === d.year))
    )
      return false;
    // Exemptions cannot name a directory outside this explicit scan boundary.
    if (
      owned.some(
        (o) =>
          !/\.addin$/i.test(o.path) ||
          !roots.some(
            (r) => r.year === o.year && key(dirname(resolve(o.path))) === key(resolve(r.path)),
          ),
      )
    )
      return false;
    const wanted = new Set(ids);
    const observed: { path: string; sha256: string; size: number }[] = [],
      absent: string[] = [];
    const directories: { path: string; dev: bigint; ino: bigint; names: string }[] = [];
    let count = 0,
      total = 0;
    for (const root of roots) {
      const path = resolve(root.path);
      await guard(path);
      let before;
      try {
        before = await lstat(path, { bigint: true });
      } catch (e) {
        if (missing(e)) {
          absent.push(path);
          continue;
        }
        throw e;
      }
      check();
      if (!before.isDirectory() || before.isSymbolicLink()) return false;
      const entries = await boundedEntries(path);
      check();
      if (entries.length > 512) return false;
      const manifests = entries
        .filter((e) => /\.addin$/i.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      count += manifests.length;
      if (count > 128) return false;
      for (const entry of manifests) {
        if (!entry.isFile() || entry.isSymbolicLink()) return false;
        const file = join(path, entry.name);
        await guard(file);
        const bytes = await hashFile(file, 1024 * 1024);
        check();
        total += bytes.size;
        if (total > 8 * 1024 * 1024) return false;
        observed.push({ path: file, ...bytes });
        const exemption = owned.find(
          (o) => o.year === root.year && key(resolve(o.path)) === key(file),
        );
        if (exemption) {
          if (exemption.sha256 !== bytes.sha256 || exemption.size !== bytes.size) return false;
        } else {
          const parsed = await inspect(file, bytes.sha256, signal);
          check();
          if (parsed.some((p) => wanted.has(`${root.year}:${p.addInId}`))) return false;
        }
      }
      await guard(path);
      const after = await lstat(path, { bigint: true }),
        names = (await boundedEntries(path))
          .map((e) => e.name)
          .filter((n) => /\.addin$/i.test(n))
          .sort();
      check();
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        names.join('\0') !==
          manifests
            .map((e) => e.name)
            .sort()
            .join('\0')
      )
        return false;
      directories.push({ path, dev: before.dev, ino: before.ino, names: names.join('\0') });
    }
    for (const file of observed) {
      await guard(file.path);
      const bytes = await hashFile(file.path, 1024 * 1024);
      check();
      if (bytes.sha256 !== file.sha256 || bytes.size !== file.size) return false;
    }
    for (const path of absent) {
      await guard(path);
      try {
        await lstat(path);
        return false;
      } catch (e) {
        if (!missing(e)) throw e;
      }
    }
    // Later roots/native awaits must not hide changes to an earlier directory.
    for (const dir of directories) {
      await guard(dir.path);
      const stat = await lstat(dir.path, { bigint: true }),
        names = (await boundedEntries(dir.path)).map((e) => e.name);
      check();
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== dir.dev ||
        stat.ino !== dir.ino ||
        names.length > 512 ||
        names
          .filter((n) => /\.addin$/i.test(n))
          .sort()
          .join('\0') !== dir.names
      )
        return false;
    }
    check();
    return true;
  } catch {
    return false;
  }
}
