import { lstat, mkdir, mkdtemp, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import { desktopRelease } from '../api/updates';
import { nodePathSafe } from '../plugins/fsSafe';
import type { DesktopRelease } from '../../shared/updates';

export const DESKTOP_MAX_BYTES = 512 * 1024 * 1024;
/** Нет ни одного байта столько времени — загрузка прерывается (медленная, но живая сеть — нет). */
export const DESKTOP_IDLE_TIMEOUT_MS = 60 * 1000;
/** Общий потолок: 512 МиБ за 30 минут — около 0,3 МиБ/с, хватает и для удалённой работы. */
export const DESKTOP_TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
export interface DesktopDownloadProgress {
  readonly bytes: number;
  readonly total: number;
  readonly fraction: number;
  /** Size/SHA integrity only. Never publisher verification or permission to execute. */
  readonly verified: boolean;
}
export interface DesktopDownloadOptions {
  serverOrigin: string;
  root: string;
  current: (release: Readonly<DesktopRelease>, serverOrigin: string) => boolean;
  signal?: AbortSignal;
  onProgress?: (progress: Readonly<DesktopDownloadProgress>) => void;
  /** Общий потолок всей загрузки, не больше DESKTOP_TOTAL_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Простой: столько нет ответа или очередной порции данных, не больше timeoutMs. */
  idleTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}
/** Main-memory receipt only; never an installer permission or restart handoff. */
export interface DesktopDownloadReceipt {
  readonly operationId: string;
  readonly serverOrigin: string;
  readonly release: Readonly<DesktopRelease>;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface Identity {
  dev: bigint;
  ino: bigint;
}
export interface DesktopDownloadIdentity extends Identity {
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}
interface CompletedDownload {
  root: string;
  directory: string;
  rootIdentity: Identity;
  directoryIdentity: Identity;
  fileIdentity: DesktopDownloadIdentity;
  safe: () => Promise<void>;
  state: 'ready' | 'claimed' | 'retained' | 'deleting';
  holder?: symbol;
}
const completedDownloads = new WeakMap<DesktopDownloadReceipt, CompletedDownload>();
/** Папки загрузок этого запуска: уборка старых их не трогает, даже если загрузка ещё идёт. */
const sessionDirectories = new Set<string>();
/** Main-only lease. Cleanup cannot remove an artifact during validation/handoff. */
export function claimDesktopDownload(receipt: DesktopDownloadReceipt): Readonly<{
  identity: Readonly<DesktopDownloadIdentity>;
  finish: (spawned: boolean) => boolean;
}> | null {
  const entry = completedDownloads.get(receipt);
  if (!entry || entry.state !== 'ready') return null;
  const token = Symbol('desktop-handoff');
  entry.state = 'claimed';
  entry.holder = token;
  let finished = false;
  return Object.freeze({
    identity: Object.freeze({ ...entry.fileIdentity }),
    finish: (spawned: boolean) => {
      if (
        finished ||
        entry.state !== 'claimed' ||
        entry.holder !== token ||
        typeof spawned !== 'boolean'
      )
        return false;
      finished = true;
      entry.holder = undefined;
      entry.state = spawned ? 'retained' : 'ready';
      return true;
    },
  });
}
/** Only an original receipt can discard exact owned bytes. Handed-off files stay. */
export async function discardDesktopDownload(receipt: DesktopDownloadReceipt): Promise<boolean> {
  const entry = completedDownloads.get(receipt);
  if (!entry || entry.state !== 'ready') return false;
  entry.state = 'deleting';
  let removed = false;
  try {
    await entry.safe();
    const before = await lstat(receipt.file, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      !same(entry.fileIdentity, before) ||
      before.size !== BigInt(receipt.bytes) ||
      before.size > BigInt(DESKTOP_MAX_BYTES)
    )
      return false;
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(receipt.file)) {
      size += chunk.length;
      if (size > receipt.bytes) return false;
      hash.update(chunk);
    }
    if (size !== receipt.bytes || hash.digest('hex') !== receipt.sha256) return false;
    await entry.safe();
    const root = lstatSync(entry.root, { bigint: true }),
      dir = lstatSync(entry.directory, { bigint: true }),
      file = lstatSync(receipt.file, { bigint: true });
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      !same(entry.rootIdentity, root) ||
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      !same(entry.directoryIdentity, dir) ||
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1n ||
      !same(entry.fileIdentity, file) ||
      file.size !== before.size ||
      file.mtimeNs !== before.mtimeNs ||
      file.ctimeNs !== before.ctimeNs
    )
      return false;
    // No await from final identity checks through unlink. Nonrecursive rmdir
    // deliberately leaves a directory containing foreign entries untouched.
    unlinkSync(receipt.file);
    removed = true;
    completedDownloads.delete(receipt);
    try {
      rmdirSync(entry.directory);
    } catch {
      /* Preserve foreign entries or a locked directory. */
    }
    return true;
  } catch {
    return false;
  } finally {
    if (!removed) entry.state = 'ready';
  }
}
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const key = (path: string) => resolve(path).toLowerCase();
/**
 * Путь не переадресован ни одним компонентом (junction, симлинк, subst). Сравнение
 * с realpath — через общую проверку плагинов: короткое имя 8.3 (TEMP вида
 * `C:\Users\ABCDEF~1`) переадресацией не считается.
 */
const notRedirected = async (path: string) => {
  try {
    await nodePathSafe(path);
    return true;
  } catch {
    return false;
  }
};
const contained = (root: string, child: string) => {
  const value = relative(root, child);
  return !!value && !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};
async function statOrNull(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
/** Reject existing symlink/junction ancestors BEFORE recursive mkdir. */
async function safeAncestors(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await safeAncestors(parent);
  const stat = await statOrNull(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('download_root');
}

/** One public same-origin stream. The future controller owns double-click coalescing. */
export async function downloadDesktopRelease(
  raw: unknown,
  options: DesktopDownloadOptions,
): Promise<Readonly<DesktopDownloadReceipt>> {
  // All caller-controlled metadata, options and callback references are owned before first await.
  const release = Object.freeze(desktopRelease(raw));
  const root = resolve(options.root);
  const current = options.current;
  const onProgress = options.onProgress;
  const externalSignal = options.signal;
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DESKTOP_TOTAL_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? Math.min(DESKTOP_IDLE_TIMEOUT_MS, timeoutMs);
  const suppliedOrigin = options.serverOrigin;
  const origin = new URL(suppliedOrigin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    ![origin.origin, `${origin.origin}/`].includes(suppliedOrigin) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > DESKTOP_TOTAL_TIMEOUT_MS ||
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs < 1 ||
    idleTimeoutMs > timeoutMs ||
    typeof current !== 'function' ||
    typeof fetcher !== 'function' ||
    (onProgress !== undefined && typeof onProgress !== 'function') ||
    release.size > DESKTOP_MAX_BYTES
  )
    throw Error('download_options');
  const serverOrigin = origin.origin;
  const url = new URL(release.url, serverOrigin).href;
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  // Простой отсчитывается заново после ответа сервера и после каждой порции данных.
  let idleTimer = setTimeout(abort, idleTimeoutMs);
  const alive = () => {
    clearTimeout(idleTimer);
    if (!controller.signal.aborted) idleTimer = setTimeout(abort, idleTimeoutMs);
  };
  let directory: string | undefined;
  let directoryIdentity: Identity | undefined;
  let rootIdentity: Identity | undefined;
  const ownedFiles = new Map<string, Identity>();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  const check = () => {
    if (controller.signal.aborted) throw Error('download_aborted');
    let valid = false;
    try {
      valid = current(release, serverOrigin) === true;
    } catch {
      /* Fail closed. */
    }
    if (!valid) {
      abort();
      throw Error('download_stale');
    }
  };
  const wait = async <T>(work: Promise<T>): Promise<T> => {
    let listener = () => {};
    try {
      return await Promise.race([
        work,
        new Promise<never>((_yes, no) => {
          listener = () => no(Error('download_aborted'));
          controller.signal.addEventListener('abort', listener, { once: true });
          if (controller.signal.aborted) listener();
        }),
      ]);
    } finally {
      controller.signal.removeEventListener('abort', listener);
    }
  };
  const progress = (bytes: number, verified = false) => {
    try {
      onProgress?.(
        Object.freeze({
          bytes,
          total: release.size,
          fraction: verified ? 1 : Math.min(bytes / release.size, 0.999999999),
          verified,
        }),
      );
    } catch {
      /* Progress observers cannot turn a completed write into a new operation. */
    }
  };
  const safeDirectory = async () => {
    if (!directory || !directoryIdentity || !rootIdentity || !contained(root, directory))
      throw Error('download_root');
    await safeAncestors(root);
    const rootStat = await lstat(root, { bigint: true });
    const stat = await lstat(directory, { bigint: true });
    if (
      !same(rootIdentity, rootStat) ||
      !same(directoryIdentity, stat) ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      !(await notRedirected(root)) ||
      !(await notRedirected(directory))
    )
      throw Error('download_root');
  };
  try {
    check();
    const fetched = fetcher(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      signal: controller.signal,
    }).then((value) => {
      if (controller.signal.aborted) {
        void value.body?.cancel().catch(() => {});
        throw Error('download_aborted');
      }
      return value;
    });
    response = await wait(fetched);
    alive();
    check();
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url))
      throw Error('download_http');
    const length = response.headers.get('content-length');
    if (
      !length ||
      !/^[1-9]\d*$/.test(length) ||
      !Number.isSafeInteger(Number(length)) ||
      Number(length) !== release.size ||
      Number(length) > DESKTOP_MAX_BYTES
    )
      throw Error('download_size');
    if (!response.body) throw Error('download_empty');
    reader = response.body.getReader();
    await safeAncestors(root);
    check();
    await mkdir(root, { recursive: true });
    check();
    await safeAncestors(root);
    check();
    if (!(await notRedirected(root))) throw Error('download_root');
    check();
    rootIdentity = await lstat(root, { bigint: true });
    check();
    directory = await mkdtemp(join(root, 'desktop-'));
    sessionDirectories.add(key(directory));
    directoryIdentity = await lstat(directory, { bigint: true });
    check();
    await safeDirectory();
    check();
    const part = join(directory, 'installer.part');
    const target = join(directory, 'installer.exe');
    const file = await open(part, 'wx', 0o600);
    let received = 0;
    const hash = createHash('sha256');
    try {
      ownedFiles.set(part, await file.stat({ bigint: true }));
      check();
      while (true) {
        const chunk = await wait(reader.read());
        alive();
        check();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > release.size || received > DESKTOP_MAX_BYTES)
          throw Error('download_overflow');
        hash.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          await safeDirectory();
          check();
          const written = await file.write(chunk.value, offset, chunk.value.byteLength - offset);
          check();
          if (
            !Number.isSafeInteger(written.bytesWritten) ||
            written.bytesWritten <= 0 ||
            written.bytesWritten > chunk.value.byteLength - offset
          )
            throw Error('download_write');
          offset += written.bytesWritten;
        }
        progress(received);
        check();
      }
      if (received !== release.size) throw Error('download_size');
      if (hash.digest('hex') !== release.sha256) throw Error('download_hash');
      await file.sync();
      check();
    } finally {
      await file.close();
    }
    check();
    await safeDirectory();
    check();
    if (await statOrNull(target)) throw Error('download_target');
    check();
    const partIdentity = ownedFiles.get(part);
    if (!partIdentity || !same(partIdentity, await lstat(part, { bigint: true })))
      throw Error('download_part');
    check();
    await rename(part, target);
    ownedFiles.delete(part);
    ownedFiles.set(target, partIdentity);
    check();
    const targetStat = await lstat(target, { bigint: true });
    check();
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || !same(partIdentity, targetStat))
      throw Error('download_target');
    await safeDirectory();
    check();
    const receipt = Object.freeze({
      operationId: randomUUID(),
      serverOrigin,
      release,
      file: target,
      bytes: received,
      sha256: release.sha256,
    });
    progress(received, true);
    check();
    if (!directoryIdentity || !rootIdentity) throw Error('download_root');
    completed = true;
    completedDownloads.set(receipt, {
      root,
      directory,
      rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
      directoryIdentity: { dev: directoryIdentity.dev, ino: directoryIdentity.ino },
      fileIdentity: {
        dev: partIdentity.dev,
        ino: partIdentity.ino,
        mtimeNs: targetStat.mtimeNs,
        ctimeNs: targetStat.ctimeNs,
      },
      safe: safeDirectory,
      state: 'ready',
    });
    return receipt;
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    externalSignal?.removeEventListener('abort', abort);
    abort();
    if (reader) void reader.cancel().catch(() => {});
    else if (response) void response.body?.cancel().catch(() => {});
    if (!completed && directory) {
      try {
        await safeDirectory();
        for (const [path, identity] of ownedFiles) {
          const stat = await statOrNull(path);
          if (
            contained(directory, path) &&
            stat?.isFile() &&
            !stat.isSymbolicLink() &&
            same(identity, stat)
          )
            await unlink(path);
        }
        await rmdir(directory); // Nonrecursive: foreign files/directories are never removed.
      } catch {
        /* Replaced paths or foreign entries are preserved, never recursively removed. */
      }
    }
  }
}

const STALE_FILES = new Set(['installer.part', 'installer.exe']);
/**
 * Уборка при запуске: папки `desktop-*` прежних запусков (недокачанные и переданные
 * установщику файлы) копятся по 100+ МиБ. Удаляются только свои имена файлов —
 * обычные файлы без жёстких ссылок, затем папка без рекурсии; чужое, ссылки и
 * занятые файлы (установщик ещё работает) остаются. Папки текущего запуска не трогаются.
 * Возвращает число удалённых папок; ошибки не выходят наружу.
 */
export async function cleanupDesktopDownloads(root: string): Promise<number> {
  let removed = 0;
  try {
    const base = resolve(root);
    await safeAncestors(base);
    const baseStat = await statOrNull(base);
    if (!baseStat?.isDirectory() || baseStat.isSymbolicLink()) return 0;
    if (!(await notRedirected(base))) return 0;
    for (const name of await readdir(base)) {
      const directory = join(base, name);
      if (!/^desktop-[A-Za-z0-9]{6}$/.test(name) || sessionDirectories.has(key(directory)))
        continue;
      try {
        const stat = await lstat(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        for (const file of await readdir(directory)) {
          const path = join(directory, file);
          const info = await lstat(path, { bigint: true });
          if (STALE_FILES.has(file) && info.isFile() && !info.isSymbolicLink() && info.nlink === 1n)
            await unlink(path);
        }
        // Повторная сверка папки перед rmdir: подменённую ссылку не удаляем.
        if (!same(stat, await lstat(directory, { bigint: true }))) continue;
        await rmdir(directory);
        removed++;
      } catch {
        /* Занятый файл или чужое содержимое — папка остаётся до следующего запуска. */
      }
    }
  } catch {
    /* Нет папки или она недоступна — убирать нечего. */
  }
  return removed;
}
