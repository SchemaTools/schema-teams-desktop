import { describe, it, expect } from 'vitest';
import {
  APPROVED_INSTALL_TEMPLATES,
  bindInstallLayout,
  snapshotInstallTemplates,
  type ApprovedInstallTemplate,
} from '../../src/main/plugins/layoutPolicy';
import type { PluginBuild } from '../../src/shared/plugins';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error('Missing test fixture');
  return value;
}
const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const build = (): PluginBuild => ({
  id: 1,
  version: '1.0',
  verified: true,
  revit: [2025, 2026],
  notes: '',
  size: 100,
  sha256: 'b'.repeat(64),
  url: '/api/desktop/plugins/files/1',
  publishedAt: '2026-11-02T00:00:00.000Z',
  requires: [],
});
function template(): ApprovedInstallTemplate {
  return {
    policyId: 'synthetic-policy-v1',
    code: 'floor-plans',
    archive: {
      id: 'synthetic-archive-v1',
      files: [
        { relativePath: '2025/Plugin.addin', kind: 'addin' },
        { relativePath: '2026/Plugin.addin', kind: 'addin' },
        { relativePath: '2025/Plugin.dll', kind: 'dll' },
        { relativePath: '2026/Plugin.dll', kind: 'dll' },
        { relativePath: 'shared.json', kind: 'data' },
      ],
      manifests: [2025, 2026].map((year) => ({
        relativePath: `${year}/Plugin.addin`,
        year: year as 2025 | 2026,
        addIns: [{ addInId: guid, assemblyRelativePath: `${year}/Plugin.dll` }],
      })),
    },
    manifestTargets: [2025, 2026].map((year) => ({
      sourceRelativePath: `${year}/Plugin.addin`,
      year: year as 2025 | 2026,
      targetBasename: 'Schema.Managed.Floor.addin',
    })),
    yearFiles: [
      { year: 2025, paths: ['2025/Plugin.dll', 'shared.json'] },
      { year: 2026, paths: ['2026/Plugin.dll', 'shared.json'] },
    ],
  };
}
describe('main-owned format policy and per-operation release binding', () => {
  it('production has no approved templates and an empty registry never grants a binding', () => {
    expect(APPROVED_INSTALL_TEMPLATES).toEqual([]);
    expect(() =>
      bindInstallLayout(APPROVED_INSTALL_TEMPLATES, 'a'.repeat(64), 'floor-plans', build()),
    ).toThrow();
  });
  it('an approved format supports a new release without trusting a new format or mutable caller objects', () => {
    const policy = template(),
      first = bindInstallLayout([policy], 'a'.repeat(64), 'floor-plans', build()),
      next = {
        ...build(),
        id: 2,
        version: '1.1',
        sha256: 'c'.repeat(64),
        url: '/api/desktop/plugins/files/2',
      };
    const second = bindInstallLayout([policy], 'a'.repeat(64), 'floor-plans', next);
    required(policy.yearFiles[0]).paths = ['2026/Plugin.dll'];
    next.sha256 = 'd'.repeat(64);
    expect(first.buildId).toBe(1);
    expect(second.buildId).toBe(2);
    expect(second.archiveSha256).toBe('c'.repeat(64));
    expect(second.template.yearFiles[0]?.paths).toEqual(['2025/Plugin.dll', 'shared.json']);
    expect(Object.isFrozen(second.template.archive.manifests[0]?.addIns)).toBe(true);
  });
  it('rejects ambiguous approved formats instead of choosing the first', () => {
    expect(() =>
      bindInstallLayout(
        [template(), { ...template(), policyId: 'other' }],
        'a'.repeat(64),
        'floor-plans',
        build(),
      ),
    ).toThrow();
  });
  it('version applicability is explicit and numeric; unsupported year/code does not borrow a format', () => {
    const policy = { ...template(), versions: { from: '1.9', through: '1.10' } };
    expect(
      bindInstallLayout([policy], 'a'.repeat(64), 'floor-plans', { ...build(), version: '1.10' })
        .version,
    ).toBe('1.10');
    for (const version of ['1.8', '1.11'])
      expect(() =>
        bindInstallLayout([policy], 'a'.repeat(64), 'floor-plans', { ...build(), version }),
      ).toThrow();
    expect(() =>
      bindInstallLayout([template()], 'a'.repeat(64), 'other-plugin', build()),
    ).toThrow();
    expect(() =>
      bindInstallLayout([template()], 'a'.repeat(64), 'floor-plans', { ...build(), revit: [2025] }),
    ).toThrow();
  });
  it.each([
    [
      'wrong-year assembly subset',
      (p: ApprovedInstallTemplate) => {
        required(p.yearFiles[0]).paths = ['2026/Plugin.dll', 'shared.json'];
      },
    ],
    [
      'unassigned data',
      (p: ApprovedInstallTemplate) => {
        p.yearFiles.forEach((y) => {
          y.paths = y.paths.filter((x) => x !== 'shared.json');
        });
      },
    ],
    [
      'unknown payload',
      (p: ApprovedInstallTemplate) => {
        required(p.yearFiles[0]).paths = ['unapproved.dll'];
      },
    ],
    [
      'manifest inside payload',
      (p: ApprovedInstallTemplate) => {
        required(p.yearFiles[0]).paths = ['2025/Plugin.addin'];
      },
    ],
    [
      'unsafe target',
      (p: ApprovedInstallTemplate) => {
        required(p.manifestTargets[0]).targetBasename = '../outside.addin';
      },
    ],
    [
      'device target',
      (p: ApprovedInstallTemplate) => {
        required(p.manifestTargets[0]).targetBasename = 'CON.addin';
      },
    ],
    [
      'wrong target year',
      (p: ApprovedInstallTemplate) => {
        required(p.manifestTargets[0]).year = 2026;
      },
    ],
    [
      'case-colliding files',
      (p: ApprovedInstallTemplate) => {
        p.archive = {
          ...p.archive,
          files: [...p.archive.files, { relativePath: '2025/PLUGIN.dll', kind: 'dll' }],
        };
      },
    ],
    [
      'file-directory collision',
      (p: ApprovedInstallTemplate) => {
        p.archive = {
          ...p.archive,
          files: [...p.archive.files, { relativePath: '2025', kind: 'data' }],
        };
      },
    ],
    [
      'missing manifest mapping',
      (p: ApprovedInstallTemplate) => {
        p.manifestTargets = p.manifestTargets.slice(1);
      },
    ],
    [
      'extra DLL reference',
      (p: ApprovedInstallTemplate) => {
        p.archive = {
          ...p.archive,
          manifests: p.archive.manifests.map((m) => ({
            ...m,
            addIns: [{ addInId: guid, assemblyRelativePath: 'external.dll' }],
          })),
        };
      },
    ],
    [
      'repeated year',
      (p: ApprovedInstallTemplate) => {
        required(p.yearFiles[1]).year = 2025;
      },
    ],
  ] as const)('rejects %s before preparing any archive', (_name, mutate) => {
    const p = template();
    mutate(p);
    expect(() => snapshotInstallTemplates([p])).toThrow();
  });
  it('rejects coercible enum and checksum values', () => {
    const p = template();
    (p.archive.files[4] as unknown as Record<string, unknown>).kind = ['data'];
    expect(() => snapshotInstallTemplates([p])).toThrow();
    expect(() =>
      bindInstallLayout([template()], 'a'.repeat(64), 'floor-plans', {
        ...build(),
        sha256: ['b'.repeat(64)] as unknown as string,
      }),
    ).toThrow();
  });
});
