import { isAbsolute } from 'node:path';
import { lstat } from 'node:fs/promises';
import { lstatSync, type BigIntStats } from 'node:fs';
import { hashFile } from '../plugins/fsSafe';
import { windowsPathSafe } from '../plugins/safety';
import {
  evaluatePublisherTrust,
  verifyDesktopSignature,
  type SignatureVerdict,
} from '../plugins/signature';
import {
  DESKTOP_MAX_BYTES,
  claimDesktopDownload,
  type DesktopDownloadReceipt,
} from './downloadDesktop';

/** Separate Desktop approval; a plugin certificate never grants update execution. */
export const APPROVED_DESKTOP_PUBLISHER_DER_SHA256: readonly string[] = Object.freeze([]);
export interface SignedDesktopFile {
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
  readonly signerDerSha256: string;
  readonly identity: Readonly<{ dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint }>;
}
export interface DesktopTrustOptions {
  publisherPins: readonly string[];
  current: () => boolean;
  signal?: AbortSignal;
  /** Main/test seams. Production uses fixed Windows helpers. */
  pathAllowed?: typeof windowsPathSafe;
  verify?: (path: string, hash: string) => Promise<SignatureVerdict>;
}
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function desktopPublisherConfigured(pins: readonly string[]): boolean {
  return pins.length > 0 && pins.length <= 32 && pins.every(sha);
}
/** Installer entrypoint binds trust to the producer's original identity, not a
 * newly observed replacement. Its lease also excludes cancellation cleanup.
 */
export async function inspectDownloadedDesktopFile(
  receipt: DesktopDownloadReceipt,
  options: DesktopTrustOptions,
): Promise<Readonly<SignedDesktopFile>> {
  const lease = claimDesktopDownload(receipt);
  if (!lease) throw Error('update_artifact_busy');
  try {
    return await inspectSignedDesktopFile(receipt.file, options, {
      size: receipt.bytes,
      sha256: receipt.sha256,
      identity: lease.identity,
    });
  } finally {
    lease.finish(false);
  }
}
/** Read-only identity fact, not a launch permission. Expected metadata is required for staged installers. */
export async function inspectSignedDesktopFile(
  path: string,
  options: DesktopTrustOptions,
  expected?: Readonly<{
    size: number;
    sha256: string;
    identity?: SignedDesktopFile['identity'];
  }>,
): Promise<Readonly<SignedDesktopFile>> {
  const pins = [...options.publisherPins],
    current = options.current,
    signal = options.signal,
    pathAllowed = options.pathAllowed ?? windowsPathSafe,
    verify = options.verify ?? verifyDesktopSignature,
    wanted = expected
      ? { ...expected, identity: expected.identity ? { ...expected.identity } : undefined }
      : undefined;
  const check = () => {
    if (signal?.aborted || current() !== true) throw Error('stale_update');
  };
  check();
  if (!desktopPublisherConfigured(pins)) throw Error('update_publisher_unconfigured');
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    path.includes('\0') ||
    path.length > 32760 ||
    (wanted &&
      (!sha(wanted.sha256) ||
        !Number.isSafeInteger(wanted.size) ||
        wanted.size < 1 ||
        wanted.size > DESKTOP_MAX_BYTES))
  )
    throw Error('update_file_invalid');
  if ((await pathAllowed(path)) !== true) throw Error('update_path_invalid');
  check();
  const before = await lstat(path, { bigint: true });
  check();
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > BigInt(DESKTOP_MAX_BYTES)
  )
    throw Error('update_file_invalid');
  const identity = Object.freeze({
    dev: before.dev,
    ino: before.ino,
    mtimeNs: before.mtimeNs,
    ctimeNs: before.ctimeNs,
  });
  if (
    wanted?.identity &&
    (wanted.identity.dev !== identity.dev ||
      wanted.identity.ino !== identity.ino ||
      wanted.identity.mtimeNs !== identity.mtimeNs ||
      wanted.identity.ctimeNs !== identity.ctimeNs)
  )
    throw Error('update_file_changed');
  const sameIdentity = async () => {
    const now = await lstat(path, { bigint: true });
    check();
    if (
      !now.isFile() ||
      now.isSymbolicLink() ||
      now.nlink !== 1n ||
      now.dev !== identity.dev ||
      now.ino !== identity.ino ||
      now.size !== before.size ||
      now.mtimeNs !== identity.mtimeNs ||
      now.ctimeNs !== identity.ctimeNs
    )
      throw Error('update_file_changed');
  };
  const bytes = await hashFile(path, DESKTOP_MAX_BYTES);
  check();
  await sameIdentity();
  if (wanted && (wanted.sha256 !== bytes.sha256 || wanted.size !== bytes.size))
    throw Error('update_file_changed');
  const signed = await verify(path, bytes.sha256);
  check();
  await sameIdentity();
  if (
    signed.fileSha256 !== bytes.sha256 ||
    !evaluatePublisherTrust(signed, pins) ||
    !sha(signed.signerDerSha256)
  )
    throw Error('update_signature_invalid');
  return Object.freeze({ file: path, ...bytes, signerDerSha256: signed.signerDerSha256, identity });
}
/** Both current signed baseline and installer must be re-read; no cached boolean grants trust. */
export async function revalidateDesktopPair(
  baseline: Readonly<SignedDesktopFile>,
  installer: Readonly<SignedDesktopFile>,
  options: DesktopTrustOptions,
): Promise<void> {
  baseline = { ...baseline, identity: { ...baseline.identity } };
  installer = { ...installer, identity: { ...installer.identity } };
  const captured = { ...options, publisherPins: [...options.publisherPins] };
  const installed = await inspectSignedDesktopFile(baseline.file, captured, baseline);
  if (installed.signerDerSha256 !== baseline.signerDerSha256)
    throw Error('update_baseline_changed');
  const staged = await inspectSignedDesktopFile(installer.file, captured, installer);
  if (
    staged.signerDerSha256 !== installer.signerDerSha256 ||
    installed.signerDerSha256 !== staged.signerDerSha256
  )
    throw Error('update_publisher_changed');
  // Both native awaits are complete. Re-observe both facts synchronously so
  // a mutation during verification of the other file cannot pass unnoticed.
  const stable = (fact: SignedDesktopFile, stat: BigIntStats) =>
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1n &&
    stat.dev === fact.identity.dev &&
    stat.ino === fact.identity.ino &&
    stat.size === BigInt(fact.size) &&
    stat.mtimeNs === fact.identity.mtimeNs &&
    stat.ctimeNs === fact.identity.ctimeNs;
  if (
    captured.signal?.aborted ||
    captured.current() !== true ||
    !stable(installed, lstatSync(installed.file, { bigint: true })) ||
    !stable(staged, lstatSync(staged.file, { bigint: true }))
  )
    throw Error('update_file_changed');
}
