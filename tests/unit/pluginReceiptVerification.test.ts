import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const { appRoot } = vi.hoisted(() => ({ appRoot: process.cwd() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => appRoot } }));
import {
  createReceiptVerification,
  createLocalOwnershipVerification,
  type ReceiptVerificationOptions,
} from '../../src/main/plugins/receiptVerification';
import type { PluginReceipt } from '../../src/main/plugins/transactionTypes';
import { packageKey } from '../../src/main/plugins/transactionStore';
import type { PluginTransactionOptions } from '../../src/main/plugins/transaction';
import type { PluginCatalog } from '../../src/shared/plugins';
import type { ApprovedInstallTemplate } from '../../src/main/plugins/layoutPolicy';
import { fixtureXml, fileHash } from '../helpers/pluginArchiveFixture';
const base = resolve(__dirname, '../../private'),
  roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + sep) || !root.includes('receipt-verify-'))
      throw Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(targetName = 'targets') {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'receipt-verify-')),
    targetRoot = join(root, targetName),
    dataRoot = join(root, 'state'),
    stagingParent = join(root, 'staging');
  roots.push(root);
  const guid = randomUUID(),
    generation = randomUUID(),
    dllTarget = `2025/managed/${generation}/floor-plans/Plugin.dll`,
    addinTarget = '2025/Floor.addin',
    dll = join(targetRoot, ...dllTarget.split('/')),
    addin = join(targetRoot, ...addinTarget.split('/')),
    bytes = Buffer.from('INERT PAYLOAD, NOT A LOADABLE DLL'),
    xml = fixtureXml(dll.replaceAll('&', '&amp;'), guid);
  await mkdir(dirname(dll), { recursive: true });
  await writeFile(dll, bytes);
  await writeFile(addin, xml);
  const pkg = {
      code: 'floor-plans',
      buildId: 1,
      version: '1.0',
      archiveSha256: 'a'.repeat(64),
      archiveSize: 200,
      revit: [2025 as const],
      descriptorId: 'synthetic-v1',
    },
    dllFile = {
      packageKey: packageKey(pkg),
      targetPath: dllTarget,
      kind: 'dll' as const,
      sha256: fileHash(bytes),
      size: bytes.length,
    },
    addinFile = {
      packageKey: packageKey(pkg),
      targetPath: addinTarget,
      kind: 'addin' as const,
      sha256: fileHash(xml),
      size: xml.length,
      addInIds: [guid],
    };
  const receipt: PluginReceipt = {
    schema: 1,
    id: randomUUID(),
    scope: { serverHash: 'b'.repeat(64), ownerId: 1 },
    rootsHash: createHash('sha256')
      .update(JSON.stringify([targetRoot, dataRoot, stagingParent]))
      .digest('hex'),
    packages: [pkg],
    files: [dllFile, addinFile],
  };
  const policy: ApprovedInstallTemplate = {
    policyId: 'synthetic-v1',
    code: 'floor-plans',
    archive: {
      id: 'synthetic-raw',
      files: [
        { relativePath: 'Plugin.dll', kind: 'dll' },
        { relativePath: 'Plugin.addin', kind: 'addin' },
      ],
      manifests: [
        {
          relativePath: 'Plugin.addin',
          year: 2025,
          addIns: [{ addInId: guid, assemblyRelativePath: 'Plugin.dll' }],
        },
      ],
    },
    yearFiles: [{ year: 2025, paths: ['Plugin.dll'] }],
    manifestTargets: [
      { sourceRelativePath: 'Plugin.addin', year: 2025, targetBasename: 'Floor.addin' },
    ],
  };
  const catalog: PluginCatalog = {
    tester: false,
    plugins: [
      {
        code: 'floor-plans',
        name: 'Fixture',
        short: 'FP',
        beta: null,
        stable: {
          id: 1,
          version: '1.0',
          verified: true,
          size: 200,
          sha256: 'a'.repeat(64),
          url: '/api/desktop/plugins/files/1',
          revit: [2025],
          notes: '',
          requires: [],
          publishedAt: '2026-11-02T00:00:00.000Z',
        },
      },
    ],
  };
  const state = { live: true };
  const verify = vi.fn(async (_path: string, hash: string) => ({
    v: 1 as const,
    verdict: 'valid' as const,
    reason: 'verified' as const,
    winTrustCode: '00000000',
    fileSha256: hash,
    signerDerSha256: 'f'.repeat(64),
  }));
  const options: ReceiptVerificationOptions = {
    scope: receipt.scope,
    targetRoot,
    dataRoot,
    stagingParent,
    templates: [policy],
    publisherPins: ['f'.repeat(64)],
    betaAllowed: false,
    current: () => state.live,
    readCatalog: async () => structuredClone(catalog),
    pathAllowed: async () => true,
    verify,
  };
  const request: Parameters<PluginTransactionOptions['admit']>[0] = {
    scope: receipt.scope,
    purpose: 'install',
    receipt,
    sources: [],
  };
  return {
    root,
    options,
    request,
    receipt,
    catalog,
    verify,
    state,
    dll,
    addin,
    dllFile,
    addinFile,
    guid,
  };
}
describe('receipt verification closed policy', () => {
  it('empty publisher policy does not read catalog or paths', async () => {
    const f = await fixture(),
      read = vi.fn(f.options.readCatalog),
      path = vi.fn(f.options.pathAllowed);
    expect(
      await createReceiptVerification({
        ...f.options,
        readCatalog: read,
        pathAllowed: path,
        publisherPins: [],
      })(f.request),
    ).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(path).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });
});
describe.skipIf(process.platform !== 'win32')(
  'actual local bytes and native XML, with injected publisher oracle',
  () => {
    it('reads Cyrillic, apostrophe and ampersand paths from the actual UTF8 native protocol', async () => {
      const f = await fixture("Плагины & O'Connor");
      expect(await createReceiptVerification(f.options)(f.request)).toBe(true);
    });
    it('accepts exact managed mapping and bytes without modifying files', async () => {
      const f = await fixture(),
        before = await readFile(f.addin);
      expect(await createReceiptVerification(f.options)(f.request)).toBe(true);
      expect(f.verify).toHaveBeenCalledOnce();
      expect(await readFile(f.addin)).toEqual(before);
    });
    it('local ownership of a hidden previous build does not authorize its activation', async () => {
      const f = await fixture(),
        read = vi.fn(f.options.readCatalog);
      const plugin = f.catalog.plugins[0];
      if (!plugin) throw Error('Fixture');
      plugin.stable = null;
      expect(await createReceiptVerification({ ...f.options, readCatalog: read })(f.request)).toBe(
        false,
      );
      read.mockClear();
      const localOptions = { ...f.options, readCatalog: read };
      expect(await createLocalOwnershipVerification(localOptions)(f.request)).toBe(true);
      expect(read).not.toHaveBeenCalled();
    });
    it('local ownership still requires approved layout, publisher and exact roots', async () => {
      const f = await fixture();
      f.receipt.rootsHash = 'd'.repeat(64);
      expect(await createLocalOwnershipVerification(f.options)(f.request)).toBe(false);
      const g = await fixture();
      const pkg = g.receipt.packages[0];
      if (!pkg) throw Error('Fixture');
      pkg.descriptorId = 'unapproved';
      expect(await createLocalOwnershipVerification(g.options)(g.request)).toBe(false);
      const h = await fixture();
      expect(
        await createLocalOwnershipVerification({ ...h.options, publisherPins: ['e'.repeat(64)] })(
          h.request,
        ),
      ).toBe(false);
    });
    it('rejects a manifest pointing outside its owned generation even with a matching forged receipt hash', async () => {
      const f = await fixture(),
        bad = fixtureXml(join(f.root, 'outside', 'Foreign.dll'), f.guid);
      await writeFile(f.addin, bad);
      f.addinFile.sha256 = fileHash(bad);
      f.addinFile.size = bad.length;
      expect(await createReceiptVerification(f.options)(f.request)).toBe(false);
      expect(f.verify).not.toHaveBeenCalled();
      expect(await readFile(f.addin)).toEqual(bad);
    });
    it('rejects changed manifest GUIDs and unapproved target names', async () => {
      const f = await fixture(),
        bad = fixtureXml(f.dll, randomUUID());
      await writeFile(f.addin, bad);
      f.addinFile.sha256 = fileHash(bad);
      f.addinFile.size = bad.length;
      expect(await createReceiptVerification(f.options)(f.request)).toBe(false);
      f.addinFile.targetPath = '2025/Unapproved.addin';
      expect(await createReceiptVerification(f.options)(f.request)).toBe(false);
    });
    it('rejects corrupt DLL bytes and an untrusted signer separately', async () => {
      const f = await fixture();
      await writeFile(f.dll, 'corrupt');
      expect(await createReceiptVerification(f.options)(f.request)).toBe(false);
      expect(f.verify).not.toHaveBeenCalled();
      const g = await fixture();
      expect(
        await createReceiptVerification({
          ...g.options,
          verify: async (p, h) => ({ ...(await g.verify(p, h)), verdict: 'invalid' }),
        })(g.request),
      ).toBe(false);
    });
    it('rejects a source outside trusted roots without reading it', async () => {
      const f = await fixture();
      f.request.sources = [{ ...f.dllFile, sourceRoot: 'C:\\outside', sourcePath: 'Plugin.dll' }];
      expect(await createReceiptVerification(f.options)(f.request)).toBe(false);
      expect(f.verify).not.toHaveBeenCalled();
    });
    it.each(['rollback', 'recovery'] as const)(
      'verifies actual backup bytes for %s and denies incomplete source mappings',
      async (purpose) => {
        const f = await fixture(),
          backup = join(f.options.dataRoot, 'backups', randomUUID());
        f.request.purpose = purpose;
        f.request.sources = [];
        for (const file of f.receipt.files) {
          const source = join(backup, ...file.targetPath.split('/'));
          await mkdir(dirname(source), { recursive: true });
          await writeFile(
            source,
            await readFile(join(f.options.targetRoot, ...file.targetPath.split('/'))),
          );
          f.request.sources = [
            ...f.request.sources,
            { ...file, sourceRoot: backup, sourcePath: file.targetPath },
          ];
        }
        // Backup XML must retain the final owned Assembly path, not point at backup DLLs.
        expect(await createReceiptVerification(f.options)(f.request)).toBe(true);
        f.request.sources = f.request.sources.slice(0, -1);
        expect(await createReceiptVerification(f.options)(f.request)).toBe(false);
      },
    );
    it('denies duplicate mappings, mismatched scope and cancellation', async () => {
      const f = await fixture(),
        source = {
          ...f.dllFile,
          sourceRoot: f.options.targetRoot,
          sourcePath: f.dllFile.targetPath,
        };
      f.request.sources = [source, source];
      expect(await createReceiptVerification(f.options)(f.request)).toBe(false);
      f.request.sources = [];
      f.request.scope = { ...f.receipt.scope, ownerId: 2 };
      expect(await createReceiptVerification(f.options)(f.request)).toBe(false);
      const abort = new AbortController();
      abort.abort();
      f.request.scope = f.receipt.scope;
      expect(
        await createReceiptVerification({ ...f.options, signal: abort.signal })(f.request),
      ).toBe(false);
    });
    it('current context revocation during signature verification never returns a valid result', async () => {
      const f = await fixture();
      const admit = createReceiptVerification({
        ...f.options,
        verify: async (p, h) => {
          const result = await f.verify(p, h);
          f.state.live = false;
          return result;
        },
      });
      expect(await admit(f.request)).toBe(false);
    });
    it('freezes policy roots and callback references before catalog await', async () => {
      const f = await fixture();
      let ready!: () => void;
      const gate = new Promise<void>((r) => {
        ready = r;
      });
      f.options.readCatalog = async () => {
        await gate;
        return structuredClone(f.catalog);
      };
      const admit = createReceiptVerification(f.options),
        work = admit(f.request);
      f.options.targetRoot = join(f.root, 'decoy');
      f.options.current = () => false;
      f.options.publisherPins = [];
      ready();
      expect(await work).toBe(true);
    });
  },
);
