import { isAbsolute, resolve, sep } from 'node:path';
import { pluginCode } from '../../shared/plugins';
import { uuid, relativeSafe, key } from './transactionFs';
import { receiptValid, scopeValid, scopeSame, packageKey } from './transactionStore';
import type {
  PluginTransactionPlan,
  PluginReceipt,
  OwnedPluginFile,
  InstalledPluginPackage,
} from './transactionTypes';
export function ownedFile(file: PluginTransactionPlan['files'][number]): OwnedPluginFile {
  return {
    packageKey: file.packageKey,
    targetPath: file.targetPath,
    kind: file.kind,
    sha256: file.sha256,
    size: file.size,
    ...(file.addInIds && { addInIds: [...file.addInIds] }),
  };
}
/** A selected closure is a patch, not the whole installation. Preserve unselected owners/years. */
export function mergeManagedSet(
  previous: PluginReceipt | null,
  plan: PluginTransactionPlan,
  rootsHash: string,
  stagingParent: string,
): PluginReceipt {
  if (
    !plan ||
    typeof plan !== 'object' ||
    Array.isArray(plan) ||
    Object.keys(plan).some(
      (k) => !['id', 'scope', 'replace', 'files', 'packages', 'expectedCurrentId'].includes(k),
    ) ||
    !uuid(plan.id) ||
    !scopeValid(plan.scope) ||
    (!uuid(plan.expectedCurrentId) && plan.expectedCurrentId !== null) ||
    plan.expectedCurrentId !== (previous?.id ?? null) ||
    (previous &&
      (!receiptValid(previous) ||
        previous.rootsHash !== rootsHash ||
        !scopeSame(previous.scope, plan.scope)))
  )
    throw Error('receipt_changed');
  if (
    !Array.isArray(plan.replace) ||
    plan.replace.length < 1 ||
    plan.replace.length > 256 ||
    !Array.isArray(plan.files) ||
    plan.files.length < 1 ||
    plan.files.length > 512 ||
    !Array.isArray(plan.packages)
  )
    throw Error('invalid_plan');
  const replacement = new Set<string>();
  for (const r of plan.replace) {
    if (
      !r ||
      typeof r !== 'object' ||
      Array.isArray(r) ||
      Object.keys(r).sort().join(',') !== 'code,year' ||
      !pluginCode(r.code) ||
      (r.year !== 2025 && r.year !== 2026)
    )
      throw Error('invalid_plan');
    const k = `${r.code}:${r.year}`;
    if (replacement.has(k)) throw Error('invalid_plan');
    replacement.add(k);
  }
  const selected: PluginReceipt = {
    schema: 1,
    id: plan.id,
    scope: plan.scope,
    rootsHash,
    files: plan.files.map(ownedFile),
    packages: plan.packages,
  };
  if (!receiptValid(selected)) throw Error('invalid_plan');
  const base = resolve(stagingParent) + sep;
  for (const f of plan.files) {
    if (
      Object.keys(f).some(
        (k) =>
          ![
            'packageKey',
            'targetPath',
            'kind',
            'sha256',
            'size',
            'addInIds',
            'sourceRoot',
            'sourcePath',
          ].includes(k),
      ) ||
      typeof f.sourceRoot !== 'string' ||
      f.sourceRoot.length > 32760 ||
      !isAbsolute(f.sourceRoot) ||
      !key(resolve(f.sourceRoot)).startsWith(key(base)) ||
      !relativeSafe(f.sourcePath)
    )
      throw Error('unsafe_source');
    const p = plan.packages.find((p) => packageKey(p) === f.packageKey);
    if (!p || !replacement.has(`${p.code}:${f.targetPath.split('/')[0]}`))
      throw Error('invalid_plan');
  }
  for (const p of plan.packages)
    for (const y of p.revit) if (!replacement.has(`${p.code}:${y}`)) throw Error('invalid_plan');
  for (const k of replacement)
    if (!plan.packages.some((p) => p.revit.some((y) => `${p.code}:${y}` === k)))
      throw Error('invalid_plan');
  const retained = (previous?.files ?? []).filter((f) => {
    const p = previous?.packages.find((p) => packageKey(p) === f.packageKey);
    if (!p) throw Error('invalid_receipt');
    return !replacement.has(`${p.code}:${f.targetPath.split('/')[0]}`);
  });
  const packages: InstalledPluginPackage[] = (previous?.packages ?? [])
    .map((p) => ({ ...p, revit: p.revit.filter((y) => !replacement.has(`${p.code}:${y}`)) }))
    .filter((p) => p.revit.length > 0);
  for (const p of plan.packages) {
    const existing = packages.find((old) => packageKey(old) === packageKey(p));
    if (existing) {
      const oldMeta = { ...existing, revit: [] },
        newMeta = { ...p, revit: [] };
      if (JSON.stringify(oldMeta) !== JSON.stringify(newMeta)) throw Error('package_changed');
      existing.revit = [...new Set([...existing.revit, ...p.revit])].sort();
    } else packages.push(structuredClone(p));
  }
  const next = { ...selected, files: [...structuredClone(retained), ...selected.files], packages };
  if (!receiptValid(next)) throw Error('invalid_plan');
  return structuredClone(next);
}
