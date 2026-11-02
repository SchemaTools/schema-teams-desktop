import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') {
  const compiler = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  if (!existsSync(compiler)) throw Error('Windows Framework compiler required');
  const output = fileURLToPath(new URL('../dist/native/plugin-safety.exe', import.meta.url)),
    source = fileURLToPath(new URL('../native/PluginSafety.cs', import.meta.url));
  mkdirSync(fileURLToPath(new URL('../dist/native', import.meta.url)), { recursive: true });
  const r = spawnSync(
    compiler,
    ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${output}`, source],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 },
  );
  if (r.status !== 0) throw Error(r.stderr || r.stdout || 'Safety helper compilation failed');
  console.log('Read-only plugin process/path safety helper built');
}
