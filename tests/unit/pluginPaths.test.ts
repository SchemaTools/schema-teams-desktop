import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { nodePathSafe } from '../../src/main/plugins/fsSafe';
import { assertOrdinaryDirectory } from '../../src/main/plugins/archivePaths';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-paths-'));
  roots.push(root);
  return root;
}
function shortName(long: string): string {
  return spawnSync(
    'cmd.exe',
    ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`],
    // Кавычки внутри /c Node иначе экранирует.
    { encoding: 'utf8', windowsVerbatimArguments: true },
  ).stdout.trim();
}
describe('plugin path redirection checks', () => {
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
  it.runIf(process.platform === 'win32')(
    'short 8.3 name passes the staging directory check; junction does not',
    async () => {
      const root = await fixture(),
        long = join(root, 'Long staging folder name');
      await mkdir(long);
      const short = shortName(long);
      if (!/~[0-9]+$/.test(short)) return;
      await expect(assertOrdinaryDirectory(short)).resolves.toBeUndefined();
      const link = join(root, 'linked');
      await symlink(long, link, 'junction');
      await expect(assertOrdinaryDirectory(link)).rejects.toThrow();
    },
  );
});
