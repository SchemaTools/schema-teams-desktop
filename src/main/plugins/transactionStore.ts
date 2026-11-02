import {
  openSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  lstatSync,
  fstatSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pluginCode, pluginVersion, PLUGIN_MAX_BYTES } from '../../shared/plugins';
import { positiveId } from '../../shared/time';
import { sha, uuid, relativeSafe, key } from './transactionFs';
import type {
  PluginScope,
  OwnedPluginFile,
  PluginReceipt,
  PluginBackupRecord,
  PluginTransactionJournal,
  InstalledPluginPackage,
} from './transactionTypes';
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).every((n) => names.includes(n));
export const scopeValid = (v: unknown): v is PluginScope =>
  obj(v) && only(v, ['serverHash', 'ownerId']) && sha(v.serverHash) && positiveId(v.ownerId);
export const scopeSame = (a: PluginScope, b: PluginScope) =>
  a.serverHash === b.serverHash && a.ownerId === b.ownerId;
export const packageKey = (p: InstalledPluginPackage) => `${p.code}:${p.buildId}:${p.descriptorId}`;
const guid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v) &&
  v !== '00000000-0000-0000-0000-000000000000';
export function fileValid(v: unknown): v is OwnedPluginFile {
  if (
    !obj(v) ||
    !only(v, ['packageKey', 'targetPath', 'kind', 'sha256', 'size', 'addInIds']) ||
    typeof v.packageKey !== 'string' ||
    !/^[a-z][a-z0-9-]{1,39}:[1-9]\d{0,15}:[a-zA-Z0-9._-]{1,80}$/.test(v.packageKey) ||
    !relativeSafe(v.targetPath) ||
    !/^(2025|2026)\//.test(v.targetPath) ||
    !sha(v.sha256) ||
    !Number.isSafeInteger(v.size) ||
    Number(v.size) <= 0 ||
    Number(v.size) > 1024 * 1024 * 1024
  )
    return false;
  if (v.kind === 'addin')
    return (
      Number(v.size) <= 1024 * 1024 &&
      v.targetPath.split('/').length === 2 &&
      /\.addin$/i.test(v.targetPath) &&
      Array.isArray(v.addInIds) &&
      v.addInIds.length > 0 &&
      v.addInIds.length <= 128 &&
      v.addInIds.every(guid) &&
      new Set(v.addInIds.map((g) => g.toLowerCase())).size === v.addInIds.length
    );
  if ('addInIds' in v) return false;
  if (v.kind === 'dll') return v.targetPath.split('/').length >= 3 && /\.dll$/i.test(v.targetPath);
  return (
    v.kind === 'data' &&
    v.targetPath.split('/').length >= 3 &&
    !/\.(?:dll|addin)$/i.test(v.targetPath)
  );
}
function packageValid(v: unknown): v is InstalledPluginPackage {
  return (
    obj(v) &&
    only(v, [
      'code',
      'buildId',
      'version',
      'archiveSha256',
      'archiveSize',
      'revit',
      'descriptorId',
    ]) &&
    pluginCode(v.code) &&
    positiveId(v.buildId) &&
    pluginVersion(v.version) &&
    sha(v.archiveSha256) &&
    Number.isSafeInteger(v.archiveSize) &&
    Number(v.archiveSize) > 0 &&
    Number(v.archiveSize) <= PLUGIN_MAX_BYTES &&
    Array.isArray(v.revit) &&
    v.revit.length > 0 &&
    v.revit.length <= 2 &&
    v.revit.every((y) => y === 2025 || y === 2026) &&
    new Set(v.revit).size === v.revit.length &&
    typeof v.descriptorId === 'string' &&
    /^[a-zA-Z0-9._-]{1,80}$/.test(v.descriptorId)
  );
}
export function receiptValid(v: unknown): v is PluginReceipt {
  if (
    !obj(v) ||
    !only(v, ['schema', 'id', 'scope', 'rootsHash', 'files', 'packages']) ||
    v.schema !== 1 ||
    !uuid(v.id) ||
    !scopeValid(v.scope) ||
    !sha(v.rootsHash) ||
    !Array.isArray(v.files) ||
    v.files.length < 1 ||
    v.files.length > 512 ||
    !v.files.every(fileValid) ||
    !Array.isArray(v.packages) ||
    v.packages.length < 1 ||
    v.packages.length > 128 ||
    !v.packages.every(packageValid)
  )
    return false;
  const packages = v.packages,
    ids = v.files.flatMap((f) =>
      (f.addInIds ?? []).map((id) => `${f.targetPath.split('/')[0]}:${id.toLowerCase()}`),
    ),
    packageYears = packages.flatMap((p) => p.revit.map((y) => `${p.code}:${y}`));
  const files = v.files;
  return (
    new Set(files.map((f) => key(f.targetPath))).size === files.length &&
    files.reduce((n, f) => n + f.size, 0) <= 1024 * 1024 * 1024 &&
    files.some((f) => f.kind === 'addin') &&
    files.some((f) => f.kind === 'dll') &&
    new Set(packages.map(packageKey)).size === packages.length &&
    new Set(packageYears).size === packageYears.length &&
    new Set(ids).size === ids.length &&
    files.every((f) =>
      packages.some(
        (p) =>
          packageKey(p) === f.packageKey &&
          p.revit.includes(Number(f.targetPath.split('/')[0]) as 2025 | 2026),
      ),
    ) &&
    packages.every((p) =>
      p.revit.every((y) =>
        ['dll', 'addin'].every((kind) =>
          files.some(
            (f) =>
              f.packageKey === packageKey(p) &&
              Number(f.targetPath.split('/')[0]) === y &&
              f.kind === kind,
          ),
        ),
      ),
    )
  );
}
export function backupValid(v: unknown): v is PluginBackupRecord {
  return (
    obj(v) &&
    only(v, ['schema', 'backupId', 'receipt', 'replacedBy']) &&
    v.schema === 1 &&
    uuid(v.backupId) &&
    receiptValid(v.receipt) &&
    uuid(v.replacedBy)
  );
}
export function journalValid(v: unknown): v is PluginTransactionJournal {
  if (
    !obj(v) ||
    !only(v, [
      'schema',
      'id',
      'rootsHash',
      'scope',
      'purpose',
      'next',
      'previous',
      'priorBackup',
      'sources',
      'before',
      'backupFiles',
      'removals',
      'removalIntents',
      'phase',
    ]) ||
    v.schema !== 2 ||
    !uuid(v.id) ||
    !sha(v.rootsHash) ||
    !scopeValid(v.scope) ||
    typeof v.purpose !== 'string' ||
    !['install', 'rollback'].includes(v.purpose) ||
    !receiptValid(v.next) ||
    (v.previous !== null && !receiptValid(v.previous)) ||
    (v.priorBackup !== null && !backupValid(v.priorBackup)) ||
    !Array.isArray(v.sources) ||
    v.sources.length < 1 ||
    v.sources.length > v.next.files.length ||
    !Array.isArray(v.before) ||
    !Array.isArray(v.backupFiles) ||
    v.before.length > 512 ||
    v.backupFiles.length > 1024 ||
    !Array.isArray(v.removals) ||
    !Array.isArray(v.removalIntents) ||
    v.removals.length > 512 ||
    v.removalIntents.length > v.removals.length ||
    typeof v.phase !== 'string' ||
    !['intent', 'backed-up', 'payload', 'addin', 'metadata', 'complete'].includes(v.phase)
  )
    return false;
  if (
    v.next.rootsHash !== v.rootsHash ||
    !scopeSame(v.scope, v.next.scope) ||
    (v.previous &&
      (v.previous.rootsHash !== v.rootsHash || !scopeSame(v.scope, v.previous.scope))) ||
    (v.priorBackup &&
      (v.priorBackup.receipt.rootsHash !== v.rootsHash ||
        !scopeSame(v.scope, v.priorBackup.receipt.scope)))
  )
    return false;
  const next = v.next;
  const removed = (v.previous?.files ?? []).filter(
    (f) => f.kind === 'addin' && !next.files.some((n) => key(n.targetPath) === key(f.targetPath)),
  );
  if (
    v.removals.length !== removed.length ||
    !v.removals.every(
      (r) =>
        fileValid(r) &&
        r.kind === 'addin' &&
        removed.some((f) => JSON.stringify(f) === JSON.stringify(r)),
    ) ||
    new Set(v.removals.map((r) => key((r as OwnedPluginFile).targetPath))).size !==
      v.removals.length
  )
    return false;
  if (
    !v.removalIntents.every(
      (p) => typeof p === 'string' && removed.some((f) => f.targetPath === p),
    ) ||
    new Set(v.removalIntents).size !== v.removalIntents.length
  )
    return false;
  if (!['addin', 'metadata', 'complete'].includes(v.phase) && v.removalIntents.length) return false;
  if (['metadata', 'complete'].includes(v.phase) && v.removalIntents.length !== removed.length)
    return false;
  if (
    (v.previous === null && v.priorBackup !== null) ||
    (v.previous && v.priorBackup && v.priorBackup.replacedBy !== v.previous.id) ||
    (v.purpose === 'install' && next.id !== v.id) ||
    (v.purpose === 'rollback' && (!v.priorBackup || next.id !== v.priorBackup.receipt.id))
  )
    return false;
  const beforeValid = (b: unknown) =>
    obj(b) &&
    only(b, ['targetPath', 'sha256', 'size']) &&
    relativeSafe(b.targetPath) &&
    sha(b.sha256) &&
    Number.isSafeInteger(b.size) &&
    Number(b.size) > 0 &&
    Number(b.size) <= 1024 * 1024 * 1024;
  if (!v.before.every(beforeValid) || !v.backupFiles.every(beforeValid)) return false;
  if (
    !v.sources.every((s) => {
      if (
        !obj(s) ||
        !only(s, [
          'packageKey',
          'targetPath',
          'kind',
          'sha256',
          'size',
          'addInIds',
          'sourceRoot',
          'sourcePath',
        ]) ||
        typeof s.sourceRoot !== 'string' ||
        s.sourceRoot.length > 32760 ||
        !relativeSafe(s.sourcePath)
      )
        return false;
      const f = next.files.find((f) => f.targetPath === s.targetPath);
      return (
        f &&
        s.kind === f.kind &&
        s.sha256 === f.sha256 &&
        s.size === f.size &&
        s.packageKey === f.packageKey &&
        JSON.stringify(s.addInIds) === JSON.stringify(f.addInIds)
      );
    })
  )
    return false;
  if (new Set(v.sources.map((s) => key(s.targetPath))).size !== v.sources.length) return false;
  const before = v.before as { targetPath: string; sha256: string; size: number }[],
    backups = v.backupFiles as { targetPath: string; sha256: string; size: number }[];
  if (before.some((b) => !next.files.some((f) => key(f.targetPath) === key(b.targetPath))))
    return false;
  const expected = [...before, ...(v.previous?.files ?? [])];
  if (
    backups.some(
      (b) =>
        !expected.some(
          (f) =>
            key(f.targetPath) === key(b.targetPath) && f.sha256 === b.sha256 && f.size === b.size,
        ),
    ) ||
    expected.some(
      (f) =>
        !backups.some(
          (b) =>
            key(f.targetPath) === key(b.targetPath) && f.sha256 === b.sha256 && f.size === b.size,
        ),
    )
  )
    return false;
  return (
    new Set(v.before.map((b) => key((b as { targetPath: string }).targetPath))).size ===
      v.before.length &&
    new Set(v.backupFiles.map((b) => key((b as { targetPath: string }).targetPath))).size ===
      v.backupFiles.length
  );
}
type StoreName = 'journal' | 'receipt' | 'previous';
/** One main writer. Bounded checksummed metadata, fsync+atomic replace; corrupt bytes are never reset. */
export class PluginTransactionStore {
  constructor(
    private readonly root: string,
    private readonly guard: (path: string) => Promise<void>,
    private readonly live: () => boolean = () => true,
  ) {}
  private assertLive(): void {
    if (!this.live()) throw Error('stale_writer');
  }
  private path(name: StoreName) {
    return join(this.root, name + '.json');
  }
  async read<T>(name: StoreName, valid: (v: unknown) => v is T): Promise<T | null> {
    const path = this.path(name);
    await this.guard(path);
    let bytes: Buffer;
    try {
      if (lstatSync(path).size > 1024 * 1024) throw Error('corrupt_metadata');
      bytes = readFileSync(path);
      if (bytes.length > 1024 * 1024) throw Error('corrupt_metadata');
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null;
      throw e;
    }
    const text = bytes.toString('utf8'),
      raw: unknown = JSON.parse(text);
    if (
      JSON.stringify(raw) !== text ||
      !obj(raw) ||
      Object.keys(raw).sort().join(',') !== 'payload,schema,sha256' ||
      raw.schema !== 1 ||
      !sha(raw.sha256) ||
      createHash('sha256').update(JSON.stringify(raw.payload)).digest('hex') !== raw.sha256 ||
      !valid(raw.payload)
    )
      throw Error('corrupt_metadata');
    return structuredClone(raw.payload);
  }
  async write(name: StoreName, payload: unknown): Promise<void> {
    const path = this.path(name);
    await this.guard(path);
    this.assertLive();
    const body = JSON.stringify({
      schema: 1,
      payload,
      sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    });
    if (Buffer.byteLength(body) > 1024 * 1024) throw Error('metadata_limit');
    this.assertLive();
    mkdirSync(dirname(path), { recursive: true });
    await this.guard(path);
    this.assertLive();
    const temp = path + '.' + randomUUID() + '.part';
    let fd: number | undefined, id: { dev: bigint; ino: bigint } | undefined;
    const own = () => {
      try {
        const stat = lstatSync(temp, { bigint: true });
        return (
          stat.isFile() && !stat.isSymbolicLink() && id?.dev === stat.dev && id.ino === stat.ino
        );
      } catch {
        return false;
      }
    };
    try {
      this.assertLive();
      fd = openSync(temp, 'wx', 0o600);
      id = fstatSync(fd, { bigint: true });
      writeFileSync(fd, body);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      await this.guard(path);
      this.assertLive();
      if (!own() || readFileSync(temp, 'utf8') !== body) throw Error('metadata_changed');
      renameSync(temp, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (this.live() && own())
        try {
          unlinkSync(temp);
        } catch {
          // Leave this owned orphan without replacing the original operation error.
        }
    }
  }
  async remove(name: StoreName): Promise<void> {
    const path = this.path(name);
    await this.guard(path);
    this.assertLive();
    try {
      unlinkSync(path);
    } catch (e) {
      if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'ENOENT') throw e;
    }
  }
}
