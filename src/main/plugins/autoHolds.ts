import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { PluginReceipt } from './transactionTypes';

/** Negative local intent only: never authorization to install or restore files. */
export function pluginAutoHoldKey(
  serverHash: string,
  ownerId: number,
  rootsHash: string,
  code: string,
  year: 2025 | 2026,
  buildId: number,
  archiveSha256: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([serverHash, ownerId, rootsHash, code, year, buildId, archiveSha256]))
    .digest('hex');
}
/** Called only with the locally and freshly verified rollback pair. */
export function rolledBackBuildHolds(previous: PluginReceipt, next: PluginReceipt): string[] {
  return previous.packages.flatMap((p) =>
    p.revit
      .filter(
        (year) =>
          !next.packages.some(
            (n) =>
              n.code === p.code &&
              n.revit.includes(year) &&
              n.buildId === p.buildId &&
              n.archiveSha256 === p.archiveSha256,
          ),
      )
      .map((year) =>
        pluginAutoHoldKey(
          previous.scope.serverHash,
          previous.scope.ownerId,
          previous.rootsHash,
          p.code,
          year,
          p.buildId,
          p.archiveSha256,
        ),
      ),
  );
}
/** Separate from preference migration: malformed state blocks automation/rollback
 * instead of becoming an empty list. No silent eviction of a past rollback. */
export class PluginAutoHolds {
  constructor(private readonly file: string) {}
  read(): Set<string> {
    let stat;
    try {
      stat = lstatSync(this.file);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return new Set();
      throw Error('plugin_auto_holds_unavailable', { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 300_000)
      throw Error('plugin_auto_holds_invalid');
    const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw Error('plugin_auto_holds_invalid');
    const r = raw as Record<string, unknown>;
    if (
      Object.keys(r).sort().join(',') !== 'keys,schema' ||
      r.schema !== 1 ||
      !Array.isArray(r.keys) ||
      r.keys.length > 4096 ||
      !r.keys.every((k) => typeof k === 'string' && /^[a-f0-9]{64}$/.test(k)) ||
      new Set(r.keys).size !== r.keys.length
    )
      throw Error('plugin_auto_holds_invalid');
    return new Set(r.keys as string[]);
  }
  add(keys: readonly string[]): void {
    const next = this.read();
    for (const key of keys) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw Error('plugin_auto_holds_invalid');
      next.add(key);
    }
    if (next.size > 4096) throw Error('plugin_auto_holds_full');
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx');
      writeFileSync(fd, JSON.stringify({ schema: 1, keys: [...next].sort() }) + '\n', 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.file);
      const saved = this.read();
      if ([...next].some((key) => !saved.has(key))) throw Error('plugin_auto_holds_write');
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        /* renamed or retained failure */
      }
    }
  }
}
