import { createHash } from 'node:crypto';
import type { ApiResult, ChatFile } from '../../shared/client';
import type {
  ReportSupportState,
  SupportAttemptView,
  SupportPayload,
  SupportReceipt,
} from '../../shared/report';
import type { ApprovedSupportBundle } from './service';
import { SupportLedger, type SupportScope, type SupportIntent } from './ledger';
import { utcInstant } from '../../shared/time';

export interface SupportContext extends SupportScope {
  epoch: number;
  chatId: number;
  serverNow: string;
  uncertaintyMs: number;
}
interface Dependencies {
  ledger: SupportLedger;
  fresh: () => Promise<ApiResult<SupportContext>>;
  current: (context: SupportContext) => boolean;
  previewCurrent: (id: string, context: SupportContext) => boolean;
  bundle: (id: string) => Promise<ApprovedSupportBundle>;
  upload: (name: string, bytes: Uint8Array) => Promise<ApiResult<ChatFile>>;
  post: (payload: SupportPayload, key: string) => Promise<ApiResult<SupportReceipt>>;
}
const bad = (code: string, error: string): ApiResult<never> => ({
  ok: false,
  code,
  error,
  retryable: false,
});
const stale = () =>
  bad('stale_report', 'Вход или предпросмотр изменился. Подготовьте диагностику заново.');
const disk = () =>
  bad(
    'support_storage',
    'Не удалось сохранить состояние отправки. Не отправляйте повторно; проверьте место на диске и перезапустите приложение.',
  );
const definitive = new Set([
  'validation',
  'bad_request',
  'forbidden',
  'forbidden_type',
  'too_large',
  'no_support_chat',
  'idempotency_conflict',
  'csrf',
  'password_change_required',
]);
const reliableClock = (context: SupportContext) =>
  utcInstant(context.serverNow) &&
  Number.isFinite(context.uncertaintyMs) &&
  context.uncertaintyMs >= 0 &&
  context.uncertaintyMs <= 60000;
/** Explicit UI send/retry only; durable intent survives clear/edit/logout. */
export class SupportSender {
  private flight = false;
  constructor(private readonly o: Dependencies) {}
  status(
    scope: SupportScope | null,
    chatId: number | null,
    available: boolean,
    now: number,
  ): ReportSupportState {
    const attempt = scope ? this.o.ledger.view(scope, now) : null;
    const record = scope ? this.o.ledger.current(scope) : null;
    if (attempt)
      attempt.retryAllowed = attempt.retryAllowed && available && record?.chatId === chatId;
    return {
      available: available && this.o.ledger.healthy,
      error: this.o.ledger.healthy
        ? null
        : 'Сохранённое состояние отправки недоступно. Результат прежнего обращения может быть неизвестен. Перезапустите приложение после проверки диска.',
      attempt,
    };
  }
  async send(id: string): Promise<ApiResult<SupportAttemptView | null>> {
    if (this.flight) return bad('busy', 'Дождитесь результата текущего действия.');
    this.flight = true;
    try {
      const fresh = await this.o.fresh();
      if (!fresh.ok) return fresh;
      const context = fresh.data;
      if (!reliableClock(context))
        return bad('support_clock', 'Не удалось проверить время сервера. Повторите позже.');
      if (!this.o.current(context) || !this.o.previewCurrent(id, context)) return stale();
      if (!this.o.ledger.healthy) return disk();
      const previous = this.o.ledger.preview(context, id);
      if (previous?.status === 'confirmed')
        return {
          ok: true,
          data: {
            id: previous.id,
            previewId: previous.previewId,
            text: previous.payload.text,
            files: previous.files.map((f) => ({ name: f.name, size: f.size })),
            status: 'confirmed',
            retryAllowed: false,
            receipt: previous.receipt,
          },
        };
      if (previous?.status === 'resolved')
        return bad('stale_report', 'Подготовьте новый предпросмотр перед новым обращением.');
      if (this.o.ledger.locked(context))
        return bad(
          'support_unresolved',
          'Результат прежней отправки пока неизвестен. Сначала проверьте отправку.',
        );
      const bundle = await this.o.bundle(id);
      if (!this.o.current(context) || !this.o.previewCurrent(id, context)) return stale();
      if (bundle.previewId !== id || bundle.files.length < 1 || bundle.files.length > 3)
        return bad('validation', 'Проверьте вложения диагностики.');
      const files = [];
      for (const file of bundle.files) {
        if (!file.bytes.length || file.bytes.length > 50 * 1024 * 1024)
          return bad('too_large', 'Архив слишком велик. Сохраните его локально.');
        const bytes = Uint8Array.from(file.bytes),
          sha256 = createHash('sha256').update(bytes).digest('hex');
        const result = await this.o.upload(file.name, bytes);
        if (!this.o.current(context) || !this.o.previewCurrent(id, context)) return stale();
        if (!result.ok)
          return bad(
            result.code,
            result.uncertain
              ? 'Загрузка файла не подтверждена. Обращение ещё не отправлялось; при новой попытке может остаться отдельная незавершённая загрузка.'
              : result.error,
          );
        if (result.data.fileName !== file.name || result.data.size !== bytes.length)
          return bad(
            'invalid_data',
            'Сервер не подтвердил вложение. Обращение ещё не отправлялось.',
          );
        files.push({ name: file.name, size: bytes.length, sha256, fileId: result.data.fileId });
      }
      const renewed = await this.o.fresh();
      if (!this.o.current(context) || !this.o.previewCurrent(id, context)) return stale();
      if (!renewed.ok) return renewed;
      const current = renewed.data;
      if (
        current.epoch !== context.epoch ||
        current.ownerId !== context.ownerId ||
        current.serverHash !== context.serverHash ||
        current.chatId !== context.chatId ||
        !this.o.current(current)
      )
        return stale();
      const now = Date.parse(current.serverNow),
        margin = Math.max(120000, current.uncertaintyMs + 30000);
      if (!reliableClock(current) || !Number.isFinite(margin) || margin >= 24 * 3600000)
        return bad(
          'support_clock',
          'Не удалось проверить время сервера. Сохраните архив и повторите позже.',
        );
      const intent = this.o.ledger.begin({
        serverHash: current.serverHash,
        ownerId: current.ownerId,
        chatId: current.chatId,
        previewId: id,
        payload: { text: bundle.text, fileIds: files.map((f) => f.fileId) },
        files,
        firstAt: new Date(now).toISOString(),
        retryNotAfter: new Date(now + 24 * 3600000 - margin).toISOString(),
      });
      if (!intent) return disk();
      return await this.deliver(current, intent, false);
    } catch {
      return bad(
        'report_error',
        'Не удалось подготовить отправку. Сохраните архив и проверьте результат прежней отправки.',
      );
    } finally {
      this.flight = false;
    }
  }
  async retry(id: string): Promise<ApiResult<SupportAttemptView | null>> {
    if (this.flight) return bad('busy', 'Дождитесь результата текущего действия.');
    this.flight = true;
    try {
      const fresh = await this.o.fresh();
      if (!fresh.ok) return fresh;
      const context = fresh.data;
      if (!reliableClock(context))
        return bad('support_clock', 'Не удалось проверить время сервера. Повторите позже.');
      if (!this.o.current(context)) return stale();
      if (!this.o.ledger.healthy) return disk();
      const record = this.o.ledger.current(context);
      if (
        !record ||
        record.id !== id ||
        !['intent', 'unresolved', 'review'].includes(record.status)
      )
        return stale();
      if (record.chatId !== context.chatId) {
        if (!this.o.ledger.unknown(context, id, 'chat-changed')) return disk();
        return bad(
          'support_changed',
          'Настройка поддержки изменилась. Результат прежней отправки требует ручной проверки.',
        );
      }
      const now = Date.parse(context.serverNow);
      if (!this.o.ledger.retryAllowed(record, now)) {
        if (
          record.status !== 'review' &&
          !this.o.ledger.unknown(
            context,
            id,
            now < Date.parse(record.firstAt) ? 'clock' : 'expired',
          )
        )
          return disk();
        return bad(
          'support_review',
          'Результат отправки пока неизвестен. Безопасный повтор недоступен; проверьте обращение с поддержкой.',
        );
      }
      if (!this.o.ledger.unknown(context, id)) return disk();
      return await this.deliver(context, record, true);
    } finally {
      this.flight = false;
    }
  }
  resolve(scope: SupportScope, id: string): boolean {
    return !this.flight && this.o.ledger.healthy && this.o.ledger.resolve(scope, id);
  }
  private async deliver(
    context: SupportContext,
    record: SupportIntent,
    priorUnknown: boolean,
  ): Promise<ApiResult<SupportAttemptView | null>> {
    let result: ApiResult<SupportReceipt>;
    try {
      result = await this.o.post(structuredClone(record.payload), record.key);
    } catch {
      result = {
        ok: false,
        code: 'network',
        error: 'Результат отправки пока неизвестен.',
        retryable: false,
        uncertain: true,
      };
    }
    // A destroyed/previous Host must never rewrite a newer writer's file.
    if (!this.o.current(context)) return stale();
    if (this.o.ledger.current(context)?.id !== record.id) return stale();
    if (result.ok) {
      if (result.data.chatId !== record.chatId) {
        if (!this.o.ledger.unknown(context, record.id, 'chat-changed')) return disk();
        return bad(
          'support_changed',
          'Сервер подтвердил отправку в другой чат поддержки. Проверьте результат вручную.',
        );
      }
      if (!this.o.ledger.confirm(context, record.id, result.data))
        return bad(
          'support_storage',
          'Сервер подтвердил отправку, но сохранить подтверждение не удалось. Не создавайте новое обращение; проверьте результат после перезапуска.',
        );
    } else {
      const rejected = !result.uncertain && definitive.has(result.code);
      const saved = rejected
        ? this.o.ledger.reject(context, record.id, priorUnknown || record.mayHaveCommitted)
        : this.o.ledger.unknown(context, record.id);
      if (!saved) return disk();
      if (rejected && !priorUnknown && !record.mayHaveCommitted) return result;
    }
    return { ok: true, data: this.o.ledger.view(context, Date.parse(context.serverNow)) };
  }
}
