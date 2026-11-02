import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
const { appRoot, runner, osMock } = vi.hoisted(() => ({
  appRoot: process.cwd(),
  runner: vi.fn(),
  osMock: { platform: (): string => 'win32' },
}));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => appRoot } }));
vi.mock('node:child_process', () => ({ execFile: runner }));
vi.mock('node:os', () => osMock);
import {
  extractPluginArchive,
  discardPreparedPluginGeneration,
  type ApprovedLayoutDescriptor,
} from '../../src/main/plugins/archive';
import { renderValidatedAddinManifest } from '../../src/main/plugins/addinManifest';
import { fixtureGuid, fixtureXml, makePluginZip, fileHash } from '../helpers/pluginArchiveFixture';

const xml = fixtureXml(),
  dll = Buffer.from('SYNTHETIC ONLY');
const layout: ApprovedLayoutDescriptor = {
  id: 'synthetic',
  files: [
    { relativePath: 'Plugin.addin', kind: 'addin' },
    { relativePath: 'managed/gen-v1/Plugin.dll', kind: 'dll' },
  ],
  manifests: [
    {
      relativePath: 'Plugin.addin',
      year: 2025,
      addIns: [{ addInId: fixtureGuid, assemblyRelativePath: 'managed/gen-v1/Plugin.dll' }],
    },
  ],
};
const good = {
  v: 1,
  status: 'valid',
  sha256: fileHash(xml),
  addIns: [
    {
      type: 'Application',
      assembly: 'managed/gen-v1/Plugin.dll',
      addInId: fixtureGuid,
      fullClassName: 'Fixture.Plugin',
    },
  ],
};
let root: string, parent: string, source: string, zipHash: string;
beforeAll(async () => {
  await mkdir(join(appRoot, 'private'), { recursive: true });
  root = await mkdtemp(join(appRoot, 'private/archive-protocol-'));
  parent = join(root, 'stage');
  await mkdir(parent);
  source = join(root, 'source.zip');
  const buffer = makePluginZip([
    { name: 'Plugin.addin', bytes: xml },
    { name: 'managed/gen-v1/Plugin.dll', bytes: dll },
  ]).buffer;
  zipHash = fileHash(buffer);
  await writeFile(source, buffer);
});
beforeEach(() => {
  runner.mockReset();
  osMock.platform = () => 'win32';
});
afterAll(async () => {
  if (
    !root ||
    !relative(resolve(appRoot, 'private'), resolve(root)).startsWith('archive-protocol-') ||
    !resolve(root).startsWith(`${resolve(appRoot, 'private')}${sep}`)
  )
    throw new Error('Unsafe fixture cleanup');
  await rm(root, { recursive: true, force: true });
});
const extract = () =>
  extractPluginArchive({
    archivePath: source,
    expectedSha256: zipHash,
    stagingParent: parent,
    layout,
  });
function answer(stdout: string, error: Error | null = null) {
  runner.mockImplementation((_helper, _args, _options, done) => done(error, stdout));
}

describe('manifest wrapper protocol with mocked runner; filesystem staging is real', () => {
  it.each([
    'invalid-json',
    '{"v":1,"v":1}',
    'x'.repeat(128 * 1024 + 1),
    JSON.stringify({ ...good, v: 2 }),
    JSON.stringify({ ...good, status: ['valid'] }),
    JSON.stringify({ ...good, status: null }),
    JSON.stringify({ ...good, sha256: [good.sha256] }),
    JSON.stringify({ ...good, sha256: '0'.repeat(64) }),
    JSON.stringify({ ...good, extra: 1 }),
    JSON.stringify({ ...good, addIns: [] }),
    JSON.stringify({ ...good, addIns: null }),
    ...['type', 'assembly', 'addInId', 'fullClassName'].flatMap((field) =>
      [[good.addIns[0]?.[field as keyof (typeof good.addIns)[0]]], {}, null].map((value) =>
        JSON.stringify({ ...good, addIns: [{ ...good.addIns[0], [field]: value }] }),
      ),
    ),
  ])('rejects malformed helper JSON and removes staging', async (stdout) => {
    answer(stdout);
    await expect(extract()).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });
  it.each(['ETIMEDOUT', 'ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])(
    'rejects helper error %s despite valid stdout',
    async (code) => {
      answer(JSON.stringify(good), Object.assign(new Error('fixture'), { code }));
      await expect(extract()).rejects.toThrow();
      expect(await readdir(parent)).toEqual([]);
    },
  );
  it('synchronous spawn throw rejects and cleans owned generation', async () => {
    runner.mockImplementation(() => {
      throw new Error('fixture');
    });
    await expect(extract()).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });
  it('unsupported platform never invokes helper', async () => {
    osMock.platform = () => 'linux';
    await expect(extract()).rejects.toThrow('manifest-platform');
    expect(runner).not.toHaveBeenCalled();
    expect(await readdir(parent)).toEqual([]);
  });
  it('controlled helper path/options and source expected SHA are fixed in main', async () => {
    answer(JSON.stringify(good));
    const generation = await extract();
    expect(runner).toHaveBeenCalledWith(
      join(appRoot, 'dist/native/plugin-manifest.exe'),
      [join(generation.generationRoot, 'Plugin.addin'), fileHash(xml)],
      {
        shell: false,
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 128 * 1024,
        encoding: 'utf8',
        signal: expect.any(AbortSignal),
      },
      expect.any(Function),
    );
    await discardPreparedPluginGeneration(generation);
  });
  it.each([
    'bad-json',
    JSON.stringify({
      v: 1,
      status: 'valid',
      sha256: good.sha256,
      addIns: good.addIns,
      outputSha256: ['a'.repeat(64)],
      outputSize: 50,
    }),
    JSON.stringify({
      v: 1,
      status: 'valid',
      sha256: good.sha256,
      addIns: good.addIns,
      outputSha256: 'a'.repeat(64),
      outputSize: '50',
    }),
  ])('render rejects invalid helper protocol with cleanup', async (stdout) => {
    answer(JSON.stringify(good));
    const generation = await extract();
    answer(stdout);
    await expect(
      renderValidatedAddinManifest({
        generation,
        sourceRelativePath: 'Plugin.addin',
        year: 2025,
        targetGenerationRoot: join(root, 'final', 'gen-v1'),
        stagingParent: parent,
      }),
    ).rejects.toThrow();
    expect((await readdir(parent)).length).toBe(1);
    await discardPreparedPluginGeneration(generation);
  });
});
