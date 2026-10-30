import { REALTIME_EVENTS } from './realtime/events';
export const LOG_MESSAGES = [
  'запуск',
  'выход',
  'ошибка завершения клиента',
  'необработанная ошибка',
  'необработанный отказ',
  'запуск не удался',
  'cookie не сохранены',
  'не удалось сохранить день напоминания',
  'событие клиента',
  'неподдержанное событие чата',
  'неподдержанное уведомление',
  'не удалось восстановить настройку автозапуска',
  'локальное окно не загружено',
  'открытие пути',
  'архив диагностики сохранён',
  'состояние соединения',
  'команда таймера',
  'событие исключено',
] as const;
const states = new Set([
  'noServer',
  'connecting',
  'online',
  'offline',
  'signedOut',
  'passwordChange',
  'incompatible',
]);
const commands = new Set(['start', 'pause', 'resume', 'extend', 'reset', 'finish']);
const codes = new Set([
  'network',
  'timeout',
  'invalid_data',
  'payload_too_large',
  'unauthenticated',
  'password_change_required',
  'forbidden',
  'not_found',
  'read_only',
  'validation',
  'bad_request',
  'csrf',
  'idempotency_conflict',
  'stale_session',
  'server_error',
  'no_timer',
  'timer_running',
  'timer_changed',
  'timer_busy',
  'stale_timer',
  'stale_timer_segment',
  'precondition_required',
  'prepared_expired',
  'invalid_event_time',
  'timer_day_start',
  'other',
]);
const errors = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
]);
export interface LogProjection {
  message: string;
  details: Record<string, string | boolean>;
}
/** One policy for new disk records and legacy records selected for a report.
 * Unknown messages/fields and raw exception text never become log content. */
export function projectLog(message: string, raw?: Record<string, unknown>): LogProjection {
  const safeMessage = (LOG_MESSAGES as readonly string[]).includes(message)
    ? message
    : 'событие исключено';
  const details: LogProjection['details'] = {};
  try {
    if (raw && safeMessage === 'запуск') {
      for (const key of ['app', 'electron', 'chrome', 'windows']) {
        const value = raw[key];
        if (
          typeof value === 'string' &&
          value.length <= 64 &&
          /^\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.-]{1,32})?$/.test(value)
        )
          details[key] = value;
      }
      for (const key of ['packaged', 'hidden'])
        if (typeof raw[key] === 'boolean') details[key] = raw[key];
    }
    if (raw && safeMessage === 'открытие пути') {
      if (['ok', 'unavailable', 'blocked'].includes(String(raw.result)))
        details.result = String(raw.result);
      if (raw.reason === 'invalid-or-closed') details.reason = raw.reason;
    }
    if (
      raw &&
      safeMessage === 'событие клиента' &&
      typeof raw.event === 'string' &&
      (REALTIME_EVENTS as readonly string[]).includes(raw.event)
    )
      details.event = raw.event;
    if (
      raw &&
      safeMessage === 'состояние соединения' &&
      typeof raw.state === 'string' &&
      states.has(raw.state)
    )
      details.state = raw.state;
    if (raw && safeMessage === 'команда таймера') {
      if (typeof raw.command === 'string' && commands.has(raw.command))
        details.command = raw.command;
      if (raw.phase === 'requested' || raw.phase === 'result') details.phase = raw.phase;
      if (['ok', 'rejected', 'uncertain'].includes(String(raw.outcome)))
        details.outcome = String(raw.outcome);
      if (typeof raw.code === 'string') details.code = codes.has(raw.code) ? raw.code : 'other';
    }
    if (
      raw &&
      [
        'необработанная ошибка',
        'необработанный отказ',
        'запуск не удался',
        'cookie не сохранены',
        'ошибка завершения клиента',
      ].includes(safeMessage)
    ) {
      const name = raw.err instanceof Error ? raw.err.name : raw.errorType;
      if (typeof name === 'string') details.errorType = errors.has(name) ? name : 'Error';
    }
  } catch {
    /* A malformed object/getter must not break business work or disclose arbitrary data. */
  }
  return { message: safeMessage, details };
}
