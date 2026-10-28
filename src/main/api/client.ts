import type {
  ApiResult,
  ChatDetail,
  ChatList,
  ChatMessage,
  FocusState,
  FocusSummary,
  Health,
  MessagePage,
  NotificationPage,
  NotificationSettings,
  SafeUser,
} from '../../shared/client';
import * as parse from './parse';

export interface TeamsApiOptions {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  onAuthLost?: () => void;
}
export type MessageCursor = { before?: number; after?: number; around?: number };
type Raw = { status: number; body: unknown };
const DEADLINE = 15000;
const BODY_LIMIT = 2 * 1024 * 1024;
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ERROR_TEXT: Record<string, string> = {
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
  constructor(private readonly o: TeamsApiOptions) {}
  get epoch(): number {
    return this.generation;
  }
  get owner(): number | null {
    return this.user?.id ?? null;
  }
  clear(): void {
    this.generation++;
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
  listChats(): Promise<ApiResult<ChatList>> {
    return this.request('/api/chats', 'GET', parse.list);
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
  send(chatId: number, text: string, requestId: string): Promise<ApiResult<ChatMessage>> {
    if (
      !this.validId(chatId) ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.trim().length > 4000 ||
      typeof requestId !== 'string' ||
      !/^[A-Za-z0-9._:-]{8,100}$/.test(requestId)
    )
      return Promise.resolve(failure('validation'));
    const owner = this.owner;
    const expectedText = text.trim();
    return this.request(
      `/api/chats/${chatId}/messages`,
      'POST',
      (raw) => {
        const value = parse.message(raw);
        if (value.chatId !== chatId || value.text !== expectedText || value.author?.id !== owner)
          throw new parse.InvalidData();
        return value;
      },
      { text: expectedText },
      true,
      [200, 201],
      requestId,
    );
  }
  read(chatId: number, upTo: number): Promise<ApiResult<null>> {
    return this.validId(chatId) && this.validId(upTo)
      ? this.request(`/api/chats/${chatId}/read`, 'POST', parse.acknowledged, { upTo })
      : Promise.resolve(failure('validation'));
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
      if (protectedRoute && (raw.status === 401 || error.code === 'password_change_required')) {
        this.authLost(epoch);
        return raw.status === 401 ? failure('unauthenticated') : error;
      }
      if (protectedRoute && raw.status === 403 && error.code === 'csrf' && attempt === 0) {
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
  ): Promise<ApiResult<Raw>> {
    const controller = new AbortController();
    this.pending.add(controller);
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      controller.abort();
    }, DEADLINE);
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
        if (csrf && MUTATIONS.has(method)) headers['x-csrf-token'] = csrf;
        if (requestId) headers['idempotency-key'] = requestId;
        const response = await this.o.fetch(path, {
          method,
          headers,
          ...(body !== undefined && { body: JSON.stringify(body) }),
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
        const size = response.headers.get('content-length');
        if (size !== null && Number(size) > BODY_LIMIT) {
          void response.body?.cancel().catch(() => {});
          throw new TransportError('payload_too_large');
        }
        const reader = response.body?.getReader();
        if (!reader) return { status: response.status, body: null };
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
            if (total > BODY_LIMIT) {
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
