import { join, resolve } from 'node:path';
import {
  comparePluginVersions,
  type PluginBuild,
  type PluginCatalog,
  type ManagedPluginsView,
} from '../../shared/plugins';
import type { AutomaticPluginAdmission } from './planSafety';
import type {
  PluginScope,
  PluginReceipt,
  PluginTransactionResult,
  StagedPluginFile,
} from './transactionTypes';
import { PluginTransactions } from './transaction';
import { PluginTransactionStore, journalValid, scopeSame, scopeValid } from './transactionStore';
import { nodePathSafe, ownedPath, existingFile, key } from './transactionFs';
import { createLocalOwnershipVerification, createReceiptVerification } from './receiptVerification';
import { verifyNoForeignAddinIds } from './foreignRegistrations';
import {
  preparePluginInstall,
  runPreparedInstall,
  releasePreparedInstall,
  type PreparedInstall,
} from './prepareInstall';
import { PluginProcessWatch } from './processWatch';
import { readRevitProcesses, windowsPathSafe } from './safety';
import { verifyPluginSignature, APPROVED_PLUGIN_PUBLISHER_DER_SHA256 } from './signature';
import { snapshotInstallTemplates, type ApprovedInstallTemplate } from './layoutPolicy';
import { auditPlugin, type PluginAuditListener } from './audit';
type PluginIntent =
  | {
      kind: 'install';
      code: string;
      years: (2025 | 2026)[];
      verifiedOnly?: boolean;
      automatic?: AutomaticPluginAdmission;
    }
  | { kind: 'rollback'; expectedCurrentId: string }
  | { kind: 'recovery' };

export interface PluginJobContext {
  scope: PluginScope;
  /** Main-owned auth/config/catalog/preference/policy generation, not an IPC value. */
  token: string;
  beta: boolean;
  targetRoot: string;
  dataRoot: string;
  stagingParent: string;
  scanRoots: { year: 2025 | 2026; path: string }[];
}
interface Policy {
  templates: readonly ApprovedInstallTemplate[];
  publisherPins: readonly string[];
}
export interface PluginControllerPorts {
  automaticHeld?: (
    scope: PluginScope,
    rootsHash: string,
    code: string,
    year: 2025 | 2026,
    build: PluginBuild,
  ) => boolean;
  beforeRollback?: (previous: PluginReceipt, next: PluginReceipt) => Promise<void>;
  audit?: PluginAuditListener;
  context: () => PluginJobContext | null;
  readCatalog: () => Promise<PluginCatalog>;
  download: (build: PluginBuild, root: string, signal: AbortSignal) => Promise<string>;
  /** Main-only lifecycle gate; no job may start during a Desktop handoff. */
  mayRun?: () => boolean;
  stage?: (phase: 'checking' | 'downloading' | 'installing') => void;
}
/** Dependency injection is main/test-only; production factory fixes every safety hook. */
export interface PluginControllerOptions extends PluginControllerPorts {
  policy: (scope: PluginScope) => Policy | null;
  processes?: typeof readRevitProcesses;
  pathAllowed?: typeof windowsPathSafe;
  verify?: typeof verifyPluginSignature;
}
// A policy is approved for a specific server, never learned from catalog/ZIP/settings.
const approvedServerPolicies: readonly {
  serverHash: string;
  templates: readonly ApprovedInstallTemplate[];
}[] = Object.freeze([]);
export function createProductionPluginController(ports: PluginControllerPorts): PluginController {
  return new PluginController({
    ...ports,
    policy: (scope) => {
      const matches = approvedServerPolicies.filter((p) => p.serverHash === scope.serverHash);
      const policy = matches[0];
      return matches.length === 1 && policy
        ? { templates: policy.templates, publisherPins: APPROVED_PLUGIN_PUBLISHER_DER_SHA256 }
        : null;
    },
    processes: readRevitProcesses,
    pathAllowed: windowsPathSafe,
    verify: verifyPluginSignature,
  });
}

/** One verified job at a time. Scheduling/waiting belongs to the main coordinator. */
export class PluginController {
  private readonly o: Readonly<PluginControllerOptions>;
  private active?: AbortController;
  private generation = 0;
  constructor(options: PluginControllerOptions) {
    this.o = Object.freeze({ ...options });
  }
  get busy(): boolean {
    return this.active !== undefined;
  }
  invalidate(): void {
    this.generation++;
    this.active?.abort();
  }
  install(code: string, years: readonly (2025 | 2026)[]): Promise<PluginTransactionResult> {
    return this.run({ kind: 'install', code, years: [...years] });
  }
  installVerified(
    code: string,
    years: readonly (2025 | 2026)[],
    automatic?: AutomaticPluginAdmission,
  ): Promise<PluginTransactionResult> {
    return this.run({
      kind: 'install',
      code,
      years: [...years],
      verifiedOnly: true,
      automatic: structuredClone(automatic),
    });
  }
  rollback(expectedCurrentId: string): Promise<PluginTransactionResult> {
    return this.run({ kind: 'rollback', expectedCurrentId });
  }
  recover(): Promise<PluginTransactionResult> {
    return this.run({ kind: 'recovery' });
  }
  /** Local verified installation facts only; does not claim current server eligibility. */
  async inspect(): Promise<ManagedPluginsView> {
    const view = (
      status: ManagedPluginsView['status'],
      installationAvailable = false,
    ): ManagedPluginsView => ({ status, installationAvailable, receiptId: null, packages: [] });
    if (this.active) return view('busy');
    const generation = this.generation;
    let core: PluginTransactions | undefined;
    try {
      if (this.o.mayRun?.() === false) return view('unavailable');
      const context = structuredClone(this.o.context());
      if (!context || !scopeValid(context.scope)) return view('unavailable');
      const stamp = JSON.stringify(context),
        current = () =>
          !this.active &&
          this.o.mayRun?.() !== false &&
          generation === this.generation &&
          JSON.stringify(this.o.context()) === stamp;
      const policy = this.o.policy(structuredClone(context.scope));
      if (!policy || !policy.templates.length || !policy.publisherPins.length)
        return view('unavailable');
      const templates = snapshotInstallTemplates(policy.templates),
        publisherPins = [...policy.publisherPins],
        pathAllowed = this.o.pathAllowed ?? windowsPathSafe;
      const local = createLocalOwnershipVerification({
        ...context,
        templates,
        publisherPins,
        current,
        pathAllowed,
        verify: this.o.verify ?? verifyPluginSignature,
      });
      core = new PluginTransactions({
        ...context,
        current: (s) => current() && scopeSame(s, context.scope),
        pathAllowed,
        processes: async () => 'unknown',
        admit: async () => false,
      });
      const state = await core.inspect(context.scope);
      if (!current() || state.blocked) return view('blocked');
      if (state.pending) return view('recovery', true);
      if (
        state.receipt &&
        !(await local({
          scope: context.scope,
          purpose: 'install',
          receipt: state.receipt,
          sources: [],
        }))
      )
        return view('blocked');
      if (!current()) return view('blocked');
      return {
        status: 'ready',
        installationAvailable: true,
        receiptId: state.receipt?.id ?? null,
        rootsHash: core.rootsHash,
        packages: (state.receipt?.packages ?? []).map((p) => ({
          code: p.code,
          version: p.version,
          buildId: p.buildId,
          archiveSha256: p.archiveSha256,
          years: [...p.revit],
        })),
      };
    } catch {
      return view('blocked');
    } finally {
      core?.dispose();
    }
  }
  private async run(intent: PluginIntent): Promise<PluginTransactionResult> {
    const operation = intent.kind;
    auditPlugin(this.o.audit, {
      operation,
      phase: 'requested',
      ...(intent.kind === 'install' && { plugin: intent.code }),
    });
    let result: PluginTransactionResult;
    try {
      result = await this.runCore(intent);
    } catch {
      result = { status: 'blocked', reason: 'plugin_job_failed' };
    }
    if (result.status === 'complete') {
      for (const p of result.receipt.packages)
        auditPlugin(this.o.audit, {
          operation,
          phase: 'result',
          outcome: 'ok',
          plugin: p.code,
          version: p.version,
          buildId: p.buildId,
        });
    } else
      auditPlugin(this.o.audit, {
        operation,
        phase: result.status === 'waiting' || result.processInterruption ? 'waiting' : 'result',
        outcome: 'rejected',
        reason: result.reason,
        ...(intent.kind === 'install' && { plugin: intent.code }),
      });
    return result;
  }
  private async runCore(intent: PluginIntent): Promise<PluginTransactionResult> {
    if (this.active) return { status: 'blocked', reason: 'busy' };
    if (this.o.mayRun?.() === false)
      return { status: 'blocked', reason: 'desktop_update_in_progress' };
    const abort = new AbortController(),
      generation = this.generation;
    this.active = abort;
    let core: PluginTransactions | undefined,
      watch: PluginProcessWatch | undefined,
      prepared: PreparedInstall | undefined;
    let processChanged = false;
    let automaticCommitCheck: (() => boolean) | undefined;
    let stillCurrent = () => false;
    try {
      const context = structuredClone(this.o.context());
      if (
        !context ||
        !scopeValid(context.scope) ||
        !context.token ||
        typeof context.beta !== 'boolean'
      )
        return { status: 'blocked', reason: 'plugin_context_unavailable' };
      const stamp = JSON.stringify(context),
        scope = context.scope;
      const baseCurrent = () =>
        this.active === abort &&
        !abort.signal.aborted &&
        generation === this.generation &&
        this.o.mayRun?.() !== false &&
        JSON.stringify(this.o.context()) === stamp;
      stillCurrent = baseCurrent;
      const observedResult = (result: PluginTransactionResult): PluginTransactionResult =>
        result.status !== 'complete' && processChanged && baseCurrent()
          ? { ...result, processInterruption: true }
          : result;
      let processSafe = true;
      const current = () => baseCurrent() && processSafe;
      const check = () => {
        if (!current()) throw Error('stale_plugin_job');
      };
      const rawPolicy = this.o.policy(structuredClone(scope));
      if (!rawPolicy || !rawPolicy.publisherPins.length || !rawPolicy.templates.length)
        return { status: 'blocked', reason: 'plugin_trust_unconfigured' };
      this.o.stage?.('checking');
      const templates = snapshotInstallTemplates(rawPolicy.templates),
        publisherPins = [...rawPolicy.publisherPins];
      if (
        publisherPins.length > 32 ||
        !publisherPins.every((p) => typeof p === 'string' && /^[a-f0-9]{64}$/.test(p))
      )
        return { status: 'blocked', reason: 'plugin_trust_unconfigured' };
      // All roots for both scopes are mandatory, even when a directory is absent.
      if (
        context.scanRoots.length !== 4 ||
        new Set(context.scanRoots.map((r) => key(resolve(r.path)))).size !== 4 ||
        [2025, 2026].some(
          (year) =>
            context.scanRoots.filter((r) => r.year === year).length !== 2 ||
            !context.scanRoots.some(
              (r) =>
                r.year === year &&
                key(resolve(r.path)) === key(resolve(context.targetRoot, String(year))),
            ),
        )
      )
        return { status: 'blocked', reason: 'plugin_scan_roots_unavailable' };
      const pathAllowed = this.o.pathAllowed ?? windowsPathSafe,
        verify = this.o.verify ?? verifyPluginSignature;
      const guard = async (path: string) => {
        check();
        await nodePathSafe(path);
        check();
        if (!(await pathAllowed(path))) throw Error('unsafe_plugin_path');
        check();
      };
      const processes = this.o.processes ?? readRevitProcesses;
      watch = new PluginProcessWatch({
        current: baseCurrent,
        read: async () => {
          try {
            const state = await processes();
            if (state !== 'idle') {
              processSafe = false;
              processChanged = true;
            }
            return state;
          } catch {
            processSafe = false;
            processChanged = true;
            return 'unknown';
          }
        },
      });
      const state = await watch.start();
      if (state !== 'idle')
        return { status: 'waiting', reason: state === 'busy' ? 'revit_busy' : 'revit_unknown' };
      check();
      const common = {
        ...context,
        templates,
        publisherPins,
        current,
        pathAllowed,
        verify,
        signal: abort.signal,
      };
      const local = createLocalOwnershipVerification(common);
      const readCatalog = async () => {
        check();
        const c = await this.o.readCatalog();
        check();
        return c;
      };
      const fresh = createReceiptVerification({
        ...common,
        betaAllowed: context.beta,
        readCatalog,
      });
      const store = new PluginTransactionStore(context.dataRoot, guard, current);
      core = new PluginTransactions({
        ...context,
        current: (s) => scopeSame(s, scope) && current(),
        beforeRollback: this.o.beforeRollback,
        beforeInstall: async () => {
          if (intent.kind === 'install' && intent.verifiedOnly && !automaticCommitCheck?.())
            throw Error('automatic_admission_changed');
        },
        pathAllowed,
        processes: () => (watch ? watch.read() : Promise.resolve('unknown')),
        admit: async (request) => {
          check();
          const transaction = core;
          if (!transaction) return false;
          const existing = await transaction.inspect(scope);
          check();
          if (existing.blocked) return false;
          const journal = existing.pending ? await store.read('journal', journalValid) : null;
          check();
          if (
            journal &&
            (journal.rootsHash !== transaction.rootsHash || !scopeSame(journal.scope, scope))
          )
            return false;
          const candidates: { receipt: PluginReceipt; sources: readonly StagedPluginFile[] }[] = [];
          if (journal) {
            if (journal.previous)
              candidates.push({
                receipt: journal.previous,
                sources: journal.previous.files.map((f) => ({
                  ...f,
                  sourceRoot:
                    journal.phase === 'intent'
                      ? context.targetRoot
                      : join(context.dataRoot, 'backups', journal.id),
                  sourcePath: f.targetPath,
                })),
              });
            candidates.push({ receipt: journal.next, sources: journal.sources });
          } else if (existing.receipt) candidates.push({ receipt: existing.receipt, sources: [] });
          for (const candidate of candidates) {
            if (!(await local({ scope, purpose: 'install', ...candidate }))) return false;
            check();
          }
          if (!(await fresh(request))) return false;
          check();
          if (!request.receipt) return true;
          const known = new Map<
            string,
            { year: 2025 | 2026; path: string; sha256: string; size: number }
          >();
          for (const candidate of candidates)
            for (const f of candidate.receipt.files.filter((f) => f.kind === 'addin')) {
              const path = ownedPath(context.targetRoot, f.targetPath);
              await guard(path);
              const actual = await existingFile(path);
              check();
              if (actual?.sha256 === f.sha256 && actual.size === f.size)
                known.set(key(path), {
                  year: Number(f.targetPath.slice(0, 4)) as 2025 | 2026,
                  path,
                  ...actual,
                });
            }
          return verifyNoForeignAddinIds({
            roots: context.scanRoots,
            desired: request.receipt.files
              .filter((f) => f.kind === 'addin')
              .flatMap((f) =>
                (f.addInIds ?? []).map((addInId) => ({
                  year: Number(f.targetPath.slice(0, 4)) as 2025 | 2026,
                  addInId,
                })),
              ),
            owned: [...known.values()],
            current,
            pathAllowed,
            signal: abort.signal,
          });
        },
      });
      const existing = await core.inspect(scope);
      check();
      if (existing.blocked) return { status: 'blocked', reason: 'plugin_state_unavailable' };
      if (intent.kind === 'recovery') return observedResult(await core.recover(scope));
      if (existing.pending) return { status: 'recovery', reason: 'unfinished_transaction' };
      if (intent.kind === 'rollback')
        return observedResult(await core.rollback(scope, intent.expectedCurrentId));
      if (
        intent.verifiedOnly &&
        (!intent.automatic || intent.automatic.currentId !== (existing.receipt?.id ?? null))
      )
        return { status: 'blocked', reason: 'automatic_admission_changed' };
      const rootsHash = core.rootsHash;
      prepared = await preparePluginInstall({
        ...common,
        code: intent.code,
        years: intent.years,
        beta: context.beta,
        verifiedOnly: intent.verifiedOnly === true,
        automaticSafety: intent.automatic?.safety,
        validateAutomatic: (plans) => {
          const allowed = () =>
            plans.every((p) =>
              p.builds.every(({ code, build }) => {
                const installed = existing.receipt?.packages.find(
                  (i) => i.code === code && i.revit.includes(p.year),
                );
                if (installed && comparePluginVersions(installed.version, build.version) > 0)
                  return false;
                if (installed?.buildId === build.id && installed.archiveSha256 === build.sha256)
                  return true;
                return !this.o.automaticHeld?.(scope, rootsHash, code, p.year, build);
              }),
            );
          automaticCommitCheck = allowed;
          return allowed();
        },
        expectedCurrentId: existing.receipt?.id ?? null,
        local: (existing.receipt?.packages ?? []).map((p) => ({
          plugin: p.code,
          version: p.version,
          years: p.revit,
        })),
        readCatalog,
        download: async (build, root, signal) => {
          check();
          this.o.stage?.('downloading');
          const path = await this.o.download(build, root, signal);
          check();
          return path;
        },
      });
      check();
      this.o.stage?.('installing');
      const result = await runPreparedInstall(prepared, scope, core);
      // A mid-job process change is an intent to recheck/recover after idle,
      // never evidence that rollback or installation already completed.
      return observedResult(result);
    } catch {
      if (processChanged && stillCurrent())
        return { status: 'blocked', reason: 'plugin_job_failed', processInterruption: true };
      return { status: 'blocked', reason: 'plugin_job_failed' };
    } finally {
      if (prepared && core) {
        try {
          await releasePreparedInstall(prepared, async () => {
            const context = this.o.context();
            return context && core ? core.inspect(context.scope) : { pending: true, blocked: true };
          });
        } catch {
          /* Owned uncertain bytes remain for explicit recovery. */
        }
      }
      core?.dispose();
      watch?.stop();
      if (this.active === abort) this.active = undefined;
    }
  }
}
