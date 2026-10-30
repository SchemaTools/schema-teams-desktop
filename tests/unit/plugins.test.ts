function required<T>(v: T | null | undefined): T {
  if (v == null) throw Error('Expected fixture');
  return v;
}
import { describe, it, expect, vi } from 'vitest';
import { pluginCatalog } from '../../src/main/api/plugins';
import { planPlugins, planPluginYears } from '../../src/main/plugins/planner';
import { PluginCatalogService } from '../../src/main/plugins/catalog';
import {
  comparePluginVersions,
  type PluginBuild,
  type PluginCatalog,
} from '../../src/shared/plugins';
import { requestValid } from '../../src/shared/requests';
import { normalizeSettings } from '../../src/main/settings';
import { auditPlugin } from '../../src/main/plugins/audit';
const build = (id = 1, version = '1.10'): PluginBuild => ({
  id,
  version,
  verified: true,
  revit: [2025, 2026],
  notes: 'Изменения',
  size: 4,
  sha256: 'a'.repeat(64),
  url: `/api/desktop/plugins/files/${id}`,
  publishedAt: '2026-10-31T04:00:00.000Z',
  requires: [],
});
const catalog = (): PluginCatalog => ({
  tester: false,
  plugins: [
    { code: 'floor-plans', name: 'Планы этажей', short: 'ПЭ', stable: build(), beta: null },
  ],
});
describe('Desktop plugin metadata and dependency planning', () => {
  it('projects exact current routes, empty catalog is valid, numeric versions normalize patch', () => {
    expect(pluginCatalog(catalog())).toEqual(catalog());
    expect(pluginCatalog({ tester: false, plugins: [] })).toEqual({ tester: false, plugins: [] });
    expect(comparePluginVersions('1.10', '1.9.99')).toBe(1);
    expect(comparePluginVersions('1.2', '1.2.0')).toBe(0);
  });
  it('rejects malformed bounds/path and never accepts unverified stable or beta for non-tester', () => {
    for (const patch of [
      { size: 0 },
      { size: 200 * 1024 * 1024 + 1 },
      { url: 'https://evil.invalid/api/desktop/plugins/files/1' },
      { url: '/api/desktop/plugins/files/2' },
      { sha256: 'bad' },
      { verified: false },
      { revit: [2025, 2025] },
      { version: 'v1.0' },
      { publishedAt: 'tomorrow' },
      { requires: [{ plugin: 'x', minVersion: '1.0' }] },
    ]) {
      const c = catalog();
      Object.assign(required(required(c.plugins[0]).stable), patch);
      expect(() => pluginCatalog(c)).toThrow();
    }
    const c = catalog();
    required(c.plugins[0]).beta = build(2);
    expect(() => pluginCatalog(c)).toThrow();
    c.tester = true;
    required(required(c.plugins[0]).beta).verified = false;
    expect(pluginCatalog(c).plugins[0]?.beta?.verified).toBe(false);
  });
  it('orders dependency closure before consumer without inventing historical IDs', () => {
    const c = catalog();
    required(required(c.plugins[0]).stable).requires = [
      { plugin: 'schema-tools', minVersion: '2.0' },
    ];
    c.plugins.push({
      code: 'schema-tools',
      name: 'Tools',
      short: 'СТ',
      stable: build(2, '2.1'),
      beta: null,
    });
    expect(planPlugins(c, 'floor-plans', 2025, false).builds.map((p) => p.build.id)).toEqual([
      2, 1,
    ]);
    required(required(c.plugins[1]).stable).version = '1.99';
    expect(() => planPlugins(c, 'floor-plans', 2025, false)).toThrow('dependency_incompatible');
  });
  it('blocks missing, incompatible year and cyclic dependency before any download', () => {
    const c = catalog();
    required(required(c.plugins[0]).stable).requires = [{ plugin: 'missing', minVersion: '1.0' }];
    expect(() => planPlugins(c, 'floor-plans', 2025, false)).toThrow('dependency_missing');
    required(required(c.plugins[0]).stable).requires = [
      { plugin: 'floor-plans', minVersion: '1.0' },
    ];
    expect(() => planPlugins(c, 'floor-plans', 2025, false)).toThrow('dependency_cycle');
    required(required(c.plugins[0]).stable).requires = [];
    required(required(c.plugins[0]).stable).revit = [2024];
    expect(() => planPlugins(c, 'floor-plans', 2026, false)).toThrow('dependency_incompatible');
  });
  it('beta needs both tester and opt-in; year-compatible stable remains fallback', () => {
    const c = catalog();
    required(c.plugins[0]).beta = build(2, '2.0');
    expect(() => planPlugins(c, 'floor-plans', 2025, true)).toThrow('invalid_plugins');
    c.tester = true;
    expect(planPlugins(c, 'floor-plans', 2025, false).builds[0]?.build.id).toBe(1);
    expect(planPlugins(c, 'floor-plans', 2025, true).builds[0]?.build.id).toBe(2);
    required(required(c.plugins[0]).beta).revit = [2024];
    expect(planPlugins(c, 'floor-plans', 2025, true).builds[0]?.build.id).toBe(1);
  });
  it('IPC exposes metadata refresh/preferences only, no URL/file/download/install/publisher bypass', () => {
    expect(requestValid({ kind: 'plugins.refresh', epoch: 2 })).toBe(true);
    expect(requestValid({ kind: 'plugins.preferences', epoch: 2, beta: true })).toBe(true);
    for (const raw of [
      { kind: 'plugins.refresh' },
      { kind: 'plugins.refresh', epoch: 2, url: '/api/admin/plugins' },
      { kind: 'plugins.download', epoch: 2, id: 1 },
      { kind: 'plugins.install', epoch: 2 },
      { kind: 'plugins.preferences', epoch: 2, publisher: 'trust' },
      { kind: 'plugins.preferences', epoch: 2, beta: 'true' },
    ])
      expect(requestValid(raw)).toBe(false);
  });
  it('plans both selected years independently and blocks explicitly unknown local dependencies', () => {
    const c = catalog();
    required(required(c.plugins[0]).stable).requires = [
      { plugin: 'schema-tools', minVersion: '2.0' },
    ];
    c.plugins.push({
      code: 'schema-tools',
      name: 'Tools',
      short: 'СТ',
      stable: build(2, '2.0'),
      beta: null,
    });
    expect(planPluginYears(c, 'floor-plans', [2025, 2026], false).map((p) => p.year)).toEqual([
      2025, 2026,
    ]);
    expect(() =>
      planPlugins(c, 'floor-plans', 2025, false, [
        { plugin: 'schema-tools', version: null, years: [2025] },
      ]),
    ).toThrow('installed_version_unknown');
    expect(() => planPluginYears(c, 'floor-plans', [], false)).toThrow('unsupported_revit');
  });
});
describe('Catalog lifecycle', () => {
  it('startup and six-hour cadence; manual refresh coalesces; errors hide previous catalog', async () => {
    let now = 0;
    const read = vi.fn(async () => ({ ok: true as const, data: catalog() })),
      service = new PluginCatalogService({
        context: () => 'owner1',
        read,
        now: () => now,
        changed: vi.fn(),
      });
    await service.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    now = 6 * 3600000 - 1;
    await service.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    now++;
    await service.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    await Promise.all([service.refresh(true), service.refresh(true)]);
    expect(read).toHaveBeenCalledTimes(3);
    read.mockRejectedValueOnce(Error('private network detail'));
    await service.refresh(true);
    expect(service.state).toMatchObject({
      status: 'error',
      catalog: null,
      error: 'Не удалось прочитать каталог плагинов.',
    });
  });
  it('push immediately invalidates; burst performs one replacement read; old owner response cannot publish', async () => {
    let resolve!: (v: { ok: true; data: PluginCatalog }) => void,
      scope: string | null = 'A';
    const pending = new Promise<{ ok: true; data: PluginCatalog }>((r) => {
      resolve = r;
    });
    const read = vi
        .fn()
        .mockReturnValueOnce(pending)
        .mockResolvedValue({ ok: true, data: { tester: false, plugins: [] } }),
      service = new PluginCatalogService({ context: () => scope, read, changed: vi.fn() });
    const first = service.refresh();
    service.invalidate();
    service.invalidate();
    expect(service.state.catalog).toBeNull();
    resolve({ ok: true, data: catalog() });
    await first;
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service.state.status).toBe('ready'));
    expect(service.state.catalog?.plugins).toEqual([]);
    scope = null;
    await service.refresh();
    expect(service.state.status).toBe('unavailable');
    expect(service.state.catalog).toBeNull();
  });
  it('late response after owner change or reset never restores prior private catalog', async () => {
    let resolve!: (v: { ok: true; data: PluginCatalog }) => void,
      scope = 'A';
    const read = vi.fn(
        () =>
          new Promise<{ ok: true; data: PluginCatalog }>((r) => {
            resolve = r;
          }),
      ),
      service = new PluginCatalogService({ context: () => scope, read, changed: vi.fn() });
    const work = service.refresh();
    scope = 'B';
    service.reset();
    resolve({ ok: true, data: catalog() });
    await work;
    expect(service.state.catalog).toBeNull();
  });
});
it('beta opt-in persistence accepts only bounded server-owner identities, never global truthy legacy values', () => {
  const a = `${'a'.repeat(64)}:1`,
    b = `${'b'.repeat(64)}:2`;
  expect(
    normalizeSettings({
      plugins: { beta: true, autoUpdate: false, betaScopes: [a, b, a, {}, [a], 'bad'] },
    }).plugins,
  ).toEqual({ autoUpdate: false, betaScopes: [a, b] });
  expect(normalizeSettings({ plugins: { beta: true } }).plugins?.betaScopes).toEqual([]);
});
it('audit projection emits only bounded identifiers and fixed classification; observer exceptions never escape', () => {
  const observer = vi.fn();
  auditPlugin(observer, {
    operation: 'download',
    phase: 'result',
    outcome: 'rejected',
    reason: 'secret path or URL',
    plugin: '../private',
    version: 'sensitive value',
  });
  expect(observer).toHaveBeenCalledWith({
    operation: 'download',
    phase: 'result',
    outcome: 'rejected',
    reason: 'error',
  });
  expect(() =>
    auditPlugin(
      () => {
        throw Error('disk');
      },
      { operation: 'catalog', phase: 'requested' },
    ),
  ).not.toThrow();
});
it('audit distinguishes same-version builds by positive safe ID and omits invalid ID', () => {
  const observer = vi.fn();
  for (const id of [1, 2, Number.MAX_SAFE_INTEGER + 1])
    auditPlugin(observer, {
      operation: 'download',
      phase: 'requested',
      version: '1.0',
      buildId: id,
    });
  expect(observer.mock.calls.map((c) => c[0].buildId)).toEqual([1, 2, undefined]);
});
