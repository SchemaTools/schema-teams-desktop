import { describe, expect, it } from 'vitest';
import { DEFAULT_SIZE, fitBounds, MIN_SIZE } from '../../src/main/windowState';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1920, height: 1040 };

describe('fitBounds', () => {
  it('без сохранённого — по центру основного монитора', () => {
    expect(fitBounds(undefined, [primary], primary)).toEqual({
      x: (1920 - DEFAULT_SIZE.width) / 2,
      y: (1040 - DEFAULT_SIZE.height) / 2,
      ...DEFAULT_SIZE,
    });
  });
  it('сохранённое на месте — без изменений', () => {
    const saved = { x: 2000, y: 100, width: 1000, height: 700 };
    expect(fitBounds(saved, [primary, second], primary)).toEqual(saved);
  });
  it('второй монитор отключили — окно возвращается на основной', () => {
    const r = fitBounds({ x: 2000, y: 100, width: 1000, height: 700 }, [primary], primary);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(1920);
    expect(r.width).toBe(1000);
  });
  it('заголовок за верхним краем — окно возвращается', () => {
    const r = fitBounds({ x: 100, y: -500, width: 1000, height: 700 }, [primary], primary);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });
  it('слишком маленькое окно увеличивается до наименьшего размера', () => {
    const r = fitBounds({ x: 10, y: 10, width: 100, height: 50 }, [primary], primary);
    expect(r.width).toBe(MIN_SIZE.width);
    expect(r.height).toBe(MIN_SIZE.height);
  });
  it('окно больше монитора ужимается при переносе', () => {
    const small = { x: 0, y: 0, width: 1280, height: 680 };
    const r = fitBounds({ x: 5000, y: 0, width: 1800, height: 1000 }, [small], small);
    expect(r.width).toBeLessThanOrEqual(1280);
    expect(r.height).toBeLessThanOrEqual(680);
  });
});
