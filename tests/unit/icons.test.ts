import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { drawMark, ELECTRIC, WHITE } from '../../src/main/mark';
import { encodeIco, encodePng } from '../../src/main/png';

describe('знак', () => {
  it('левый верхний угол — светлый, правый нижний — электрик', () => {
    const b = drawMark(16, WHITE);
    const px = (x: number, y: number) => [
      ...b.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4),
    ];
    expect(px(0, 0)).toEqual([...WHITE]);
    expect(px(15, 15)).toEqual([...ELECTRIC]);
  });
});

describe('PNG и ICO', () => {
  it('PNG с верной подписью, размером и данными', () => {
    const png = encodePng(drawMark(16, WHITE));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(16);
    expect(png.readUInt32BE(20)).toBe(16);
    const idatLen = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    expect(inflateSync(png.subarray(41, 41 + idatLen)).length).toBe((16 * 4 + 1) * 16);
  });
  it('ICO: заголовок и каталог, 256 записывается как 0', () => {
    const ico = encodeIco([drawMark(16, WHITE), drawMark(256, WHITE)]);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico[6]).toBe(16);
    expect(ico[6 + 16]).toBe(0);
    const off = ico.readUInt32LE(6 + 16 + 12);
    expect(ico.subarray(off + 1, off + 4).toString('ascii')).toBe('PNG');
  });
});
