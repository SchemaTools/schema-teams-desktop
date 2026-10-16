// Записывает адрес сервера в dist/build-config.json (ТЗ, 9.1).
// Источник — переменная SERVER_URL или закрытый файл .env (в репозиторий не попадает).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
let serverUrl = process.env.SERVER_URL ?? '';
const envFile = new URL('.env', root);
if (!serverUrl && existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*SERVER_URL\s*=\s*(.*?)\s*$/.exec(line);
    if (m) serverUrl = m[1].replace(/^["']|["']$/g, '');
  }
}
// заглушка из .env.example — не адрес
if (serverUrl.includes('<')) serverUrl = '';
writeFileSync(new URL('dist/build-config.json', root), JSON.stringify({ serverUrl }, null, 2));
console.log(
  serverUrl ? '✓ адрес сервера записан в сборку' : '! адрес сервера не задан (SERVER_URL)',
);
