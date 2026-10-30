import type { DesktopRelease } from '../../shared/updates';
import { releaseVersionValid } from '../../shared/updates';
import { InvalidData, object } from './parse';
/** Metadata only. A server manifest never grants permission to execute its file. */
export function desktopRelease(raw: unknown): DesktopRelease {
  const x = object(raw);
  if (
    !releaseVersionValid(x.version) ||
    typeof x.notes !== 'string' ||
    x.notes.length > 10000 ||
    typeof x.file !== 'string' ||
    x.file.length < 1 ||
    x.file.length > 200 ||
    x.file.trim() !== x.file ||
    /[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}]/u.test(x.file) ||
    !/^.+\.exe$/i.test(x.file) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(x.file) ||
    typeof x.sha256 !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(x.sha256) ||
    typeof x.size !== 'number' ||
    !Number.isSafeInteger(x.size) ||
    x.size <= 0 ||
    x.size > 512 * 1024 * 1024 ||
    x.url !== `/api/desktop/files/${encodeURIComponent(x.file)}`
  )
    throw new InvalidData();
  return {
    version: x.version,
    notes: x.notes,
    file: x.file,
    sha256: x.sha256.toLowerCase(),
    size: x.size,
    url: x.url,
  };
}
