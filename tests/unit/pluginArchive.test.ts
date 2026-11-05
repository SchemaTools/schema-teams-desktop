import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  symlink,
  truncate,
} from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
const { appRoot } = vi.hoisted(() => ({ appRoot: process.cwd() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => appRoot } }));
import {
  extractPluginArchive,
  discardExtractedArchive,
  PLUGIN_ARCHIVE_LIMITS,
} from '../../src/main/plugins/archive';
import {
  fixtureXml,
  fileHash,
  makePluginZip,
  type FixtureEntry,
} from '../helpers/pluginArchiveFixture';

const dll = Buffer.from('SYNTHETIC DATA ONLY, NOT A LOADABLE DLL'),
  xml = fixtureXml();
const baseEntries = (method = 0): FixtureEntry[] => [
  { name: 'Plugin.addin', bytes: xml, method },
  { name: 'managed/gen-v1/Plugin.dll', bytes: dll, method },
];
let root: string, parent: string, caseRoot: string;
beforeAll(async () => {
  await mkdir(join(appRoot, 'private'), { recursive: true });
  root = await mkdtemp(join(appRoot, 'private/archive-actual-io-'));
});
beforeEach(async () => {
  caseRoot = await mkdtemp(join(root, 'case-'));
  parent = join(caseRoot, 'staging');
  await mkdir(parent);
});
afterAll(async () => {
  if (
    !root ||
    !relative(resolve(appRoot, 'private'), resolve(root)).startsWith('archive-actual-io-') ||
    !resolve(root).startsWith(`${resolve(appRoot, 'private')}${sep}`)
  )
    throw new Error('Refusing unsafe fixture cleanup');
  await rm(root, { recursive: true, force: true });
});
async function run(buffer: Buffer, signal?: AbortSignal) {
  const path = join(caseRoot, 'archive.zip');
  await writeFile(path, buffer);
  return extractPluginArchive({
    archivePath: path,
    expectedSha256: fileHash(buffer),
    stagingParent: parent,
    signal,
  });
}
async function rejectsClean(buffer: Buffer) {
  await expect(run(buffer)).rejects.toThrow();
  expect(await readdir(parent)).toEqual([]);
}

describe('bounded archive + REAL filesystem (composition described by the archive itself)', () => {
  it('enforces remaining output budget before generation writes and accepts the exact boundary', async () => {
    const buffer = makePluginZip(baseEntries(8)).buffer,
      path = join(caseRoot, 'budget.zip'),
      size = xml.length + dll.length;
    await writeFile(path, buffer);
    const request = {
      archivePath: path,
      expectedSha256: fileHash(buffer),
      stagingParent: parent,
      outputBudgetBytes: size - 1,
    };
    await expect(extractPluginArchive(request)).rejects.toThrow('zip-total');
    expect(await readdir(parent)).toEqual([]);
    const result = await extractPluginArchive({ ...request, outputBudgetBytes: size });
    expect(result.files.reduce((n, f) => n + f.size, 0)).toBe(size);
    await discardExtractedArchive(result);
  });
  it.each([0, -1, 1.5, PLUGIN_ARCHIVE_LIMITS.totalBytes + 1])(
    'rejects invalid remaining output budget %s before staging writes',
    async (outputBudgetBytes) => {
      const path = join(caseRoot, 'not-read.zip');
      await expect(
        extractPluginArchive({
          archivePath: path,
          expectedSha256: 'a'.repeat(64),
          stagingParent: parent,
          outputBudgetBytes,
        }),
      ).rejects.toThrow('input');
      expect(await readdir(parent)).toEqual([]);
    },
  );
  it.each([true, false])('validates data descriptor, signature=%s', async (descriptorSignature) => {
    const result = await run(
      makePluginZip(
        baseEntries(8).map((entry) => ({ ...entry, flags: 0x808, descriptorSignature })),
      ).buffer,
    );
    await discardExtractedArchive(result);
  });
  it('pre-aborted extraction writes nothing', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(run(makePluginZip(baseEntries()).buffer, abort.signal)).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });
  it('wrong archive SHA fails and cleans only owned directory', async () => {
    const path = join(caseRoot, 'archive.zip');
    await writeFile(path, makePluginZip(baseEntries()).buffer);
    const sentinel = join(parent, 'unrelated.txt');
    await writeFile(sentinel, 'keep');
    await expect(
      extractPluginArchive({
        archivePath: path,
        expectedSha256: '0'.repeat(64),
        stagingParent: parent,
      }),
    ).rejects.toThrow('archive-hash');
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
    expect(await readdir(parent)).toEqual(['unrelated.txt']);
  });
  it('rejects junction staging parent, writes nothing to its target', async () => {
    const target = join(caseRoot, 'outside');
    await mkdir(target);
    const alias = join(caseRoot, 'junction');
    await symlink(target, alias, 'junction');
    const path = join(caseRoot, 'archive.zip'),
      buffer = makePluginZip(baseEntries()).buffer;
    await writeFile(path, buffer);
    await expect(
      extractPluginArchive({
        archivePath: path,
        expectedSha256: fileHash(buffer),
        stagingParent: alias,
      }),
    ).rejects.toThrow('reparse');
    expect(await readdir(target)).toEqual([]);
  });
  it('arbitrary cleanup object has no authority', async () => {
    await expect(
      discardExtractedArchive({
        contentRoot: parent,
        archiveSha256: '',
        files: [],
      }),
    ).rejects.toThrow('cleanup-ownership');
    expect((await lstat(parent)).isDirectory()).toBe(true);
  });
  it.each([
    '../escape.dll',
    '/absolute.dll',
    'C:/absolute.dll',
    '//server/share.dll',
    '\\server\\share.dll',
    'file.dll:stream',
    'CON.dll',
    'aux',
    'COM1.bin',
    'LPT9',
    'conin$.txt',
    'a./x',
    'a /x',
    'a/../x',
    'a/./x',
    'a//x',
    'a\\b',
    'a?b',
    'a\0b',
    'name.',
    'name ',
    'кириллица.dll',
  ])('rejects unsafe ZIP path %s without outside write', async (name) => {
    await rejectsClean(makePluginZip([...baseEntries(), { name, bytes: dll }]).buffer);
  });
  it.each(['Plugin.addin', 'plugin.ADDIN', 'managed', 'managed/gen-v1/Plugin.dll/child'])(
    'rejects duplicate/case/file-dir collision %s',
    async (name) => {
      await rejectsClean(makePluginZip([...baseEntries(), { name, bytes: dll }]).buffer);
    },
  );
  it.each([
    ['symlink', { attributes: 0xa1ff0000 }],
    ['FIFO', { attributes: 0x11ff0000 }],
    ['reparse', { attributes: 0x400 }],
    ['device', { attributes: 0x40 }],
    ['volume', { attributes: 0x08 }],
    ['encrypted', { flags: 0x801 }],
    ['strong encrypted', { flags: 0x840 }],
    ['unsupported method', { method: 12 }],
    ['ZIP64 extra', { extra: Buffer.from([1, 0, 0, 0]) }],
    ['unknown extra', { extra: Buffer.from([0x75, 0x70, 0, 0]) }],
    ['bad extra length', { extra: Buffer.from([0x55, 0x54, 4, 0]) }],
  ] as const)('rejects %s feature', async (_name, patch) => {
    const entries = baseEntries();
    entries[1] = { ...(entries[1] as FixtureEntry), ...patch };
    await rejectsClean(makePluginZip(entries).buffer);
  });
  it.each([
    'multidisk',
    'zip64-count',
    'central-offset',
    'central-count',
    'truncated',
    'extra-tail',
    'local-name',
    'local-size',
    'overlap',
    'local-method',
    'descriptor',
  ])('rejects structural %s', async (which) => {
    const fixture = makePluginZip(
        which === 'descriptor'
          ? baseEntries(8).map((entry) => ({ ...entry, flags: 0x808 }))
          : baseEntries(),
      ),
      bytes = Buffer.from(fixture.buffer);
    const first = fixture.locals[0] ?? 0,
      secondCenter = fixture.centers[1] ?? 0;
    if (which === 'multidisk') bytes.writeUInt16LE(1, fixture.eocd + 4);
    if (which === 'zip64-count') bytes.writeUInt16LE(0xffff, fixture.eocd + 10);
    if (which === 'central-offset') bytes.writeUInt32LE(fixture.centralAt + 1, fixture.eocd + 16);
    if (which === 'central-count') {
      bytes.writeUInt16LE(1, fixture.eocd + 8);
      bytes.writeUInt16LE(1, fixture.eocd + 10);
    }
    if (which === 'local-name') bytes[first + 30] = 120;
    if (which === 'local-size') bytes.writeUInt32LE(123, first + 22);
    if (which === 'local-method') bytes.writeUInt16LE(8, first + 8);
    if (which === 'overlap') bytes.writeUInt32LE(0, secondCenter + 42);
    if (which === 'descriptor') bytes[(fixture.locals[1] ?? 0) - 4] = 99;
    await rejectsClean(
      which === 'truncated'
        ? bytes.subarray(0, bytes.length - 3)
        : which === 'extra-tail'
          ? Buffer.concat([bytes, Buffer.from('extra')])
          : bytes,
    );
  });
  it('CRC mismatch is rejected after streaming actual output and cleaned', async () => {
    await rejectsClean(
      makePluginZip(
        baseEntries().map((entry, index) => (index === 1 ? { ...entry, crc: 1234 } : entry)),
      ).buffer,
    );
  });
  it('declared tiny output cannot hide decompression overflow', async () => {
    const entries = baseEntries(8);
    entries[1] = {
      ...(entries[1] as FixtureEntry),
      bytes: Buffer.alloc(128 * 1024, 65),
      size: 1,
    };
    await rejectsClean(makePluginZip(entries).buffer);
  });
  it('declared huge file is rejected before decompression', async () => {
    const entries = baseEntries(8);
    entries[1] = { ...(entries[1] as FixtureEntry), size: PLUGIN_ARCHIVE_LIMITS.fileBytes + 1 };
    await rejectsClean(makePluginZip(entries).buffer);
  });
  it('entry count limit rejects before creating extracted files', async () => {
    const fixture = makePluginZip(baseEntries()),
      bytes = Buffer.from(fixture.buffer);
    bytes.writeUInt16LE(4097, fixture.eocd + 8);
    bytes.writeUInt16LE(4097, fixture.eocd + 10);
    await rejectsClean(bytes);
  });
  it('trailing bytes inside compressed record are not ignored', async () => {
    const entries = baseEntries(8);
    entries[1] = {
      ...(entries[1] as FixtureEntry),
      compressed: Buffer.concat([deflateRawSync(dll), Buffer.from('TRAILING')]),
    };
    await rejectsClean(makePluginZip(entries).buffer);
  });
  it('truncated DEFLATE rejects unsuccessful end', async () => {
    const entries = baseEntries(8),
      compressed = deflateRawSync(dll);
    entries[1] = {
      ...(entries[1] as FixtureEntry),
      compressed: compressed.subarray(0, compressed.length - 1),
    };
    await rejectsClean(makePluginZip(entries).buffer);
  });
  it('hidden bytes before central directory are rejected as a local-record gap', async () => {
    const fixture = makePluginZip(baseEntries()),
      modified = Buffer.concat([
        fixture.buffer.subarray(0, fixture.centralAt),
        Buffer.from('hidden'),
        fixture.buffer.subarray(fixture.centralAt),
      ]);
    modified.writeUInt32LE(fixture.centralAt + 6, fixture.eocd + 6 + 16);
    await rejectsClean(modified);
  });
  it('rejects sparse archive beyond compressed byte limit before copying', async () => {
    const path = join(caseRoot, 'large.zip');
    await writeFile(path, '');
    await truncate(path, PLUGIN_ARCHIVE_LIMITS.compressedBytes + 1);
    await expect(
      extractPluginArchive({
        archivePath: path,
        expectedSha256: '0'.repeat(64),
        stagingParent: parent,
      }),
    ).rejects.toThrow('archive-type');
    expect(await readdir(parent)).toEqual([]);
  });
  it('declared total output limit is checked across all entries', async () => {
    const huge: FixtureEntry[] = Array.from({ length: 6 }, (_, index) => ({
      name: `payload-${index}.dat`,
      bytes: Buffer.alloc(0),
      method: 8,
      compressed: Buffer.alloc(
        Math.ceil(PLUGIN_ARCHIVE_LIMITS.fileBytes / PLUGIN_ARCHIVE_LIMITS.ratio),
      ),
      size: PLUGIN_ARCHIVE_LIMITS.fileBytes,
      crc: 0,
    }));
    await rejectsClean(makePluginZip([...baseEntries(), ...huge]).buffer);
  });
  it('cancellation after private source copy begins cleans actual staging files', async () => {
    const entries = baseEntries();
    entries[1] = { name: 'managed/gen-v1/Plugin.dll', bytes: Buffer.alloc(16 * 1024 * 1024, 65) };
    const buffer = makePluginZip(entries).buffer,
      path = join(caseRoot, 'archive.zip');
    await writeFile(path, buffer);
    const abort = new AbortController();
    let observed = false;
    const watcher = (async () => {
      const stop = Date.now() + 3000;
      while (Date.now() < stop) {
        const names = await readdir(parent);
        for (const name of names) {
          try {
            if ((await lstat(join(parent, name, 'source.zip'))).size > 0) {
              observed = true;
              abort.abort();
              return;
            }
          } catch {
            /* copy not open yet */
          }
        }
        await new Promise((done) => setTimeout(done, 1));
      }
      abort.abort();
    })();
    await expect(
      extractPluginArchive({
        archivePath: path,
        expectedSha256: fileHash(buffer),
        stagingParent: parent,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    await watcher;
    expect(observed).toBe(true);
    expect(await readdir(parent)).toEqual([]);
  });
  it('streaming output SHA equals independent disk re-read', async () => {
    const result = await run(makePluginZip(baseEntries(8)).buffer);
    for (const entry of result.files) {
      const sha = createHash('sha256');
      for await (const chunk of createReadStream(join(result.contentRoot, entry.relativePath)))
        sha.update(chunk);
      expect(sha.digest('hex')).toBe(entry.sha256);
    }
    await discardExtractedArchive(result);
  });
});
describe('archive composition: general limits instead of a per-plugin file list', () => {
  it.each([0, 8])(
    'method %i keeps bytes, hashes and kinds; resources are allowed',
    async (method) => {
      const png = Buffer.from('synthetic image');
      const result = await run(
        makePluginZip([
          ...baseEntries(method),
          { name: 'managed/gen-v1/ru/Plugin.resources.dll', bytes: dll, method },
          { name: 'managed/gen-v1/icon.png', bytes: png, method },
          { name: 'managed/gen-v1/Plugin.deps.json', bytes: Buffer.from('{}'), method },
        ]).buffer,
      );
      expect(result.files.map((f) => [f.relativePath, f.kind])).toEqual([
        ['Plugin.addin', 'addin'],
        ['managed/gen-v1/Plugin.dll', 'dll'],
        ['managed/gen-v1/ru/Plugin.resources.dll', 'dll'],
        ['managed/gen-v1/icon.png', 'data'],
        ['managed/gen-v1/Plugin.deps.json', 'data'],
      ]);
      expect(result.files[1]?.sha256).toBe(fileHash(dll));
      expect(await readFile(join(result.contentRoot, 'managed/gen-v1/icon.png'))).toEqual(png);
      expect(Object.isFrozen(result) && Object.isFrozen(result.files)).toBe(true);
      await discardExtractedArchive(result);
      expect(await readdir(parent)).toEqual([]);
    },
  );
  it.each(['setup.exe', 'install.ps1', 'run.bat', 'tool.cmd', 'evil.js', 'link.lnk', 'noext'])(
    'executable or unknown file %s is refused and nothing stays in staging',
    async (name) => {
      await rejectsClean(makePluginZip([...baseEntries(), { name, bytes: dll }]).buffer);
    },
  );
  it('an archive without any assembly is refused', async () => {
    await rejectsClean(makePluginZip([{ name: 'Plugin.addin', bytes: xml }]).buffer);
  });
  it('library package (Schema.Tools) without .addin is accepted', async () => {
    const result = await run(makePluginZip([{ name: 'Schema.Tools.dll', bytes: dll }]).buffer);
    expect(result.files.map((f) => f.kind)).toEqual(['dll']);
    await discardExtractedArchive(result);
  });
});
