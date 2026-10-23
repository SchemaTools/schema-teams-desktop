// Проверяем IPC в главном процессе: TypeScript не проверяет данные страницы во время работы.
import type { DesktopEvents, DesktopEventName, DesktopNotify, DesktopTimer } from './protocol';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const text = (value: unknown, max = 2000): value is string =>
  typeof value === 'string' && value.length <= max;
const id = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
const nullableId = (value: unknown) => value === null || id(value);
const iso = (value: unknown) => text(value, 100) && Number.isFinite(Date.parse(value));

export function teamsLink(link: unknown): link is string {
  if (
    !text(link) ||
    !link.startsWith('/') ||
    link.startsWith('//') ||
    link.includes('\\') ||
    Array.from(link).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
    return false;
  try {
    return new URL(link, 'https://example.com').origin === 'https://example.com';
  } catch {
    return false;
  }
}

export function notifyValid(value: unknown): value is DesktopNotify {
  if (!record(value)) return false;
  if (!text(value.key, 200) || value.key === '' || !text(value.title) || !text(value.text, 32000))
    return false;
  if (
    typeof value.kind !== 'string' ||
    !['message', 'mention', 'notification', 'focusSummary'].includes(value.kind)
  )
    return false;
  if (!(value.author === null || text(value.author, 500))) return false;
  if (!(value.link === null || teamsLink(value.link))) return false;
  if (!nullableId(value.chatId) || !nullableId(value.messageId) || !count(value.count))
    return false;
  if (!Array.isArray(value.buttons) || value.buttons.length > 4) return false;
  if (!value.buttons.every((button) => ['reply', 'open', 'read', 'startTimer'].includes(button)))
    return false;
  if (new Set(value.buttons).size !== value.buttons.length) return false;
  if (value.buttons.includes('reply') && !id(value.chatId)) return false;
  if (value.buttons.includes('startTimer') && !id(value.taskId)) return false;
  if (value.buttons.includes('read') && value.read === null) return false;
  if (value.read !== null) {
    if (!record(value.read)) return false;
    if (value.read.kind === 'chat') {
      if (!id(value.read.chatId) || !id(value.read.messageId)) return false;
    } else if (value.read.kind !== 'notification' || !id(value.read.id)) return false;
  }
  return value.taskId === undefined || nullableId(value.taskId);
}

export function timerValid(value: unknown): value is DesktopTimer {
  if (!record(value) || !['idle', 'run', 'pause'].includes(String(value.state))) return false;
  if (
    value.task !== null &&
    (!record(value.task) ||
      !id(value.task.id) ||
      !text(value.task.title) ||
      !(value.task.mark === null || text(value.task.mark, 100)))
  )
    return false;
  return (
    (value.startedAt === null || iso(value.startedAt)) &&
    count(value.elapsedSec) &&
    [null, 'lock', 'manual'].includes(value.reason as null | string)
  );
}

export function eventValid<E extends DesktopEventName>(
  name: E,
  value: unknown,
): value is DesktopEvents[E] {
  switch (name) {
    case 'hello':
      return (
        record(value) &&
        text(value.protocol, 30) &&
        /^\d+\.\d+$/.test(value.protocol) &&
        record(value.user) &&
        id(value.user.id) &&
        text(value.user.shortName, 500) &&
        text(value.serverVersion, 100)
      );
    case 'signedOut':
      return record(value) && Object.keys(value).length === 0;
    case 'counters':
      return record(value) && count(value.chat) && count(value.notifications);
    case 'notify':
      return notifyValid(value);
    case 'timer':
      return timerValid(value);
    case 'focus':
      return value === null || (record(value) && iso(value.until));
    case 'connection':
      return value === 'online' || value === 'offline';
    case 'openPath':
      return record(value) && text(value.path, 32000) && typeof value.reveal === 'boolean';
    default:
      return false;
  }
}
