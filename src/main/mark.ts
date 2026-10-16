// Знак Schema для значков: квадрат, разделённый по диагонали (макет, класс .mk).
// Левый верхний треугольник — белый на тёмной панели задач и графитовый на светлой,
// правый нижний — электрик. Рисуется на лету (ТЗ, 4.1), без файлов картинок.

export type Rgba = readonly [number, number, number, number];

export const ELECTRIC: Rgba = [0x1b, 0x3f, 0xd1, 0xff];
export const GRAPHITE: Rgba = [0x1a, 0x1d, 0x21, 0xff];
export const WHITE: Rgba = [0xff, 0xff, 0xff, 0xff];

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, построчно сверху вниз */
  data: Buffer;
}

export function drawMark(size: number, light: Rgba): Bitmap {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // центр пикселя относительно диагонали из правого верхнего угла в левый нижний
      const d = x + 0.5 + (y + 0.5) - size;
      let c: Rgba;
      if (Math.abs(d) < 0.5) {
        // пиксель на диагонали — смешиваем, чтобы край не был ступенькой
        const t = d + 0.5;
        c = mix(light, ELECTRIC, t);
      } else {
        c = d < 0 ? light : ELECTRIC;
      }
      data.set(c, (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const m = (i: 0 | 1 | 2 | 3) => Math.round(a[i] * (1 - t) + b[i] * t);
  return [m(0), m(1), m(2), m(3)];
}
