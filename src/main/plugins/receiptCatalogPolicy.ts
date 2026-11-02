import { comparePluginVersions, type PluginBuild } from '../../shared/plugins';
import { pluginCatalog } from '../api/plugins';
import { receiptValid, packageKey } from './transactionStore';
import type { PluginReceipt } from './transactionTypes';
import {
  bindInstallLayout,
  type ApprovedInstallTemplate,
  type InstallLayoutBinding,
} from './layoutPolicy';

export interface ReceiptCatalogEvidence {
  readonly packageKey: string;
  readonly channel: 'stable' | 'beta';
  readonly build: Readonly<PluginBuild>;
  readonly layout: Readonly<InstallLayoutBinding>;
}
const frozen = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
};

/** Current metadata gate only. File hashes, publisher, XML/target mapping and scope are independent gates. */
export function resolveReceiptCatalog(
  receipt: PluginReceipt,
  rawCatalog: unknown,
  templates: readonly ApprovedInstallTemplate[],
  betaAllowed: boolean,
): readonly ReceiptCatalogEvidence[] {
  receipt = structuredClone(receipt);
  if (!receiptValid(receipt) || typeof betaAllowed !== 'boolean')
    throw Error('invalid_plugin_receipt');
  const catalog = pluginCatalog(rawCatalog),
    resolved: ReceiptCatalogEvidence[] = [];
  for (const pkg of receipt.packages) {
    const plugin = catalog.plugins.find((p) => p.code === pkg.code);
    if (!plugin) throw Error('plugin_unavailable');
    let build: PluginBuild, channel: 'stable' | 'beta';
    if (plugin.stable?.id === pkg.buildId) {
      build = plugin.stable;
      channel = 'stable';
    } else if (plugin.beta?.id === pkg.buildId) {
      if (!catalog.tester || !betaAllowed) throw Error('plugin_beta_not_allowed');
      build = plugin.beta;
      channel = 'beta';
    } else throw Error('historical_plugin_metadata_unavailable');
    if (
      build.version !== pkg.version ||
      build.sha256 !== pkg.archiveSha256 ||
      build.size !== pkg.archiveSize ||
      pkg.revit.some((year) => !build.revit.includes(year))
    )
      throw Error('plugin_build_changed');
    const layout = bindInstallLayout(templates, receipt.scope.serverHash, pkg.code, build);
    if (layout.template.policyId !== pkg.descriptorId) throw Error('plugin_layout_changed');
    for (const requirement of build.requires)
      for (const year of pkg.revit) {
        const dependency = receipt.packages.find(
          (p) => p.code === requirement.plugin && p.revit.includes(year),
        );
        if (!dependency || comparePluginVersions(dependency.version, requirement.minVersion) < 0)
          throw Error('plugin_dependency_incompatible');
      }
    resolved.push({ packageKey: packageKey(pkg), channel, build: structuredClone(build), layout });
  }
  // Fresh requires may change without a new build ID. Validate the complete
  // retained graph too, independently for each Revit year.
  for (const year of [2025, 2026] as const) {
    const visiting = new Set<string>(),
      done = new Set<string>();
    const visit = (code: string) => {
      if (visiting.has(code)) throw Error('dependency_cycle');
      if (done.has(code)) return;
      const pkg = receipt.packages.find((p) => p.code === code && p.revit.includes(year));
      const evidence = pkg && resolved.find((e) => e.packageKey === packageKey(pkg));
      if (!evidence) throw Error('plugin_dependency_incompatible');
      visiting.add(code);
      for (const r of evidence.build.requires) visit(r.plugin);
      visiting.delete(code);
      done.add(code);
    };
    for (const pkg of receipt.packages) if (pkg.revit.includes(year)) visit(pkg.code);
  }
  return frozen(resolved);
}
