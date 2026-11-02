import type { PluginBuild } from '../../shared/plugins';
import {
  pluginCode,
  pluginVersion,
  comparePluginVersions,
  PLUGIN_MAX_BYTES,
} from '../../shared/plugins';
import { positiveId } from '../../shared/time';
import type { ApprovedLayoutDescriptor } from './archive';
import { safeArchiveRelativePath } from './archivePaths';

export interface ApprovedInstallTemplate {
  policyId: string;
  code: string;
  versions?: { from: string; through?: string };
  archive: ApprovedLayoutDescriptor;
  manifestTargets: readonly {
    sourceRelativePath: string;
    year: 2025 | 2026;
    targetBasename: string;
  }[];
  yearFiles: readonly { year: 2025 | 2026; paths: readonly string[] }[];
}
export interface InstallLayoutBinding {
  readonly serverHash: string;
  readonly code: string;
  readonly buildId: number;
  readonly version: string;
  readonly archiveSha256: string;
  readonly archiveSize: number;
  readonly template: Readonly<ApprovedInstallTemplate>;
}

// Main-owned approved format policy, never a catalog/ZIP/renderer/settings field.
// No real bureau format has been supplied or approved yet.
export const APPROVED_INSTALL_TEMPLATES: readonly ApprovedInstallTemplate[] = Object.freeze([]);
const hash = /^[a-f0-9]{64}$/;
const id = /^[a-zA-Z0-9._-]{1,80}$/;
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
function deny(): never {
  throw Error('unsupported_plugin_layout');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate and own every nested value synchronously, before any filesystem/network operation. */
export function snapshotInstallTemplates(
  raw: readonly ApprovedInstallTemplate[],
): readonly ApprovedInstallTemplate[] {
  if (!Array.isArray(raw) || raw.length > 100) deny();
  const templates = structuredClone(raw);
  for (const t of templates) {
    if (
      !object(t) ||
      !keys(t, ['policyId', 'code', 'versions', 'archive', 'manifestTargets', 'yearFiles']) ||
      typeof t.policyId !== 'string' ||
      !id.test(t.policyId) ||
      !pluginCode(t.code)
    )
      deny();
    if (
      t.versions !== undefined &&
      (!object(t.versions) ||
        !keys(t.versions, ['from', 'through']) ||
        !pluginVersion(t.versions.from) ||
        (t.versions.through !== undefined &&
          (!pluginVersion(t.versions.through) ||
            comparePluginVersions(t.versions.from, t.versions.through) > 0)))
    )
      deny();
    const a = t.archive;
    if (
      !object(a) ||
      !keys(a, ['id', 'files', 'manifests']) ||
      typeof a.id !== 'string' ||
      !id.test(a.id) ||
      !Array.isArray(a.files) ||
      a.files.length < 1 ||
      a.files.length > 4096 ||
      !Array.isArray(a.manifests) ||
      a.manifests.length < 1 ||
      a.manifests.length > 64
    )
      deny();
    const files = new Map<string, string>(),
      folded = new Set<string>();
    for (const f of a.files) {
      if (
        !object(f) ||
        !keys(f, ['relativePath', 'kind']) ||
        typeof f.relativePath !== 'string' ||
        typeof f.kind !== 'string' ||
        !['dll', 'addin', 'data'].includes(f.kind)
      )
        deny();
      const p = safeArchiveRelativePath(f.relativePath);
      if (
        folded.has(p.toLowerCase()) ||
        p.toLowerCase().endsWith('.dll') !== (f.kind === 'dll') ||
        p.toLowerCase().endsWith('.addin') !== (f.kind === 'addin') ||
        (f.kind === 'data' &&
          /\.(exe|com|bat|cmd|ps1|vbs|js|msi|lnk|url|reg|sys|scr|pif|hta|ocx)$/i.test(p))
      )
        deny();
      for (const prior of files.keys())
        if (
          p.toLowerCase().startsWith(prior.toLowerCase() + '/') ||
          prior.toLowerCase().startsWith(p.toLowerCase() + '/')
        )
          deny();
      folded.add(p.toLowerCase());
      files.set(p, f.kind as string);
    }
    const manifests = new Set<string>(),
      yearIds = new Set<string>(),
      years = new Set<number>();
    for (const m of a.manifests) {
      if (
        !object(m) ||
        !keys(m, ['relativePath', 'year', 'addIns']) ||
        typeof m.relativePath !== 'string' ||
        files.get(m.relativePath) !== 'addin' ||
        manifests.has(m.relativePath) ||
        (m.year !== 2025 && m.year !== 2026) ||
        !Array.isArray(m.addIns) ||
        m.addIns.length < 1 ||
        m.addIns.length > 32
      )
        deny();
      manifests.add(m.relativePath);
      years.add(m.year);
      for (const entry of m.addIns) {
        if (
          !object(entry) ||
          !keys(entry, ['addInId', 'assemblyRelativePath']) ||
          typeof entry.addInId !== 'string' ||
          !guid.test(entry.addInId) ||
          entry.addInId === '00000000-0000-0000-0000-000000000000' ||
          typeof entry.assemblyRelativePath !== 'string' ||
          files.get(entry.assemblyRelativePath) !== 'dll' ||
          yearIds.has(`${m.year}:${entry.addInId}`)
        )
          deny();
        yearIds.add(`${m.year}:${entry.addInId}`);
      }
    }
    if (
      [...files].filter(([, kind]) => kind === 'addin').length !== manifests.size ||
      !Array.isArray(t.manifestTargets) ||
      t.manifestTargets.length !== manifests.size ||
      !Array.isArray(t.yearFiles) ||
      t.yearFiles.length !== years.size
    )
      deny();
    const targets = new Set<string>(),
      sources = new Set<string>();
    for (const m of t.manifestTargets) {
      if (
        !object(m) ||
        !keys(m, ['sourceRelativePath', 'year', 'targetBasename']) ||
        typeof m.sourceRelativePath !== 'string' ||
        typeof m.targetBasename !== 'string' ||
        !a.manifests.some((x) => x.relativePath === m.sourceRelativePath && x.year === m.year) ||
        sources.has(m.sourceRelativePath)
      )
        deny();
      const name = safeArchiveRelativePath(m.targetBasename);
      if (
        name.includes('/') ||
        !name.toLowerCase().endsWith('.addin') ||
        targets.has(`${m.year}:${name.toLowerCase()}`)
      )
        deny();
      sources.add(m.sourceRelativePath);
      targets.add(`${m.year}:${name.toLowerCase()}`);
    }
    const covered = new Set<string>(),
      mappedYears = new Set<number>();
    for (const y of t.yearFiles) {
      if (
        !object(y) ||
        !keys(y, ['year', 'paths']) ||
        (y.year !== 2025 && y.year !== 2026) ||
        !years.has(y.year) ||
        mappedYears.has(y.year) ||
        !Array.isArray(y.paths) ||
        y.paths.length < 1 ||
        y.paths.length > 4096 ||
        new Set(y.paths).size !== y.paths.length
      )
        deny();
      mappedYears.add(y.year);
      for (const p of y.paths) {
        if (typeof p !== 'string' || !files.has(p) || files.get(p) === 'addin') deny();
        covered.add(p);
      }
      for (const m of a.manifests.filter((m) => m.year === y.year))
        for (const e of m.addIns) if (!y.paths.includes(e.assemblyRelativePath)) deny();
    }
    if ([...files].some(([p, kind]) => kind !== 'addin' && !covered.has(p))) deny();
  }
  return freeze(templates);
}

/** Templates authorize format; this immutable binding owns a fresh release identity for one job. */
export function bindInstallLayout(
  templates: readonly ApprovedInstallTemplate[],
  serverHash: string,
  code: string,
  build: PluginBuild,
): Readonly<InstallLayoutBinding> {
  build = structuredClone(build);
  if (
    typeof serverHash !== 'string' ||
    !hash.test(serverHash) ||
    !pluginCode(code) ||
    !positiveId(build.id) ||
    !pluginVersion(build.version) ||
    typeof build.sha256 !== 'string' ||
    !hash.test(build.sha256) ||
    !Number.isSafeInteger(build.size) ||
    build.size < 1 ||
    build.size > PLUGIN_MAX_BYTES ||
    build.url !== `/api/desktop/plugins/files/${build.id}` ||
    !Array.isArray(build.revit) ||
    new Set(build.revit).size !== build.revit.length ||
    build.revit.length < 1 ||
    build.revit.some((y) => y !== 2025 && y !== 2026)
  )
    deny();
  const owned = snapshotInstallTemplates(templates);
  const selected = owned.filter(
    (t) =>
      t.code === code &&
      (!t.versions ||
        (comparePluginVersions(build.version, t.versions.from) >= 0 &&
          (!t.versions.through ||
            comparePluginVersions(build.version, t.versions.through) <= 0))) &&
      t.yearFiles.length === build.revit.length &&
      t.yearFiles.every((y) => build.revit.includes(y.year)),
  );
  const template = selected[0];
  if (selected.length !== 1 || !template) deny();
  return freeze({
    serverHash,
    code,
    buildId: build.id,
    version: build.version,
    archiveSha256: build.sha256,
    archiveSize: build.size,
    template,
  });
}
