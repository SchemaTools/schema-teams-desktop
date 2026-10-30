import { drawMark, GRAPHITE, WHITE, type Bitmap, type Rgba } from '../mark';

const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
  '!': ['010', '010', '010', '000', '010'],
};
const RED: Rgba = [209, 49, 65, 255];
const AMBER: Rgba = [238, 183, 67, 255];
function pixel(bitmap: Bitmap, x: number, y: number, color: Rgba) {
  if (x >= 0 && y >= 0 && x < bitmap.width && y < bitmap.height)
    bitmap.data.set(color, (y * bitmap.width + x) * 4);
}
function circle(bitmap: Bitmap, x: number, y: number, radius: number, color: Rgba) {
  for (let py = 0; py < bitmap.height; py++)
    for (let px = 0; px < bitmap.width; px++) {
      if ((px + 0.5 - x) ** 2 + (py + 0.5 - y) ** 2 <= radius ** 2) pixel(bitmap, px, py, color);
    }
}
function label(bitmap: Bitmap, value: string, x: number, y: number, scale: number, color: Rgba) {
  for (let i = 0; i < value.length; i++) {
    const glyph = GLYPHS[value[i] ?? ''];
    if (!glyph) continue;
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 3; col++)
        if (glyph[row]?.[col] === '1') {
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++)
              pixel(
                bitmap,
                Math.floor(x + (i * 4 + col) * scale + dx),
                Math.floor(y + row * scale + dy),
                color,
              );
        }
  }
}
export interface IconState {
  count: number;
  online: boolean;
  focus: boolean;
  timer: 'idle' | 'run' | 'pause';
}
export function statusBitmap(size: number, dark: boolean, state: IconState): Bitmap {
  const bitmap = drawMark(size, dark ? WHITE : GRAPHITE);
  const scale = size / 16;
  if (!state.online) {
    for (let i = 0; i < bitmap.data.length; i += 4) {
      const gray = Math.round(
        (((bitmap.data[i] ?? 0) + (bitmap.data[i + 1] ?? 0) + (bitmap.data[i + 2] ?? 0)) / 3) *
          0.65,
      );
      bitmap.data[i] = gray;
      bitmap.data[i + 1] = gray;
      bitmap.data[i + 2] = gray;
    }
    circle(bitmap, 11.5 * scale, 11.5 * scale, 4.5 * scale, AMBER);
    label(bitmap, '!', 10 * scale, 9 * scale, Math.max(1, Math.floor(scale)), GRAPHITE);
    return bitmap;
  }
  if (state.focus) {
    circle(bitmap, 4 * scale, 4 * scale, 4 * scale, GRAPHITE);
    circle(bitmap, 4 * scale, 4 * scale, 2.8 * scale, AMBER);
    circle(bitmap, 5.3 * scale, 3 * scale, 2.4 * scale, GRAPHITE);
  }
  if (state.count > 0) {
    const value = state.count > 9 ? '9+' : String(state.count);
    circle(bitmap, 11.5 * scale, 4.5 * scale, 4.5 * scale, RED);
    label(
      bitmap,
      value,
      (11.5 - (value.length * 4 - 1) / 2) * scale,
      2 * scale,
      Math.max(1, Math.floor(scale)),
      WHITE,
    );
  }
  if (state.timer !== 'idle') {
    circle(bitmap, 3.5 * scale, 12.5 * scale, 3.5 * scale, GRAPHITE);
    circle(
      bitmap,
      3.5 * scale,
      12.5 * scale,
      2.5 * scale,
      state.timer === 'run' ? [46, 204, 143, 255] : AMBER,
    );
  }
  return bitmap;
}
export function badgeBitmap(count: number): Bitmap {
  const bitmap: Bitmap = { width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4) };
  circle(bitmap, 8, 8, 8, RED);
  const value = count > 9 ? '9+' : String(Math.max(0, count));
  label(bitmap, value, (16 - (value.length * 4 - 1) * 2) / 2, 3, 2, WHITE);
  return bitmap;
}
