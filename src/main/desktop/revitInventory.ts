import { opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RevitInventory } from '../../shared/setup';
interface Roots {
  programFiles: string;
  appData: string;
  programData: string;
}
const missing = (error: unknown) =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_r, reject) => {
        timeout = setTimeout(() => reject(Error('inventory_timeout')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
async function names(path: string): Promise<{ names: string[]; truncated: boolean }> {
  const directory = await opendir(path),
    found: string[] = [];
  let scanned = 0,
    truncated = false;
  for await (const entry of directory) {
    if (++scanned > 512) {
      truncated = true;
      break;
    }
    if (entry.isFile() && /\.addin$/i.test(entry.name)) {
      if (entry.name.length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(entry.name)) {
        truncated = true;
        continue;
      }
      if (found.length >= 200) {
        truncated = true;
        break;
      }
      found.push(entry.name);
    }
  }
  return { names: found.sort((a, b) => a.localeCompare(b)), truncated };
}
/** Read-only evidence from standard 2025/2026 folders; never parses or loads a DLL/manifest. */
export async function scanRevit(roots: Roots): Promise<RevitInventory> {
  const years = await Promise.all(
    ([2025, 2026] as const).map(async (year) => {
      let executable: RevitInventory['years'][number]['executable'] = 'unavailable';
      if (roots.programFiles)
        try {
          executable = (
            await bounded(stat(join(roots.programFiles, 'Autodesk', `Revit ${year}`, 'Revit.exe')))
          ).isFile()
            ? 'found'
            : 'notFound';
        } catch (error) {
          executable = missing(error) ? 'notFound' : 'unavailable';
        }
      const addins = await Promise.all(
        (['user', 'machine'] as const).map(async (scope) => {
          const root = scope === 'user' ? roots.appData : roots.programData;
          if (root)
            try {
              return {
                scope,
                status: 'ok' as const,
                ...(await bounded(names(join(root, 'Autodesk', 'Revit', 'Addins', String(year))))),
              };
            } catch (error) {
              return {
                scope,
                status: missing(error) ? ('missing' as const) : ('unavailable' as const),
                names: [],
                truncated: false,
              };
            }
          return { scope, status: 'unavailable' as const, names: [], truncated: false };
        }),
      );
      return { year, executable, addins };
    }),
  );
  return { checkedAt: Date.now(), years };
}
export class RevitInventoryService {
  private result?: RevitInventory;
  private flight?: Promise<RevitInventory>;
  constructor(private readonly read: () => Promise<RevitInventory>) {}
  inspect(refresh = false): Promise<RevitInventory> {
    if (!refresh && this.result && Date.now() - this.result.checkedAt < 60000)
      return Promise.resolve(structuredClone(this.result));
    if (!this.flight)
      this.flight = this.read()
        .then((result) => {
          this.result = result;
          return structuredClone(result);
        })
        .finally(() => {
          this.flight = undefined;
        });
    return this.flight;
  }
}
