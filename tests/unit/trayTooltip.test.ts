import { describe, expect, it } from 'vitest';
import { TRAY_TOOLTIP_LIMIT, trayTooltip } from '../../src/main/desktop/trayTooltip';
import type { WorkTimer } from '../../src/shared/time';

const now = Date.parse('2026-11-05T10:00:00Z');
const timer = (state: 'run' | 'pause', mark = 'АР1', title = 'Планы этажей'): WorkTimer => ({
  version: 1,
  state,
  pauseReason: state === 'pause' ? 'manual' : null,
  task: { id: 1, kind: 'album', albumId: 1, mark, title, place: 'Объект А' },
  segments: [{ from: '2026-11-05T08:48:00Z', to: state === 'run' ? null : '2026-11-05T10:00:00Z' }],
  startedAt: '2026-11-05T08:48:00Z',
  updatedAt: '2026-11-05T08:48:00Z',
  serverNow: '2026-11-05T10:00:00Z',
});
const base = {
  online: true,
  signedIn: true,
  unread: 3,
  timer: null,
  focusUntil: null,
  now,
};

describe('подсказка значка трея (ТЗ 4.1)', () => {
  it('2–4 строки: непрочитанное, таймер, «Фокус до …»', () => {
    const focusUntil = new Date(now + 3600000).toISOString();
    const tip = trayTooltip({ ...base, timer: timer('run'), timerObservedAt: now, focusUntil });
    const lines = tip.split('\n');
    expect(lines[0]).toBe('Schema Teams');
    expect(lines[1]).toBe('Непрочитанных: 3');
    expect(lines[2]).toBe('▶ АР1 · 1:12');
    expect(lines[3]).toMatch(/^Фокус до \d{2}:\d{2}$/);
    expect(lines).toHaveLength(4);
  });
  it('пауза таймера, задача без марки, без фокуса — три строки', () => {
    const tip = trayTooltip({
      ...base,
      unread: 0,
      timer: timer('pause', ''),
      timerObservedAt: now,
    });
    expect(tip.split('\n')).toEqual(['Schema Teams', 'Нет непрочитанных', '⏸ Планы этажей · 1:12']);
  });
  it('нет связи и выход — короткие подсказки', () => {
    expect(trayTooltip({ ...base, online: false })).toBe('Schema Teams\nНет связи');
    expect(trayTooltip({ ...base, signedIn: false })).toBe('Schema Teams\nВойдите в Schema Teams');
  });
  it('истёкший фокус не показывается', () => {
    const tip = trayTooltip({ ...base, focusUntil: new Date(now - 1000).toISOString() });
    expect(tip).not.toContain('Фокус');
  });
  it('не длиннее 127 символов: укорачивается название задачи, время остаётся', () => {
    const tip = trayTooltip({
      ...base,
      unread: 120,
      timer: timer('run', '', 'Очень длинное название задачи '.repeat(10)),
      timerObservedAt: now,
      focusUntil: new Date(now + 60000).toISOString(),
    });
    expect(tip.length).toBeLessThanOrEqual(TRAY_TOOLTIP_LIMIT);
    expect(tip).toContain('… · 1:12');
    expect(tip).toMatch(/Фокус до \d{2}:\d{2}$/);
  });
});
