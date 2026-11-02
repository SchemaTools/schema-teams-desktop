import { resolve, sep, join, isAbsolute, dirname } from 'node:path';
import { unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  ownedPath,
  nodePathSafe,
  existingFile,
  atomicCopy,
  removeOwnedManifest,
  key,
  uuid,
} from './transactionFs';
import {
  PluginTransactionStore,
  receiptValid,
  backupValid,
  journalValid,
  scopeValid,
  scopeSame,
} from './transactionStore';
import { mergeManagedSet } from './transactionPlan';
import type { RevitProcessState } from './safety';
import type {
  PluginScope,
  PluginReceipt,
  PluginTransactionPlan,
  PluginTransactionJournal,
  PluginTransactionResult,
  PluginBeforeFile,
  PluginBackupRecord,
  StagedPluginFile,
} from './transactionTypes';
interface Admission {
  scope: PluginScope;
  purpose: 'install' | 'rollback' | 'recovery';
  receipt: PluginReceipt | null;
  sources: readonly StagedPluginFile[];
}
export interface PluginTransactionOptions {
  targetRoot: string;
  dataRoot: string;
  stagingParent: string;
  current: (scope: PluginScope) => boolean;
  admit: (request: Admission) => Promise<boolean>;
  processes: () => Promise<RevitProcessState>;
  pathAllowed: (path: string) => Promise<boolean>;
  afterCheckpoint?: (phase: PluginTransactionJournal['phase']) => Promise<void>;
  afterWrite?: (targetPath: string) => Promise<void>;
}
class Waiting extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
class Blocked extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const sameBytes = (
  a: { sha256: string; size: number } | null,
  b: { sha256: string; size: number },
) => a?.sha256 === b.sha256 && a.size === b.size;
const operationLeases = new Map<string, { token: symbol; live: () => boolean }>();
/** Recoverable whole-managed-set transaction. Not a global atomic filesystem operation. */
export class PluginTransactions {
  readonly rootsHash: string;
  private readonly store: PluginTransactionStore;
  private readonly o: Readonly<PluginTransactionOptions>;
  private flight = false;
  private disposed = false;
  private lease?: symbol;
  private operationScope?: PluginScope;
  constructor(options: PluginTransactionOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      ['targetRoot', 'dataRoot', 'stagingParent'].some((k) => {
        const v = options[k as 'targetRoot' | 'dataRoot' | 'stagingParent'];
        return (
          typeof v !== 'string' ||
          v.length > 32760 ||
          v.includes('\0') ||
          !isAbsolute(v) ||
          /^(?:\\\\|\/\/)/.test(v) ||
          resolve(v) === dirname(resolve(v))
        );
      }) ||
      ['current', 'admit', 'processes', 'pathAllowed'].some(
        (k) =>
          typeof options[k as 'current' | 'admit' | 'processes' | 'pathAllowed'] !== 'function',
      )
    )
      throw Error('invalid_roots');
    const target = resolve(options.targetRoot),
      data = resolve(options.dataRoot),
      staging = resolve(options.stagingParent);
    if (
      key(data + sep).startsWith(key(target + sep)) ||
      key(target + sep).startsWith(key(data + sep)) ||
      key(staging + sep).startsWith(key(target + sep)) ||
      key(target + sep).startsWith(key(staging + sep))
    )
      throw Error('overlapping_roots');
    this.rootsHash = createHash('sha256')
      .update(JSON.stringify([target, data, staging]))
      .digest('hex');
    this.o = Object.freeze({
      ...options,
      targetRoot: target,
      dataRoot: data,
      stagingParent: staging,
    });
    this.store = new PluginTransactionStore(
      data,
      (path) => this.pathGuard(path),
      () => this.operationAlive(),
    );
  }
  private operationAlive(): boolean {
    try {
      return (
        !this.disposed &&
        !!this.lease &&
        operationLeases.get(key(this.o.dataRoot))?.token === this.lease &&
        !!this.operationScope &&
        this.o.current(this.operationScope)
      );
    } catch {
      return false;
    }
  }
  private acquire(scope: PluginScope): void {
    const k = key(this.o.dataRoot),
      old = operationLeases.get(k);
    if (old?.live()) throw new Blocked('busy');
    const token = Symbol('plugin-operation');
    this.lease = token;
    this.operationScope = structuredClone(scope);
    operationLeases.set(k, { token, live: () => this.operationAlive() });
    if (!this.operationAlive()) {
      this.release();
      throw new Blocked('stale_scope');
    }
  }
  private release(): void {
    if (operationLeases.get(key(this.o.dataRoot))?.token === this.lease)
      operationLeases.delete(key(this.o.dataRoot));
    this.lease = undefined;
    this.operationScope = undefined;
  }
  dispose(): void {
    this.disposed = true;
    this.release();
  }
  private async pathGuard(path: string): Promise<void> {
    await nodePathSafe(path);
    if (!(await this.o.pathAllowed(path))) throw new Blocked('unsafe_path');
  }
  private async check(scope: PluginScope): Promise<void> {
    if (!this.operationAlive() || !this.o.current(scope)) throw new Blocked('stale_scope');
    let state: RevitProcessState = 'unknown';
    try {
      state = await this.o.processes();
    } catch {
      /* Unknown is waiting. */
    }
    if (!this.operationAlive() || !this.o.current(scope)) throw new Blocked('stale_scope');
    if (state !== 'idle') throw new Waiting(state === 'busy' ? 'revit_busy' : 'revit_unknown');
  }
  private trusted(receipt: PluginReceipt, scope: PluginScope): void {
    if (
      !receiptValid(receipt) ||
      receipt.rootsHash !== this.rootsHash ||
      !scopeSame(receipt.scope, scope)
    )
      throw new Blocked('receipt_scope');
  }
  private backupRoot(id: string): string {
    if (!uuid(id)) throw new Blocked('backup_invalid');
    return join(this.o.dataRoot, 'backups', id);
  }
  private async verify(receipt: PluginReceipt, root = this.o.targetRoot): Promise<void> {
    for (const f of receipt.files) {
      const path = ownedPath(root, f.targetPath);
      await this.pathGuard(path);
      if (!sameBytes(await existingFile(path), f)) throw new Blocked('owned_file_changed');
    }
  }
  private async checkpoint(
    j: PluginTransactionJournal,
    phase: PluginTransactionJournal['phase'],
  ): Promise<void> {
    await this.check(j.scope);
    j.phase = phase;
    if (!journalValid(j)) throw new Blocked('journal_invalid');
    await this.store.write('journal', j);
    await this.o.afterCheckpoint?.(phase);
  }
  async inspect(
    scope: PluginScope,
  ): Promise<{ receipt: PluginReceipt | null; pending: boolean; blocked: boolean }> {
    try {
      scope = structuredClone(scope);
      if (!scopeValid(scope) || !this.o.current(scope))
        return { receipt: null, pending: false, blocked: true };
      const j = await this.store.read('journal', journalValid),
        r = await this.store.read('receipt', receiptValid);
      if (j && (j.rootsHash !== this.rootsHash || !scopeSame(j.scope, scope)))
        throw new Blocked('journal_scope');
      if (r) this.trusted(r, scope);
      if (!this.o.current(scope)) throw new Blocked('stale_scope');
      return { receipt: r, pending: !!j, blocked: false };
    } catch {
      return { receipt: null, pending: true, blocked: true };
    }
  }
  async install(rawPlan: PluginTransactionPlan): Promise<PluginTransactionResult> {
    if (this.flight) return { status: 'blocked', reason: 'busy' };
    this.flight = true;
    try {
      const plan = structuredClone(rawPlan);
      if (!scopeValid(plan.scope) || !this.o.current(plan.scope)) throw new Blocked('stale_scope');
      this.acquire(plan.scope);
      const pending = await this.store.read('journal', journalValid);
      if (pending) return { status: 'recovery', reason: 'unfinished_transaction' };
      const previous = await this.store.read('receipt', receiptValid),
        priorBackup = await this.store.read('previous', backupValid);
      if (previous) this.trusted(previous, plan.scope);
      const next = mergeManagedSet(previous, plan, this.rootsHash, this.o.stagingParent);
      return await this.execute(
        randomUUID(),
        plan.scope,
        'install',
        next,
        previous,
        priorBackup,
        plan.files,
      );
    } catch (e) {
      return this.failure(e, false);
    } finally {
      this.release();
      this.flight = false;
    }
  }
  async rollback(scope: PluginScope, expectedCurrentId: string): Promise<PluginTransactionResult> {
    if (this.flight) return { status: 'blocked', reason: 'busy' };
    this.flight = true;
    try {
      scope = structuredClone(scope);
      if (!scopeValid(scope) || !uuid(expectedCurrentId) || !this.o.current(scope))
        throw new Blocked('stale_scope');
      this.acquire(scope);
      if (await this.store.read('journal', journalValid))
        return { status: 'recovery', reason: 'unfinished_transaction' };
      const previous = await this.store.read('receipt', receiptValid),
        backup = await this.store.read('previous', backupValid);
      if (
        !previous ||
        !backup ||
        previous.id !== expectedCurrentId ||
        backup.replacedBy !== previous.id
      )
        throw new Blocked('backup_invalid');
      this.trusted(previous, scope);
      this.trusted(backup.receipt, scope);
      await this.verify(backup.receipt, this.backupRoot(backup.backupId));
      const sources = backup.receipt.files.map((f) => ({
        ...f,
        sourceRoot: this.backupRoot(backup.backupId),
        sourcePath: f.targetPath,
      }));
      return await this.execute(
        randomUUID(),
        scope,
        'rollback',
        backup.receipt,
        previous,
        backup,
        sources,
      );
    } catch (e) {
      return this.failure(e, false);
    } finally {
      this.release();
      this.flight = false;
    }
  }
  private async execute(
    id: string,
    scope: PluginScope,
    purpose: 'install' | 'rollback',
    next: PluginReceipt,
    previous: PluginReceipt | null,
    priorBackup: PluginBackupRecord | null,
    sources: StagedPluginFile[],
  ): Promise<PluginTransactionResult> {
    let started = false;
    try {
      if (!this.operationAlive()) throw new Blocked('stale_scope');
      if (
        !(await this.o.admit({
          scope: structuredClone(scope),
          purpose,
          receipt: structuredClone(next),
          sources: structuredClone(sources),
        }))
      )
        throw new Blocked('admission_denied');
      await this.check(scope);
      if (previous) await this.verify(previous);
      if (
        priorBackup &&
        (priorBackup.replacedBy !== previous?.id ||
          priorBackup.receipt.rootsHash !== this.rootsHash ||
          !scopeSame(priorBackup.receipt.scope, scope))
      )
        throw new Blocked('backup_invalid');
      const before: PluginBeforeFile[] = [];
      for (const f of sources) {
        await this.check(scope);
        const source = ownedPath(f.sourceRoot, f.sourcePath);
        await this.pathGuard(source);
        if (!sameBytes(await existingFile(source), f)) throw new Blocked('source_changed');
        const target = ownedPath(this.o.targetRoot, f.targetPath);
        await this.pathGuard(target);
        const actual = await existingFile(target);
        if (actual) {
          const owned = previous?.files.find((old) => key(old.targetPath) === key(f.targetPath));
          const historical =
            purpose === 'rollback'
              ? next.files.find((old) => key(old.targetPath) === key(f.targetPath))
              : undefined;
          if (!(
            (owned && sameBytes(actual, owned)) ||
            (historical && sameBytes(actual, historical))
          ))
            throw new Blocked('foreign_target');
          if (f.kind !== 'addin' && purpose === 'install')
            throw new Blocked('payload_not_immutable');
          before.push({ targetPath: f.targetPath, ...actual });
        }
      }
      const backupMap = new Map<string, PluginBeforeFile>();
      for (const f of [...(previous?.files ?? []), ...before]) {
        const old = backupMap.get(key(f.targetPath));
        if (old && !sameBytes(old, f)) throw new Blocked('backup_invalid');
        backupMap.set(key(f.targetPath), {
          targetPath: f.targetPath,
          sha256: f.sha256,
          size: f.size,
        });
      }
      const removals = (previous?.files ?? []).filter(
        (f) =>
          f.kind === 'addin' && !next.files.some((n) => key(n.targetPath) === key(f.targetPath)),
      );
      const j: PluginTransactionJournal = {
        schema: 2,
        id,
        rootsHash: this.rootsHash,
        scope: structuredClone(scope),
        purpose,
        next: structuredClone(next),
        previous: structuredClone(previous),
        priorBackup: structuredClone(priorBackup),
        sources: structuredClone(sources),
        before,
        backupFiles: [...backupMap.values()],
        removals: structuredClone(removals),
        removalIntents: [],
        phase: 'intent',
      };
      if (purpose === 'install') j.id = next.id;
      await this.check(scope);
      if (!journalValid(j)) throw new Blocked('journal_invalid');
      await this.store.write('journal', j);
      started = true;
      await this.o.afterCheckpoint?.('intent');
      for (const f of j.backupFiles) {
        await this.check(scope);
        const target = ownedPath(this.backupRoot(j.id), f.targetPath);
        if (await existingFile(target)) throw new Blocked('backup_collision');
        await atomicCopy(
          ownedPath(this.o.targetRoot, f.targetPath),
          target,
          f,
          (path) => this.pathGuard(path),
          () => this.operationAlive(),
        );
      }
      for (const f of j.backupFiles)
        if (!sameBytes(await existingFile(ownedPath(this.backupRoot(j.id), f.targetPath)), f))
          throw new Blocked('backup_invalid');
      await this.checkpoint(j, 'backed-up');
      for (const phase of ['payload', 'addin'] as const) {
        await this.checkpoint(j, phase);
        if (phase === 'addin')
          for (const f of j.removals) {
            await this.check(scope);
            j.removalIntents.push(f.targetPath);
            await this.store.write('journal', j);
            await removeOwnedManifest(
              ownedPath(this.o.targetRoot, f.targetPath),
              f,
              async (p) => {
                await this.pathGuard(p);
                await this.check(scope);
              },
              () => this.operationAlive(),
            );
            await this.o.afterWrite?.(f.targetPath);
          }
        for (const f of j.sources.filter((f) =>
          phase === 'addin' ? f.kind === 'addin' : f.kind !== 'addin',
        )) {
          await this.check(scope);
          const target = ownedPath(this.o.targetRoot, f.targetPath),
            expectedBefore = j.before.find((b) => key(b.targetPath) === key(f.targetPath));
          const guard = async (path: string) => {
            await this.pathGuard(path);
            await this.check(scope);
            if (key(path) === key(target)) {
              const actual = await existingFile(target);
              if (expectedBefore ? !sameBytes(actual, expectedBefore) : actual !== null)
                throw new Blocked('target_changed');
            }
          };
          if (purpose === 'rollback' && sameBytes(await existingFile(target), f)) continue;
          await atomicCopy(ownedPath(f.sourceRoot, f.sourcePath), target, f, guard, () =>
            this.operationAlive(),
          );
          await this.o.afterWrite?.(f.targetPath);
        }
      }
      await this.verify(j.next);
      await this.verifyRemoved(j);
      await this.checkpoint(j, 'metadata');
      if (previous)
        await this.store.write('previous', {
          schema: 1,
          backupId: j.id,
          receipt: previous,
          replacedBy: next.id,
        } satisfies PluginBackupRecord);
      else await this.store.remove('previous');
      await this.check(scope);
      await this.store.write('receipt', next);
      await this.checkpoint(j, 'complete');
      await this.store.remove('journal');
      return { status: 'complete', receipt: structuredClone(next) };
    } catch (e) {
      return this.failure(e, started);
    }
  }
  async recover(scope: PluginScope): Promise<PluginTransactionResult> {
    if (this.flight) return { status: 'blocked', reason: 'busy' };
    this.flight = true;
    try {
      scope = structuredClone(scope);
      if (!scopeValid(scope) || !this.o.current(scope)) throw new Blocked('stale_scope');
      this.acquire(scope);
      const j = await this.store.read('journal', journalValid);
      if (!j) return { status: 'blocked', reason: 'no_pending_transaction' };
      if (j.rootsHash !== this.rootsHash || !scopeSame(j.scope, scope))
        throw new Blocked('journal_scope');
      const recoveryReceipt = j.phase === 'complete' ? j.next : j.previous;
      const recoveryRoot =
        j.phase === 'complete' || j.phase === 'intent' ? this.o.targetRoot : this.backupRoot(j.id);
      const recoverySources = (recoveryReceipt?.files ?? []).map((f) => ({
        ...f,
        sourceRoot: recoveryRoot,
        sourcePath: f.targetPath,
      }));
      if (
        !(await this.o.admit({
          scope: structuredClone(scope),
          purpose: 'recovery',
          receipt: structuredClone(recoveryReceipt),
          sources: structuredClone(recoverySources),
        }))
      )
        throw new Blocked('admission_denied');
      await this.check(scope);
      if (j.phase === 'complete') {
        const actual = await this.store.read('receipt', receiptValid);
        if (actual?.id !== j.next.id) throw new Blocked('receipt_changed');
        await this.verify(j.next);
        await this.verifyRemoved(j);
        await this.store.remove('journal');
        return { status: 'complete', receipt: j.next };
      }
      const backupRoot = this.backupRoot(j.id);
      if (j.phase !== 'intent')
        for (const f of j.backupFiles) {
          const path = ownedPath(backupRoot, f.targetPath);
          await this.pathGuard(path);
          if (!sameBytes(await existingFile(path), f)) throw new Blocked('backup_invalid');
        }
      if (j.phase === 'intent' && j.previous) await this.verify(j.previous);
      if (j.phase !== 'intent' && j.previous)
        for (const f of j.previous.files.filter((f) => f.kind !== 'addin')) {
          await this.check(scope);
          const target = ownedPath(this.o.targetRoot, f.targetPath);
          await this.pathGuard(target);
          const actual = await existingFile(target);
          if (sameBytes(actual, f)) continue;
          const knownNew = j.next.files.find((n) => key(n.targetPath) === key(f.targetPath));
          if (actual && !(knownNew && sameBytes(actual, knownNew)))
            throw new Blocked('target_changed');
          await atomicCopy(
            ownedPath(backupRoot, f.targetPath),
            target,
            f,
            async (p) => {
              await this.pathGuard(p);
              await this.check(scope);
              if (key(p) === key(target)) {
                const now = await existingFile(target);
                if (actual ? !sameBytes(now, actual) : now !== null)
                  throw new Blocked('target_changed');
              }
            },
            () => this.operationAlive(),
          );
          await this.o.afterWrite?.(f.targetPath);
        }
      // Remove newly created manifests before restoring older names with the same AddInId.
      const freshManifests = j.sources.filter(
        (f) => f.kind === 'addin' && !j.before.some((b) => key(b.targetPath) === key(f.targetPath)),
      );
      for (const f of freshManifests) {
        const target = ownedPath(this.o.targetRoot, f.targetPath);
        await this.pathGuard(target);
        const actual = await existingFile(target);
        if (!actual) continue;
        if (!['addin', 'metadata', 'complete'].includes(j.phase) || !sameBytes(actual, f))
          throw new Blocked('target_changed');
        await removeOwnedManifest(
          target,
          f,
          async (p) => {
            await this.pathGuard(p);
            await this.check(scope);
          },
          () => this.operationAlive(),
        );
        await this.o.afterWrite?.(f.targetPath);
      }
      for (const f of j.removals) {
        const target = ownedPath(this.o.targetRoot, f.targetPath);
        await this.pathGuard(target);
        const actual = await existingFile(target);
        if (sameBytes(actual, f)) continue;
        if (actual || !j.removalIntents.includes(f.targetPath)) throw new Blocked('target_changed');
        await atomicCopy(
          ownedPath(backupRoot, f.targetPath),
          target,
          f,
          async (p) => {
            await this.pathGuard(p);
            await this.check(scope);
            if (key(p) === key(target) && (await existingFile(target)) !== null)
              throw new Blocked('target_changed');
          },
          () => this.operationAlive(),
        );
        await this.o.afterWrite?.(f.targetPath);
      }
      const restoreOrder = [
        ...j.sources.filter(
          (f) =>
            f.kind !== 'addin' && j.before.some((b) => key(b.targetPath) === key(f.targetPath)),
        ),
        ...j.sources.filter(
          (f) =>
            f.kind === 'addin' && j.before.some((b) => key(b.targetPath) === key(f.targetPath)),
        ),
        ...j.sources.filter(
          (f) =>
            f.kind !== 'addin' && !j.before.some((b) => key(b.targetPath) === key(f.targetPath)),
        ),
      ];
      for (const f of restoreOrder) {
        await this.check(scope);
        const target = ownedPath(this.o.targetRoot, f.targetPath);
        await this.pathGuard(target);
        const actual = await existingFile(target),
          before = j.before.find((b) => key(b.targetPath) === key(f.targetPath));
        if ((before && sameBytes(actual, before)) || (!before && actual === null)) continue;
        if (
          j.phase === 'intent' ||
          j.phase === 'backed-up' ||
          (f.kind === 'addin' && j.phase === 'payload')
        )
          throw new Blocked('target_changed');
        if (actual && !sameBytes(actual, f)) throw new Blocked('target_changed');
        if (before) {
          await atomicCopy(
            ownedPath(backupRoot, before.targetPath),
            target,
            before,
            async (p) => {
              await this.pathGuard(p);
              await this.check(scope);
              if (key(p) === key(target)) {
                const now = await existingFile(target);
                if (actual ? !sameBytes(now, f) : now !== null) throw new Blocked('target_changed');
              }
            },
            () => this.operationAlive(),
          );
        } else {
          await this.check(scope);
          await this.pathGuard(target);
          if (!sameBytes(await existingFile(target), f)) throw new Blocked('target_changed');
          if (!this.operationAlive()) throw new Blocked('stale_scope');
          unlinkSync(target);
        }
        await this.o.afterWrite?.(f.targetPath);
      }
      if (j.previous) {
        await this.verify(j.previous);
        await this.store.write('receipt', j.previous);
      } else await this.store.remove('receipt');
      if (j.priorBackup) await this.store.write('previous', j.priorBackup);
      else await this.store.remove('previous');
      await this.check(scope);
      await this.store.remove('journal');
      return j.previous
        ? { status: 'complete', receipt: j.previous }
        : { status: 'blocked', reason: 'rolled_back_empty' };
    } catch (e) {
      return this.failure(e, true);
    } finally {
      this.release();
      this.flight = false;
    }
  }
  private failure(error: unknown, started: boolean): PluginTransactionResult {
    if (error instanceof Waiting) return { status: 'waiting', reason: error.reason };
    return {
      status: started ? 'recovery' : 'blocked',
      reason: error instanceof Blocked ? error.reason : 'transaction_failed',
    };
  }
  private async verifyRemoved(j: PluginTransactionJournal): Promise<void> {
    for (const f of j.removals) {
      const path = ownedPath(this.o.targetRoot, f.targetPath);
      await this.pathGuard(path);
      if ((await existingFile(path)) !== null) throw new Blocked('target_changed');
    }
  }
}
