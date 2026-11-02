import { resolve, relative, isAbsolute, join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { comparePluginVersions, type PluginCatalog } from '../../shared/plugins';
import type { PluginTransactionOptions } from './transaction';
import type { PluginScope, OwnedPluginFile, StagedPluginFile } from './transactionTypes';
import { scopeSame, scopeValid, packageKey, receiptValid } from './transactionStore';
import { ownedFile } from './transactionPlan';
import { ownedPath, hashFile, relativeSafe, uuid, key } from './transactionFs';
import { snapshotInstallTemplates, type ApprovedInstallTemplate } from './layoutPolicy';
import { resolveReceiptCatalog } from './receiptCatalogPolicy';
import { verifyPluginSignature, evaluatePublisherTrust, type SignatureVerdict } from './signature';
import { inspectPluginManifest } from './addinManifest';

export interface ReceiptVerificationOptions {
  scope: PluginScope;
  targetRoot: string;
  dataRoot: string;
  stagingParent: string;
  templates: readonly ApprovedInstallTemplate[];
  publisherPins: readonly string[];
  betaAllowed: boolean;
  current: () => boolean;
  readCatalog: () => Promise<PluginCatalog>;
  pathAllowed: (path: string) => Promise<boolean>;
  /** Dependency seams are main/test only. Production binds the real Windows helpers. */
  verify?: (path: string, hash: string) => Promise<SignatureVerdict>;
  inspectManifest?: typeof inspectPluginManifest;
  signal?: AbortSignal;
}
const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return !isAbsolute(r) && r !== '..' && !r.startsWith('..\\') && !r.startsWith('../');
};
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  [...a]
    .map((x) => x.toLowerCase())
    .sort()
    .join(',') ===
    [...b]
      .map((x) => x.toLowerCase())
      .sort()
      .join(',');

/** Current metadata + local byte/layout/publisher gate. Ownership and foreign registrations remain separate gates. Never writes. */
export function createReceiptVerification(
  options: ReceiptVerificationOptions,
): PluginTransactionOptions['admit'] {
  return createVerification(options, {
    readCatalog: options.readCatalog,
    betaAllowed: options.betaAllowed,
  });
}
export type LocalOwnershipOptions = Omit<ReceiptVerificationOptions, 'readCatalog' | 'betaAllowed'>;
/** Ownership only: verifies an existing receipt using current local trust policy.
 * Historical archive identity is not current server authorization. Never use this
 * gate alone to activate NEXT, rollback or recovery bytes.
 */
export function createLocalOwnershipVerification(
  options: LocalOwnershipOptions,
): PluginTransactionOptions['admit'] {
  return createVerification(options);
}
function createVerification(
  options: LocalOwnershipOptions,
  metadata?: Pick<ReceiptVerificationOptions, 'readCatalog' | 'betaAllowed'>,
): PluginTransactionOptions['admit'] {
  const scope = structuredClone(options.scope),
    templates = snapshotInstallTemplates(options.templates),
    pins = [...options.publisherPins],
    betaAllowed = metadata?.betaAllowed;
  const targetRoot = resolve(options.targetRoot),
    dataRoot = resolve(options.dataRoot),
    staging = resolve(options.stagingParent),
    backupRoot = join(dataRoot, 'backups');
  const current = options.current,
    readCatalog = metadata?.readCatalog,
    pathAllowed = options.pathAllowed,
    verify = options.verify ?? verifyPluginSignature,
    inspect = options.inspectManifest ?? inspectPluginManifest,
    signal = options.signal ?? new AbortController().signal;
  const rootsHash = createHash('sha256')
    .update(JSON.stringify([targetRoot, dataRoot, staging]))
    .digest('hex');
  const check = () => {
    if (signal.aborted || current() !== true) throw Error('stale_plugin_job');
  };
  const guard = async (path: string) => {
    check();
    if ((await pathAllowed(path)) !== true) throw Error('unsafe_plugin_path');
    check();
  };
  return async (raw) => {
    try {
      const request = structuredClone(raw);
      check();
      if (
        !scopeValid(scope) ||
        !scopeValid(request.scope) ||
        !scopeSame(scope, request.scope) ||
        !['install', 'rollback', 'recovery'].includes(request.purpose) ||
        !templates.length ||
        !pins.length ||
        pins.length > 32 ||
        !pins.every((p) => typeof p === 'string' && /^[a-f0-9]{64}$/.test(p)) ||
        (metadata && typeof betaAllowed !== 'boolean') ||
        !Array.isArray(request.sources)
      )
        return false;
      if (request.receipt === null)
        return request.purpose === 'recovery' && request.sources.length === 0;
      if (
        !receiptValid(request.receipt) ||
        !scopeSame(scope, request.receipt.scope) ||
        request.receipt.rootsHash !== rootsHash
      )
        return false;
      let resolved: { packageKey: string; template: ApprovedInstallTemplate }[];
      if (readCatalog) {
        const catalog = await readCatalog();
        check();
        resolved = resolveReceiptCatalog(
          request.receipt,
          catalog,
          templates,
          betaAllowed === true,
        ).map((e) => ({ packageKey: e.packageKey, template: e.layout.template }));
      } else {
        resolved = request.receipt.packages.map((pkg) => {
          const candidates = templates.filter(
            (t) =>
              t.code === pkg.code &&
              t.policyId === pkg.descriptorId &&
              (!t.versions ||
                (comparePluginVersions(pkg.version, t.versions.from) >= 0 &&
                  (!t.versions.through ||
                    comparePluginVersions(pkg.version, t.versions.through) <= 0))) &&
              pkg.revit.every((year) => t.yearFiles.some((y) => y.year === year)),
          );
          const template = candidates[0];
          if (candidates.length !== 1 || !template) throw Error('unsupported_owned_layout');
          return { packageKey: packageKey(pkg), template };
        });
      }
      const sources = new Map<string, StagedPluginFile>();
      for (const source of request.sources) {
        const recorded = request.receipt.files.find(
          (f) => key(f.targetPath) === key(source.targetPath),
        );
        if (
          !recorded ||
          JSON.stringify(ownedFile(source)) !== JSON.stringify(recorded) ||
          sources.has(key(source.targetPath)) ||
          typeof source.sourceRoot !== 'string' ||
          !isAbsolute(source.sourceRoot) ||
          !relativeSafe(source.sourcePath)
        )
          return false;
        const root = resolve(source.sourceRoot);
        if (key(root) !== key(targetRoot) && !inside(staging, root) && !inside(backupRoot, root))
          return false;
        sources.set(key(source.targetPath), source);
      }
      const paths = new Map<string, string>();
      const sourcePath = (file: OwnedPluginFile) => {
        const s = sources.get(key(file.targetPath));
        if (s) return ownedPath(s.sourceRoot, s.sourcePath);
        if (request.purpose !== 'install') throw Error('missing_plugin_source');
        return ownedPath(targetRoot, file.targetPath);
      };
      for (const pkg of request.receipt.packages) {
        const evidence = resolved.find((e) => e.packageKey === packageKey(pkg));
        if (!evidence) return false;
        const template = evidence.template;
        for (const year of pkg.revit) {
          const yearFiles = template.yearFiles.find((y) => y.year === year);
          if (!yearFiles) return false;
          const recorded = request.receipt.files.filter(
            (f) => f.packageKey === packageKey(pkg) && f.targetPath.startsWith(`${year}/`),
          );
          const payload = recorded.filter((f) => f.kind !== 'addin');
          if (payload.length !== yearFiles.paths.length) return false;
          let prefix: string | undefined;
          const seen = new Set<string>();
          for (const f of payload) {
            const parts = f.targetPath.split('/'),
              tail = parts.slice(4).join('/');
            if (
              parts[0] !== String(year) ||
              parts[1] !== 'managed' ||
              !uuid(parts[2]) ||
              parts[3] !== pkg.code ||
              !yearFiles.paths.includes(tail) ||
              seen.has(tail) ||
              template.archive.files.find((x) => x.relativePath === tail)?.kind !== f.kind
            )
              return false;
            seen.add(tail);
            const candidate = parts.slice(0, 4).join('/');
            if (prefix && prefix !== candidate) return false;
            prefix = candidate;
          }
          if (!prefix) return false;
          const manifests = recorded.filter((f) => f.kind === 'addin'),
            targets = template.manifestTargets.filter((m) => m.year === year);
          if (manifests.length !== targets.length) return false;
          for (const f of manifests) {
            const target = targets.find((m) => f.targetPath === `${year}/${m.targetBasename}`);
            if (!target) return false;
            const rawManifest = template.archive.manifests.find(
              (m) => m.year === year && m.relativePath === target.sourceRelativePath,
            );
            if (
              !rawManifest ||
              !sameIds(
                f.addInIds ?? [],
                rawManifest.addIns.map((a) => a.addInId),
              )
            )
              return false;
            const path = sourcePath(f);
            await guard(path);
            const bytes = await hashFile(path);
            check();
            if (bytes.sha256 !== f.sha256 || bytes.size !== f.size) return false;
            const parsed = await inspect(path, f.sha256, signal);
            check();
            if (
              !sameIds(
                parsed.map((p) => p.addInId),
                rawManifest.addIns.map((a) => a.addInId),
              )
            )
              return false;
            for (const addin of parsed) {
              const expected = rawManifest.addIns.find((a) => a.addInId === addin.addInId);
              if (
                !expected ||
                !win32.isAbsolute(addin.assembly) ||
                key(win32.normalize(addin.assembly)) !==
                  key(
                    win32.normalize(
                      ownedPath(targetRoot, `${prefix}/${expected.assemblyRelativePath}`),
                    ),
                  )
              )
                return false;
            }
            paths.set(key(f.targetPath), path);
          }
        }
      }
      for (const f of request.receipt.files) {
        const path = sourcePath(f);
        await guard(path);
        const bytes = await hashFile(path);
        check();
        if (bytes.sha256 !== f.sha256 || bytes.size !== f.size) return false;
        if (f.kind === 'dll') {
          const result = await verify(path, f.sha256);
          check();
          if (result.fileSha256 !== f.sha256 || !evaluatePublisherTrust(result, pins)) return false;
        }
        if (f.kind === 'addin' && !paths.has(key(f.targetPath))) return false;
      }
      check();
      return true;
    } catch {
      return false;
    }
  };
}
