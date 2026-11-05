// Записывает адрес сервера и список серверов бюро для путей `\\сервер\…`
// в dist/build-config.json (ТЗ, 9.1 и 7.2).
// Источник — переменные SERVER_URL и UNC_HOSTS или закрытый файл .env (в репозиторий не попадает).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const fromEnvFile = {};
const envFile = new URL('.env', root);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(SERVER_URL|UNC_HOSTS)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) fromEnvFile[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
let serverUrl = process.env.SERVER_URL || fromEnvFile.SERVER_URL || '';
// заглушка из .env.example — не адрес
if (serverUrl.includes('<')) serverUrl = '';
// UNC_HOSTS=host1,host2 — имена или IP без `\`; сравнение в приложении без учёта регистра
const uncHosts = [
  ...new Set(
    (process.env.UNC_HOSTS ?? fromEnvFile.UNC_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host && !host.includes('<')),
  ),
];
writeFileSync(
  new URL('dist/build-config.json', root),
  JSON.stringify({ serverUrl, uncHosts }, null, 2),
);
console.log(
  serverUrl ? '✓ адрес сервера записан в сборку' : '! адрес сервера не задан (SERVER_URL)',
);
console.log(
  uncHosts.length
    ? `✓ серверов бюро для путей: ${uncHosts.length}`
    : '! серверы бюро для путей не заданы (UNC_HOSTS): каждый путь — с подтверждением',
);
