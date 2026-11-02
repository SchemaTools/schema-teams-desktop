import { mkdir, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join, relative, dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginBuild, PluginCatalog } from '../../shared/plugins';
import { pluginCatalog } from '../api/plugins';
import { planPluginYears, type LocalPluginEvidence, type PluginPlan } from './planner';
import {
  snapshotInstallTemplates,
  bindInstallLayout,
  type ApprovedInstallTemplate,
} from './layoutPolicy';
import { extractPluginArchive } from './archive';
import { renderValidatedAddinManifest } from './addinManifest';
import { assertOrdinaryDirectory, removeOwnedTree } from './archivePaths';
import { verifyPluginSignature, evaluatePublisherTrust, type SignatureVerdict } from './signature';
import { packageKey, scopeValid, scopeSame, receiptValid } from './transactionStore';
import { ownedFile } from './transactionPlan';
import { uuid, nodePathSafe } from './transactionFs';
import type {
  PluginScope,
  PluginTransactionPlan,
  InstalledPluginPackage,
  PluginTransactionResult,
} from './transactionTypes';
import type { PluginTransactions } from './transaction';
import { pluginPlanSafety as safety } from './planSafety';

export interface PrepareInstallOptions {
  scope: PluginScope;
  code: string;
  years: readonly (2025 | 2026)[];
  beta: boolean;
  /** Automatic jobs require verified metadata for every member of the closure. */
  verifiedOnly?: boolean;
  automaticSafety?: string;
  validateAutomatic?: (plans: readonly PluginPlan[]) => boolean;
  expectedCurrentId: string | null;
  local: readonly LocalPluginEvidence[];
  templates: readonly ApprovedInstallTemplate[];
  publisherPins: readonly string[];
  targetRoot: string;
  stagingParent: string;
  current: () => boolean;
  readCatalog: () => Promise<PluginCatalog>;
  download: (build: PluginBuild, root: string, signal: AbortSignal) => Promise<string>;
  /** Internal test seam. Production factory supplies the real fixed-path Windows verifier. */
  verify?: (path: string, sha256: string) => Promise<SignatureVerdict>;
  signal?: AbortSignal;
  /** Internal lower output allowance; never raises the 1GiB job ceiling. */
  expandedBudgetBytes?: number;
}
export interface PreparedInstall {
  readonly id: string;
}
interface OwnedPreparation {
  plan: PluginTransactionPlan;
  root: string;
  parent: string;
  current: () => boolean;
  readCatalog: () => Promise<PluginCatalog>;
  selection: { code: string; years: (2025 | 2026)[]; beta: boolean; local: LocalPluginEvidence[] };
  safety: string;
  validateAutomatic?: () => boolean;
  state: 'ready' | 'in-use' | 'consumed' | 'releasing';
}
const owned = new WeakMap<PreparedInstall, OwnedPreparation>();
const freeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};

/** Main-only preparation. No target activation, receipt mutation or renderer-provided path. */
export async function preparePluginInstall(input: PrepareInstallOptions): Promise<PreparedInstall> {
  const scope = structuredClone(input.scope),
    selection = structuredClone({
      code: input.code,
      years: [...input.years],
      beta: input.beta,
      local: [...input.local],
    }),
    pins = [...input.publisherPins],
    templates = snapshotInstallTemplates(input.templates);
  const targetRoot = input.targetRoot,
    parent = input.stagingParent,
    current = input.current,
    readCatalog = input.readCatalog,
    download = input.download,
    verify = input.verify ?? verifyPluginSignature,
    external = input.signal,
    expected = input.expectedCurrentId,
    expandedBudget = input.expandedBudgetBytes ?? 1024 * 1024 * 1024,
    verifiedOnly = input.verifiedOnly === true,
    automaticSafety = input.automaticSafety,
    validateAutomatic = input.validateAutomatic;
  if (
    !scopeValid(scope) ||
    (expected !== null && !uuid(expected)) ||
    typeof selection.beta !== 'boolean' ||
    !isAbsolute(targetRoot) ||
    !isAbsolute(parent) ||
    [targetRoot, parent].some(
      (p) => p.length > 32760 || p.includes('\0') || /^(?:\\\\|\/\/)/.test(p),
    ) ||
    resolve(targetRoot) === dirname(resolve(targetRoot)) ||
    resolve(parent) === dirname(resolve(parent)) ||
    typeof current !== 'function' ||
    typeof readCatalog !== 'function' ||
    typeof download !== 'function' ||
    typeof verify !== 'function'
  )
    throw Error('invalid_install_request');
  if (
    !Number.isSafeInteger(expandedBudget) ||
    expandedBudget < 1 ||
    expandedBudget > 1024 * 1024 * 1024
  )
    throw Error('invalid_install_budget');
  const targetPrefix = resolve(targetRoot).toLowerCase() + sep,
    parentPrefix = resolve(parent).toLowerCase() + sep;
  if (targetPrefix.startsWith(parentPrefix) || parentPrefix.startsWith(targetPrefix))
    throw Error('overlapping_roots');
  if (
    !pins.length ||
    pins.length > 32 ||
    !pins.every((p) => typeof p === 'string' && /^[a-f0-9]{64}$/.test(p))
  )
    throw Error('publisher_not_configured');
  if (!templates.length) throw Error('unsupported_plugin_layout');
  if (process.platform !== 'win32') throw Error('unsupported_platform');
  const controller = new AbortController(),
    cancel = () => controller.abort();
  external?.addEventListener('abort', cancel, { once: true });
  if (external?.aborted) cancel();
  const started = performance.now();
  let root: string | undefined;
  const check = () => {
    if (controller.signal.aborted || performance.now() - started > 300000)
      throw Error('install_cancelled');
    if (current() !== true) throw Error('stale_install');
  };
  try {
    check();
    const catalog = pluginCatalog(await readCatalog());
    check();
    const plans = planPluginYears(
        catalog,
        selection.code,
        selection.years,
        selection.beta,
        selection.local,
      ),
      stamp = safety(plans, catalog);
    if (verifiedOnly && plans.some((p) => p.builds.some((item) => !item.build.verified)))
      throw Error('unverified_automatic_build');
    if (verifiedOnly && (automaticSafety !== stamp || !validateAutomatic?.(plans)))
      throw Error('automatic_admission_changed');
    const groups = new Map<string, { code: string; build: PluginBuild; years: (2025 | 2026)[] }>();
    for (const p of plans)
      for (const item of p.builds) {
        const key = `${item.code}:${item.build.id}`;
        const existing = groups.get(key);
        if (existing) existing.years.push(p.year);
        else groups.set(key, { ...item, years: [p.year] });
      }
    if (
      groups.size > 32 ||
      [...groups.values()].reduce((n, g) => n + g.build.size, 0) > 1024 * 1024 * 1024
    )
      throw Error('install_budget');
    // Bind every selected format before the first staging write or package download.
    const bindings = [...groups.values()].map((g) => ({
      group: g,
      binding: bindInstallLayout(templates, scope.serverHash, g.code, g.build),
    }));
    await nodePathSafe(parent);
    check();
    await mkdir(parent, { recursive: true });
    check();
    await assertOrdinaryDirectory(parent);
    check();
    root = await mkdtemp(join(parent, 'schema-plugin-'));
    check();
    const transactionId = randomUUID(),
      files: PluginTransactionPlan['files'] = [],
      packages: InstalledPluginPackage[] = [];
    let extractedBytes = 0;
    for (const { group: g, binding } of bindings) {
      const remaining = expandedBudget - extractedBytes;
      if (remaining < 1) throw Error('install_budget');
      const zip = await download(structuredClone(g.build), root, controller.signal);
      check();
      const rel = relative(root, zip);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('unowned_download');
      const generation = await extractPluginArchive({
        archivePath: zip,
        expectedSha256: binding.archiveSha256,
        stagingParent: root,
        layout: binding.template.archive,
        signal: controller.signal,
        outputBudgetBytes: remaining,
      });
      check();
      extractedBytes += generation.entries.reduce((n, f) => n + f.size, 0);
      if (extractedBytes > expandedBudget) throw Error('install_budget');
      for (const f of generation.entries.filter((f) => f.kind === 'dll')) {
        const verdict = await verify(
          join(generation.generationRoot, ...f.relativePath.split('/')),
          f.sha256,
        );
        check();
        if (verdict.fileSha256 !== f.sha256 || !evaluatePublisherTrust(verdict, pins))
          throw Error('untrusted_plugin_dll');
      }
      const pkg: InstalledPluginPackage = {
        code: g.code,
        buildId: g.build.id,
        version: g.build.version,
        archiveSha256: g.build.sha256,
        archiveSize: g.build.size,
        revit: [...g.years],
        descriptorId: binding.template.policyId,
      };
      packages.push(pkg);
      for (const year of g.years) {
        const payload = binding.template.yearFiles.find((y) => y.year === year);
        if (!payload) throw Error('unsupported_plugin_layout');
        const prefix = `${year}/managed/${transactionId}/${g.code}`,
          targetGenerationRoot = join(targetRoot, ...prefix.split('/'));
        for (const path of payload.paths) {
          const entry = generation.entries.find((f) => f.relativePath === path);
          if (!entry || entry.kind === 'addin') throw Error('unsupported_plugin_layout');
          files.push({
            packageKey: packageKey(pkg),
            targetPath: `${prefix}/${path}`,
            kind: entry.kind,
            sha256: entry.sha256,
            size: entry.size,
            sourceRoot: generation.generationRoot,
            sourcePath: path,
          });
        }
        for (const m of binding.template.manifestTargets.filter((m) => m.year === year)) {
          const rendered = await renderValidatedAddinManifest({
            generation,
            sourceRelativePath: m.sourceRelativePath,
            year,
            targetGenerationRoot,
            stagingParent: root,
            signal: controller.signal,
          });
          check();
          files.push({
            packageKey: packageKey(pkg),
            targetPath: `${year}/${m.targetBasename}`,
            kind: 'addin',
            sha256: rendered.sha256,
            size: rendered.size,
            addInIds: rendered.assemblies.map((x) => x.addInId),
            sourceRoot: dirname(rendered.path),
            sourcePath: 'manifest.addin',
          });
        }
        if (files.length > 512 || files.reduce((n, f) => n + f.size, 0) > 1024 * 1024 * 1024)
          throw Error('install_budget');
      }
    }
    check();
    const plan: PluginTransactionPlan = {
      id: transactionId,
      scope,
      replace: bindings.flatMap(({ group: g }) => g.years.map((year) => ({ code: g.code, year }))),
      files,
      packages,
      expectedCurrentId: expected,
    };
    const handle = Object.freeze({ id: transactionId });
    if (
      !receiptValid({
        schema: 1,
        id: transactionId,
        scope,
        rootsHash: '0'.repeat(64),
        files: plan.files.map(ownedFile),
        packages: plan.packages,
      })
    )
      throw Error('unsupported_install_plan');
    owned.set(handle, {
      plan: freeze(plan),
      root,
      parent,
      current: () =>
        current() === true && !external?.aborted && performance.now() - started <= 300000,
      readCatalog,
      selection,
      safety: stamp,
      validateAutomatic: verifiedOnly ? () => validateAutomatic?.(plans) === true : undefined,
      state: 'ready',
    });
    return handle;
  } catch (error) {
    controller.abort();
    if (root) await removeOwnedTree(root, parent);
    throw error;
  } finally {
    external?.removeEventListener('abort', cancel);
  }
}

/** Re-read and re-plan after preparation; notes/name edits do not authorize a different artifact. */
async function preparedInstallPlan(
  handle: PreparedInstall,
  scope: PluginScope,
): Promise<PluginTransactionPlan> {
  const entry = owned.get(handle);
  if (!entry || !scopeSame(scope, entry.plan.scope) || !entry.current())
    throw Error('stale_install');
  if (entry.validateAutomatic && !entry.validateAutomatic())
    throw Error('automatic_admission_changed');
  const catalog = pluginCatalog(await entry.readCatalog());
  if (
    !entry.current() ||
    safety(
      planPluginYears(
        catalog,
        entry.selection.code,
        entry.selection.years,
        entry.selection.beta,
        entry.selection.local,
      ),
      catalog,
    ) !== entry.safety
  )
    throw Error('plugin_catalog_changed');
  if (entry.validateAutomatic && !entry.validateAutomatic())
    throw Error('automatic_admission_changed');
  return structuredClone(entry.plan);
}

/** One handoff holds the staging lease until the awaited core operation finishes. */
export async function runPreparedInstall(
  handle: PreparedInstall,
  scope: PluginScope,
  core: Pick<PluginTransactions, 'install'>,
): Promise<PluginTransactionResult> {
  const entry = owned.get(handle);
  if (!entry || entry.state !== 'ready') throw Error('prepared_install_busy');
  const install = core.install.bind(core);
  entry.state = 'in-use';
  try {
    const plan = await preparedInstallPlan(handle, scope);
    if (!entry.current()) throw Error('stale_install');
    return await install(plan);
  } finally {
    entry.state = 'consumed';
  }
}

/** Pending/corrupt durable state owns the bytes; uncertainty deliberately retains staging. */
export async function releasePreparedInstall(
  handle: PreparedInstall,
  inspect: () => Promise<{ pending: boolean; blocked: boolean }>,
): Promise<boolean> {
  const entry = owned.get(handle);
  if (!entry || !entry.current() || entry.state === 'in-use' || entry.state === 'releasing')
    return false;
  const previous = entry.state;
  entry.state = 'releasing';
  let cleanupStarted = false;
  try {
    const state = await inspect();
    if (!entry.current() || state?.pending !== false || state?.blocked !== false) return false;
    cleanupStarted = true;
    await removeOwnedTree(entry.root, entry.parent);
    owned.delete(handle);
    return true;
  } catch (error) {
    if (cleanupStarted) throw error;
    return false;
  } finally {
    // A failed/partial cleanup never turns the material back into an installable handle.
    entry.state = cleanupStarted ? 'consumed' : previous;
  }
}
