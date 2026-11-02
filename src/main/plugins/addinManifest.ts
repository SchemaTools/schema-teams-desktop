import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { join, posix, dirname, isAbsolute, resolve } from 'node:path';
import { mkdtemp, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import type { ApprovedLayoutDescriptor, PreparedPluginEntry } from './archive';
import {
  assertOrdinaryDirectory,
  containedPath,
  safeArchiveRelativePath,
  reject,
  removeOwnedTree,
  PluginArchiveError,
} from './archivePaths';

export type ValidatedAddin = Readonly<{
  relativePath: string;
  sourceRelativePath: string;
  year: 2025 | 2026;
  addInId: string;
  assemblyRelativePath: string;
}>;
export type RenderedPluginManifest = Readonly<{
  path: string;
  size: number;
  sha256: string;
  sourceRelativePath: string;
  year: 2025 | 2026;
  assemblies: readonly Readonly<{ addInId: string; absoluteAssemblyPath: string }>[];
}>;
const renderedOwned = new WeakMap<RenderedPluginManifest, { root: string; parent: string }>();
type ParsedAddin = {
  type: 'Application' | 'Command';
  assembly: string;
  addInId: string;
  fullClassName: string;
};
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxOutput = 128 * 1024;

// The Framework JavaScriptSerializer escapes HTML-sensitive and line separator
// characters. Compare against its exact canonical form as well as JSON.stringify;
// duplicate keys/extra whitespace still match neither serialization.
function canonicalHelperJson(value: unknown, text: string): boolean {
  const canonical = JSON.stringify(value);
  return (
    text === canonical ||
    text ===
      canonical.replace(
        /[<>&'\u0085\u2028\u2029]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      )
  );
}

function parse(stdout: string, expected: string): ParsedAddin[] {
  if (Buffer.byteLength(stdout, 'utf8') > maxOutput) reject('manifest-helper-output');
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    reject('manifest-helper-json');
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !canonicalHelperJson(raw, stdout.trim())
  )
    reject('manifest-helper-json');
  const result = raw as Record<string, unknown>;
  if (
    Object.keys(result).sort().join(',') !== 'addIns,sha256,status,v' ||
    result.v !== 1 ||
    result.status !== 'valid' ||
    result.sha256 !== expected ||
    !Array.isArray(result.addIns) ||
    !result.addIns.length ||
    result.addIns.length > 32
  )
    reject('manifest-unverified');
  return result.addIns.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      reject('manifest-helper-schema');
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(',') !== 'addInId,assembly,fullClassName,type' ||
      (item.type !== 'Application' && item.type !== 'Command') ||
      typeof item.assembly !== 'string' ||
      !item.assembly.length ||
      item.assembly.length > 512 ||
      typeof item.addInId !== 'string' ||
      !guid.test(item.addInId) ||
      item.addInId === '00000000-0000-0000-0000-000000000000' ||
      typeof item.fullClassName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_.+`]{0,511}$/.test(item.fullClassName)
    )
      reject('manifest-helper-schema');
    return item as ParsedAddin;
  });
}

export async function inspectPluginManifest(
  path: string,
  hash: string,
  signal: AbortSignal,
): Promise<ParsedAddin[]> {
  if (platform() !== 'win32') reject('manifest-platform');
  const base = app.isPackaged ? `${app.getAppPath()}.unpacked` : app.getAppPath();
  return new Promise((resolve, rejectPromise) => {
    execFile(
      join(base, 'dist/native/plugin-manifest.exe'),
      [path, hash],
      {
        shell: false,
        windowsHide: true,
        timeout: 5000,
        maxBuffer: maxOutput,
        encoding: 'utf8',
        signal,
      },
      (error, stdout) => {
        if (error) {
          rejectPromise(new Error('Manifest helper unavailable'));
          return;
        }
        try {
          resolve(parse(stdout, hash));
        } catch (error) {
          rejectPromise(error);
        }
      },
    );
  });
}

/** Explicit transaction target root only; raw source XML and generation bytes stay untouched. */
export async function renderValidatedAddinManifest(request: {
  generation: import('./archive').PreparedPluginGeneration;
  sourceRelativePath: string;
  year: 2025 | 2026;
  targetGenerationRoot: string;
  stagingParent: string;
  signal?: AbortSignal;
}): Promise<RenderedPluginManifest> {
  // Capture scalars and derive an independent mapping before any I/O.
  const sourceRelativePath = safeArchiveRelativePath(request.sourceRelativePath),
    year = request.year;
  if (
    platform() !== 'win32' ||
    (year !== 2025 && year !== 2026) ||
    typeof request.targetGenerationRoot !== 'string' ||
    !isAbsolute(request.targetGenerationRoot)
  )
    reject('render-input');
  const targetRoot = resolve(request.targetGenerationRoot);
  if (!/^[A-Za-z]:\\/.test(targetRoot)) reject('render-target');
  const generationRoot = request.generation.generationRoot,
    stagingParent = request.stagingParent,
    signal = request.signal;
  const entry = request.generation.entries.find((item) => item.relativePath === sourceRelativePath);
  if (!entry || entry.kind !== 'addin' || !/^[a-f0-9]{64}$/.test(entry.sha256))
    reject('render-source');
  const sourceSha256 = entry.sha256,
    source = containedPath(generationRoot, sourceRelativePath);
  const selected = request.generation.addins.filter(
    (item) => item.sourceRelativePath === sourceRelativePath && item.year === year,
  );
  if (!selected.length || selected.length > 32) reject('render-policy');
  const mapping: Record<string, string> = Object.create(null) as Record<string, string>;
  const assemblies = selected.map((item) => {
    if (
      typeof item.addInId !== 'string' ||
      !guid.test(item.addInId) ||
      Object.hasOwn(mapping, item.addInId)
    )
      reject('render-id');
    const relativeAssembly = safeArchiveRelativePath(item.assemblyRelativePath);
    if (
      !request.generation.entries.some(
        (file) => file.relativePath === relativeAssembly && file.kind === 'dll',
      )
    )
      reject('render-assembly');
    const absoluteAssemblyPath = containedPath(targetRoot, relativeAssembly);
    if (absoluteAssemblyPath.length > 1024) reject('render-target');
    mapping[item.addInId] = absoluteAssemblyPath;
    return Object.freeze({ addInId: item.addInId, absoluteAssemblyPath });
  });
  const serializedMap = JSON.stringify(mapping);
  if (serializedMap.length > 32768) reject('render-map-size');
  if (signal?.aborted) reject('render-cancelled');
  await assertOrdinaryDirectory(generationRoot);
  await assertOrdinaryDirectory(dirname(source));
  await assertOrdinaryDirectory(stagingParent);
  let root: string | undefined;
  try {
    if (signal?.aborted) reject('render-cancelled');
    root = await mkdtemp(join(stagingParent, 'schema-plugin-'));
    await assertOrdinaryDirectory(root);
    const path = join(root, 'manifest.addin');
    const base = app.isPackaged ? `${app.getAppPath()}.unpacked` : app.getAppPath();
    const stdout = await new Promise<string>((done, fail) => {
      execFile(
        join(base, 'dist/native/plugin-manifest.exe'),
        ['render', source, sourceSha256, path, serializedMap],
        {
          shell: false,
          windowsHide: true,
          timeout: 5000,
          maxBuffer: maxOutput,
          encoding: 'utf8',
          signal,
        },
        (error, output) =>
          error ? fail(new Error('Manifest rendering helper unavailable')) : done(output),
      );
    });
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch {
      reject('render-helper-json');
    }
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Buffer.byteLength(stdout, 'utf8') > maxOutput ||
      !canonicalHelperJson(raw, stdout.trim())
    )
      reject('render-helper-json');
    const result = raw as Record<string, unknown>;
    if (
      Object.keys(result).sort().join(',') !== 'addIns,outputSha256,outputSize,sha256,status,v' ||
      typeof result.outputSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.outputSha256) ||
      typeof result.outputSize !== 'number' ||
      !Number.isSafeInteger(result.outputSize) ||
      result.outputSize < 1 ||
      result.outputSize > 2 * 1024 * 1024
    )
      reject('render-helper-schema');
    const sourceAddins = parse(
      JSON.stringify({
        v: result.v,
        status: result.status,
        sha256: result.sha256,
        addIns: result.addIns,
      }),
      sourceSha256,
    );
    if (
      sourceAddins.length !== selected.length ||
      sourceAddins.some((item) => !Object.hasOwn(mapping, item.addInId))
    )
      reject('render-helper-source');
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== result.outputSize
    )
      reject('render-file');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) {
      if (signal?.aborted) reject('render-cancelled');
      size += chunk.length;
      if (size > 2 * 1024 * 1024) reject('render-size');
      hash.update(chunk);
    }
    const sha256 = hash.digest('hex');
    if (size !== result.outputSize || sha256 !== result.outputSha256) reject('render-hash');
    const output: RenderedPluginManifest = Object.freeze({
      path,
      size,
      sha256,
      sourceRelativePath,
      year,
      assemblies: Object.freeze(assemblies),
    });
    renderedOwned.set(output, { root, parent: stagingParent });
    return output;
  } catch (error) {
    if (root) {
      try {
        await removeOwnedTree(root, stagingParent);
      } catch {
        throw new PluginArchiveError('render-cleanup-incomplete');
      }
    }
    if (error instanceof PluginArchiveError) throw error;
    throw new PluginArchiveError(signal?.aborted ? 'render-cancelled' : 'render-unavailable');
  }
}

export async function discardRenderedPluginManifest(
  manifest: RenderedPluginManifest,
): Promise<void> {
  const state = renderedOwned.get(manifest);
  if (!state) reject('render-cleanup-ownership');
  await removeOwnedTree(state.root, state.parent);
  renderedOwned.delete(manifest);
}

/** No XML rewriting, external Assembly mapping or production target inference. */
export async function validateAddinManifests(
  generationRoot: string,
  layout: ApprovedLayoutDescriptor,
  entries: readonly PreparedPluginEntry[],
  signal: AbortSignal,
): Promise<ValidatedAddin[]> {
  await assertOrdinaryDirectory(generationRoot);
  const files = new Map(entries.map((entry) => [entry.relativePath, entry]));
  const manifests = entries.filter((entry) => entry.kind === 'addin');
  if (layout.manifests.length !== manifests.length) reject('manifest-layout-count');
  const result: ValidatedAddin[] = [],
    seenFiles = new Set<string>(),
    ids = new Set<string>();
  for (const descriptor of layout.manifests) {
    const path = safeArchiveRelativePath(descriptor.relativePath),
      entry = files.get(path);
    if (
      !entry ||
      entry.kind !== 'addin' ||
      seenFiles.has(path) ||
      (descriptor.year !== 2025 && descriptor.year !== 2026) ||
      !Array.isArray(descriptor.addIns) ||
      !descriptor.addIns.length ||
      descriptor.addIns.length > 32
    )
      reject('manifest-layout');
    seenFiles.add(path);
    const parsed = await inspectPluginManifest(
      containedPath(generationRoot, path),
      entry.sha256,
      signal,
    );
    if (parsed.length !== descriptor.addIns.length) reject('manifest-addin-count');
    const expected = new Map<string, string>();
    for (const item of descriptor.addIns) {
      if (
        typeof item.addInId !== 'string' ||
        !guid.test(item.addInId) ||
        expected.has(item.addInId)
      )
        reject('manifest-expected-id');
      const assembly = safeArchiveRelativePath(item.assemblyRelativePath);
      if (files.get(assembly)?.kind !== 'dll') reject('manifest-expected-assembly');
      expected.set(item.addInId, assembly);
    }
    for (const item of parsed) {
      // Relative paths must be plain owned payload paths. No traversal even when
      // it could normalize back inside the generation, no env expansion/UNC/ADS.
      const reference = safeArchiveRelativePath(item.assembly.replaceAll('\\', '/'));
      const resolved = safeArchiveRelativePath(posix.join(posix.dirname(path), reference));
      const key = `${descriptor.year}:${item.addInId}`;
      if (
        files.get(resolved)?.kind !== 'dll' ||
        expected.get(item.addInId) !== resolved ||
        ids.has(key)
      )
        reject('manifest-assembly-or-id');
      ids.add(key);
      result.push(
        Object.freeze({
          relativePath: path,
          sourceRelativePath: path,
          year: descriptor.year,
          addInId: item.addInId,
          assemblyRelativePath: resolved,
        }),
      );
    }
  }
  return result;
}
