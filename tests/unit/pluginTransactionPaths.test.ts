import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, symlink, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { relativeSafe, ownedPath, nodePathSafe } from '../../src/main/plugins/transactionFs';
import { PluginTransactionStore, receiptValid } from '../../src/main/plugins/transactionStore';
import type { PluginReceipt } from '../../src/main/plugins/transactionTypes';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-txn-paths-'));
  roots.push(root);
  return root;
}
const receipt = (): PluginReceipt => ({
  schema: 1,
  id: randomUUID(),
  scope: { serverHash: 'a'.repeat(64), ownerId: 1 },
  rootsHash: 'b'.repeat(64),
  files: [
    {
      packageKey: 'floor-plans:1:test-layout-v1',
      targetPath: '2025/Plugin.addin',
      kind: 'addin',
      sha256: 'c'.repeat(64),
      size: 20,
      addInIds: [randomUUID()],
    },
    {
      packageKey: 'floor-plans:1:test-layout-v1',
      targetPath: '2025/managed/g1/Plugin.dll',
      kind: 'dll',
      sha256: 'd'.repeat(64),
      size: 30,
    },
  ],
  packages: [
    {
      code: 'floor-plans',
      buildId: 1,
      version: '1.0',
      archiveSha256: 'e'.repeat(64),
      archiveSize: 100,
      revit: [2025],
      descriptorId: 'test-layout-v1',
    },
  ],
});
describe('transaction Windows paths and durable metadata', () => {
  it('rejects reserved aliases/superscripts, traversal, ADS, nonprimitive and excessive segments before writes', () => {
    for (const path of [
      '2025/COM¹.addin',
      '2025/LPT².addin',
      '2025/managed/COM³.dll',
      '2025/CONIN$.addin',
      '2025/CONOUT$.addin',
      '2025/CLOCK$.addin',
      '2025/managed/aux.txt',
      '../outside',
      '/absolute',
      '2025/a:stream',
      '2025/name.',
      '2025/a /file',
      '2025/' + 'x'.repeat(201),
      '2025/../file',
      {},
      ['2025/a.addin'],
      null,
    ])
      expect(relativeSafe(path), String(path)).toBe(false);
    expect(relativeSafe('2025/managed/gen-v1/Plugin.dll')).toBe(true);
    expect(() => ownedPath([] as unknown as string, '2025/ok.addin')).toThrow('unsafe_path');
  });
  it('a valid-checksum adversarial receipt is rejected and its bytes are preserved', async () => {
    const root = await fixture(),
      store = new PluginTransactionStore(root, nodePathSafe),
      r = receipt();
    await store.write('receipt', r);
    expect(await store.read('receipt', receiptValid)).toEqual(r);
    for (const bad of ['2025/COM¹.addin', '2025/CONOUT$.addin', '../outside.addin']) {
      r.files[0] = { ...r.files[0], targetPath: bad } as PluginReceipt['files'][number];
      const payload = r,
        raw = JSON.stringify({
          schema: 1,
          payload,
          sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        });
      await writeFile(join(root, 'receipt.json'), raw);
      await expect(store.read('receipt', receiptValid)).rejects.toThrow('corrupt_metadata');
      expect(await readFile(join(root, 'receipt.json'), 'utf8')).toBe(raw);
    }
  });
  it('actual symlink/junction ancestor is denied without following writes outside root', async () => {
    const root = await fixture(),
      outside = await fixture(),
      link = join(root, 'linked');
    await mkdir(join(outside, 'owned'));
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(nodePathSafe(join(link, 'new-file'))).rejects.toThrow('reparse_path');
  });
  it('junction на соседнюю папку той же родительской папки тоже отклоняется', async () => {
    const root = await fixture(),
      link = join(root, 'linked');
    await mkdir(join(root, 'sibling'));
    await symlink(join(root, 'sibling'), link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(nodePathSafe(join(link, 'new-file'))).rejects.toThrow('reparse_path');
  });
  it.runIf(process.platform === 'win32')(
    'короткое имя Windows 8.3 не считается переадресацией',
    async () => {
      const root = await fixture(),
        long = join(root, 'Long folder name for checks');
      await mkdir(long);
      // Короткое имя выдаёт сама ФС; если 8.3 на томе отключены, проверять нечего.
      const short = spawnSync(
        'cmd.exe',
        ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`],
        // Кавычки внутри /c Node иначе экранирует, и cmd получает испорченную строку.
        { encoding: 'utf8', windowsVerbatimArguments: true },
      ).stdout.trim();
      if (!/~[0-9]+$/.test(short)) return;
      await expect(nodePathSafe(join(short, 'new-file'))).resolves.toBeUndefined();
      await writeFile(join(long, 'file.txt'), 'x');
      await expect(nodePathSafe(join(short, 'file.txt'))).resolves.toBeUndefined();
    },
  );
});
