import { createHash } from 'node:crypto';
import type { PluginTrustOutcome } from './updater';

/**
 * Доверие сертификату бюро на чистом компьютере (решение руководителя 06.11). Проверка
 * подписи DLL (WinVerifyTrust) требует, чтобы самоподписанный сертификат бюро был в
 * «Доверенных корневых» и «Доверенных издателях» пользователя; раньше это делал установщик
 * Inno через certutil. Публичный .cer кладётся в сборку из закрытого пути (PLUGIN_CERT_PATH);
 * без него функция выключена. Импортируется только сертификат, чей SHA-256 (DER) уже
 * зашит в список доверия — чужой не импортируется никогда.
 */
export interface CertificateDeps {
  /** DER публичного сертификата из сборки или null (функция выключена). */
  certificate(): Promise<Buffer | null>;
  /** APPROVED_PLUGIN_PUBLISHER_DER_SHA256 — из кода, не из настроек. */
  pins: readonly string[];
  /** Есть ли сертификат с этим SHA-256 в хранилищах пользователя; null — не удалось узнать. */
  stores(sha256: string): Promise<{ root: boolean; trustedPublisher: boolean } | null>;
  /** Импорт через certutil -user -addstore <store> <файл> (execFile без shell); код выхода. */
  addStore(store: 'Root' | 'TrustedPublisher', der: Buffer): Promise<number>;
}

/** DER из файла .cer: двоичный или Base64 (PEM). */
export function certificateDer(bytes: Buffer): Buffer | null {
  if (bytes.length < 64 || bytes.length > 64 * 1024) return null;
  if (bytes[0] === 0x30) return bytes;
  const text = bytes.toString('ascii');
  const match = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/.exec(
    text,
  );
  if (!match?.[1]) return null;
  const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  return der[0] === 0x30 ? der : null;
}
export const derSha256 = (der: Buffer) => createHash('sha256').update(der).digest('hex');

export async function ensureBureauCertificate(
  deps: CertificateDeps,
  o: { manual: boolean; prompting: () => void },
): Promise<PluginTrustOutcome> {
  const der = await deps.certificate();
  if (!der) return 'ok';
  const sha256 = derSha256(der);
  if (!deps.pins.includes(sha256)) return 'failed';
  const before = await deps.stores(sha256);
  if (!before) return 'failed';
  if (before.root && before.trustedPublisher) return 'ok';
  // Системный диалог Windows — только после действия пользователя.
  if (!o.manual) return 'required';
  if (!before.root) {
    o.prompting();
    const code = await deps.addStore('Root', der).catch(() => -1);
    const now = await deps.stores(sha256);
    if (!now?.root) return code === -1 ? 'failed' : 'declined';
  }
  if (!before.trustedPublisher) await deps.addStore('TrustedPublisher', der).catch(() => -1);
  const after = await deps.stores(sha256);
  return after?.root && after.trustedPublisher ? 'ok' : 'failed';
}
