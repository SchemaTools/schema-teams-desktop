// Размер и положение окна (ТЗ, 4.3): запоминаются, с поправкой, если монитор отключили.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds?: Rect;
  maximized?: boolean;
}

export const DEFAULT_SIZE = { width: 1280, height: 820 };
export const MIN_SIZE = { width: 800, height: 560 };
/** Сколько окна должно оставаться на мониторе, чтобы его можно было схватить за заголовок */
const MIN_VISIBLE = 100;

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

/**
 * Подбирает положение окна по сохранённому и текущим мониторам (рабочие области).
 * Окно, ушедшее за пределы всех мониторов, ставится по центру основного.
 */
export function fitBounds(saved: Rect | undefined, workAreas: Rect[], primary: Rect): Rect {
  const center = (area: Rect, w: number, h: number): Rect => {
    const width = Math.min(w, area.width);
    const height = Math.min(h, area.height);
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    };
  };
  if (!saved || !isRect(saved)) return center(primary, DEFAULT_SIZE.width, DEFAULT_SIZE.height);
  const width = Math.max(MIN_SIZE.width, saved.width);
  const height = Math.max(MIN_SIZE.height, saved.height);
  const rect = { ...saved, width, height };
  // заголовок окна (верхняя полоса) должен быть виден хотя бы на одном мониторе
  const titleBar: Rect = { x: rect.x, y: rect.y, width: rect.width, height: 32 };
  const visible = workAreas.some((a) => {
    const o = overlap(titleBar, a);
    return o.w >= MIN_VISIBLE && o.h > 0;
  });
  if (visible) return rect;
  return center(primary, width, height);
}

export function isRect(v: unknown): v is Rect {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(
    (k) => typeof r[k] === 'number' && Number.isFinite(r[k]),
  );
}
