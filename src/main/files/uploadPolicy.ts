/** Server 0.11.2 attachment limits plus Windows executable/active-file restrictions. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const FORBIDDEN = new Set([
  'exe',
  'msi',
  'bat',
  'cmd',
  'com',
  'scr',
  'ps1',
  'vbs',
  'vbe',
  'js',
  'mjs',
  'jse',
  'jar',
  'dll',
  'hta',
  'wsf',
  'html',
  'htm',
  'xhtml',
  'svg',
  'svgz',
  'lnk',
  'reg',
  'cpl',
  'url',
  'scf',
  'pif',
  'appref-ms',
  'application',
  'appx',
  'appxbundle',
  'msix',
  'msixbundle',
  'msu',
  'msp',
  'sct',
  'wsh',
  'psc1',
  'msc',
  'gadget',
  'psm1',
  'py',
  'pyw',
  'sh',
  'bash',
  'pl',
  'rb',
  'chm',
  'diagcab',
  'search-ms',
]);

export function validateUpload(name: unknown, bytes: unknown, mime: unknown): string | null {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 200 ||
    name.trim() !== name ||
    name.endsWith('.') ||
    name === '.' ||
    name === '..' ||
    /[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}]/u.test(name) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/iu.test(
      (name.split('.')[0] ?? '').trimEnd(),
    ) ||
    !(bytes instanceof Uint8Array) ||
    bytes.length === 0 ||
    bytes.length > MAX_UPLOAD_BYTES ||
    typeof mime !== 'string' ||
    mime.length > 200 ||
    /[\r\n]/.test(mime)
  )
    return null;
  const dot = name.lastIndexOf('.');
  if (
    dot >= 0 &&
    FORBIDDEN.has(
      name
        .slice(dot + 1)
        .toUpperCase()
        .toLowerCase(),
    )
  )
    return null;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if ((b[0] === 0x4d && b[1] === 0x5a) || (b[0] === 0x7f && b.toString('ascii', 1, 4) === 'ELF'))
    return null;
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) {
    const length = (b[26] ?? 0) | ((b[27] ?? 0) << 8);
    if (b.toString('latin1', 30, 30 + Math.min(length, 64)).startsWith('META-INF/')) return null;
  }
  const head = b
    .subarray(0, 1024)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (
    head.startsWith('#!') ||
    /^<(?:!doctype html|html|script|svg)/.test(head) ||
    (head.startsWith('<?xml') && head.includes('<svg'))
  )
    return null;
  // Never trust a renderer or OS-provided MIME. Only known raster signatures select an image type.
  if (
    b.length >= 24 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    b.toString('ascii', 12, 16) === 'IHDR'
  )
    return 'image/png';
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 10 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)))
    return 'image/gif';
  if (
    b.length >= 16 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return 'application/octet-stream';
}
