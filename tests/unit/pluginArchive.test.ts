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
import { execFileSync } from 'node:child_process';
const { appRoot } = vi.hoisted(() => ({ appRoot: process.cwd() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => appRoot } }));
import {
  APPROVED_PLUGIN_LAYOUT,
  extractPluginArchive,
  discardPreparedPluginGeneration,
  PLUGIN_ARCHIVE_LIMITS,
  type ApprovedLayoutDescriptor,
} from '../../src/main/plugins/archive';
import {
  renderValidatedAddinManifest,
  discardRenderedPluginManifest,
} from '../../src/main/plugins/addinManifest';
import {
  fixtureGuid,
  fixtureXml,
  fileHash,
  makePluginZip,
  type FixtureEntry,
} from '../helpers/pluginArchiveFixture';

const dll = Buffer.from('SYNTHETIC DATA ONLY, NOT A LOADABLE DLL'),
  xml = fixtureXml();
function layout() {
  return {
    id: 'synthetic-v1',
    files: [
      { relativePath: 'Plugin.addin', kind: 'addin' as const },
      { relativePath: 'managed/gen-v1/Plugin.dll', kind: 'dll' as const },
    ],
    manifests: [
      {
        relativePath: 'Plugin.addin',
        year: 2025 as const,
        addIns: [{ addInId: fixtureGuid, assemblyRelativePath: 'managed/gen-v1/Plugin.dll' }],
      },
    ],
  };
}
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
async function run(
  buffer: Buffer,
  descriptor: ApprovedLayoutDescriptor | null = layout(),
  signal?: AbortSignal,
) {
  const path = join(caseRoot, 'archive.zip');
  await writeFile(path, buffer);
  return extractPluginArchive({
    archivePath: path,
    expectedSha256: fileHash(buffer),
    stagingParent: parent,
    layout: descriptor,
    signal,
  });
}
async function rejectsClean(buffer: Buffer) {
  await expect(run(buffer)).rejects.toThrow();
  expect(await readdir(parent)).toEqual([]);
}

describe.skipIf(process.platform !== 'win32')(
  'bounded archive + REAL filesystem and native XmlReader (synthetic layout only)',
  () => {
    it('enforces remaining output budget before generation writes and accepts the exact boundary', async () => {
      const buffer = makePluginZip(baseEntries(8)).buffer,
        path = join(caseRoot, 'budget.zip'),
        size = xml.length + dll.length;
      await writeFile(path, buffer);
      const request = {
        archivePath: path,
        expectedSha256: fileHash(buffer),
        stagingParent: parent,
        layout: layout(),
        outputBudgetBytes: size - 1,
      };
      await expect(extractPluginArchive(request)).rejects.toThrow('zip-total');
      expect(await readdir(parent)).toEqual([]);
      const result = await extractPluginArchive({ ...request, outputBudgetBytes: size });
      expect(result.entries.reduce((n, f) => n + f.size, 0)).toBe(size);
      await discardPreparedPluginGeneration(result);
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
            layout: layout(),
            outputBudgetBytes,
          }),
        ).rejects.toThrow('input');
        expect(await readdir(parent)).toEqual([]);
      },
    );
    it.each([0, 8])(
      'streams method %i, preserves bytes/hashes and validates owned Assembly',
      async (method) => {
        const result = await run(makePluginZip(baseEntries(method)).buffer);
        expect(result.entries.map((item) => item.sha256)).toEqual([fileHash(xml), fileHash(dll)]);
        expect(await readFile(join(result.generationRoot, 'Plugin.addin'))).toEqual(xml);
        expect(result.addins).toEqual([
          {
            relativePath: 'Plugin.addin',
            sourceRelativePath: 'Plugin.addin',
            year: 2025,
            addInId: fixtureGuid,
            assemblyRelativePath: 'managed/gen-v1/Plugin.dll',
          },
        ]);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.entries)).toBe(true);
        await discardPreparedPluginGeneration(result);
        expect(await readdir(parent)).toEqual([]);
      },
    );
    it.each([true, false])(
      'validates data descriptor, signature=%s',
      async (descriptorSignature) => {
        const result = await run(
          makePluginZip(
            baseEntries(8).map((entry) => ({ ...entry, flags: 0x808, descriptorSignature })),
          ).buffer,
        );
        await discardPreparedPluginGeneration(result);
      },
    );
    it('production descriptor is absent and cannot prepare a generation', async () => {
      expect(APPROVED_PLUGIN_LAYOUT).toBeNull();
      await expect(
        run(makePluginZip(baseEntries()).buffer, APPROVED_PLUGIN_LAYOUT),
      ).rejects.toThrow('layout-unavailable');
      expect(await readdir(parent)).toEqual([]);
    });
    it('captures immutable caller layout and scalar inputs before first I/O', async () => {
      const buffer = makePluginZip(baseEntries()).buffer,
        source = join(caseRoot, 'archive.zip');
      await writeFile(source, buffer);
      const descriptor = layout(),
        cancelled = new AbortController();
      const request = {
        archivePath: source,
        expectedSha256: fileHash(buffer),
        stagingParent: parent,
        layout: descriptor,
        signal: new AbortController().signal,
      };
      const pending = extractPluginArchive(request);
      request.archivePath = join(caseRoot, 'missing.zip');
      request.expectedSha256 = '0'.repeat(64);
      request.stagingParent = join(caseRoot, 'missing-parent');
      request.signal = cancelled.signal;
      cancelled.abort();
      descriptor.id = 'mutated';
      const first = descriptor.files[0],
        manifest = descriptor.manifests[0],
        addin = manifest?.addIns[0];
      if (!first || !manifest || !addin) throw new Error('fixture');
      first.relativePath = '../escape';
      manifest.relativePath = 'missing.addin';
      addin.assemblyRelativePath = '../foreign.dll';
      addin.addInId = '00000000-0000-0000-0000-000000000000';
      const result = await pending;
      expect(result.layoutId).toBe('synthetic-v1');
      expect(result.archiveSha256).toBe(fileHash(buffer));
      expect(result.addins[0]?.addInId).toBe(fixtureGuid);
      expect(result.generationRoot.startsWith(parent)).toBe(true);
      await discardPreparedPluginGeneration(result);
    });
    it('pre-aborted extraction writes nothing', async () => {
      const abort = new AbortController();
      abort.abort();
      await expect(
        run(makePluginZip(baseEntries()).buffer, layout(), abort.signal),
      ).rejects.toThrow();
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
          layout: layout(),
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
          layout: layout(),
        }),
      ).rejects.toThrow('reparse');
      expect(await readdir(target)).toEqual([]);
    });
    it('arbitrary cleanup object has no authority', async () => {
      await expect(
        discardPreparedPluginGeneration({
          generationRoot: parent,
          archiveSha256: '',
          layoutId: '',
          entries: [],
          addins: [],
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
    it.each([
      '../foreign.dll',
      '/absolute.dll',
      'C:\\foreign.dll',
      '\\\\server\\foreign.dll',
      '%APPDATA%/foreign.dll',
      'managed/gen-v1/Missing.dll',
    ])('rejects external/unowned Assembly %s via REAL XML helper', async (reference) => {
      const entries = baseEntries();
      entries[0] = { name: 'Plugin.addin', bytes: fixtureXml(reference) };
      await rejectsClean(makePluginZip(entries).buffer);
    });
    it.each([
      Buffer.from(
        '<!DOCTYPE RevitAddIns [<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]><RevitAddIns><AddIn Type="Application"><Assembly>&xxe;</Assembly></AddIn></RevitAddIns>',
      ),
      Buffer.from('<!DOCTYPE RevitAddIns [<!ENTITY a "boom">]><RevitAddIns>&a;</RevitAddIns>'),
      Buffer.from('<RevitAddIns xmlns="urn:unknown"/>'),
      Buffer.from(
        '<RevitAddIns><AddIn Type="Application"><Assembly>one</Assembly><Assembly>two</Assembly></AddIn></RevitAddIns>',
      ),
      fixtureXml('managed/gen-v1/Plugin.dll', '00000000-0000-0000-0000-000000000000'),
      Buffer.from(
        '<RevitAddIns><AddIn Type="Application"><Script>bad</Script></AddIn></RevitAddIns>',
      ),
      Buffer.from('<RevitAddIns>malformed'),
      Buffer.from(
        '<RevitAddIns><AddIn Type="Application"><Assembly><nested/></Assembly></AddIn></RevitAddIns>',
      ),
    ])('rejects unsafe XML via native DTD-prohibited parser', async (bytes) => {
      const entries = baseEntries();
      entries[0] = { name: 'Plugin.addin', bytes };
      await rejectsClean(makePluginZip(entries).buffer);
    });
    it.each([
      ['missing', ''],
      ['empty', '<Name/>'],
      ['whitespace', '<Name> \t\r\n </Name>'],
    ])(
      'rejects Application with %s Name during native parse AND shared-Parse render',
      async (_shape, name) => {
        const bytes = Buffer.from(xml.toString().replace('<Name>Synthetic fixture</Name>', name));
        const entries = baseEntries();
        entries[0] = { name: 'Plugin.addin', bytes };
        await rejectsClean(makePluginZip(entries).buffer);
        const source = join(caseRoot, 'bad-name.addin'),
          output = join(caseRoot, 'must-not-render.addin');
        await writeFile(source, bytes);
        const helper = join(appRoot, 'dist/native/plugin-manifest.exe'),
          options = {
            shell: false,
            windowsHide: true,
            timeout: 5000,
            maxBuffer: 128 * 1024,
            encoding: 'utf8' as const,
          };
        const parsed = JSON.parse(execFileSync(helper, [source, fileHash(bytes)], options));
        expect(parsed.status).toBe('invalid');
        expect(parsed.addIns).toEqual([]);
        const rendered = JSON.parse(
          execFileSync(
            helper,
            [
              'render',
              source,
              fileHash(bytes),
              output,
              JSON.stringify({ [fixtureGuid]: join(caseRoot, 'target.dll') }),
            ],
            options,
          ),
        );
        expect(rendered.status).toBe('invalid');
        expect(rendered.addIns).toEqual([]);
        await expect(lstat(output)).rejects.toThrow();
        expect(await readFile(source)).toEqual(bytes);
      },
    );
    it('Command without optional Text or Application Name is valid and renderable', async () => {
      const bytes = Buffer.from(
          xml
            .toString()
            .replace('Type="Application"', 'Type="Command"')
            .replace('<Name>Synthetic fixture</Name>', ''),
        ),
        entries = baseEntries();
      entries[0] = { name: 'Plugin.addin', bytes };
      const generation = await run(makePluginZip(entries).buffer);
      const rendered = await renderValidatedAddinManifest({
        generation,
        sourceRelativePath: 'Plugin.addin',
        year: 2025,
        targetGenerationRoot: join(caseRoot, 'target'),
        stagingParent: parent,
      });
      const text = await readFile(rendered.path, 'utf8');
      expect(text).toContain('Type="Command"');
      expect(text).not.toContain('<Text');
      expect(text).not.toContain('<Name');
      await discardRenderedPluginManifest(rendered);
      await discardPreparedPluginGeneration(generation);
      expect(await readdir(parent)).toEqual([]);
    });
    it('same AddInID across 2025/2026 is valid, matching explicit descriptor', async () => {
      const descriptor = layout();
      descriptor.files.push({ relativePath: 'Other.addin', kind: 'addin' });
      const manifests: ApprovedLayoutDescriptor['manifests'] = [
        ...descriptor.manifests,
        {
          relativePath: 'Other.addin',
          year: 2026,
          addIns: [{ addInId: fixtureGuid, assemblyRelativePath: 'managed/gen-v1/Plugin.dll' }],
        },
      ];
      const result = await run(
        makePluginZip([...baseEntries(), { name: 'Other.addin', bytes: xml }]).buffer,
        { ...descriptor, manifests },
      );
      expect(result.addins.map((item) => item.year)).toEqual([2025, 2026]);
      await discardPreparedPluginGeneration(result);
    });
    it('same-year duplicate AddInID is blocked by explicit descriptor', async () => {
      const descriptor = layout();
      descriptor.files.push({ relativePath: 'Other.addin', kind: 'addin' });
      descriptor.manifests.push({
        relativePath: 'Other.addin',
        year: 2025,
        addIns: [{ addInId: fixtureGuid, assemblyRelativePath: 'managed/gen-v1/Plugin.dll' }],
      });
      await expect(
        run(
          makePluginZip([...baseEntries(), { name: 'Other.addin', bytes: xml }]).buffer,
          descriptor,
        ),
      ).rejects.toThrow();
      expect(await readdir(parent)).toEqual([]);
    });
    it('multiple AddIn nodes are individually validated and semantically rendered', async () => {
      const secondId = '8ba69c10-0f12-4bc0-8ced-a167b8947150';
      const secondNode = fixtureXml('managed/gen-v1/Plugin.dll', secondId)
        .toString()
        .match(/<AddIn Type=[\s\S]*<\/AddIn>/)?.[0];
      if (!secondNode) throw new Error('fixture');
      const multi = Buffer.from(
          xml.toString().replace('</RevitAddIns>', `${secondNode}</RevitAddIns>`),
        ),
        entries = baseEntries();
      entries[0] = { name: 'Plugin.addin', bytes: multi };
      const descriptor = layout(),
        manifest = descriptor.manifests[0];
      if (!manifest) throw new Error('fixture');
      manifest.addIns.push({
        addInId: secondId,
        assemblyRelativePath: 'managed/gen-v1/Plugin.dll',
      });
      const generation = await run(makePluginZip(entries).buffer, descriptor);
      expect(generation.addins.map((item) => item.addInId)).toEqual([fixtureGuid, secondId]);
      const rendered = await renderValidatedAddinManifest({
        generation,
        sourceRelativePath: 'Plugin.addin',
        year: 2025,
        targetGenerationRoot: join(caseRoot, 'target'),
        stagingParent: parent,
      });
      const text = await readFile(rendered.path, 'utf8');
      expect(text.match(/<Assembly>/g)?.length).toBe(2);
      expect(text).toContain(secondId);
      await discardRenderedPluginManifest(rendered);
      await discardPreparedPluginGeneration(generation);
    });
    it('duplicate AddInID in XML is rejected even against a distinct two-node descriptor', async () => {
      const node = xml.toString().match(/<AddIn Type=[\s\S]*<\/AddIn>/)?.[0];
      if (!node) throw new Error('fixture');
      const duplicate = Buffer.from(
          xml.toString().replace('</RevitAddIns>', `${node}</RevitAddIns>`),
        ),
        entries = baseEntries();
      entries[0] = { name: 'Plugin.addin', bytes: duplicate };
      const descriptor = layout(),
        manifest = descriptor.manifests[0];
      if (!manifest) throw new Error('fixture');
      manifest.addIns.push({
        addInId: '8ba69c10-0f12-4bc0-8ced-a167b8947150',
        assemblyRelativePath: 'managed/gen-v1/Plugin.dll',
      });
      await expect(run(makePluginZip(entries).buffer, descriptor)).rejects.toThrow();
      expect(await readdir(parent)).toEqual([]);
    });
    it('DLL cannot be disguised as data in the approved descriptor', async () => {
      const descriptor: ApprovedLayoutDescriptor = {
        ...layout(),
        files: [
          { relativePath: 'Plugin.addin', kind: 'addin' },
          { relativePath: 'managed/gen-v1/Plugin.dll', kind: 'data' },
        ],
      };
      await expect(run(makePluginZip(baseEntries()).buffer, descriptor)).rejects.toThrow(
        'layout-files',
      );
      expect(await readdir(parent)).toEqual([]);
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
          layout: layout(),
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
          layout: layout(),
          signal: abort.signal,
        }),
      ).rejects.toThrow();
      await watcher;
      expect(observed).toBe(true);
      expect(await readdir(parent)).toEqual([]);
    });
    it('renders only Assembly to explicit immutable target, preserving raw source and other XML fields', async () => {
      const generation = await run(makePluginZip(baseEntries()).buffer),
        targetGenerationRoot = join(caseRoot, 'final-target', 'gen-v1');
      const rendered = await renderValidatedAddinManifest({
        generation,
        sourceRelativePath: 'Plugin.addin',
        year: 2025,
        targetGenerationRoot,
        stagingParent: parent,
      });
      const bytes = await readFile(rendered.path),
        text = bytes.toString('utf8');
      expect(fileHash(bytes)).toBe(rendered.sha256);
      expect(bytes.length).toBe(rendered.size);
      expect(text).toContain(
        `<Assembly>${join(targetGenerationRoot, 'managed/gen-v1/Plugin.dll')}</Assembly>`,
      );
      expect(text).toContain('<Name>Synthetic fixture</Name>');
      expect(text).toContain('<VendorId>TEST</VendorId>');
      expect(text).toContain('<FullClassName>Fixture.Plugin</FullClassName>');
      expect(await readFile(join(generation.generationRoot, 'Plugin.addin'))).toEqual(xml);
      await expect(lstat(targetGenerationRoot)).rejects.toThrow();
      expect(rendered.assemblies).toEqual([
        {
          addInId: fixtureGuid,
          absoluteAssemblyPath: join(targetGenerationRoot, 'managed/gen-v1/Plugin.dll'),
        },
      ]);
      await discardRenderedPluginManifest(rendered);
      await discardPreparedPluginGeneration(generation);
      expect(await readdir(parent)).toEqual([]);
    });
    it('render snapshot is unaffected by caller scalar mutation during first I/O', async () => {
      const generation = await run(makePluginZip(baseEntries()).buffer),
        targetGenerationRoot = join(caseRoot, 'final-target', 'gen-v1');
      const request = {
        generation,
        sourceRelativePath: 'Plugin.addin',
        year: 2025 as const,
        targetGenerationRoot,
        stagingParent: parent,
        signal: new AbortController().signal,
      };
      const pending = renderValidatedAddinManifest(request);
      request.sourceRelativePath = '../escape.addin';
      request.targetGenerationRoot = 'C:\\foreign';
      request.stagingParent = join(caseRoot, 'missing');
      const abort = new AbortController();
      abort.abort();
      request.signal = abort.signal;
      const rendered = await pending;
      expect(rendered.assemblies[0]?.absoluteAssemblyPath).toBe(
        join(targetGenerationRoot, 'managed/gen-v1/Plugin.dll'),
      );
      await discardRenderedPluginManifest(rendered);
      await discardPreparedPluginGeneration(generation);
    });
    it('changed source after validation cannot be rendered and does not remove the generation', async () => {
      const generation = await run(makePluginZip(baseEntries()).buffer);
      await writeFile(
        join(generation.generationRoot, 'Plugin.addin'),
        fixtureXml('../foreign.dll'),
      );
      await expect(
        renderValidatedAddinManifest({
          generation,
          sourceRelativePath: 'Plugin.addin',
          year: 2025,
          targetGenerationRoot: join(caseRoot, 'target'),
          stagingParent: parent,
        }),
      ).rejects.toThrow();
      expect((await readdir(parent)).length).toBe(1);
      await discardPreparedPluginGeneration(generation);
    });
    it('unknown year/policy and pre-aborted render create no output', async () => {
      const generation = await run(makePluginZip(baseEntries()).buffer),
        base = {
          generation,
          sourceRelativePath: 'Plugin.addin',
          targetGenerationRoot: join(caseRoot, 'target'),
          stagingParent: parent,
        };
      await expect(renderValidatedAddinManifest({ ...base, year: 2026 })).rejects.toThrow(
        'render-policy',
      );
      const abort = new AbortController();
      abort.abort();
      await expect(
        renderValidatedAddinManifest({ ...base, year: 2025, signal: abort.signal }),
      ).rejects.toThrow('render-cancelled');
      expect((await readdir(parent)).length).toBe(1);
      await discardPreparedPluginGeneration(generation);
    });
    it('streaming output SHA equals independent disk re-read', async () => {
      const result = await run(makePluginZip(baseEntries(8)).buffer);
      for (const entry of result.entries) {
        const sha = createHash('sha256');
        for await (const chunk of createReadStream(join(result.generationRoot, entry.relativePath)))
          sha.update(chunk);
        expect(sha.digest('hex')).toBe(entry.sha256);
      }
      await discardPreparedPluginGeneration(result);
    });
  },
);
