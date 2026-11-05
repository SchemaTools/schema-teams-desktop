import { REALTIME_EVENTS } from './realtime/events';
import { auditPlugin, type PluginAudit } from './plugins/audit';
import { validateUncPath } from './paths/validate';
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
  'плагины',
  'ошибка обновления',
  'пропущены данные сервера',
  'тихие часы не проверены',
  'хранилище сброшено',
  'записи паузы удалены',
  'не удалось сохранить недавние задачи',
  'не удалось сохранить таймер этого компьютера',
] as const;
// Мягкий разбор (ТЗ 3.3): только вид пропущенного элемента, без содержимого.
const SKIPPED = new Set(['chat', 'message', 'reaction', 'file', 'link', 'card', 'mention']);
const QUIET_REASONS = new Set(['settings_unavailable', 'no_timezone', 'invalid_settings']);
// Испорченный файл состояния отправлен в карантин (ТЗ 13): только имя хранилища.
const STORES = new Set(['pause-outbox', 'pause-returns', 'support-ledger']);
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
// Необработанные ошибки (ТЗ, 13): имя и сообщение, без стека. Стек почти всегда содержит
// пути профиля и установки, а для разбора хватает имени, сообщения и соседних записей.
const UNHANDLED = new Set(['необработанная ошибка', 'необработанный отказ', 'запуск не удался']);
const MAX_ERROR_MESSAGE = 300;
/**
 * Сообщение ошибки для журнала: одна строка, не длиннее 300 знаков; путь профиля
 * (`C:\Users\<имя>`), значения вида `cookie=…`, `token: …` и строки запросов
 * в адресах маскируются. Повторное применение ничего не меняет — та же проекция
 * используется для старых записей в «Сообщить о проблеме».
 */
export function maskErrorMessage(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ')
    .replace(
      /\b([A-Za-z]:[\x5C/]+(?:Users|Documents and Settings)[\x5C/]+)(?!<user>)[^\x5C/\s'"]+/giu,
      '$1<user>',
    )
    .replace(
      /\b([\w-]*(?:cookie|session|token|csrf|password|passwd|secret|authorization)[\w-]*)(\s*[=:]\s*)(?!<скрыто>)[^\s;,'"]+/giu,
      '$1$2<скрыто>',
    )
    .replace(/(https?:\/\/[^\s?#'"]*)[?#](?!<скрыто>)[^\s'"]*/giu, '$1?<скрыто>')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE);
}
const UPDATE_CODE = /^(?:update|download)_[a-z_]{1,40}$/;
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
    if (raw && safeMessage === 'плагины')
      auditPlugin(
        (event) => {
          for (const [key, value] of Object.entries(event))
            if (typeof value === 'string') details[key] = value;
          if (event.buildId !== undefined) details.buildId = String(event.buildId);
        },
        raw as unknown as PluginAudit,
      );
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
      if (
        ['invalid-or-closed', 'foreign-host-declined', 'foreign-host-confirmed'].includes(
          String(raw.reason),
        )
      )
        details.reason = String(raw.reason);
      // ТЗ, 7.2: «путь, результат» — только путь, прошедший правила UNC, без содержимого.
      const path = typeof raw.path === 'string' ? validateUncPath(raw.path) : null;
      if (path) details.path = path;
    }
    if (raw && safeMessage === 'ошибка обновления') {
      if (raw.stage === 'prepare' || raw.stage === 'launch') details.stage = raw.stage;
      if (typeof raw.code === 'string')
        details.code =
          UPDATE_CODE.test(raw.code) || raw.code === 'stale_update' ? raw.code : 'update_failed';
    }
    if (raw && safeMessage === 'пропущены данные сервера' && SKIPPED.has(String(raw.kind)))
      details.kind = String(raw.kind);
    if (raw && safeMessage === 'тихие часы не проверены' && QUIET_REASONS.has(String(raw.reason)))
      details.reason = String(raw.reason);
    if (raw && safeMessage === 'хранилище сброшено' && STORES.has(String(raw.store)))
      details.store = String(raw.store);
    if (
      raw &&
      safeMessage === 'записи паузы удалены' &&
      typeof raw.count === 'string' &&
      /^[1-9][0-9]{0,3}$/.test(raw.count)
    )
      details.count = raw.count;
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
      // Сообщение — только у объекта Error: отказ строкой или объектом может нести любые данные.
      const text = raw.err instanceof Error ? raw.err.message : raw.errorMessage;
      if (UNHANDLED.has(safeMessage) && typeof text === 'string') {
        const masked = maskErrorMessage(text);
        if (masked) details.errorMessage = masked;
      }
    }
  } catch {
    /* A malformed object/getter must not break business work or disclose arbitrary data. */
  }
  return { message: safeMessage, details };
}
