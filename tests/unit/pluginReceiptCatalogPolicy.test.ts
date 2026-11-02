import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveReceiptCatalog } from '../../src/main/plugins/receiptCatalogPolicy';
import type {
  PluginReceipt,
  InstalledPluginPackage,
} from '../../src/main/plugins/transactionTypes';
import type { PluginCatalog, PluginBuild } from '../../src/shared/plugins';
import type { ApprovedInstallTemplate } from '../../src/main/plugins/layoutPolicy';
import { packageKey } from '../../src/main/plugins/transactionStore';
function fixture(code = 'floor-plans', id = 1) {
  const guid = randomUUID(),
    sha = 'a'.repeat(64),
    policy: ApprovedInstallTemplate = {
      code,
      policyId: code + '-policy',
      archive: {
        id: code + '-raw',
        files: [
          { relativePath: 'Plugin.addin', kind: 'addin' },
          { relativePath: 'Plugin.dll', kind: 'dll' },
        ],
        manifests: [
          {
            relativePath: 'Plugin.addin',
            year: 2025,
            addIns: [{ addInId: guid, assemblyRelativePath: 'Plugin.dll' }],
          },
        ],
      },
      manifestTargets: [
        { sourceRelativePath: 'Plugin.addin', year: 2025, targetBasename: code + '.addin' },
      ],
      yearFiles: [{ year: 2025, paths: ['Plugin.dll'] }],
    };
  const build: PluginBuild = {
    id,
    version: '1.0',
    sha256: sha,
    size: 100,
    verified: true,
    revit: [2025],
    notes: '',
    publishedAt: '2026-11-02T00:00:00.000Z',
    url: `/api/desktop/plugins/files/${id}`,
    requires: [],
  };
  const pkg: InstalledPluginPackage = {
    code,
    buildId: id,
    version: '1.0',
    archiveSha256: sha,
    archiveSize: 100,
    revit: [2025],
    descriptorId: policy.policyId,
  };
  const receipt: PluginReceipt = {
    schema: 1,
    id: randomUUID(),
    scope: { serverHash: 'b'.repeat(64), ownerId: 1 },
    rootsHash: 'c'.repeat(64),
    packages: [pkg],
    files: [
      {
        packageKey: packageKey(pkg),
        targetPath: `2025/${code}.addin`,
        kind: 'addin',
        sha256: sha,
        size: 200,
        addInIds: [guid],
      },
      {
        packageKey: packageKey(pkg),
        targetPath: `2025/managed/${randomUUID()}/${code}/Plugin.dll`,
        kind: 'dll',
        sha256: sha,
        size: 100,
      },
    ],
  };
  const catalog: PluginCatalog = {
    tester: false,
    plugins: [{ code, name: code, short: 'FP', stable: build, beta: null }],
  };
  return { receipt, catalog, build, policy };
}
describe('current server metadata for the whole managed receipt', () => {
  it('resolves current stable identity and returns immutable facts without claiming file trust', () => {
    const f = fixture(),
      result = resolveReceiptCatalog(f.receipt, f.catalog, [f.policy], false);
    f.build.requires.push({ plugin: 'other-plugin', minVersion: '9.0' });
    expect(result[0]?.channel).toBe('stable');
    expect(result[0]?.build.requires).toEqual([]);
    expect(Object.isFrozen(result[0]?.layout.template)).toBe(true);
  });
  it('never infers current stable from a historical stored ID absent from latest', () => {
    const f = fixture();
    f.build.id = 2;
    f.build.url = '/api/desktop/plugins/files/2';
    expect(() => resolveReceiptCatalog(f.receipt, f.catalog, [f.policy], false)).toThrow(
      'historical_plugin_metadata_unavailable',
    );
  });
  it('channel stable→beta requires current tester and explicit opt-in', () => {
    const f = fixture();
    f.catalog.tester = true;
    const p = f.catalog.plugins[0];
    if (!p) throw Error('Fixture');
    p.stable = null;
    p.beta = f.build;
    expect(() => resolveReceiptCatalog(f.receipt, f.catalog, [f.policy], false)).toThrow(
      'plugin_beta_not_allowed',
    );
    expect(resolveReceiptCatalog(f.receipt, f.catalog, [f.policy], true)[0]?.channel).toBe('beta');
  });
  it.each(['sha256', 'version', 'size', 'revit'] as const)(
    'changed %s never authorizes cached backup bytes',
    (field) => {
      const f = fixture();
      if (field === 'sha256') f.build.sha256 = 'd'.repeat(64);
      else if (field === 'version') f.build.version = '2.0';
      else if (field === 'size') f.build.size = 101;
      else f.build.revit = [2026];
      expect(() => resolveReceiptCatalog(f.receipt, f.catalog, [f.policy], false)).toThrow(
        'plugin_build_changed',
      );
    },
  );
  it('requires is current and checked for each year, including retained dependencies', () => {
    const a = fixture(),
      b = fixture('dependency-lib', 2);
    a.receipt.packages.push(...b.receipt.packages);
    a.receipt.files.push(...b.receipt.files);
    a.catalog.plugins.push(...b.catalog.plugins);
    a.build.requires = [{ plugin: 'dependency-lib', minVersion: '1.0' }];
    expect(resolveReceiptCatalog(a.receipt, a.catalog, [a.policy, b.policy], false)).toHaveLength(
      2,
    );
    a.build.requires[0] = { plugin: 'dependency-lib', minVersion: '2.0' };
    expect(() => resolveReceiptCatalog(a.receipt, a.catalog, [a.policy, b.policy], false)).toThrow(
      'plugin_dependency_incompatible',
    );
  });
  it('a retained revoked/missing package is not ignored when updating another package', () => {
    const a = fixture(),
      b = fixture('other-plugin', 2);
    a.receipt.packages.push(...b.receipt.packages);
    a.receipt.files.push(...b.receipt.files);
    expect(() => resolveReceiptCatalog(a.receipt, a.catalog, [a.policy, b.policy], false)).toThrow(
      'plugin_unavailable',
    );
  });
  it.each(['self', 'two-node'] as const)(
    'rejects a fresh %s dependency cycle in retained packages',
    (kind) => {
      const a = fixture(),
        b = fixture('dependency-lib', 2);
      a.receipt.packages.push(...b.receipt.packages);
      a.receipt.files.push(...b.receipt.files);
      a.catalog.plugins.push(...b.catalog.plugins);
      a.build.requires = [
        { plugin: kind === 'self' ? 'floor-plans' : 'dependency-lib', minVersion: '1.0' },
      ];
      if (kind === 'two-node') b.build.requires = [{ plugin: 'floor-plans', minVersion: '1.0' }];
      expect(() =>
        resolveReceiptCatalog(a.receipt, a.catalog, [a.policy, b.policy], false),
      ).toThrow('dependency_cycle');
    },
  );
});
