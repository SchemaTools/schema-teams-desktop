// Значки из знака Schema (mark.ts) в виде nativeImage.
import { nativeImage, type NativeImage } from 'electron';
import { drawMark, GRAPHITE, WHITE } from './mark';
import { encodePng } from './png';

/** Значок трея: 16 px и крупнее для масштабов Windows 125–200 %. */
export function trayImage(darkTaskbar: boolean): NativeImage {
  const img = nativeImage.createEmpty();
  for (const [scaleFactor, size] of [
    [1, 16],
    [1.25, 20],
    [1.5, 24],
    [2, 32],
  ] as const) {
    const png = encodePng(drawMark(size, darkTaskbar ? WHITE : GRAPHITE));
    img.addRepresentation({ scaleFactor, width: size, height: size, buffer: png });
  }
  return img;
}

/** Значок окна (заголовок и панель задач при запуске без установщика). */
export function windowImage(): NativeImage {
  return nativeImage.createFromBuffer(encodePng(drawMark(256, GRAPHITE)));
}
