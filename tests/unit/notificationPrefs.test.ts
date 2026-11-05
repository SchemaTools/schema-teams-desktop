import { describe, expect, it, vi } from 'vitest';
import { notificationAllowed, quietDecision } from '../../src/main/api/notificationPrefs';
import { notificationSettings } from '../../src/main/api/parse';
import { TeamsApi } from '../../src/main/api/client';
import type { NotificationSettings } from '../../src/shared/client';

const base: NotificationSettings = {
  rows: [{ key: 'chat_mention', inApp: false }],
  digestHourly: false,
  quiet: { from: '19:00', to: '08:00' },
};
describe('тихие часы обычных сообщений: время бюро, не системный пояс ПК', () => {
  it.each([
    ['до начала', Date.UTC(2026, 9, 28, 13, 59), true],
    ['начало включительно', Date.UTC(2026, 9, 28, 14, 0), false],
    ['ночь', Date.UTC(2026, 9, 28, 20, 0), false],
    ['перед концом', Date.UTC(2026, 9, 29, 2, 59), false],
    ['конец исключительно', Date.UTC(2026, 9, 29, 3, 0), true],
  ] as const)('%s', (_label, now, allowed) =>
    expect(notificationAllowed(base, now, 'Asia/Yekaterinburg')).toBe(allowed),
  );
  it('дневной интервал и границы совпадают с серверным helper', () => {
    const settings = { ...base, quiet: { from: '12:00', to: '13:00' } };
    expect(notificationAllowed(settings, Date.UTC(2026, 9, 28, 11, 59), 'UTC')).toBe(true);
    expect(notificationAllowed(settings, Date.UTC(2026, 9, 28, 12), 'UTC')).toBe(false);
    expect(notificationAllowed(settings, Date.UTC(2026, 9, 28, 13), 'UTC')).toBe(true);
  });
  it('пояс меняет результат одного UTC-момента; не используется локальный new Date().getHours()', () => {
    const now = Date.UTC(2026, 9, 28, 15);
    expect(notificationAllowed(base, now, 'UTC')).toBe(true);
    expect(notificationAllowed(base, now, 'Asia/Yekaterinburg')).toBe(false);
  });
  it('оба вхождения повторённого часа при переходе DST подчиняются местному времени бюро', () => {
    const settings = { ...base, quiet: { from: '01:00', to: '02:00' } };
    expect(notificationAllowed(settings, Date.UTC(2026, 10, 1, 5, 30), 'America/New_York')).toBe(
      false,
    );
    expect(notificationAllowed(settings, Date.UTC(2026, 10, 1, 6, 30), 'America/New_York')).toBe(
      false,
    );
  });
  // Поведение изменено 05.11.2026 (ревью PR #6, Ч3): сбой проверки тишины не гасит
  // уведомление молча — показываем и сообщаем причину для журнала.
  it('unknown settings/TZ и неправильные часы показывают уведомление с причиной для журнала', () => {
    expect(quietDecision(null)).toEqual({ allowed: true, warning: 'settings_unavailable' });
    expect(quietDecision(base)).toEqual({ allowed: true, warning: 'no_timezone' });
    expect(quietDecision(base, Date.now(), 'Not/A_Time_Zone')).toEqual({
      allowed: true,
      warning: 'no_timezone',
    });
    expect(
      quietDecision({ ...base, quiet: { from: '24:00', to: '08:00' } }, Date.now(), 'UTC'),
    ).toEqual({ allowed: true, warning: 'invalid_settings' });
    expect(quietDecision(base, NaN, 'UTC')).toEqual({
      allowed: true,
      warning: 'invalid_settings',
    });
    expect(notificationAllowed(null)).toBe(true);
  });
  it('известная тишина подавляет без предупреждения', () => {
    expect(quietDecision(base, Date.UTC(2026, 9, 28, 20, 0), 'Asia/Yekaterinburg')).toEqual({
      allowed: false,
    });
  });
  it('quiet:null означает выключенную тишину; default19–08 не подставляется', () => {
    expect(notificationAllowed({ ...base, quiet: null }, Date.UTC(2026, 9, 28, 23))).toBe(true);
  });
  it('равные границы не являются круглосуточным запретом по серверной семантике', () => {
    expect(notificationAllowed({ ...base, quiet: { from: '09:00', to: '09:00' } })).toBe(true);
  });
  it('отключение chat_mention и digest не выдумывает отсутствующий флаг обычных сообщений', () => {
    expect(
      notificationAllowed({
        rows: [{ key: 'chat_mention', inApp: false }],
        digestHourly: true,
        quiet: null,
      }),
    ).toBe(true);
  });
});
describe('GET /api/notification-settings: неизменённая серверная схема', () => {
  it('проверяет обязательные поля и игнорирует будущие неизвестные поля', () => {
    expect(notificationSettings({ ...base, future: 'ignored' })).toEqual(base);
    for (const raw of [
      { ...base, rows: [{ key: 'chat_mention', inApp: 'no' }] },
      { ...base, digestHourly: undefined },
      { ...base, quiet: { from: '1:00', to: '08:00' } },
    ])
      expect(() => notificationSettings(raw)).toThrow();
  });
  it('публичный API-метод использует только точный GET и не раскрывает CSRF', async () => {
    const fetch = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { id: 1, shortName: 'Тест', mustChangePassword: false },
            csrfToken: 'private-test-csrf',
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(base)));
    const api = new TeamsApi({ fetch });
    await api.authenticate();
    const result = await api.notificationSettings();
    expect(result).toEqual({ ok: true, data: base });
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/notification-settings');
    expect(fetch.mock.calls[1]?.[1]?.method).toBe('GET');
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('x-csrf-token')).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-test-csrf');
  });
});
