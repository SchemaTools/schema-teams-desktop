import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const compiler = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  if (!existsSync(compiler)) throw new Error('Windows .NET Framework 4.x compiler required');
  const output = fileURLToPath(new URL('../dist/native/plugin-manifest.exe', import.meta.url));
  mkdirSync(fileURLToPath(new URL('../dist/native', import.meta.url)), { recursive: true });
  const result = spawnSync(
    compiler,
    [
      '/nologo',
      '/optimize+',
      '/platform:x64',
      '/target:exe',
      '/r:System.Web.Extensions.dll',
      `/out:${output}`,
      fileURLToPath(new URL('../native/PluginManifest.cs', import.meta.url)),
    ],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || 'Manifest helper compilation failed');
  console.log('Windows safe XML manifest helper built');
}
