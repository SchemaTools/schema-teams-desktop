// Записывает адрес сервера и список серверов бюро для путей `\\сервер\…`
// в dist/build-config.json (ТЗ, 9.1 и 7.2), папки бюро для bureau.txt (BUREAU_*) и
// публичный сертификат бюро для плагинов (PLUGIN_CERT_PATH → dist/plugin-cert.cer) —
// решение 06.11. Источник — переменные окружения или закрытый файл .env (в репозиторий
// не попадает). Сертификат в git не кладётся: только из закрытого пути при сборке.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const fromEnvFile = {};
const envFile = new URL('.env', root);
const NAMES =
  /^\s*(SERVER_URL|UNC_HOSTS|PLUGIN_CERT_PATH|BUREAU_(?:FEEDBACK_FOLDER|DELETE_LOG_FOLDER|MCP_SCENARIOS|LIBRARY_FOLDER|SETTINGS_FOLDER))\s*=\s*(.*?)\s*$/;
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = NAMES.exec(line);
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
const value = (name) => {
  const v = (process.env[name] ?? fromEnvFile[name] ?? '').trim();
  // заглушка из .env.example (`\\<FILE_SERVER>\…`) — не значение
  return v && !v.includes('<') ? v : undefined;
};
// Папки бюро для %APPDATA%\Schema\bureau.txt; пустые не пишутся.
const bureau = Object.fromEntries(
  [
    ['feedbackFolder', 'BUREAU_FEEDBACK_FOLDER'],
    ['deleteLogFolder', 'BUREAU_DELETE_LOG_FOLDER'],
    ['mcpScenarios', 'BUREAU_MCP_SCENARIOS'],
    ['libraryFolder', 'BUREAU_LIBRARY_FOLDER'],
    ['settingsFolder', 'BUREAU_SETTINGS_FOLDER'],
  ]
    .map(([key, name]) => [key, value(name)])
    .filter(([, v]) => v),
);
writeFileSync(
  new URL('dist/build-config.json', root),
  JSON.stringify({ serverUrl, uncHosts, bureau }, null, 2),
);
// Публичный сертификат бюро (.cer — не ключ): без переменной импорт в приложении выключен.
const certTarget = new URL('dist/plugin-cert.cer', root);
rmSync(certTarget, { force: true });
const certPath = value('PLUGIN_CERT_PATH');
if (certPath) {
  const bytes = readFileSync(certPath);
  const pem = bytes.toString('ascii').includes('-----BEGIN CERTIFICATE-----');
  if (bytes.length < 64 || bytes.length > 65536 || (!pem && bytes[0] !== 0x30))
    throw Error('PLUGIN_CERT_PATH: не сертификат X.509 (.cer)');
  writeFileSync(certTarget, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  console.log(
    `✓ сертификат бюро для плагинов записан в сборку (${pem ? 'PEM' : 'DER'}, ${digest}…)`,
  );
} else console.log('! сертификат бюро для плагинов не задан (PLUGIN_CERT_PATH): импорт выключен');
console.log(
  serverUrl ? '✓ адрес сервера записан в сборку' : '! адрес сервера не задан (SERVER_URL)',
);
console.log(
  uncHosts.length
    ? `✓ серверов бюро для путей: ${uncHosts.length}`
    : '! серверы бюро для путей не заданы (UNC_HOSTS): каждый путь — с подтверждением',
);
console.log(
  Object.keys(bureau).length
    ? `✓ папок бюро для bureau.txt: ${Object.keys(bureau).length}`
    : '! папки бюро для bureau.txt не заданы (BUREAU_*): файл не пишется',
);
