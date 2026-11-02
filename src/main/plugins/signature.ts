import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { join, win32 } from 'node:path';
import { app } from 'electron';

export type SignatureVerdict = {
  v: 1;
  verdict: 'valid' | 'invalid' | 'unknown' | 'unsupported';
  reason:
    | 'verified'
    | 'input'
    | 'file-type'
    | 'size'
    | 'hash-mismatch'
    | 'malformed-pe'
    | 'no-embedded-signature'
    | 'wintrust'
    | 'file-changed'
    | 'unavailable'
    | 'platform'
    | 'helper';
  fileSha256: string | null;
  signerDerSha256: string | null;
  winTrustCode: string | null;
};

// Main-controlled policy. No runtime env/settings/renderer/source-package trust inputs.
export const APPROVED_PLUGIN_PUBLISHER_DER_SHA256: readonly string[] = Object.freeze([]);
const sha256 = /^[a-f0-9]{64}$/;
const unknown = (): SignatureVerdict => ({
  v: 1,
  verdict: 'unknown',
  reason: 'helper',
  fileSha256: null,
  signerDerSha256: null,
  winTrustCode: null,
});

function parse(stdout: string, expected: string): SignatureVerdict {
  if (Buffer.byteLength(stdout, 'utf8') > 1024) return unknown();
  try {
    const text = stdout.trim();
    const raw: unknown = JSON.parse(text);
    // Canonical compact JSON disallows duplicate keys, trailing data and coercions.
    if (JSON.stringify(raw) !== text || !raw || typeof raw !== 'object' || Array.isArray(raw))
      return unknown();
    const item = raw as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(',') !==
      'fileSha256,reason,signerDerSha256,v,verdict,winTrustCode'
    )
      return unknown();
    if (
      item.v !== 1 ||
      typeof item.verdict !== 'string' ||
      !['valid', 'invalid', 'unknown'].includes(item.verdict)
    )
      return unknown();
    if (
      typeof item.reason !== 'string' ||
      ![
        'verified',
        'input',
        'file-type',
        'size',
        'hash-mismatch',
        'malformed-pe',
        'no-embedded-signature',
        'wintrust',
        'file-changed',
        'unavailable',
      ].includes(item.reason)
    )
      return unknown();
    if (
      item.fileSha256 !== null &&
      (typeof item.fileSha256 !== 'string' || !sha256.test(item.fileSha256))
    )
      return unknown();
    if (
      item.winTrustCode !== null &&
      (typeof item.winTrustCode !== 'string' || !/^[0-9a-f]{8}$/.test(item.winTrustCode))
    )
      return unknown();
    if (item.verdict === 'valid') {
      if (
        item.reason !== 'verified' ||
        item.fileSha256 !== expected ||
        item.winTrustCode !== '00000000' ||
        typeof item.signerDerSha256 !== 'string' ||
        !sha256.test(item.signerDerSha256)
      )
        return unknown();
    } else {
      if (item.signerDerSha256 !== null || item.reason === 'verified') return unknown();
      if (
        item.fileSha256 !== null &&
        item.fileSha256 !== expected &&
        item.reason !== 'hash-mismatch'
      )
        return unknown();
    }
    return item as SignatureVerdict;
  } catch {
    return unknown();
  }
}

/** Main only. Never execute, import or load the inspected file. */
export async function verifyPluginSignature(
  path: string,
  expectedSha256: string,
): Promise<SignatureVerdict> {
  if (platform() !== 'win32') return { ...unknown(), verdict: 'unsupported', reason: 'platform' };
  if (
    typeof path !== 'string' ||
    !win32.isAbsolute(path) ||
    path.includes('\0') ||
    path.length > 32760 ||
    typeof expectedSha256 !== 'string' ||
    !sha256.test(expectedSha256)
  )
    return { ...unknown(), verdict: 'invalid', reason: 'input' };
  const base = app.isPackaged ? `${app.getAppPath()}.unpacked` : app.getAppPath();
  const helper = join(base, 'dist/native/plugin-signature.exe');
  return new Promise((resolve) => {
    try {
      execFile(
        helper,
        [path, expectedSha256],
        { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 1024, encoding: 'utf8' },
        (error, stdout) => {
          resolve(error ? unknown() : parse(stdout, expectedSha256));
        },
      );
    } catch {
      resolve(unknown());
    }
  });
}

/** Pins must come from approved main-owned policy; this function does not create trust. */
export function evaluatePublisherTrust(
  verdict: SignatureVerdict,
  approvedDerSha256Pins: readonly string[],
): boolean {
  return (
    approvedDerSha256Pins.length > 0 &&
    approvedDerSha256Pins.length <= 32 &&
    approvedDerSha256Pins.every((pin) => typeof pin === 'string' && sha256.test(pin)) &&
    verdict.v === 1 &&
    verdict.verdict === 'valid' &&
    verdict.reason === 'verified' &&
    verdict.winTrustCode === '00000000' &&
    typeof verdict.fileSha256 === 'string' &&
    sha256.test(verdict.fileSha256) &&
    typeof verdict.signerDerSha256 === 'string' &&
    sha256.test(verdict.signerDerSha256) &&
    approvedDerSha256Pins.includes(verdict.signerDerSha256)
  );
}
