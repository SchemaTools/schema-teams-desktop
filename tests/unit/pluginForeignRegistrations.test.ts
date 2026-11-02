import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
const { appRoot } = vi.hoisted(() => ({ appRoot: process.cwd() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => appRoot } }));
import {
  verifyNoForeignAddinIds,
  type ForeignRegistrationOptions,
} from '../../src/main/plugins/foreignRegistrations';
import { inspectPluginManifest } from '../../src/main/plugins/addinManifest';
import { fixtureXml, fileHash } from '../helpers/pluginArchiveFixture';
const base = resolve(__dirname, '../../private'),
  roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + sep) || !root.includes('foreign-addins-'))
      throw Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'foreign-addins-'));
  roots.push(root);
  const user = join(root, 'Пользователь'),
    machine = join(root, 'Machine'),
    id = randomUUID();
  await mkdir(user);
  await mkdir(machine);
  const options: ForeignRegistrationOptions = {
    roots: [
      { year: 2025, path: user },
      { year: 2025, path: machine },
    ],
    desired: [{ year: 2025, addInId: id }],
    owned: [],
    current: () => true,
    pathAllowed: async () => true,
  };
  const write = async (dir: string, name: string, guid = randomUUID()) => {
    const bytes = fixtureXml('Plugin.dll', guid),
      path = join(dir, name);
    await writeFile(path, bytes);
    return { year: 2025 as const, path, sha256: fileHash(bytes), size: bytes.length };
  };
  return { root, user, machine, id, options, write };
}
describe.skipIf(process.platform !== 'win32')(
  'foreign AddInId scan with native XML in temporary directories',
  () => {
    it('reads unrelated registrations without modifying them', async () => {
      const f = await fixture(),
        file = await f.write(f.machine, 'Foreign.addin'),
        before = await readFile(file.path);
      expect(await verifyNoForeignAddinIds(f.options)).toBe(true);
      expect(await readFile(file.path)).toEqual(before);
    });
    it.each(['user', 'machine'] as const)(
      'blocks the desired GUID under another filename in %s scope',
      async (which) => {
        const f = await fixture();
        await f.write(f[which], 'Unexpected.ADDIN', f.id);
        expect(await verifyNoForeignAddinIds(f.options)).toBe(false);
      },
    );
    it('allows exact known owned bytes and blocks replacement at the same path', async () => {
      const f = await fixture(),
        file = await f.write(f.user, 'Owned.addin', f.id);
      f.options.owned = [file];
      expect(await verifyNoForeignAddinIds(f.options)).toBe(true);
      await writeFile(file.path, fixtureXml('Other.dll', f.id));
      expect(await verifyNoForeignAddinIds(f.options)).toBe(false);
    });
    it('does not exempt an unrelated registration outside the specified roots', async () => {
      const f = await fixture(),
        file = await f.write(f.root, 'Outside.addin', f.id);
      f.options.owned = [file];
      expect(await verifyNoForeignAddinIds(f.options)).toBe(false);
    });
    it('does not collide across Revit years', async () => {
      const f = await fixture(),
        other = join(f.root, '2026');
      await mkdir(other);
      await f.write(other, 'OtherYear.addin', f.id);
      f.options.roots = [...f.options.roots, { year: 2026, path: other }];
      expect(await verifyNoForeignAddinIds(f.options)).toBe(true);
    });
    it('blocks unknown XML and a directory masquerading as an addin', async () => {
      const f = await fixture();
      await writeFile(join(f.machine, 'Unknown.addin'), '<RevitAddIns><Unknown/></RevitAddIns>');
      expect(await verifyNoForeignAddinIds(f.options)).toBe(false);
      const g = await fixture();
      await mkdir(join(g.user, 'Directory.addin'));
      expect(await verifyNoForeignAddinIds(g.options)).toBe(false);
    });
    it('allows missing roots but denies their creation during the scan', async () => {
      const f = await fixture(),
        absent = join(f.root, 'absent');
      f.options.roots = [{ year: 2025, path: absent }, ...f.options.roots];
      expect(await verifyNoForeignAddinIds(f.options)).toBe(true);
      await f.write(f.user, 'Trigger.addin');
      f.options.inspect = async (...args) => {
        await mkdir(absent);
        return inspectPluginManifest(...args);
      };
      expect(await verifyNoForeignAddinIds(f.options)).toBe(false);
    });
    it('rejects foreign bytes changed after native inspection', async () => {
      const f = await fixture(),
        file = await f.write(f.machine, 'Foreign.addin');
      f.options.inspect = async (...args) => {
        const p = await inspectPluginManifest(...args);
        await writeFile(file.path, fixtureXml('Plugin.dll', f.id));
        return p;
      };
      expect(await verifyNoForeignAddinIds(f.options)).toBe(false);
    });
    it('rejects a new registration introduced during the scan', async () => {
      const f = await fixture();
      await f.write(f.user, 'First.addin');
      f.options.inspect = async (...args) => {
        const p = await inspectPluginManifest(...args);
        await f.write(f.user, 'Late.addin', f.id);
        return p;
      };
      expect(await verifyNoForeignAddinIds(f.options)).toBe(false);
    });
    it('rejects a registration added to an earlier root while inspecting the later root', async () => {
      const f = await fixture();
      await f.write(f.machine, 'Machine.addin');
      f.options.inspect = async (...args) => {
        const p = await inspectPluginManifest(...args);
        await f.write(f.user, 'Late.addin', f.id);
        return p;
      };
      expect(await verifyNoForeignAddinIds(f.options)).toBe(false);
    });
    it('rechecks context after a native await and denies unsafe paths before inspection', async () => {
      const f = await fixture();
      await f.write(f.machine, 'Foreign.addin');
      let live = true;
      f.options.current = () => live;
      f.options.inspect = async (...args) => {
        const p = await inspectPluginManifest(...args);
        live = false;
        return p;
      };
      expect(await verifyNoForeignAddinIds(f.options)).toBe(false);
      const inspect = vi.fn(inspectPluginManifest);
      expect(
        await verifyNoForeignAddinIds({
          ...f.options,
          current: () => true,
          pathAllowed: async () => false,
          inspect,
        }),
      ).toBe(false);
      expect(inspect).not.toHaveBeenCalled();
    });
    it('bounds registration counts and individual XML size before parsing', async () => {
      const f = await fixture();
      await Promise.all(
        Array.from({ length: 129 }, (_, i) => writeFile(join(f.user, `${i}.addin`), 'x')),
      );
      const inspect = vi.fn(inspectPluginManifest);
      expect(await verifyNoForeignAddinIds({ ...f.options, inspect })).toBe(false);
      expect(inspect).not.toHaveBeenCalled();
      const g = await fixture();
      await writeFile(join(g.user, 'Large.addin'), Buffer.alloc(1024 * 1024 + 1));
      expect(await verifyNoForeignAddinIds({ ...g.options, inspect })).toBe(false);
      expect(inspect).not.toHaveBeenCalled();
    });
    it('stops directory enumeration at the bounded entry count, including non-addin files', async () => {
      const f = await fixture();
      await Promise.all(
        Array.from({ length: 513 }, (_, i) => writeFile(join(f.user, `${i}.txt`), 'x')),
      );
      const inspect = vi.fn(inspectPluginManifest);
      expect(await verifyNoForeignAddinIds({ ...f.options, inspect })).toBe(false);
      expect(inspect).not.toHaveBeenCalled();
    });
  },
);
