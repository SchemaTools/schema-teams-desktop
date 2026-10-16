// Простейший кодировщик PNG (RGBA, 8 бит) и упаковка в ICO — для значков трея и установщика.
import { deflateSync } from 'node:zlib';
import type { Bitmap } from './mark';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

export function encodePng(bmp: Bitmap): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(bmp.width, 0);
  ihdr.writeUInt32BE(bmp.height, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  const stride = bmp.width * 4;
  const raw = Buffer.alloc((stride + 1) * bmp.height);
  for (let y = 0; y < bmp.height; y++) {
    raw[y * (stride + 1)] = 0; // фильтр «нет»
    bmp.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO с картинками PNG внутри (Windows Vista и новее) */
export function encodeIco(images: Bitmap[]): Buffer {
  const pngs = images.map(encodePng);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // тип — значок
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((img, i) => {
    const png = pngs[i] as Buffer;
    const o = i * 16;
    dir[o] = img.width >= 256 ? 0 : img.width;
    dir[o + 1] = img.height >= 256 ? 0 : img.height;
    dir.writeUInt16LE(1, o + 4); // плоскости
    dir.writeUInt16LE(32, o + 6); // бит на пиксель
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...pngs]);
}
