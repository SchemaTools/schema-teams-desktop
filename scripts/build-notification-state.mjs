import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const compiler = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  if (!existsSync(compiler))
    throw new Error('Для сборки helper нужен компилятор .NET Framework 4.x');
  const output = fileURLToPath(new URL('../dist/native/notification-state.exe', import.meta.url));
  const source = fileURLToPath(new URL('../native/NotificationState.cs', import.meta.url));
  mkdirSync(fileURLToPath(new URL('../dist/native', import.meta.url)), { recursive: true });
  const run = spawnSync(
    compiler,
    ['/nologo', '/optimize+', '/target:exe', `/out:${output}`, source],
    {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    },
  );
  if (run.status !== 0)
    throw new Error(run.stderr || run.stdout || 'Не удалось собрать helper уведомлений');
  console.log('✓ helper состояния уведомлений Windows');
}
