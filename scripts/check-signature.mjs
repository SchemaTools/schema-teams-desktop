// После `npm run dist:signed`: установщик и Schema Teams.exe подписаны сертификатом бюро
// (тот же отпечаток SHA-256, что в списках доверия приложения), подпись действительна.
// Только Windows: читает подпись средствами PowerShell (Get-AuthenticodeSignature).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const source = readFileSync(new URL('src/main/plugins/signature.ts', root), 'utf8');
const pin = /BUREAU_PUBLISHER_DER_SHA256 =\s*'([0-9a-f]{64})'/.exec(source)?.[1];
if (!pin) throw new Error('не найден отпечаток сертификата бюро в src/main/plugins/signature.ts');

const release = new URL('release/', root);
const setup = readdirSync(release).find((n) => /^Schema Teams Setup .*\.exe$/.test(n));
if (!setup) throw new Error('в release/ нет установщика');
const files = [
  join(release.pathname.slice(1), setup),
  join(release.pathname.slice(1), 'win-unpacked', 'Schema Teams.exe'),
];

let fail = false;
for (const file of files) {
  const script =
    "$s = Get-AuthenticodeSignature -LiteralPath $env:TARGET; if (-not $s.SignerCertificate) { 'NONE'; exit }; " +
    "$h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($s.SignerCertificate.RawData)).Replace('-','').ToLower(); " +
    '"$($s.Status)|$h"';
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: { ...process.env, TARGET: decodeURIComponent(file) },
      encoding: 'utf8',
    },
  ).trim();
  const [status, hash] = out.split('|');
  // самоподписанный сертификат: Valid — если он доверенный на этом компьютере, иначе UnknownError
  const ok = hash === pin && (status === 'Valid' || status === 'UnknownError');
  console.log(
    `${ok ? '✓' : '✕'} ${decodeURIComponent(file).split(/[\\/]/).pop()}: ${out === 'NONE' ? 'нет подписи' : status}`,
  );
  if (!ok) fail = true;
}
if (fail) {
  console.error(
    'Подпись не сертификатом бюро. Нужен «Schema Bureau Revit Plugins» с закрытым ключом в хранилище «Личное».',
  );
  process.exit(1);
}
