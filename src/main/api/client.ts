import { randomUUID } from 'node:crypto';
import type {
  ApiResult,
  ChatDetail,
  ChatFile,
  ChatList,
  ChatMessage,
  ChatReaction,
  ChatSummary,
  FocusState,
  FocusSummary,
  Health,
  MessagePage,
  NotificationPage,
  NotificationItem,
  NotificationSettings,
  SafeUser,
  ObjectInfo,
} from '../../shared/client';
import { REACTION_KINDS } from '../../shared/client';
import { supportPayloadValid, type SupportPayload, type SupportReceipt } from '../../shared/report';
import type { MorningSummary } from '../../shared/morning';
import * as parse from './parse';
import * as time from './time';
import { desktopRelease } from './updates';
import { desktopConfig } from './desktopConfig';
import type { DesktopConfig } from '../../shared/desktopConfig';
import type { DesktopRelease } from '../../shared/updates';
import {
  expectedValid,
  matchesTimer,
  type TimerRowsCheck,
  positiveId,
  timerRowsValid,
  type WorkTimer,
  type TimeOptions,
  type TimerExpected,
  type TimerPrepared,
  type TimerRow,
} from '../../shared/time';
import { validateUpload } from '../files/uploadPolicy';

export interface TeamsApiOptions {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  onAuthLost?: () => void;
  onTimerAudit?: (audit: TimerAudit) => void;
}
export interface TimerAudit {
  command: 'start' | 'pause' | 'resume' | 'extend' | 'reset' | 'finish';
  phase: 'requested' | 'result';
  outcome?: 'ok' | 'rejected' | 'uncertain';
  code?: string;
}
export type MessageCursor = { before?: number; after?: number; around?: number };
type Raw = { status: number; body: unknown };
interface UploadBody {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
}
const REACTIONS = new Set<string>(REACTION_KINDS);
const DEADLINE = 15000;
const BODY_LIMIT = 2 * 1024 * 1024;
export const FILE_LIMIT = 50 * 1024 * 1024;
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ERROR_TEXT: Record<string, string> = {
  no_support_chat: 'Чат поддержки не настроен. Сохраните архив и передайте его администратору.',
  top_limit: 'Закрепить можно не больше 5 чатов.',
  network: 'Нет связи с сервером. Повторите действие после восстановления связи.',
  timeout: 'Сервер не подтвердил действие вовремя.',
  invalid_data: 'Сервер вернул неподдерживаемые данные.',
  payload_too_large: 'Ответ сервера слишком велик.',
  unauthenticated: 'Войдите в Schema Teams.',
  password_change_required: 'Сначала смените временный пароль в окне входа.',
  forbidden: 'Недостаточно прав для этого действия.',
  not_found: 'Разговор или сообщение недоступны.',
  read_only: 'В этот разговор нельзя отправить сообщение.',
  validation: 'Проверьте введённые данные.',
  bad_request: 'Запрос составлен неверно.',
  csrf: 'Не удалось обновить сеанс. Повторите действие.',
  idempotency_conflict: 'Ключ повтора уже занят другой отправкой.',
  stale_session: 'Вход изменился. Повторите действие из текущего окна.',
  server_error: 'Сервер временно не может выполнить действие.',
  invalid_file: 'Не удалось проверить файл. Повторите загрузку из актуального сообщения.',
  file_error: 'Не удалось сохранить или открыть файл. Проверьте доступ к папке «Загрузки».',
  busy: 'Дождитесь окончания загрузки файла.',
  forbidden_type: 'Такие файлы нельзя прикладывать. Положите файл в папку объекта.',
  too_large: 'Файл больше 50 МБ. Положите его в папку объекта.',
  no_timer: 'Таймер уже завершён. Обновите состояние.',
  timer_running: 'Сначала завершите текущую задачу.',
  timer_changed: 'Таймер изменился в другом окне. Обновите состояние и проверьте задачу.',
  timer_busy: 'Дождитесь завершения действия с таймером.',
  timer_day_start: 'Нельзя добавить 15 минут раньше начала дня бюро.',
  precondition_required: 'Сервер не подтвердил безопасное управление таймером. Обновите состояние.',
  stale_timer: 'Таймер изменился на другом устройстве. Обновите состояние.',
  stale_timer_segment: 'Интервал таймера изменился. Обновите состояние.',
  invalid_event_time: 'Сервер отклонил время события. Проверьте интервалы.',
  prepared_expired: 'Срок проверки истёк. Закройте проверку и подготовьте её заново.',
};
export function failure<T = never>(code: string, uncertain = false): ApiResult<T> {
  return {
    ok: false,
    code,
    error: ERROR_TEXT[code] ?? 'Сервер временно не может выполнить действие.',
    retryable: ['network', 'timeout', 'server_error'].includes(code),
    ...(uncertain && { uncertain: true }),
  };
}
class TransportError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Единственный API-клиент main. Ни одного произвольного HTTP-метода/URL из renderer. */
export class TeamsApi {
  private generation = 0;
  private user: SafeUser | null = null;
  private csrf: string | null = null;
  private readonly pending = new Set<AbortController>();
  private authFlight?: Promise<ApiResult<SafeUser>>;
  private timerFlight?: { epoch: number };
  private timerNow: string | null = null;
  get timerServerNow(): string | null {
    return this.timerNow;
  }
  private config: DesktopConfig | null = null;
  get desktopConfiguration(): DesktopConfig | null {
    return this.config ? structuredClone(this.config) : null;
  }
  get timerControl(): boolean {
    return (this.config?.capabilities.timerControl ?? 0) >= 2;
  }
  async readDesktopConfig(): Promise<ApiResult<DesktopConfig>> {
    const epoch = this.epoch,
      owner = this.owner;
    this.config = null;
    const result = await this.request('/api/desktop/config', 'GET', desktopConfig);
    if (epoch !== this.epoch || owner !== this.owner) return failure('stale_session');
    if (result.ok) this.config = result.data;
    return result;
  }
  constructor(private readonly o: TeamsApiOptions) {}
  get epoch(): number {
    return this.generation;
  }
  get owner(): number | null {
    return this.user?.id ?? null;
  }
  clear(): void {
    this.generation++;
    this.config = null;
    this.timerNow = null;
    this.prepared.clear();
    this.user = null;
    this.csrf = null;
    this.authFlight = undefined;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }
  authenticate(): Promise<ApiResult<SafeUser>> {
    if (this.authFlight) return this.authFlight;
    const epoch = this.generation;
    const flight = this.raw('/api/auth/me', 'GET', undefined, epoch)
      .then((result): ApiResult<SafeUser> => {
        if (epoch !== this.generation) return failure('stale_session');
        if (!result.ok) return result;
        if (result.data.status === 401) {
          this.authLost(epoch);
          return failure('unauthenticated');
        }
        if (result.data.status !== 200) return this.httpFailure(result.data, false);
        try {
          const current = parse.session(result.data.body);
          if (
            this.user &&
            (this.user.id !== current.user.id ||
              this.user.mustChangePassword !== current.user.mustChangePassword)
          )
            this.clear();
          this.user = current.user;
          this.csrf = current.csrf;
          return { ok: true, data: { ...current.user } };
        } catch {
          return failure('invalid_data');
        }
      })
      .finally(() => {
        if (this.authFlight === flight) this.authFlight = undefined;
      });
    this.authFlight = flight;
    return flight;
  }
  health(): Promise<ApiResult<Health>> {
    return this.request('/api/health', 'GET', parse.health, undefined, false, [200, 503]);
  }
  async latestRelease(): Promise<ApiResult<DesktopRelease | null>> {
    const epoch = this.epoch;
    const result = await this.raw('/api/desktop/latest', 'GET', undefined, epoch);
    if (!result.ok) return result;
    if (result.data.status === 404) {
      try {
        if (parse.object(parse.object(result.data.body).error).code === 'no_release')
          return { ok: true, data: null };
      } catch {
        /* A generic 404 is not an empty release feed. */
      }
    }
    if (result.data.status !== 200) return this.httpFailure(result.data, false);
    try {
      return { ok: true, data: desktopRelease(result.data.body) };
    } catch {
      return failure('invalid_data');
    }
  }
  listChats(): Promise<ApiResult<ChatList>> {
    return this.request('/api/chats', 'GET', parse.list);
  }
  timer(): Promise<ApiResult<WorkTimer | null>> {
    return this.request('/api/time/timer', 'GET', (raw) => {
      const timer = this.timerControl ? time.controlledTimer(raw) : time.workTimer(raw);
      this.timerNow = this.timerControl
        ? String(parse.object(raw).serverNow)
        : (timer?.serverNow ?? null);
      return timer;
    });
  }
  async timeOptions(q = ''): Promise<ApiResult<TimeOptions>> {
    if (typeof q !== 'string' || q.length > 200) return failure('validation');
    const epoch = this.epoch;
    const options = await this.request('/api/time/options', 'GET', time.timeOptions);
    if (!options.ok || !this.timerControl) return options;
    const list = await this.request(
      `/api/time/timer/pick-list${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`,
      'GET',
      (raw) => {
        const x = parse.object(raw);
        if (
          !Array.isArray(x.tasks) ||
          x.tasks.length > 10000 ||
          !Array.isArray(x.recent) ||
          x.recent.length > 3
        )
          throw new parse.InvalidData();
        return { tasks: x.tasks.map(time.timeTask), recent: x.recent.map(time.timeTask) };
      },
    );
    if (epoch !== this.epoch) return failure('stale_session');
    return list.ok
      ? {
          ok: true,
          data: {
            ...options.data,
            tasks: [
              ...new Map(
                [...list.data.recent, ...list.data.tasks].map((task) => [task.id, task]),
              ).values(),
            ],
            recentTaskIds: list.data.recent.map((t) => t.id),
          },
        }
      : list;
  }
  timerPending(deviceId: string): Promise<ApiResult<NotificationItem | null>> {
    return this.request(
      `/api/desktop/timer-notices/pending?deviceId=${encodeURIComponent(deviceId)}`,
      'GET',
      (raw) => {
        const x = parse.object(raw);
        if (x.item === null) return null;
        const item = parse.notification(x.item);
        if (item.event !== 'timer_stopped') throw new parse.InvalidData();
        return item;
      },
    );
  }
  timerNoticeAck(deviceId: string, notificationId: number): Promise<ApiResult<null>> {
    return this.request('/api/desktop/timer-notices/ack', 'POST', parse.acknowledged, {
      deviceId,
      notificationId,
    });
  }
  private prepared = new Map<string, { epoch: number; value: TimerPrepared; validated?: string }>();
  private async timerCommand<T>(
    action: TimerAudit['command'] | 'prepare-finish' | 'validate-rows',
    body: object,
    decode: (raw: unknown) => T,
    operationKey: string = randomUUID(),
  ): Promise<ApiResult<T>> {
    if (!this.timerControl) return failure('precondition_required');
    if (this.timerFlight?.epoch === this.epoch) return failure('timer_busy');
    const flight = { epoch: this.epoch },
      key = operationKey;
    this.timerFlight = flight;
    const path = '/api/time/timer' + (action === 'reset' ? '' : '/' + action);
    const method = action === 'reset' ? 'DELETE' : 'POST';
    const envelope = structuredClone(body);
    try {
      const boundDecode = (raw: unknown) => {
        if (action === 'prepare-finish' && parse.object(raw).requestId !== key)
          throw new parse.InvalidData();
        return decode(raw);
      };
      let result = await this.request(path, method, boundDecode, envelope, true, [200], key);
      // Only unknown transport outcomes may replay the exact same operation envelope.
      if (!result.ok && ['network', 'timeout'].includes(result.code) && flight.epoch === this.epoch)
        result = await this.request(path, method, boundDecode, envelope, true, [200], key);
      if (
        !result.ok &&
        ['network', 'timeout'].includes(result.code) &&
        action === 'prepare-finish' &&
        flight.epoch === this.epoch
      )
        result = await this.request(
          `/api/time/timer/prepared/${encodeURIComponent(key)}`,
          'GET',
          boundDecode,
        );
      return result;
    } finally {
      if (this.timerFlight === flight) this.timerFlight = undefined;
    }
  }
  private timerWrite(
    action: TimerAudit['command'],
    expected: TimerExpected | null,
    body: object = {},
    operationKey?: string,
  ): Promise<ApiResult<WorkTimer | null>> {
    if (expected !== null && !expectedValid(expected))
      return Promise.resolve(failure('validation'));
    const audit = (value: TimerAudit) => {
      try {
        this.o.onTimerAudit?.(value);
      } catch {
        /* diagnostics cannot change commands */
      }
    };
    audit({ command: action, phase: 'requested' });
    return this.timerCommand(
      action,
      { ...body, expected },
      (raw) => {
        const timer = time.controlledTimer(raw);
        if (action === 'reset' || action === 'finish' ? timer !== null : timer === null)
          throw new parse.InvalidData();
        if (
          timer &&
          ((action === 'pause' && timer.state !== 'pause') ||
            ((action === 'start' || action === 'resume') && timer.state !== 'run') ||
            (action !== 'start' && expected && timer.timerId !== expected.timerId) ||
            ('taskId' in body && timer.task.id !== body.taskId))
        )
          throw new parse.InvalidData();
        return timer;
      },
      operationKey,
    ).then((result) => {
      audit({
        command: action,
        phase: 'result',
        outcome: result.ok ? 'ok' : result.uncertain ? 'uncertain' : 'rejected',
        ...(!result.ok && { code: result.code }),
      });
      return result;
    });
  }
  timerStart(taskId: number, expected: TimerExpected | null): Promise<ApiResult<WorkTimer | null>> {
    if (!positiveId(taskId)) return Promise.resolve(failure('validation'));
    return this.timerWrite('start', expected, { taskId });
  }
  timerPause(
    expected: TimerExpected,
    at?: string,
    operationKey?: string,
  ): Promise<ApiResult<WorkTimer | null>> {
    return this.timerWrite(
      'pause',
      expected,
      at ? { reason: 'lock', at } : { reason: 'manual' },
      operationKey,
    );
  }
  timerResume(expected: TimerExpected): Promise<ApiResult<WorkTimer | null>> {
    return this.timerWrite('resume', expected);
  }
  timerExtend(expected: TimerExpected): Promise<ApiResult<WorkTimer | null>> {
    return this.timerWrite('extend', expected);
  }
  timerReset(expected: TimerExpected): Promise<ApiResult<WorkTimer | null>> {
    return this.timerWrite('reset', expected);
  }
  timerFinish(
    expected: TimerExpected,
    rows: TimerRow[],
    note: string,
    preparedRequestId?: string,
  ): Promise<ApiResult<WorkTimer | null>> {
    const preparation = preparedRequestId ? this.prepared.get(preparedRequestId) : undefined;
    if (
      !expectedValid(expected) ||
      !timerRowsValid(rows) ||
      typeof note !== 'string' ||
      note.length > 500 ||
      !preparation ||
      preparation.epoch !== this.epoch ||
      JSON.stringify(preparation.value.expected) !== JSON.stringify(expected) ||
      preparation.validated !== JSON.stringify(rows)
    )
      return Promise.resolve(failure('validation'));
    return this.timerWrite('finish', expected, {
      rows,
      note: note.trim() || null,
      preparedRequestId,
    });
  }
  async timerProposal(expected: TimerExpected): Promise<ApiResult<TimerPrepared>> {
    if (!expectedValid(expected)) return failure('validation');
    const current = await this.timer();
    if (!current.ok) return current;
    if (!current.data || !matchesTimer(current.data, expected)) return failure('timer_changed');
    const timer = current.data;
    const result = await this.timerCommand('prepare-finish', { expected }, (raw) =>
      time.preparedTimer(raw, timer),
    );
    if (result.ok) {
      if (
        JSON.stringify(result.data.expected) !== JSON.stringify(expected) ||
        result.data.proposal.task.id !== timer.task.id
      )
        return failure('invalid_data');
      this.prepared.set(result.data.requestId, { epoch: this.epoch, value: result.data });
      if (this.prepared.size > 100) {
        const oldest = this.prepared.keys().next().value;
        if (oldest) this.prepared.delete(oldest);
      }
    }
    return result;
  }
  async timerValidateRows(
    preparedRequestId: string,
    rows: TimerRow[],
  ): Promise<ApiResult<TimerRowsCheck>> {
    const prepared = this.prepared.get(preparedRequestId);
    if (!prepared || prepared.epoch !== this.epoch || !timerRowsValid(rows))
      return failure('validation');
    prepared.validated = undefined;
    const snapshot = structuredClone(rows);
    const result = await this.timerCommand(
      'validate-rows',
      { preparedRequestId, rows: snapshot },
      time.rowsCheck,
    );
    if (result.ok && result.data.ok && prepared.epoch === this.epoch)
      prepared.validated = JSON.stringify(snapshot);
    return result;
  }
  detail(chatId: number): Promise<ApiResult<ChatDetail>> {
    return this.validId(chatId)
      ? this.request(`/api/chats/${chatId}`, 'GET', (raw) => {
          const value = parse.detail(raw);
          if (value.chat.id !== chatId) throw new parse.InvalidData();
          return value;
        })
      : Promise.resolve(failure('validation'));
  }
  async objectInfo(chatId: number): Promise<ApiResult<ObjectInfo>> {
    const epoch = this.epoch,
      owner = this.owner;
    const detail = await this.detail(chatId);
    if (epoch !== this.epoch || owner !== this.owner) return failure('stale_session');
    if (!detail.ok) return detail;
    const objectId = detail.data.chat.objectId;
    if (detail.data.chat.kind !== 'object' || objectId === null) return failure('validation');
    return this.request(`/api/objects/${objectId}`, 'GET', (raw) => {
      const value = parse.objectInfo(raw);
      if (value.id !== objectId) throw new parse.InvalidData();
      return value;
    });
  }
  messages(chatId: number, cursor: MessageCursor = {}): Promise<ApiResult<MessagePage>> {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor))
      return Promise.resolve(failure('validation'));
    const keys = Object.keys(cursor);
    if (
      !this.validId(chatId) ||
      keys.length > 1 ||
      keys.some(
        (key) =>
          !['before', 'after', 'around'].includes(key) ||
          !this.validId(cursor[key as keyof MessageCursor]),
      )
    )
      return Promise.resolve(failure('validation'));
    const key = keys[0] as keyof MessageCursor | undefined;
    return this.request(
      `/api/chats/${chatId}/messages${key ? `?${key}=${cursor[key]}` : ''}`,
      'GET',
      (raw) => {
        const value = parse.messages(raw);
        if (value.items.some((item) => item.chatId !== chatId)) throw new parse.InvalidData();
        return value;
      },
    );
  }
  search(chatId: number, q: string): Promise<ApiResult<ChatMessage[]>> {
    if (!this.validId(chatId) || typeof q !== 'string' || q.trim().length < 2 || q.length > 100)
      return Promise.resolve(failure('validation'));
    return this.request(
      `/api/chats/${chatId}/search?q=${encodeURIComponent(q.trim())}`,
      'GET',
      (raw) => {
        if (!Array.isArray(raw) || raw.length > 30) throw new parse.InvalidData();
        return raw.map((item) => {
          const value = parse.message(item);
          if (value.chatId !== chatId) throw new parse.InvalidData();
          return value;
        });
      },
    );
  }
  send(
    chatId: number,
    text: string,
    requestId: string,
    fileIds: number[] = [],
    replyTo?: number,
  ): Promise<ApiResult<ChatMessage>> {
    if (
      !this.validId(chatId) ||
      (replyTo !== undefined && !this.validId(replyTo)) ||
      !Array.isArray(fileIds) ||
      typeof text !== 'string' ||
      (!text.trim() && fileIds.length === 0) ||
      text.trim().length > 4000 ||
      typeof requestId !== 'string' ||
      !/^[A-Za-z0-9._:-]{8,100}$/.test(requestId) ||
      fileIds.length > 10 ||
      fileIds.some((id) => !this.validId(id)) ||
      new Set(fileIds).size !== fileIds.length
    )
      return Promise.resolve(failure('validation'));
    const owner = this.owner;
    const expectedText = text.trim();
    const expectedFiles = [...fileIds].sort((a, b) => a - b);
    return this.request(
      `/api/chats/${chatId}/messages`,
      'POST',
      (raw) => {
        const value = parse.message(raw);
        if (
          value.chatId !== chatId ||
          value.text !== expectedText ||
          value.author?.id !== owner ||
          (value.replyTo?.id ?? null) !== (replyTo ?? null) ||
          value.files.length !== expectedFiles.length ||
          value.files
            .map((f) => f.fileId)
            .sort((a, b) => a - b)
            .some((id, i) => id !== expectedFiles[i])
        )
          throw new parse.InvalidData();
        return value;
      },
      {
        text: expectedText,
        ...(fileIds.length > 0 && { fileIds: [...fileIds] }),
        ...(replyTo !== undefined && { replyTo }),
      },
      true,
      [200, 201],
      requestId,
    );
  }
  edit(chatId: number, messageId: number, text: string): Promise<ApiResult<ChatMessage>> {
    if (
      !this.validId(chatId) ||
      !this.validId(messageId) ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.trim().length > 4000
    )
      return Promise.resolve(failure('validation'));
    const owner = this.owner,
      expected = text.trim();
    return this.request(
      `/api/chats/${chatId}/messages/${messageId}`,
      'PATCH',
      (raw) => {
        const value = parse.message(raw);
        if (
          value.id !== messageId ||
          value.chatId !== chatId ||
          value.author?.id !== owner ||
          value.deleted ||
          value.text !== expected
        )
          throw new parse.InvalidData();
        return value;
      },
      { text: expected },
    );
  }
  delete(chatId: number, messageId: number): Promise<ApiResult<ChatMessage>> {
    if (!this.validId(chatId) || !this.validId(messageId))
      return Promise.resolve(failure('validation'));
    const owner = this.owner;
    return this.request(`/api/chats/${chatId}/messages/${messageId}`, 'DELETE', (raw) => {
      const value = parse.message(raw);
      if (
        value.id !== messageId ||
        value.chatId !== chatId ||
        value.author?.id !== owner ||
        !value.deleted ||
        value.text ||
        value.files.length
      )
        throw new parse.InvalidData();
      return value;
    });
  }
  pin(chatId: number, messageId: number | null): Promise<ApiResult<null>> {
    return this.validId(chatId) && (messageId === null || this.validId(messageId))
      ? this.request(`/api/chats/${chatId}/pin`, 'POST', parse.acknowledged, { messageId })
      : Promise.resolve(failure('validation'));
  }
  upload(
    chatId: number,
    bytes: Uint8Array,
    fileName: string,
    mime: string,
  ): Promise<ApiResult<ChatFile>> {
    const safeMime = validateUpload(fileName, bytes, mime);
    if (!this.validId(chatId) || safeMime === null) return Promise.resolve(failure('validation'));
    const body: UploadBody = { bytes: Uint8Array.from(bytes), fileName, mime: safeMime };
    return this.request(
      `/api/chats/${chatId}/files`,
      'POST',
      (raw) => {
        const value = parse.file(raw);
        if (value.fileName !== fileName || value.size !== body.bytes.length)
          throw new parse.InvalidData();
        return value;
      },
      undefined,
      true,
      [201],
      undefined,
      body,
    );
  }
  reactions(
    chatId: number,
    messageId: number,
    kind: string,
    remove: boolean,
  ): Promise<ApiResult<ChatReaction[]>> {
    if (
      !this.validId(chatId) ||
      !this.validId(messageId) ||
      !REACTIONS.has(kind) ||
      typeof remove !== 'boolean'
    )
      return Promise.resolve(failure('validation'));
    return this.request(
      `/api/chats/${chatId}/messages/${messageId}/reactions${remove ? `/${kind}` : ''}`,
      remove ? 'DELETE' : 'POST',
      parse.reactions,
      remove ? undefined : { kind },
    );
  }
  top(chatId: number, top: boolean): Promise<ApiResult<ChatSummary>> {
    if (!this.validId(chatId) || typeof top !== 'boolean')
      return Promise.resolve(failure('validation'));
    return this.request(
      `/api/chats/${chatId}/top`,
      'PUT',
      (raw) => {
        const value = parse.summary(raw);
        if (value.id !== chatId || value.top !== top) throw new parse.InvalidData();
        return value;
      },
      { top },
    );
  }
  morning(): Promise<ApiResult<MorningSummary>> {
    return this.request('/api/desktop/morning', 'GET', parse.morning);
  }
  supportUpload(fileName: string, bytes: Uint8Array): Promise<ApiResult<ChatFile>> {
    const mime = validateUpload(fileName, bytes, 'application/octet-stream');
    if (!mime || !bytes.length) return Promise.resolve(failure('validation'));
    const upload: UploadBody = {
      fileName,
      bytes: Uint8Array.from(bytes),
      mime: 'application/octet-stream',
    };
    return this.request(
      '/api/desktop/support/files',
      'POST',
      (raw) => {
        const value = parse.file(raw);
        if (
          value.fileName !== fileName ||
          value.size !== upload.bytes.length ||
          value.mime !== mime ||
          value.isImage !== mime.startsWith('image/')
        )
          throw new parse.InvalidData();
        return value;
      },
      undefined,
      true,
      [201],
      undefined,
      upload,
    );
  }
  supportSend(payload: SupportPayload, key: string): Promise<ApiResult<SupportReceipt>> {
    if (
      !supportPayloadValid(payload) ||
      typeof key !== 'string' ||
      !/^[A-Za-z0-9._:-]{8,100}$/.test(key)
    )
      return Promise.resolve(failure('validation'));
    return this.request(
      '/api/desktop/support',
      'POST',
      parse.supportReceipt,
      { text: payload.text, fileIds: [...payload.fileIds] },
      true,
      [200, 201],
      key,
    );
  }
  read(chatId: number, upTo: number): Promise<ApiResult<null>> {
    return this.validId(chatId) && this.validId(upTo)
      ? this.request(`/api/chats/${chatId}/read`, 'POST', parse.acknowledged, { upTo })
      : Promise.resolve(failure('validation'));
  }
  async download(
    fileId: number,
    size: number,
  ): Promise<ApiResult<{ bytes: Uint8Array; mime: string }>> {
    if (!this.validId(fileId) || !Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT)
      return failure('validation');
    if (!this.user || !this.csrf) return failure('unauthenticated');
    if (this.user.mustChangePassword) return failure('password_change_required');
    const epoch = this.epoch;
    const result = await this.raw(
      `/api/files/${fileId}`,
      'GET',
      undefined,
      epoch,
      null,
      undefined,
      size,
    );
    if (epoch !== this.epoch) return failure('stale_session');
    if (!result.ok) return result;
    const { status, body } = result.data;
    if (status === 401) {
      this.authLost(epoch);
      return failure('unauthenticated');
    }
    if (status === 403) return failure('forbidden');
    if (status === 404) return failure('not_found');
    if (status !== 200) return failure(status >= 500 ? 'server_error' : 'invalid_data');
    // raw creates this main-only DTO; bytes are never part of the renderer IPC result.
    return { ok: true, data: body as { bytes: Uint8Array; mime: string } };
  }
  notifications(before?: number): Promise<ApiResult<NotificationPage>> {
    return before === undefined || this.validId(before)
      ? this.request(
          `/api/notifications${before === undefined ? '' : `?before=${before}`}`,
          'GET',
          parse.notifications,
        )
      : Promise.resolve(failure('validation'));
  }
  readNotification(target: number | 'all'): Promise<ApiResult<{ unread: number }>> {
    return target === 'all' || this.validId(target)
      ? this.request(
          target === 'all' ? '/api/notifications/read-all' : `/api/notifications/${target}/read`,
          'POST',
          parse.unread,
        )
      : Promise.resolve(failure('validation'));
  }
  focus(): Promise<ApiResult<FocusState>> {
    return this.request('/api/focus', 'GET', parse.focus);
  }
  notificationSettings(): Promise<ApiResult<NotificationSettings>> {
    return this.request('/api/notification-settings', 'GET', parse.notificationSettings);
  }
  focusSummary(): Promise<ApiResult<FocusSummary>> {
    return this.request('/api/focus/summary', 'GET', parse.focusSummary);
  }
  setFocus(until: string | null): Promise<ApiResult<FocusState>> {
    return until === null ||
      (typeof until === 'string' && until.length <= 64 && Number.isFinite(Date.parse(until)))
      ? this.request('/api/focus', 'PUT', parse.focus, { until })
      : Promise.resolve(failure('validation'));
  }
  async logout(): Promise<ApiResult<null>> {
    const epoch = this.generation;
    const result = await this.request('/api/auth/logout', 'POST', parse.acknowledged);
    if (epoch === this.generation) this.clear();
    return result;
  }
  private validId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  }
  private authLost(epoch: number): void {
    if (epoch !== this.generation) return;
    this.clear();
    this.o.onAuthLost?.();
  }
  private httpFailure<T>(raw: Raw, mutation: boolean): ApiResult<T> {
    if (raw.status >= 300 && raw.status < 400) return failure('invalid_data', mutation);
    let code = raw.status >= 500 ? 'server_error' : 'bad_request';
    try {
      const candidate = parse.object(parse.object(raw.body).error).code;
      if (typeof candidate === 'string' && Object.hasOwn(ERROR_TEXT, candidate)) code = candidate;
    } catch {
      /* Только безопасный код; серверный текст и тело не выдаём. */
    }
    return failure(code, mutation && raw.status >= 500);
  }
  private async request<T>(
    path: string,
    method: string,
    decode: (raw: unknown) => T,
    body?: object,
    protectedRoute = true,
    statuses = [200],
    requestId?: string,
    upload?: UploadBody,
  ): Promise<ApiResult<T>> {
    const epoch = this.generation,
      owner = this.owner;
    if (protectedRoute && (!this.user || !this.csrf)) return failure('unauthenticated');
    if (protectedRoute && this.user?.mustChangePassword && path !== '/api/auth/logout')
      return failure('password_change_required');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (epoch !== this.generation || (protectedRoute && owner !== this.owner))
        return failure('stale_session');
      const result = await this.raw(
        path,
        method,
        body,
        epoch,
        protectedRoute ? this.csrf : null,
        requestId,
        undefined,
        upload,
      );
      if (epoch !== this.generation || (protectedRoute && owner !== this.owner))
        return failure('stale_session');
      if (!result.ok) return result;
      const raw = result.data;
      if (statuses.includes(raw.status)) {
        try {
          return { ok: true, data: decode(raw.body) };
        } catch {
          return failure('invalid_data', MUTATIONS.has(method));
        }
      }
      const error = this.httpFailure<T>(raw, MUTATIONS.has(method));
      if (error.ok) return error;
      if (path === '/api/time/timer/finish' && raw.status === 400 && error.code === 'validation') {
        try {
          const meta = parse.object(parse.object(raw.body).error);
          if (
            typeof meta.row === 'number' &&
            Number.isSafeInteger(meta.row) &&
            meta.row >= 0 &&
            meta.row < 20
          )
            error.row = meta.row;
          if (['date', 'from', 'to', 'taskId'].includes(String(meta.field)))
            error.field = meta.field as 'date' | 'from' | 'to' | 'taskId';
        } catch {
          /* Only bounded row/field metadata, never server messages. */
        }
      }
      if (protectedRoute && (raw.status === 401 || error.code === 'password_change_required')) {
        this.authLost(epoch);
        return raw.status === 401 ? failure('unauthenticated') : error;
      }
      if (
        protectedRoute &&
        !path.startsWith('/api/time/timer') &&
        raw.status === 403 &&
        error.code === 'csrf' &&
        attempt === 0
      ) {
        const refreshed = await this.authenticate();
        if (epoch !== this.generation || owner !== this.owner) return failure('stale_session');
        if (!refreshed.ok) return refreshed;
        continue;
      }
      return error;
    }
    return failure('csrf');
  }
  private async raw(
    path: string,
    method: string,
    body: object | undefined,
    epoch: number,
    csrf: string | null = null,
    requestId?: string,
    fileSize?: number,
    upload?: UploadBody,
  ): Promise<ApiResult<Raw>> {
    const controller = new AbortController();
    this.pending.add(controller);
    let timeout = false;
    const timer = setTimeout(
      () => {
        timeout = true;
        controller.abort();
      },
      fileSize === undefined && upload === undefined ? DEADLINE : 60000,
    );
    const aborted = new Promise<never>((_resolve, reject) =>
      controller.signal.addEventListener(
        'abort',
        () => reject(new TransportError(timeout ? 'timeout' : 'stale_session')),
        { once: true },
      ),
    );
    try {
      const work = (async (): Promise<Raw> => {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (upload) {
          headers['content-type'] = upload.mime;
          headers['x-file-name'] = encodeURIComponent(upload.fileName);
        }
        if (csrf && MUTATIONS.has(method)) headers['x-csrf-token'] = csrf;
        if (requestId) headers['idempotency-key'] = requestId;
        const response = await this.o.fetch(path, {
          method,
          headers,
          ...(body !== undefined && { body: JSON.stringify(body) }),
          ...(upload && { body: new Uint8Array(upload.bytes).buffer }),
          signal: controller.signal,
          redirect: 'manual',
          credentials: 'include',
        });
        // Статус входа не зависит от оформления тела reverse proxy: даже HTML
        // или незавершённое тело 401 не должны оставлять прежний вход готовым.
        if (response.status === 401) {
          void response.body?.cancel().catch(() => {});
          return { status: 401, body: null };
        }
        if (fileSize !== undefined && response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          return { status: response.status, body: null };
        }
        const limit = fileSize ?? BODY_LIMIT;
        const size = response.headers.get('content-length');
        if (size !== null && (!/^\d+$/.test(size) || Number(size) > limit)) {
          void response.body?.cancel().catch(() => {});
          throw new TransportError('payload_too_large');
        }
        const reader = response.body?.getReader();
        if (!reader) {
          if (fileSize !== undefined) throw new TransportError('invalid_file');
          return { status: response.status, body: null };
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        controller.signal.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) cancel();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > limit) {
              void reader.cancel().catch(() => {});
              throw new TransportError('payload_too_large');
            }
            chunks.push(part.value);
          }
        } finally {
          controller.signal.removeEventListener('abort', cancel);
          reader.releaseLock();
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (fileSize !== undefined) {
          if (total !== fileSize) throw new TransportError('invalid_file');
          return {
            status: response.status,
            body: {
              bytes,
              mime:
                response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ??
                'application/octet-stream',
            },
          };
        }
        if (!total) return { status: response.status, body: null };
        try {
          return {
            status: response.status,
            body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
          };
        } catch {
          throw new TransportError('invalid_data');
        }
      })();
      const data = await Promise.race([work, aborted]);
      return epoch === this.generation ? { ok: true, data } : failure('stale_session');
    } catch (error) {
      controller.abort();
      if (epoch !== this.generation) return failure('stale_session');
      const code = error instanceof TransportError ? error.code : timeout ? 'timeout' : 'network';
      return failure(code, MUTATIONS.has(method) && code !== 'stale_session');
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  }
}
