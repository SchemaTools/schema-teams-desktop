import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const localRequire = createRequire(import.meta.url);
// Use the packager's existing ASAR library, including installations that nest it.
const builderRequire = createRequire(localRequire.resolve('electron-builder'));
const asarRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = asarRequire('@electron/asar');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const moduleName = (name) => /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name);

/** Exact installed production closure and nested layout. No install/network/execution. */
export function collectRuntimePackages(packageFile) {
  const packages = new Map();
  const modules = realpathSync(join(dirname(packageFile), 'node_modules'));
  function dependency(name, from, optional = false) {
    if (!moduleName(name)) throw Error('Invalid runtime dependency name');
    let entry;
    try {
      entry = createRequire(from).resolve(name);
    } catch (error) {
      if (optional && error.code === 'MODULE_NOT_FOUND') return;
      throw Error(`Runtime dependency unavailable: ${name}`, { cause: error });
    }
    let directory = dirname(entry),
      info;
    for (;;) {
      const file = join(directory, 'package.json');
      if (existsSync(file)) {
        const candidate = json(file);
        // Bundles can contain inner type-only package.json files with the same
        // name. Only the versioned package root owns its dependency graph.
        if (candidate.name === name && typeof candidate.version === 'string' && candidate.version) {
          info = candidate;
          break;
        }
      }
      const parent = dirname(directory);
      if (parent === directory) throw Error(`Runtime package metadata unavailable: ${name}`);
      directory = parent;
    }
    const location = relative(modules, realpathSync(directory)).split(sep).join('/');
    if (!location || location.startsWith('../') || isAbsolute(location))
      throw Error(`Runtime dependency outside module layout: ${name}`);
    const relativePath = `node_modules/${location}`;
    const previous = packages.get(relativePath);
    if (previous) {
      if (previous.version !== info.version)
        throw Error(`Runtime layout version conflict: ${name}`);
      return;
    }
    const main = relative(directory, entry).split(sep).join('/');
    if (!main || main.startsWith('../') || isAbsolute(main))
      throw Error(`Invalid runtime entry: ${name}`);
    packages.set(relativePath, { name, version: info.version, directory, main, relativePath });
    const child = join(directory, 'package.json');
    for (const dependencyName of Object.keys(info.dependencies ?? {}))
      dependency(dependencyName, child);
    for (const dependencyName of Object.keys(info.optionalDependencies ?? {}))
      dependency(dependencyName, child, true);
  }
  for (const name of Object.keys(json(packageFile).dependencies ?? {}))
    dependency(name, packageFile);
  return [...packages.values()];
}

export function checkPackagedRuntime(
  archive,
  packageFile = fileURLToPath(new URL('../package.json', import.meta.url)),
) {
  const expected = collectRuntimePackages(resolve(packageFile));
  const failures = [];
  for (const item of expected) {
    try {
      const metadata = JSON.parse(
        asar.extractFile(archive, join(item.relativePath, 'package.json')).toString('utf8'),
      );
      if (metadata.name !== item.name || metadata.version !== item.version) throw Error('version');
      const entry = asar.extractFile(archive, join(item.relativePath, item.main));
      if (!entry.length || !entry.equals(readFileSync(join(item.directory, item.main))))
        throw Error('entry');
    } catch {
      failures.push(item.name);
    }
  }
  if (failures.length)
    throw Error(`Packaged runtime dependencies missing or mismatched: ${failures.join(', ')}`);
  return {
    complete: true,
    packages: expected.map(({ name, version, relativePath, directory, main }) => ({
      name,
      version,
      relativePath,
      main,
      entrySha256: createHash('sha256')
        .update(readFileSync(join(directory, main)))
        .digest('hex'),
    })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw Error('Usage: node scripts/check-packaged-runtime.mjs <app.asar>');
    console.log(JSON.stringify(checkPackagedRuntime(resolve(process.argv[2]))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
