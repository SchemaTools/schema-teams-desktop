import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';

await mkdir('dist/renderer/licenses', { recursive: true });
await build({
  entryPoints: ['src/renderer/index.tsx'],
  bundle: true,
  outfile: 'dist/renderer/index.js',
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome150',
  minify: true,
  legalComments: 'linked',
  loader: { '.woff': 'file', '.woff2': 'file' },
  assetNames: 'assets/[name]-[hash]',
});
await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
for (const [name, file] of [
  ['react', 'LICENSE'],
  ['react-dom', 'LICENSE'],
  ['@phosphor-icons/react', 'LICENSE'],
  ['@fontsource/inter', 'LICENSE'],
  ['@fontsource/ibm-plex-mono', 'LICENSE'],
])
  await copyFile(
    `node_modules/${name}/${file}`,
    `dist/renderer/licenses/${name.replaceAll('/', '-')}.txt`,
  );
await writeFile(
  'dist/renderer/licenses/README.txt',
  'React 18.3.1, React DOM 18.3.1, Phosphor Icons 2.1.10: MIT. Inter and IBM Plex Mono 5.3.0: OFL-1.1. Full license texts accompany this file.\n',
);
