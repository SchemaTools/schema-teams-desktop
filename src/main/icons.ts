// Значки из знака Schema (mark.ts) в виде nativeImage.
import { app, nativeImage, type NativeImage } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appIconBitmaps, drawMark, trayMark } from './mark';
import { encodeIco, encodePng } from './png';

/** Масштабы Windows 100–200 % и размер значка трея для каждого. */
export const TRAY_SCALES = [
  [1, 16],
  [1.25, 20],
  [1.5, 24],
  [2, 32],
] as const;

/** Значок трея: одноцветный знак, 16 px и крупнее для масштабов Windows 125–200 %. */
export function trayImage(darkTaskbar: boolean): NativeImage {
  const img = nativeImage.createEmpty();
  for (const [scaleFactor, size] of TRAY_SCALES) {
    const png = encodePng(trayMark(size, darkTaskbar));
    img.addRepresentation({ scaleFactor, width: size, height: size, buffer: png });
  }
  return img;
}

let windowIcon: NativeImage | null = null;

/**
 * Значок окна (заголовок и панель задач) — плитка, как у exe. На Windows — из файла ICO со всеми
 * размерами: Electron берёт из ICO готовые 16 и 32 px, а картинку 256 px Windows сжимает в мыло.
 */
export function windowImage(): NativeImage {
  if (windowIcon) return windowIcon;
  if (process.platform === 'win32') {
    try {
      const file = join(app.getPath('userData'), 'window-icon.ico');
      writeFileSync(file, encodeIco(appIconBitmaps()));
      const ico = nativeImage.createFromPath(file);
      if (!ico.isEmpty()) return (windowIcon = ico);
    } catch {
      // нет записи в профиль — ниже картинка без ICO
    }
  }
  return (windowIcon = notificationImage());
}

/** Значок приложения в системных уведомлениях Windows. */
export function notificationImage(): NativeImage {
  return nativeImage.createFromBuffer(encodePng(drawMark(256, 'tile')));
}
