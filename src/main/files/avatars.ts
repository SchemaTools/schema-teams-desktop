// Фото профиля и логотип бюро для окна и меню трея (замечание 6 к PR #6).
// Окно не ходит на сервер само: оно просит `schema-attachment://avatar/<id>`, а главный процесс
// скачивает фото по cookie сессии, проверяет, что это картинка, и держит в памяти до смены входа.
import type { ApiResult } from '../../shared/client';
import { rasterMime } from './service';

/** Фото (`avatar`) и картинка стикера (`sticker`) — одинаково: картинка до 5 МиБ по ид файла. */
export const AVATAR_URL = /^schema-attachment:\/\/(?:avatar|sticker)\/([1-9]\d{0,15})$/;
/** Сколько фото держать в памяти: чатов и участников в бюро — десятки. */
const MAX_ENTRIES = 300;
/** Не найдено или не картинка — не спрашивать снова раньше, чем через 10 минут. */
const MISS_TTL = 10 * 60 * 1000;

type Photo = { bytes: Uint8Array; mime: string } | null;

export interface AvatarApi {
  readonly epoch: number;
  readonly owner: unknown;
  photo(fileId: number): Promise<ApiResult<{ bytes: Uint8Array; mime: string }>>;
}

export class AvatarService {
  private readonly cache = new Map<number, { epoch: number; at: number; photo: Promise<Photo> }>();
  private stopped = false;

  constructor(private readonly o: { api: AvatarApi; now?: () => number }) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  async response(request: Request): Promise<Response> {
    const match = AVATAR_URL.exec(request.url);
    if (!['GET', 'HEAD'].includes(request.method) || !match || this.stopped || !this.o.api.owner)
      return new Response(null, { status: 404 });
    const photo = await this.get(Number(match[1]));
    if (!photo) return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(photo.bytes).buffer, {
      headers: {
        'content-type': photo.mime,
        'content-length': String(photo.bytes.length),
        // окно держит картинку само, пока она на экране; новая загрузка — снова из памяти
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  }

  /** Фото из памяти или с сервера; null — показывать буквы. */
  get(fileId: number): Promise<Photo> {
    const epoch = this.o.api.epoch;
    const hit = this.cache.get(fileId);
    if (hit && hit.epoch === epoch) {
      // старое «нет фото» может устареть: пользователь загрузил фото
      if (this.now() - hit.at < MISS_TTL) {
        this.cache.delete(fileId);
        this.cache.set(fileId, hit); // в конец — недавно нужное
        return hit.photo;
      }
    }
    const photo = this.load(fileId, epoch);
    const entry = { epoch, at: this.now(), photo };
    this.cache.set(fileId, entry);
    void photo.then((p) => {
      // удачное фото храним до смены входа; промах — на MISS_TTL
      if (p && this.cache.get(fileId) === entry) entry.at = Infinity;
    });
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return photo;
  }

  private async load(fileId: number, epoch: number): Promise<Photo> {
    const r = await this.o.api.photo(fileId);
    if (!r.ok || epoch !== this.o.api.epoch) return null;
    const mime = rasterMime(r.data.bytes);
    return mime ? { bytes: r.data.bytes, mime } : null;
  }

  /** Смена входа: фото другого пользователя не показывать. */
  reset(): void {
    this.cache.clear();
  }

  stop(): void {
    this.stopped = true;
    this.cache.clear();
  }
}
