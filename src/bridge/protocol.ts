// Мост для настольного приложения Schema Teams Desktop (версия 0.10.0, раздел 1; ТЗ приложения,
// раздел 3). Приложение передаёт странице объект `window.schemaDesktop` (contextBridge) с
// методами `send(event, data)` и `on(command, handler)`. Без него веб работает как обычно.
//
// Этот файл — договор: тот же файл копируется в репозиторий приложения
// (`src/bridge/protocol.ts`). При несовпадении старшей части версии протокола приложение
// показывает полосу «Приложение устарело — обновите» и работает только как окно.

/** Версия протокола «старшая.младшая»: старшая меняется при несовместимых изменениях. */
// 1.1 — у notify необязательное поле taskId для кнопки «▶ Начать работу» (startTimer)
export const DESKTOP_PROTOCOL_VERSION = '1.1';

/** Старшая часть версии протокола: «1.0» → 1. */
export function desktopProtocolMajor(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '', 10);
}

// ---------- страница → приложение: события ----------

/** Кнопки уведомления (ТЗ приложения, 5.3). */
export type DesktopNotifyButton = 'reply' | 'open' | 'read' | 'startTimer';

/** Что отметить прочитанным по кнопке «Прочитано» — те же данные, что у команды markRead. */
export type DesktopReadTarget =
  { kind: 'chat'; chatId: number; messageId: number } | { kind: 'notification'; id: number };

export interface DesktopNotify {
  /**
   * Ключ уведомления: повторное `notify` с тем же ключом заменяет показанное (несколько
   * сообщений одного чата за минуту — одно уведомление со счётчиком).
   */
  key: string;
  /**
   * message — сообщение в чате; mention — @упоминание; notification — строка колокольчика;
   * focusSummary — сводка «Пока вы были в фокусе».
   */
  kind: 'message' | 'mention' | 'notification' | 'focusSummary';
  title: string;
  text: string;
  /** «Фамилия И.О.» автора; null — система. */
  author: string | null;
  /** Ссылка Teams для «Открыть» и щелчка: `/chat/<id>?m=<id>`, `/albums/<id>` … */
  link: string | null;
  /** Для быстрого ответа: разговор и сообщение; иначе null. */
  chatId: number | null;
  messageId: number | null;
  /** Сколько событий собрано в уведомлении (1 — одно). */
  count: number;
  buttons: DesktopNotifyButton[];
  /** Для «Прочитано»; null — кнопки нет. */
  read: DesktopReadTarget | null;
  /**
   * Задача для «▶ Начать работу» (кнопка startTimer, протокол 1.1): приложение шлёт команду
   * `timer` {action: 'start', taskId}. Нет кнопки — поля нет или null.
   */
  taskId?: number | null;
}

/** Таймер учёта времени (раздел 2 постановки 0.10.0). */
export interface DesktopTimer {
  state: 'idle' | 'run' | 'pause';
  task: { id: number; mark: string | null; title: string } | null;
  startedAt: string | null;
  elapsedSec: number;
  /** Причина паузы: lock — блокировка компьютера, manual — вручную; иначе null. */
  reason: 'lock' | 'manual' | null;
}

/** Ответ приложения на openPath (ТЗ приложения, 6.2). */
export type DesktopOpenPathResult = 'ok' | 'unavailable' | 'blocked';

export interface DesktopEvents {
  /** Связь установлена: после загрузки `/api/auth/me`. */
  hello: {
    protocol: string;
    user: { id: number; shortName: string };
    /** Версия сервера Teams (как в `GET /api/health`). */
    serverVersion: string;
  };
  /** Выход или закрытая сессия. */
  signedOut: Record<string, never>;
  /** Непрочитанное: чат и колокольчик. */
  counters: { chat: number; notifications: number };
  notify: DesktopNotify;
  /** Таймер изменился: при каждом изменении таймера учёта времени (раздел 2). */
  timer: DesktopTimer;
  /** «Фокус»: до какого времени; null — выключен. */
  focus: { until: string } | null;
  connection: 'online' | 'offline';
  /** Открыть путь `\\сервер\…`; reveal — «Показать в папке». Ответ — DesktopOpenPathResult. */
  openPath: { path: string; reveal: boolean };
}

export type DesktopEventName = keyof DesktopEvents;

// ---------- приложение → страница: команды ----------

/**
 * Команды идемпотентны по `requestId`: повтор после обрыва не дублирует сообщение и запись
 * (у `reply` он уходит на сервер заголовком `Idempotency-Key`).
 */
export interface DesktopCommands {
  /** Переход по ссылке Teams роутером страницы. */
  navigate: { requestId: string; link: string };
  /** Отправить сообщение в разговор. */
  reply: { requestId: string; chatId: number; text: string };
  /** Прочитано: чат до сообщения или уведомление колокольчика. */
  markRead: { requestId: string } & DesktopReadTarget;
  /**
   * Таймер: start (нужен taskId) / pause (at — время события, с ним причина «компьютер
   * заблокирован») / resume / stop — открыть окно «Записать в трудозатраты».
   */
  timer: {
    requestId: string;
    action: 'start' | 'pause' | 'resume' | 'stop';
    taskId?: number;
    /** Время события (ISO), например начало блокировки компьютера. */
    at?: string;
  };
  /** Включить «Фокус» до времени (ISO) или выключить (null). */
  focus: { requestId: string; until: string | null };
  /** Окно приложения видно и в фокусе — страница учитывает при решении о notify. */
  windowState: { requestId?: string; visible: boolean; focused: boolean };
}

export type DesktopCommandName = keyof DesktopCommands;

/** Ответ страницы на команду: ok или текст ошибки для пользователя. */
export type DesktopCommandResult = { ok: true } | { ok: false; error: string };

/** То, что приложение кладёт в `window.schemaDesktop`. */
export interface DesktopBridge {
  /** Событие страницы; для openPath приложение возвращает Promise<DesktopOpenPathResult>. */
  send(event: DesktopEventName, data: unknown): unknown;
  /** Подписка на команду; обработчик возвращает Promise<DesktopCommandResult>. */
  on(command: DesktopCommandName, handler: (data: unknown) => Promise<DesktopCommandResult>): void;
}

// ---------- сервер: ключ идемпотентности и версия приложения ----------

/**
 * Заголовок ключа идемпотентности для `POST /api/chats/:id/messages`: повтор с тем же ключом
 * в течение суток возвращает уже созданное сообщение и второе не создаёт.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Сколько сервер помнит ключ идемпотентности. */
export const IDEMPOTENCY_KEEP_MS = 24 * 60 * 60 * 1000;
/** Ключ: 8–100 знаков — латиница, цифры, «-», «_», «.», «:». */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

/** `GET /api/desktop/latest` — последняя версия приложения (доступно и без входа). */
export interface DesktopLatest {
  version: string;
  notes: string;
  /** Имя файла установщика в папке `data/desktop/`. */
  file: string;
  sha256: string;
  size: number;
  /** Откуда скачать: `/api/desktop/files/<file>`. */
  url: string;
}
