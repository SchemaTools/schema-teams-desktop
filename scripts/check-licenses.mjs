// Проверка лицензий зависимостей, которые попадают в поставку (CLAUDE.md, «Зависимости»;
// ТЗ v4, 2.1). В поставку входят:
//  - dependencies (их node_modules кладёт в app.asar electron-builder);
//  - пакеты, которые esbuild собирает в интерфейс (dist/renderer/index.js): они числятся
//    в devDependencies, но их код уходит пользователю — список RENDERER_BUNDLED.
// Остальные devDependencies — инструменты разработки, в поставку не входят.
// Electron с ffmpeg.dll (LGPL-2.1) — исключение по решению 16.10.2026, здесь не проверяется.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ALLOWED_LICENSES = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
];

/** Пакеты, которые собираются в интерфейс; их лицензии копирует scripts/build-renderer.mjs. */
export const RENDERER_BUNDLED = [
  'react',
  'react-dom',
  'lucide-react',
  '@fontsource/inter',
  '@fontsource/ibm-plex-mono',
];

/** Пакеты, в которых только шрифты: им разрешена OFL-1.1 (решение 25.10.2026). */
const FONT_PACKAGE = /^node_modules\/@fontsource\/[^/]+$/;

/** Понимает выражения SPDX с OR и AND без вложенных скобок: «(MIT OR Apache-2.0)». */
export function isLicenseAllowed(license) {
  if (typeof license !== 'string' || license.trim() === '') return false;
  const expression = license.replace(/[()]/g, ' ').trim();
  return expression
    .split(/\s+OR\s+/)
    .some((option) =>
      option.split(/\s+AND\s+/).every((id) => ALLOWED_LICENSES.includes(id.trim())),
    );
}

function resolveDependency(packages, from, name) {
  let base = from;
  for (;;) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
    const parent = base.lastIndexOf('/node_modules/');
    base = parent >= 0 ? base.slice(0, parent) : '';
  }
}

/** Пакеты поставки: dependencies корня, RENDERER_BUNDLED и всё, что им нужно для работы. */
export function productPackages(lock, bundled = RENDERER_BUNDLED) {
  const packages = lock.packages ?? {};
  const root = packages[''] ?? {};
  const seen = new Set();
  const queue = [];
  for (const name of [...Object.keys(root.dependencies ?? {}), ...bundled]) {
    const found = resolveDependency(packages, '', name);
    if (found && !seen.has(found)) {
      seen.add(found);
      queue.push(found);
    }
  }
  for (let location = queue.shift(); location !== undefined; location = queue.shift()) {
    const pkg = packages[location] ?? {};
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}).filter(
        (name) => !pkg.peerDependenciesMeta?.[name]?.optional,
      ),
    ];
    for (const name of names) {
      const found = resolveDependency(packages, location, name);
      if (found && !seen.has(found)) {
        seen.add(found);
        queue.push(found);
      }
    }
  }
  return [...seen].sort();
}

/**
 * Лицензия пакета. В package-lock.json её нет у старых пакетов, которые
 * записывают лицензию списком `licenses`; тогда читается package.json пакета.
 */
export function licenseOf(location, pkg, readPackageJson) {
  if (pkg.license) return pkg.license;
  const manifest = readPackageJson(location);
  if (typeof manifest?.license === 'string') return manifest.license;
  const legacy = [manifest?.licenses ?? []].flat().map((item) => item?.type ?? item);
  return legacy.length > 0 ? legacy.join(' OR ') : undefined;
}

function readInstalledPackageJson(location) {
  try {
    return JSON.parse(
      readFileSync(new URL(`../${location}/package.json`, import.meta.url), 'utf8'),
    );
  } catch {
    return undefined;
  }
}

export function findViolations(lock, readPackageJson = readInstalledPackageJson) {
  return productPackages(lock)
    .map((location) => {
      const pkg = lock.packages[location] ?? {};
      return { location, version: pkg.version, license: licenseOf(location, pkg, readPackageJson) };
    })
    .filter((pkg) => !(FONT_PACKAGE.test(pkg.location) && pkg.license === 'OFL-1.1'))
    .filter((pkg) => !isLicenseAllowed(pkg.license))
    .map((pkg) => ({
      name: pkg.location,
      version: pkg.version,
      license: pkg.license ?? 'не указана',
    }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const violations = findViolations(lock);
  if (violations.length > 0) {
    console.error('✕ Запрещённые лицензии в поставке (CLAUDE.md, «Зависимости»):');
    for (const v of violations) console.error(`  ${v.name}@${v.version}: ${v.license}`);
    process.exit(1);
  }
  console.log(`✓ Лицензии пакетов поставки разрешены (${productPackages(lock).length})`);
}
