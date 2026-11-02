import { createReadStream, createWriteStream } from 'node:fs';
import { open, mkdir, mkdtemp, lstat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, isAbsolute } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import {
  safeArchiveRelativePath,
  containedPath,
  assertOrdinaryDirectory,
  removeOwnedTree,
  reject,
  PluginArchiveError,
} from './archivePaths';
import { validateAddinManifests, type ValidatedAddin } from './addinManifest';

export { PluginArchiveError } from './archivePaths';
export type PluginEntryKind = 'dll' | 'addin' | 'data';
export type ApprovedLayoutDescriptor = Readonly<{
  id: string;
  files: readonly Readonly<{ relativePath: string; kind: PluginEntryKind }>[];
  manifests: readonly Readonly<{
    relativePath: string;
    year: 2025 | 2026;
    addIns: readonly Readonly<{ addInId: string; assemblyRelativePath: string }>[];
  }>[];
}>;
export type PreparedPluginEntry = Readonly<{
  relativePath: string;
  size: number;
  sha256: string;
  kind: PluginEntryKind;
}>;
export type PreparedPluginGeneration = Readonly<{
  generationRoot: string;
  archiveSha256: string;
  layoutId: string;
  entries: readonly PreparedPluginEntry[];
  addins: readonly ValidatedAddin[];
}>;
// No supplied package/catalog/renderer may invent production layout authorization.
export const APPROVED_PLUGIN_LAYOUT: ApprovedLayoutDescriptor | null = null;
export const PLUGIN_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 200 * 1024 * 1024,
  entries: 4096,
  centralBytes: 4 * 1024 * 1024,
  fileBytes: 200 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  ratio: 1000,
  timeoutMs: 30000,
  chunks: 100000,
});
type ZipEntry = {
  name: string;
  directory: boolean;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  dataOffset: number;
  end: number;
};
const sha = /^[a-f0-9]{64}$/;
const owned = new WeakMap<PreparedPluginGeneration, { root: string; parent: string }>();

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let n = index;
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crcUpdate(crc: number, bytes: Buffer): number {
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
  return crc >>> 0;
}
function bounds(offset: number, length: number, size: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > size ||
    length > size - offset
  )
    reject('zip-bounds');
}
async function read(file: FileHandle, at: number, count: number, size: number): Promise<Buffer> {
  bounds(at, count, size);
  const out = Buffer.alloc(count);
  let done = 0;
  while (done < count) {
    const { bytesRead } = await file.read(out, done, count - done, at + done);
    if (!bytesRead) reject('zip-truncated');
    done += bytesRead;
  }
  return out;
}
async function measurePrivateArchive(
  path: string,
  expectedSize: number,
  signal: AbortSignal,
): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== expectedSize)
    reject('private-archive-type');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 65536, signal })) {
    size += chunk.length;
    if (size > PLUGIN_ARCHIVE_LIMITS.compressedBytes || size > expectedSize)
      reject('private-archive-size');
    hash.update(chunk);
  }
  if (size !== expectedSize) reject('private-archive-size');
  return hash.digest('hex');
}

function extra(bytes: Buffer): void {
  let at = 0;
  while (at < bytes.length) {
    bounds(at, 4, bytes.length);
    const id = bytes.readUInt16LE(at),
      length = bytes.readUInt16LE(at + 2);
    at += 4;
    bounds(at, length, bytes.length);
    if (id === 1) reject('unsupported-zip64');
    // Extended/NTFS timestamps are harmless; unknown semantic fields fail closed.
    if (id !== 0x5455 && id !== 0x000a) reject('unsupported-extra');
    at += length;
  }
}
function filename(bytes: Buffer): string {
  if (!bytes.length || bytes.length > 241 || bytes.some((byte) => byte < 32 || byte > 126))
    reject('unsupported-name-encoding');
  return bytes.toString('ascii');
}

async function inspectZip(
  file: FileHandle,
  length: number,
  check: () => void,
  outputBudgetBytes: number,
): Promise<ZipEntry[]> {
  if (length < 22 || length > PLUGIN_ARCHIVE_LIMITS.compressedBytes) reject('archive-size');
  const tailAt = Math.max(0, length - 65557),
    tail = await read(file, tailAt, length - tailAt, length);
  let eocd = -1;
  for (let at = tail.length - 22; at >= 0; at--)
    if (
      tail.readUInt32LE(at) === 0x06054b50 &&
      at + 22 + tail.readUInt16LE(at + 20) === tail.length
    ) {
      eocd = at;
      break;
    }
  if (eocd < 0) reject('zip-eocd');
  const endAt = tailAt + eocd;
  const disk = tail.readUInt16LE(eocd + 4),
    centralDisk = tail.readUInt16LE(eocd + 6),
    diskCount = tail.readUInt16LE(eocd + 8),
    count = tail.readUInt16LE(eocd + 10),
    centralSize = tail.readUInt32LE(eocd + 12),
    centralAt = tail.readUInt32LE(eocd + 16);
  if (
    disk === 0xffff ||
    centralDisk === 0xffff ||
    count === 0xffff ||
    centralSize === 0xffffffff ||
    centralAt === 0xffffffff
  )
    reject('unsupported-zip64');
  if (disk || centralDisk || diskCount !== count) reject('unsupported-multidisk');
  if (
    !count ||
    count > PLUGIN_ARCHIVE_LIMITS.entries ||
    centralSize > PLUGIN_ARCHIVE_LIMITS.centralBytes
  )
    reject('entry-count');
  if (centralAt + centralSize !== endAt) reject('zip-central-bounds');
  const central = await read(file, centralAt, centralSize, length);
  const entries: ZipEntry[] = [],
    paths = new Map<string, boolean>();
  let at = 0,
    total = 0;
  for (let i = 0; i < count; i++) {
    check();
    bounds(at, 46, central.length);
    if (central.readUInt32LE(at) !== 0x02014b50) reject('zip-central');
    const version = central.readUInt16LE(at + 6),
      flags = central.readUInt16LE(at + 8),
      method = central.readUInt16LE(at + 10),
      crc = central.readUInt32LE(at + 16),
      compressed = central.readUInt32LE(at + 20),
      size = central.readUInt32LE(at + 24),
      nameSize = central.readUInt16LE(at + 28),
      extraSize = central.readUInt16LE(at + 30),
      commentSize = central.readUInt16LE(at + 32),
      startDisk = central.readUInt16LE(at + 34),
      attributes = central.readUInt32LE(at + 38),
      offset = central.readUInt32LE(at + 42);
    if (version >= 45 || size === 0xffffffff || compressed === 0xffffffff || offset === 0xffffffff)
      reject('unsupported-zip64');
    if (
      version > 20 ||
      flags & ~0x080e ||
      (method !== 0 && method !== 8) ||
      (method === 0 && flags & 6)
    )
      reject('unsupported-zip-feature');
    if (startDisk) reject('unsupported-multidisk');
    bounds(at + 46, nameSize + extraSize + commentSize, central.length);
    const rawName = central.subarray(at + 46, at + 46 + nameSize),
      sourceName = filename(rawName),
      directory = sourceName.endsWith('/'),
      name = safeArchiveRelativePath(sourceName, directory);
    extra(central.subarray(at + 46 + nameSize, at + 46 + nameSize + extraSize));
    const mode = attributes >>> 16,
      type = mode & 0xf000,
      dos = attributes & 0xffff;
    if (
      (type !== 0 && type !== (directory ? 0x4000 : 0x8000)) ||
      dos & (0x400 | 0x40 | 0x08) ||
      (Boolean(dos & 0x10) !== directory && Boolean(dos & 0x10))
    )
      reject('zip-file-type');
    if (directory && (size || compressed || method || crc)) reject('zip-directory-data');
    if (
      (method === 0 && compressed !== size) ||
      size > PLUGIN_ARCHIVE_LIMITS.fileBytes ||
      size > Math.max(compressed, 1) * PLUGIN_ARCHIVE_LIMITS.ratio
    )
      reject('zip-size');
    total += size;
    if (total > outputBudgetBytes) reject('zip-total');
    const key = name.toLowerCase();
    if (paths.has(key)) reject('zip-duplicate');
    for (const [other, isDirectory] of paths)
      if (
        (key.startsWith(`${other}/`) && !isDirectory) ||
        (other.startsWith(`${key}/`) && !directory)
      )
        reject('zip-file-directory-collision');
    paths.set(key, directory);
    const local = await read(file, offset, 30, centralAt);
    if (
      local.readUInt32LE(0) !== 0x04034b50 ||
      local.readUInt16LE(4) !== version ||
      local.readUInt16LE(6) !== flags ||
      local.readUInt16LE(8) !== method ||
      !local.subarray(10, 14).equals(central.subarray(at + 12, at + 16))
    )
      reject('zip-local-mismatch');
    const localNameSize = local.readUInt16LE(26),
      localExtraSize = local.readUInt16LE(28),
      localCrc = local.readUInt32LE(14),
      localCompressed = local.readUInt32LE(18),
      localSize = local.readUInt32LE(22);
    if (localNameSize !== nameSize) reject('zip-local-name');
    const localVariable = await read(file, offset + 30, localNameSize + localExtraSize, centralAt);
    if (!localVariable.subarray(0, localNameSize).equals(rawName)) reject('zip-local-name');
    extra(localVariable.subarray(localNameSize));
    if (
      flags & 8
        ? (localCrc !== 0 && localCrc !== crc) ||
          (localCompressed !== 0 && localCompressed !== compressed) ||
          (localSize !== 0 && localSize !== size)
        : localCrc !== crc || localCompressed !== compressed || localSize !== size
    )
      reject('zip-local-size');
    const dataOffset = offset + 30 + localNameSize + localExtraSize;
    bounds(dataOffset, compressed, centralAt);
    let end = dataOffset + compressed;
    if (flags & 8) {
      const head = await read(file, end, 4, centralAt),
        signed = head.readUInt32LE(0) === 0x08074b50;
      const descriptor = await read(file, end + (signed ? 4 : 0), 12, centralAt);
      if (
        descriptor.readUInt32LE(0) !== crc ||
        descriptor.readUInt32LE(4) !== compressed ||
        descriptor.readUInt32LE(8) !== size
      )
        reject('zip-descriptor');
      end += signed ? 16 : 12;
    }
    entries.push({
      name,
      directory,
      flags,
      method,
      crc,
      compressed,
      size,
      offset,
      dataOffset,
      end,
    });
    at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== central.length) reject('zip-central-count');
  let next = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset !== next) reject('zip-overlap-or-gap');
    next = entry.end;
  }
  if (next !== centralAt) reject('zip-hidden-data');
  return entries;
}

function validateLayout(
  layout: ApprovedLayoutDescriptor | null | undefined,
): Map<string, PluginEntryKind> {
  if (
    !layout ||
    typeof layout.id !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,80}$/.test(layout.id) ||
    !Array.isArray(layout.files) ||
    !Array.isArray(layout.manifests) ||
    !layout.files.length ||
    layout.files.length > PLUGIN_ARCHIVE_LIMITS.entries ||
    !layout.manifests.length ||
    layout.manifests.length > 64
  )
    reject('layout-unavailable');
  const files = new Map<string, PluginEntryKind>(),
    folded = new Set<string>();
  for (const item of layout.files) {
    const path = safeArchiveRelativePath(item.relativePath);
    if (
      !['dll', 'addin', 'data'].includes(item.kind) ||
      folded.has(path.toLowerCase()) ||
      path.toLowerCase().endsWith('.dll') !== (item.kind === 'dll') ||
      path.toLowerCase().endsWith('.addin') !== (item.kind === 'addin') ||
      (item.kind === 'data' &&
        /\.(exe|com|bat|cmd|ps1|vbs|js|msi|lnk|url|reg|sys|scr|pif|hta|ocx)$/i.test(path))
    )
      reject('layout-files');
    folded.add(path.toLowerCase());
    files.set(path, item.kind);
  }
  return files;
}

function snapshotLayout(source: ApprovedLayoutDescriptor | null): ApprovedLayoutDescriptor {
  const roles = validateLayout(source);
  if (!source) reject('layout-unavailable');
  const seen = new Set<string>(),
    ids = new Set<string>();
  const manifests = source.manifests.map((item) => {
    const relativePath = safeArchiveRelativePath(item.relativePath);
    if (
      roles.get(relativePath) !== 'addin' ||
      seen.has(relativePath) ||
      (item.year !== 2025 && item.year !== 2026) ||
      !Array.isArray(item.addIns) ||
      !item.addIns.length ||
      item.addIns.length > 32
    )
      reject('manifest-layout');
    seen.add(relativePath);
    const addIns = item.addIns.map((addin) => {
      if (
        typeof addin.addInId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(addin.addInId) ||
        addin.addInId === '00000000-0000-0000-0000-000000000000'
      )
        reject('manifest-expected-id');
      const assemblyRelativePath = safeArchiveRelativePath(addin.assemblyRelativePath),
        key = `${item.year}:${addin.addInId}`;
      if (roles.get(assemblyRelativePath) !== 'dll' || ids.has(key))
        reject('manifest-expected-assembly-or-id');
      ids.add(key);
      return Object.freeze({ addInId: addin.addInId, assemblyRelativePath });
    });
    return Object.freeze({ relativePath, year: item.year, addIns: Object.freeze(addIns) });
  });
  if (manifests.length !== [...roles.values()].filter((role) => role === 'addin').length)
    reject('manifest-layout-count');
  return Object.freeze({
    id: source.id,
    files: Object.freeze(
      source.files.map((item) =>
        Object.freeze({ relativePath: item.relativePath, kind: item.kind }),
      ),
    ),
    manifests: Object.freeze(manifests),
  });
}

export async function extractPluginArchive(request: {
  archivePath: string;
  expectedSha256: string;
  stagingParent: string;
  layout: ApprovedLayoutDescriptor | null;
  signal?: AbortSignal;
  /** Internal remaining job budget; never raises the archive's own limit. */
  outputBudgetBytes?: number;
}): Promise<PreparedPluginGeneration> {
  // Snapshot every scalar and clone/freeze every nested layout field before the
  // first await. A caller mutation cannot retarget this operation during I/O.
  const input = Object.freeze({
    archivePath: request.archivePath,
    expectedSha256: request.expectedSha256,
    stagingParent: request.stagingParent,
    layout: snapshotLayout(request.layout),
    signal: request.signal,
    outputBudgetBytes: request.outputBudgetBytes ?? PLUGIN_ARCHIVE_LIMITS.totalBytes,
  });
  const layout = input.layout,
    roles = validateLayout(layout);
  if (
    typeof input.archivePath !== 'string' ||
    !isAbsolute(input.archivePath) ||
    typeof input.stagingParent !== 'string' ||
    typeof input.expectedSha256 !== 'string' ||
    !sha.test(input.expectedSha256) ||
    !Number.isSafeInteger(input.outputBudgetBytes) ||
    input.outputBudgetBytes < 1 ||
    input.outputBudgetBytes > PLUGIN_ARCHIVE_LIMITS.totalBytes
  )
    reject('input');
  await assertOrdinaryDirectory(input.stagingParent);
  const sourceStat = await lstat(input.archivePath);
  if (
    !sourceStat.isFile() ||
    sourceStat.isSymbolicLink() ||
    sourceStat.size > PLUGIN_ARCHIVE_LIMITS.compressedBytes
  )
    reject('archive-type');
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), PLUGIN_ARCHIVE_LIMITS.timeoutMs);
  const cancel = () => abort.abort();
  input.signal?.addEventListener('abort', cancel, { once: true });
  if (input.signal?.aborted) abort.abort();
  const check = () => {
    if (abort.signal.aborted) reject('cancelled-or-timeout');
  };
  let ownedRoot: string | undefined;
  try {
    check();
    ownedRoot = await mkdtemp(join(input.stagingParent, 'schema-plugin-'));
    await assertOrdinaryDirectory(ownedRoot);
    const copied = join(ownedRoot, 'source.zip'),
      generationRoot = join(ownedRoot, 'generation');
    let compressedBytes = 0;
    const archiveHash = createHash('sha256');
    await pipeline(
      createReadStream(input.archivePath, { highWaterMark: 65536 }),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          compressedBytes += chunk.length;
          if (compressedBytes > PLUGIN_ARCHIVE_LIMITS.compressedBytes)
            return done(new PluginArchiveError('archive-size'));
          archiveHash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(copied, { flags: 'wx', mode: 0o600 }),
      { signal: abort.signal },
    );
    if (compressedBytes !== sourceStat.size || archiveHash.digest('hex') !== input.expectedSha256)
      reject('archive-hash');
    if (
      (await measurePrivateArchive(copied, compressedBytes, abort.signal)) !== input.expectedSha256
    )
      reject('private-archive-hash');
    const zip = await open(copied, 'r');
    let entries: ZipEntry[];
    try {
      entries = await inspectZip(zip, compressedBytes, check, input.outputBudgetBytes);
    } finally {
      await zip.close();
    }
    const files = entries.filter((entry) => !entry.directory);
    if (files.length !== roles.size || files.some((entry) => !roles.has(entry.name)))
      reject('layout-archive-mismatch');
    await mkdir(generationRoot);
    const output: PreparedPluginEntry[] = [];
    let total = 0,
      chunks = 0;
    for (const entry of files) {
      check();
      const target = containedPath(generationRoot, entry.name);
      await mkdir(dirname(target), { recursive: true });
      await assertOrdinaryDirectory(dirname(target));
      const hash = createHash('sha256');
      let actual = 0,
        crc = 0xffffffff,
        consumed = 0;
      const compressed = entry.compressed
        ? createReadStream(copied, {
            start: entry.dataOffset,
            end: entry.dataOffset + entry.compressed - 1,
            highWaterMark: 65536,
          })
        : Readable.from([]);
      const compressedCounter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          consumed += chunk.length;
          if (++chunks > PLUGIN_ARCHIVE_LIMITS.chunks || consumed > entry.compressed)
            return done(new PluginArchiveError('work-limit'));
          done(null, chunk);
        },
      });
      const inflate = entry.method === 8 ? createInflateRaw({ chunkSize: 65536 }) : null;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          actual += chunk.length;
          total += chunk.length;
          if (
            ++chunks > PLUGIN_ARCHIVE_LIMITS.chunks ||
            actual > entry.size ||
            actual > PLUGIN_ARCHIVE_LIMITS.fileBytes ||
            total > input.outputBudgetBytes
          )
            return done(new PluginArchiveError('output-limit'));
          crc = crcUpdate(crc, chunk);
          hash.update(chunk);
          done(null, chunk);
        },
      });
      const destination = createWriteStream(target, { flags: 'wx', mode: 0o600 });
      if (inflate)
        await pipeline(compressed, compressedCounter, inflate, counter, destination, {
          signal: abort.signal,
        });
      else
        await pipeline(compressed, compressedCounter, counter, destination, {
          signal: abort.signal,
        });
      if (
        actual !== entry.size ||
        consumed !== entry.compressed ||
        (inflate && inflate.bytesWritten !== entry.compressed) ||
        (crc ^ 0xffffffff) >>> 0 !== entry.crc
      )
        reject('crc-size-or-trailing-data');
      const kind = roles.get(entry.name);
      if (!kind) reject('layout-kind');
      output.push(
        Object.freeze({ relativePath: entry.name, size: actual, sha256: hash.digest('hex'), kind }),
      );
    }
    check();
    const addins = await validateAddinManifests(generationRoot, layout, output, abort.signal);
    check();
    if (
      (await measurePrivateArchive(copied, compressedBytes, abort.signal)) !== input.expectedSha256
    )
      reject('private-archive-changed');
    await unlink(copied);
    const result: PreparedPluginGeneration = Object.freeze({
      generationRoot,
      archiveSha256: input.expectedSha256,
      layoutId: layout.id,
      entries: Object.freeze(output),
      addins: Object.freeze(addins),
    });
    owned.set(result, { root: ownedRoot, parent: input.stagingParent });
    return result;
  } catch (error) {
    if (ownedRoot) {
      try {
        await removeOwnedTree(ownedRoot, input.stagingParent);
      } catch {
        throw new PluginArchiveError('cleanup-incomplete');
      }
    }
    if (error instanceof PluginArchiveError) throw error;
    throw new PluginArchiveError(
      abort.signal.aborted ? 'cancelled-or-timeout' : 'io-or-decompression',
    );
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', cancel);
  }
}

/** Only objects created by this module carry cleanup authority; arbitrary paths are refused. */
export async function discardPreparedPluginGeneration(
  generation: PreparedPluginGeneration,
): Promise<void> {
  const state = owned.get(generation);
  if (!state) reject('cleanup-ownership');
  await removeOwnedTree(state.root, state.parent);
  owned.delete(generation);
}
