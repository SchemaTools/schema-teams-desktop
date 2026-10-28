import type { NotificationSettings } from '../../shared/client';

/**
 * Обычные сообщения: часовая политика серверного dispatcher.inQuietHours
 * (Schema Teams 0.11.2, f176f763). Он использует Bureau.timezone, не часы ПК.
 * Этот пояс не входит в GET /api/notification-settings, auth/me или health.
 * Пока он неизвестен, ненулевая тишина не разрешает popup. Фокус, системный
 * DND и локальный notifications.enabled проверяет владелец приложения.
 */
export function notificationAllowed(
  settings: NotificationSettings | null,
  now = Date.now(),
  bureauTimeZone: string | null = null,
): boolean {
  if (!settings || !Number.isFinite(now)) return false;
  if (settings.quiet === null) return true;
  const quiet = settings.quiet;
  if (
    !quiet ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.from) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.to)
  )
    return false;
  const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const from = minutesOf(quiet.from),
    to = minutesOf(quiet.to);
  // Серверный helper считает одинаковые границы выключенной тишиной.
  if (from === to) return true;
  if (!bureauTimeZone) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: bureauTimeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const hours = parts.find((part) => part.type === 'hour')?.value;
    const minute = parts.find((part) => part.type === 'minute')?.value;
    if (hours === undefined || minute === undefined) return false;
    const minutes = Number(hours) * 60 + Number(minute);
    if (!Number.isFinite(minutes)) return false;
    const quietNow = from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
    return !quietNow;
  } catch {
    return false;
  }
}
