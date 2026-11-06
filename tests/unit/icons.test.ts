import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { statusBitmap } from '../../src/main/desktop/statusBitmap';
import {
  APP_ICON_SIZES,
  appIconBitmaps,
  drawMark,
  ELECTRIC,
  ELECTRIC_ON_DARK,
  GRAPHITE,
  markFrames,
  markSvg,
  trayMark,
  WHITE,
  type Bitmap,
} from '../../src/main/mark';
import { encodeIco, encodePng } from '../../src/main/png';

const px = (b: Bitmap, x: number, y: number) => [
  ...b.data.subarray((y * b.width + x) * 4, (y * b.width + x) * 4 + 4),
];
const TRANSPARENT = [0, 0, 0, 0];
/** Точка на сетке знака 100 × 100 → пиксель. */
const at = (b: Bitmap, gx: number, gy: number) =>
  px(b, Math.floor((gx / 100) * b.width), Math.floor((gy / 100) * b.height));

describe('знак «Пересечение»: два контурных квадрата', () => {
  it('primary 256: задний — графит слева внизу, передний — электрик справа вверху', () => {
    const b = drawMark(256, 'primary');
    // левая сторона заднего квадрата (x 0–6,1) и нижняя (y 93,9–100)
    expect(at(b, 3, 60)).toEqual([...GRAPHITE]);
    expect(at(b, 40, 97)).toEqual([...GRAPHITE]);
    // правая сторона переднего (x 93,9–100) и верхняя (y 0–6,1)
    expect(at(b, 97, 40)).toEqual([...ELECTRIC]);
    expect(at(b, 60, 3)).toEqual([...ELECTRIC]);
    // передний квадрат поверх заднего на пересечениях линий
    expect(at(b, 27.6, 27.6)).toEqual([...ELECTRIC]);
    expect(at(b, 72.3, 72.3)).toEqual([...ELECTRIC]);
    // без заливки: середина пересечения и пустые углы прозрачны
    expect(at(b, 50, 50)).toEqual(TRANSPARENT);
    expect(at(b, 3, 3)).toEqual(TRANSPARENT);
    expect(at(b, 97, 97)).toEqual(TRANSPARENT);
    // внутри каждого квадрата вне пересечения — тоже прозрачно
    expect(at(b, 15, 85)).toEqual(TRANSPARENT);
    expect(at(b, 85, 15)).toEqual(TRANSPARENT);
  });

  it('primary 256: геометрия по schema-mark-primary.svg', () => {
    const { back, front } = markFrames(256, 'primary');
    const k = 256 / 100;
    expect(back.line).toBeCloseTo(6.1453 * k, 3);
    expect(back.x).toBeCloseTo(0, 3);
    expect(back.y).toBeCloseTo((27.6536 - 6.1453 / 2) * k, 2);
    expect(back.side).toBeCloseTo((69.2737 + 6.1453) * k, 2);
    expect(front.x).toBeCloseTo(back.y, 6);
    expect(front.y).toBeCloseTo(0, 3);
  });

  it('края гладкие: на крупном размере есть полупрозрачные пиксели', () => {
    const b = drawMark(256, 'primary');
    let partial = 0;
    for (let i = 3; i < b.data.length; i += 4) {
      const a = b.data[i] ?? 0;
      if (a > 0 && a < 255) partial++;
    }
    expect(partial).toBeGreaterThan(0);
  });

  it('dark: задний белый, передний #5B7BFF', () => {
    const b = drawMark(256, 'dark');
    expect(at(b, 3, 60)).toEqual([...WHITE]);
    expect(at(b, 97, 40)).toEqual([...ELECTRIC_ON_DARK]);
    expect(at(b, 50, 50)).toEqual(TRANSPARENT);
  });

  it('mono 16: толстая линия UI в 2 px, один цвет, середина пересечения пустая', () => {
    const b = drawMark(16, 'mono', WHITE);
    // задний квадрат x 0–12, y 4–16; передний x 4–16, y 0–12; линия 2 px
    expect(px(b, 0, 10)).toEqual([...WHITE]);
    expect(px(b, 1, 10)).toEqual([...WHITE]);
    expect(px(b, 2, 10)).toEqual(TRANSPARENT);
    expect(px(b, 15, 6)).toEqual([...WHITE]);
    expect(px(b, 14, 6)).toEqual([...WHITE]);
    expect(px(b, 13, 6)).toEqual(TRANSPARENT);
    expect(px(b, 8, 8)).toEqual(TRANSPARENT);
    expect(px(b, 0, 0)).toEqual(TRANSPARENT);
    expect(px(b, 15, 15)).toEqual(TRANSPARENT);
    for (let i = 0; i < b.data.length; i += 4)
      if (b.data[i + 3]) expect([...b.data.subarray(i, i + 4)]).toEqual([...WHITE]);
  });

  it.each([16, 20, 24, 32])('%i px: линии по пиксельной сетке, без мыла', (size) => {
    for (const b of [drawMark(size, 'mono'), drawMark(size, 'primary'), drawMark(size, 'tile')])
      for (let i = 3; i < b.data.length; i += 4) expect([0, 255]).toContain(b.data[i]);
  });

  it('до 32 px — толще основной линии, крупнее — основная', () => {
    expect(markFrames(32, 'mono').back.line).toBe(3);
    expect(markFrames(256, 'mono').back.line).toBeCloseTo(6.1453 * 2.56, 3);
    expect(markFrames(16, 'primary').back.line).toBe(2);
  });

  it('tile: плитка электрик без прозрачности, белые рамки, внутри — фон', () => {
    for (const size of [16, 32, 256]) {
      const b = drawMark(size, 'tile');
      expect(px(b, 0, 0)).toEqual([...ELECTRIC]);
      expect(px(b, size - 1, size - 1)).toEqual([...ELECTRIC]);
      expect(at(b, 50, 50)).toEqual([...ELECTRIC]);
      for (let i = 3; i < b.data.length; i += 4) expect(b.data[i]).toBe(255);
    }
    const b = drawMark(256, 'tile');
    // левая сторона заднего квадрата: x 14–20,6, передний — правая сторона x 79,4–86
    expect(at(b, 17.3, 60)).toEqual([...WHITE]);
    expect(at(b, 82.7, 40)).toEqual([...WHITE]);
    expect(at(b, 7, 7)).toEqual([...ELECTRIC]);
  });

  it('tile 16: обе рамки видны, шаг 4 px', () => {
    const { back, front } = markFrames(16, 'tile');
    expect(front.x - back.x).toBe(4);
    expect(back.y - front.y).toBe(4);
    const b = drawMark(16, 'tile');
    expect(px(b, back.x, back.y + back.side - 1)).toEqual([...WHITE]);
    expect(px(b, front.x + front.side - 1, front.y)).toEqual([...WHITE]);
  });
});

describe('значки приложения и трея', () => {
  it('значок приложения — плитка во всех размерах ICO', () => {
    const icons = appIconBitmaps();
    expect(icons.map((b) => b.width)).toEqual([...APP_ICON_SIZES]);
    expect(APP_ICON_SIZES).toEqual([16, 20, 24, 32, 40, 48, 64, 256]);
    for (const b of icons) expect(px(b, 0, 0)).toEqual([...ELECTRIC]);
  });

  it('трей: белый на тёмной панели задач, графит на светлой', () => {
    expect(px(trayMark(16, true), 0, 10)).toEqual([...WHITE]);
    expect(px(trayMark(16, false), 0, 10)).toEqual([...GRAPHITE]);
    expect(px(trayMark(16, true), 8, 8)).toEqual(TRANSPARENT);
  });

  it('счётчик трея рисуется поверх знака', () => {
    const b = statusBitmap(16, true, { count: 3, online: true, focus: false, timer: 'idle' });
    expect(px(b, 8, 4)).toEqual([209, 49, 65, 255]);
    expect(px(b, 11, 4)).toEqual([...WHITE]);
    expect(px(b, 0, 10)).toEqual([...WHITE]);
  });

  it('знак для страниц — два контурных квадрата', () => {
    const svg = markSvg('mark');
    expect(svg.match(/<rect /g)).toHaveLength(2);
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('class="b" x="4.5946" y="28.3784"');
    expect(svg).toContain('class="f" x="28.3784" y="4.5946"');
  });
});

describe('PNG и ICO', () => {
  it('PNG с верной подписью, размером и данными', () => {
    const png = encodePng(drawMark(16, 'tile'));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(16);
    expect(png.readUInt32BE(20)).toBe(16);
    const idatLen = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString('ascii')).toBe('IDAT');
    expect(inflateSync(png.subarray(41, 41 + idatLen)).length).toBe((16 * 4 + 1) * 16);
  });
  it('ICO: заголовок и каталог, 256 записывается как 0', () => {
    const ico = encodeIco([drawMark(16, 'tile'), drawMark(256, 'tile')]);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico[6]).toBe(16);
    expect(ico[6 + 16]).toBe(0);
    const off = ico.readUInt32LE(6 + 16 + 12);
    expect(ico.subarray(off + 1, off + 4).toString('ascii')).toBe('PNG');
  });
});
