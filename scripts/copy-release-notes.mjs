import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(import.meta.url);
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
  throw Error('Invalid release version');
const installer = join(root, 'release', `Schema Teams Setup ${version}.exe`),
  source = join(root, 'docs', `release-${version}.md`),
  notes = installer.replace(/\.exe$/, '.md');
if (!(await stat(installer)).isFile()) throw Error('Missing versioned installer');
const archive = join(root, 'release/win-unpacked/resources/app.asar'),
  asar = require('@electron/asar');
if (JSON.parse(asar.extractFile(archive, 'package.json').toString()).version !== version)
  throw Error('Installer build and package versions differ');
const bytes = await readFile(source);
if (!bytes.toString('utf8').split('\n')[0]?.includes(version))
  throw Error('Release notes version mismatch');
await writeFile(notes, bytes);
const copied = await readFile(notes);
if (!bytes.equals(copied)) throw Error('Release notes copy mismatch');
console.log(
  JSON.stringify({
    version,
    installer: `Schema Teams Setup ${version}.exe`,
    notes: `Schema Teams Setup ${version}.md`,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    notesSha256: createHash('sha256').update(copied).digest('hex'),
    match: true,
  }),
);
