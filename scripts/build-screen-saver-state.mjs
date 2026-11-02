import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const compiler = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  if (!existsSync(compiler)) throw new Error('Для сборки helper нужен .NET Framework 4.x');
  const output = fileURLToPath(new URL('../dist/native/screen-saver-state.exe', import.meta.url));
  const source = fileURLToPath(new URL('../native/ScreenSaverState.cs', import.meta.url));
  mkdirSync(fileURLToPath(new URL('../dist/native', import.meta.url)), { recursive: true });
  const result = spawnSync(
    compiler,
    ['/nologo', '/optimize+', '/target:exe', `/out:${output}`, source],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 4096 },
  );
  if (result.error || result.status !== 0) throw new Error('Не удалось собрать read-only helper');
  console.log('screen-saver-state helper built');
}
