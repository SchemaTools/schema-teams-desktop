// Знак Schema для значков: два наложенных контурных квадрата, вариант «Пересечение»
// (Брендинг бюро, schema-mark-*.svg): обе рамки видны целиком, без заливки. Задний квадрат —
// слева внизу, передний — справа вверху. Рисуется на лету (ТЗ, 4.1), без файлов картинок и
// внешних библиотек: покрытие пикселя считается точно (площадь пересечения с рамкой), края
// гладкие, фон прозрачный. На мелких размерах линии выравниваются по пиксельной сетке.

export type Rgba = readonly [number, number, number, number];

export const ELECTRIC: Rgba = [0x1b, 0x3f, 0xd1, 0xff];
export const GRAPHITE: Rgba = [0x1a, 0x1d, 0x21, 0xff];
export const WHITE: Rgba = [0xff, 0xff, 0xff, 0xff];
/** Передний квадрат на тёмном фоне (schema-mark-dark.svg). */
export const ELECTRIC_ON_DARK: Rgba = [0x5b, 0x7b, 0xff, 0xff];

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, построчно сверху вниз */
  data: Buffer;
}

/**
 * - `primary` — графит и электрик (schema-mark-primary.svg), на светлом фоне;
 * - `dark` — белый и #5B7BFF (schema-mark-dark.svg), на тёмном фоне;
 * - `mono` — один цвет (`color`, по умолчанию графит), как schema-mark-ui-mono-*.svg;
 * - `tile` — плитка электрик с белым знаком (schema-mark-ui-on-electric.svg), значок приложения.
 */
export type MarkVariant = 'primary' | 'dark' | 'mono' | 'tile';

/** Геометрия на сетке 100: отступ внешнего края рамки, сторона по внешнему краю, толщина линии. */
interface Geometry {
  margin: number;
  side: number;
  line: number;
}
// schema-mark-primary.svg: stroke 6.1453, x 3.0726, w 69.2737
const PRIMARY: Geometry = { margin: 0, side: 69.2737 + 6.1453, line: 6.1453 };
// schema-mark-ui-mono-*.svg: stroke 9.1892, x 4.5946, w 67.0270 — для размеров до 32 px
const UI: Geometry = { margin: 0, side: 67.027 + 9.1892, line: 9.1892 };
// schema-mark-ui-on-electric.svg: stroke 6.6162, x 17.3081, w 48.2595
const TILE: Geometry = { margin: 17.3081 - 6.6162 / 2, side: 48.2595 + 6.6162, line: 6.6162 };

/** Размер, до которого включительно берётся толстая геометрия UI. */
export const UI_MAX_SIZE = 32;
/** До этого размера края рамок выравниваются по целым пикселям. */
const SNAP_MAX_SIZE = 64;

/**
 * Плитка на 16 и 20 px подобрана вручную по образцам: при пропорциях SVG рамки в одну точку
 * с шагом 3 px сливаются в «три вложенных квадрата». Здесь линия толще, знак крупнее,
 * шаг 4 px — как у толстой геометрии UI. Отступ, сторона и линия — в пикселях.
 */
const TILE_HINTED: Readonly<Record<number, Geometry>> = {
  16: { margin: 1, side: 10, line: 2 },
  20: { margin: 2, side: 12, line: 2 },
};

/** Рамка в пикселях: внешний квадрат (левый верхний угол и сторона) и толщина линии. */
export interface Frame {
  x: number;
  y: number;
  side: number;
  line: number;
}

/** Задний (слева внизу) и передний (справа вверху) квадраты знака для размера `size`. */
export function markFrames(size: number, variant: MarkVariant): { back: Frame; front: Frame } {
  const hinted = variant === 'tile' ? TILE_HINTED[size] : undefined;
  if (hinted) return frames(size, hinted.margin, hinted.side, hinted.line);
  const g = variant === 'tile' ? TILE : size <= UI_MAX_SIZE ? UI : PRIMARY;
  const k = size / 100;
  let margin = g.margin * k;
  let side = g.side * k;
  let line = g.line * k;
  if (size <= SNAP_MAX_SIZE) {
    margin = Math.round(margin);
    side = Math.round(side);
    // UI-линия на 16–24 px — 1,5–2,2 px; в одну точку выглядит тонко, берём не меньше двух
    line = Math.max(variant !== 'tile' && size <= UI_MAX_SIZE ? 2 : 1, Math.round(line));
  }
  return frames(size, margin, side, line);
}

function frames(
  size: number,
  margin: number,
  side: number,
  line: number,
): { back: Frame; front: Frame } {
  const offset = size - 2 * margin - side;
  return {
    back: { x: margin, y: margin + offset, side, line },
    front: { x: margin + offset, y: margin, side, line },
  };
}

export function drawMark(size: number, variant: MarkVariant = 'primary', color?: Rgba): Bitmap {
  const [back, front, background] = palette(variant, color);
  const { back: b, front: f } = markFrames(size, variant);
  // премультиплицированные значения 0..1, слои — фон, задний квадрат, передний
  const acc = new Float64Array(size * size * 4);
  const paint = (i: number, c: Rgba, cover: number) => {
    if (cover <= 0) return;
    const a = (c[3] / 255) * cover;
    for (let ch = 0; ch < 3; ch++)
      acc[i + ch] = ((c[ch] as number) / 255) * a + (acc[i + ch] as number) * (1 - a);
    acc[i + 3] = a + (acc[i + 3] as number) * (1 - a);
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (background) paint(i, background, 1);
      paint(i, back, frameCoverage(b, x, y));
      paint(i, front, frameCoverage(f, x, y));
    }
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < acc.length; i += 4) {
    const a = acc[i + 3] as number;
    if (a <= 0) continue;
    for (let ch = 0; ch < 3; ch++)
      data[i + ch] = Math.round(Math.min(1, (acc[i + ch] as number) / a) * 255);
    data[i + 3] = Math.round(Math.min(1, a) * 255);
  }
  return { width: size, height: size, data };
}

function palette(variant: MarkVariant, color?: Rgba): [Rgba, Rgba, Rgba | null] {
  switch (variant) {
    case 'dark':
      return [WHITE, ELECTRIC_ON_DARK, null];
    case 'mono':
      return [color ?? GRAPHITE, color ?? GRAPHITE, null];
    case 'tile':
      return [WHITE, WHITE, ELECTRIC];
    default:
      return [GRAPHITE, ELECTRIC, null];
  }
}

/** Доля пикселя (x, y), закрытая рамкой: внешний квадрат минус внутренний. */
function frameCoverage(f: Frame, x: number, y: number): number {
  const outer = rectCoverage(f.x, f.y, f.x + f.side, f.y + f.side, x, y);
  if (outer <= 0) return 0;
  const inner = rectCoverage(
    f.x + f.line,
    f.y + f.line,
    f.x + f.side - f.line,
    f.y + f.side - f.line,
    x,
    y,
  );
  return Math.max(0, outer - inner);
}

function rectCoverage(x0: number, y0: number, x1: number, y1: number, px: number, py: number) {
  if (x1 <= x0 || y1 <= y0) return 0;
  const w = Math.min(px + 1, x1) - Math.max(px, x0);
  const h = Math.min(py + 1, y1) - Math.max(py, y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Размеры значка приложения (build/icon.ico и значок окна). */
export const APP_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256] as const;

/** Значок приложения: плитка электрик с белым знаком — видна на светлой и тёмной панели задач. */
export function appIconBitmaps(): Bitmap[] {
  return APP_ICON_SIZES.map((size) => drawMark(size, 'tile'));
}

/** Знак трея: одноцветный, белый на тёмной панели задач и графитовый на светлой. */
export function trayMark(size: number, darkTaskbar: boolean): Bitmap {
  return drawMark(size, 'mono', darkTaskbar ? WHITE : GRAPHITE);
}

/**
 * Знак для страниц главного процесса (уведомление, заглушки окна) — встроенный SVG по
 * schema-mark-ui-mono-*.svg: толстая линия для 12–18 px. Цвета рамок задаёт CSS страницы
 * через классы `b` (задний квадрат) и `f` (передний).
 */
export function markSvg(className: string): string {
  return (
    `<svg class="${className}" viewBox="0 0 100 100" aria-hidden="true">` +
    '<g fill="none" stroke-width="9.1892">' +
    '<rect class="b" x="4.5946" y="28.3784" width="67.027" height="67.027"/>' +
    '<rect class="f" x="28.3784" y="4.5946" width="67.027" height="67.027"/>' +
    '</g></svg>'
  );
}
