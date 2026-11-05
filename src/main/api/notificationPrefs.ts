import type { NotificationSettings } from '../../shared/client';

/** Почему тишину не удалось проверить; уведомление при этом показывается (fail-open). */
export type QuietWarning = 'settings_unavailable' | 'no_timezone' | 'invalid_settings';
export interface QuietDecision {
  allowed: boolean;
  warning?: QuietWarning;
}

/**
 * Тихие часы для событий, где сервер сам не ставит `quiet` (старый сервер без
 * capability chatQuiet, локальные сводки). Часовая политика повторяет серверный
 * dispatcher.inQuietHours (Schema Teams 0.11.2, f176f763): время бюро
 * (Bureau.timezone из /api/desktop/config), не часы ПК.
 *
 * Сбой чтения настроек, неизвестный пояс или негодные часы не гасят уведомление
 * молча: показываем и сообщаем причину для журнала (ТЗ 5.2, решение 05.11.2026).
 * Фокус, системный DND и локальный notifications.enabled проверяет владелец приложения.
 */
export function quietDecision(
  settings: NotificationSettings | null,
  now = Date.now(),
  bureauTimeZone: string | null = null,
): QuietDecision {
  if (!settings) return { allowed: true, warning: 'settings_unavailable' };
  if (settings.quiet === null) return { allowed: true };
  const quiet = settings.quiet;
  if (
    !quiet ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.from) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.to) ||
    !Number.isFinite(now)
  )
    return { allowed: true, warning: 'invalid_settings' };
  const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const from = minutesOf(quiet.from),
    to = minutesOf(quiet.to);
  // Серверный helper считает одинаковые границы выключенной тишиной.
  if (from === to) return { allowed: true };
  if (!bureauTimeZone) return { allowed: true, warning: 'no_timezone' };
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: bureauTimeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const hours = parts.find((part) => part.type === 'hour')?.value;
    const minute = parts.find((part) => part.type === 'minute')?.value;
    const minutes = Number(hours) * 60 + Number(minute);
    if (hours === undefined || minute === undefined || !Number.isFinite(minutes))
      return { allowed: true, warning: 'no_timezone' };
    const quietNow = from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
    return { allowed: !quietNow };
  } catch {
    return { allowed: true, warning: 'no_timezone' };
  }
}

/** Краткая форма для проверок: показывать ли уведомление сейчас. */
export function notificationAllowed(
  settings: NotificationSettings | null,
  now = Date.now(),
  bureauTimeZone: string | null = null,
): boolean {
  return quietDecision(settings, now, bureauTimeZone).allowed;
}
