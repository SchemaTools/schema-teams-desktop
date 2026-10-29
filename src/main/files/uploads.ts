import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ApiResult, ChatFile, FilePickResult } from '../../shared/client';
import { TeamsApi, failure } from '../api/client';
import { MAX_UPLOAD_BYTES, validateUpload } from './uploadPolicy';

export interface UploadScope {
  epoch: number;
  chatId: number;
}
interface Options {
  api: TeamsApi;
  choose: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  clipboardImage: () => Promise<Uint8Array | null>;
}
interface Operation {
  scope: UploadScope;
  owner: number;
  generation: number;
  abort: AbortController;
}
class UploadError extends Error {
  constructor(readonly code: 'stale_session' | 'file_error' | 'timeout' | 'validation') {
    super(code);
  }
}
const safeError = (code: string) => {
  if (code === 'stale_session')
    return {
      ok: false as const,
      code,
      error: 'Вход изменился. Повторите действие из текущего окна.',
      retryable: false,
    };
  return {
    ok: false as const,
    code,
    error:
      code === 'timeout'
        ? 'Чтение файла заняло больше минуты. Повторите выбор.'
        : code === 'validation'
          ? 'Файл пустой, слишком большой или этот тип нельзя прикладывать.'
          : 'Не удалось прочитать выбранный файл. Проверьте доступ и повторите выбор.',
    retryable: code === 'timeout' || code === 'file_error',
  };
};
const validId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Native selection and clipboard bytes stay in main; only ChatFile DTOs leave this service. */
export class UploadService {
  private generation = 0;
  private active?: Operation;
  private readonly reads = new Set<Promise<Uint8Array>>();
  private stopped = false;
  constructor(private readonly o: Options) {}
  reset(): void {
    this.generation++;
    this.active?.abort.abort();
  }
  destroy(): void {
    this.stopped = true;
    this.reset();
  }
  private current(op: Operation): boolean {
    return (
      !this.stopped &&
      !op.abort.signal.aborted &&
      this.generation === op.generation &&
      op.scope.epoch === this.o.api.epoch &&
      op.owner === this.o.api.owner
    );
  }
  private guard(op: Operation): void {
    if (!this.current(op)) throw new UploadError('stale_session');
  }
  private async run<T>(
    scope: UploadScope,
    work: (op: Operation) => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> {
    if (!validId(scope.chatId) || !Number.isSafeInteger(scope.epoch) || scope.epoch < 0)
      return failure('validation');
    if (this.stopped || scope.epoch !== this.o.api.epoch) return failure('stale_session');
    const owner = this.o.api.owner;
    if (owner === null) return failure('unauthenticated');
    // An uninterruptible native dialog or late fs.open keeps its slot until its cleanup runs.
    if (this.active || this.reads.size) return failure('busy');
    const op: Operation = {
      scope: { ...scope },
      owner,
      generation: this.generation,
      abort: new AbortController(),
    };
    this.active = op;
    let canceled: () => void = () => {};
    const cancellation = new Promise<ApiResult<T>>((resolve) => {
      canceled = () => resolve(failure('stale_session'));
      op.abort.signal.addEventListener('abort', canceled, { once: true });
    });
    const task = work(op)
      .catch((error) => safeError(error instanceof UploadError ? error.code : 'file_error'))
      .finally(() => {
        op.abort.signal.removeEventListener('abort', canceled);
        if (this.active === op) this.active = undefined;
      });
    // Both branches have handlers even when a native operation finishes after cancellation.
    return Promise.race([task, cancellation]);
  }
  private async writable(op: Operation): Promise<ApiResult<null>> {
    this.guard(op);
    const detail = await this.o.api.detail(op.scope.chatId);
    this.guard(op);
    if (!detail.ok) return detail;
    return detail.data.canWrite ? { ok: true, data: null } : failure('read_only');
  }
  private async read(path: string, op: Operation): Promise<Uint8Array> {
    this.guard(op);
    let timedOut = false;
    const check = () => {
      this.guard(op);
      if (timedOut) throw new UploadError('timeout');
    };
    const work = (async () => {
      // open() itself cannot be aborted. The finally closes even a late handle.
      const handle = await open(path, 'r');
      try {
        check();
        const before = await handle.stat();
        check();
        if (
          !before.isFile() ||
          !Number.isSafeInteger(before.size) ||
          before.size <= 0 ||
          before.size > MAX_UPLOAD_BYTES
        )
          throw new UploadError('validation');
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const buffer = new Uint8Array(64 * 1024);
          const part = await handle.read(buffer, 0, buffer.length, null);
          check();
          if (part.bytesRead === 0) break;
          total += part.bytesRead;
          if (total > before.size || total > MAX_UPLOAD_BYTES) throw new UploadError('validation');
          chunks.push(buffer.subarray(0, part.bytesRead));
        }
        const after = await handle.stat();
        check();
        if (
          total !== before.size ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new UploadError('file_error');
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return bytes;
      } finally {
        await handle.close().catch(() => {});
      }
    })();
    const tracked = work.finally(() => this.reads.delete(tracked));
    this.reads.add(tracked);
    void tracked.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: () => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new UploadError('timeout'));
      }, 60000);
      cancel = () => reject(new UploadError('stale_session'));
      op.abort.signal.addEventListener('abort', cancel, { once: true });
      if (op.abort.signal.aborted) cancel();
    });
    try {
      return await Promise.race([tracked, deadline]);
    } finally {
      clearTimeout(timer);
      op.abort.signal.removeEventListener('abort', cancel);
    }
  }
  pick(scope: UploadScope, limit: number): Promise<ApiResult<FilePickResult>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
      return Promise.resolve(failure('validation'));
    return this.run<FilePickResult>(scope, async (op) => {
      const access = await this.writable(op);
      this.guard(op);
      if (!access.ok) return access;
      const selection = await this.o.choose();
      this.guard(op);
      if (selection.canceled) return { ok: true, data: { items: [], canceled: true } };
      if (
        !Array.isArray(selection.filePaths) ||
        !selection.filePaths.every((p) => typeof p === 'string' && p.length > 0)
      )
        return failure('invalid_data');
      if (selection.filePaths.length > limit)
        return {
          ok: true,
          data: {
            items: [],
            canceled: false,
            error: `Можно приложить ещё ${limit} файлов. Выберите меньше файлов.`,
          },
        };
      const items: ChatFile[] = [];
      for (const path of selection.filePaths) {
        this.guard(op);
        let bytes: Uint8Array;
        try {
          bytes = await this.read(path, op);
          this.guard(op);
        } catch (error) {
          this.guard(op);
          return {
            ok: true,
            data: {
              items,
              canceled: false,
              error: safeError(error instanceof UploadError ? error.code : 'file_error').error,
            },
          };
        }
        const name = basename(path),
          mime = validateUpload(name, bytes, 'application/octet-stream');
        if (mime === null)
          return {
            ok: true,
            data: { items, canceled: false, error: safeError('validation').error },
          };
        const result = await this.o.api.upload(op.scope.chatId, bytes, name, mime);
        this.guard(op);
        if (!result.ok) {
          if (result.code === 'stale_session') return result;
          return { ok: true, data: { items, canceled: false, error: result.error } };
        }
        items.push(result.data);
      }
      return { ok: true, data: { items, canceled: false } };
    });
  }
  paste(scope: UploadScope): Promise<ApiResult<ChatFile | null>> {
    return this.run<ChatFile | null>(scope, async (op) => {
      const access = await this.writable(op);
      this.guard(op);
      if (!access.ok) return access;
      const bytes = await this.o.clipboardImage();
      this.guard(op);
      if (bytes === null) return { ok: true, data: null };
      const name = `Изображение-${Date.now()}.png`;
      if (validateUpload(name, bytes, 'image/png') !== 'image/png') return safeError('validation');
      const result = await this.o.api.upload(op.scope.chatId, bytes, name, 'image/png');
      this.guard(op);
      return result;
    });
  }
}
