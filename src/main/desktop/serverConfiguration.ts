import { randomUUID } from 'node:crypto';
import type { ApiResult, Health } from '../../shared/client';
import {
  configuredServer,
  supportedServerVersion,
  MINIMUM_SERVER_VERSION,
  type ServerCheck,
  type ServerConfiguration,
} from '../../shared/serverConfiguration';
interface Options {
  current: URL | null;
  locked: boolean;
  notice?: string;
  readHealth: (server: URL) => Promise<ApiResult<Health>>;
  activate: (server: URL) => Promise<void>;
}
const error = (code: string, message: string): ApiResult<never> => ({
  ok: false,
  code,
  error: message,
  retryable: false,
});
export class ServerConfigurationService {
  private generation = 0;
  private destroyed = false;
  private applying = false;
  private proof?: ServerCheck & { until: number };
  constructor(private readonly o: Options) {}
  read(): ServerConfiguration {
    return {
      url: this.o.current?.origin ?? '',
      locked: this.o.locked,
      minimumVersion: MINIMUM_SERVER_VERSION,
      notice: this.o.notice ?? null,
    };
  }
  async check(value: string): Promise<ApiResult<ServerCheck>> {
    const generation = ++this.generation;
    this.proof = undefined;
    const server = configuredServer(value);
    if (this.destroyed || this.applying || !server)
      return error(
        'validation',
        'Укажите адрес http:// или https:// без пути, пароля и параметров.',
      );
    if (this.o.locked && server.origin !== this.o.current?.origin)
      return error(
        'configuration_locked',
        'Адрес задан окружением запуска и доступен только для чтения.',
      );
    try {
      const result = await this.o.readHealth(server);
      if (this.destroyed || generation !== this.generation)
        return error('stale_check', 'Адрес или проверка уже изменились. Проверьте связь снова.');
      if (!result.ok || result.data.status !== 'ok' || result.data.db !== 'ok')
        return error(
          'server_unavailable',
          'Сервер не подтвердил готовность. Проверьте адрес и связь.',
        );
      if (!supportedServerVersion(result.data.version))
        return error(
          'incompatible',
          `Нужен Schema Teams ${MINIMUM_SERVER_VERSION} или новее для собственного клиента.`,
        );
      const check = { url: server.origin, version: result.data.version, token: randomUUID() };
      this.proof = { ...check, until: Date.now() + 5 * 60 * 1000 };
      return { ok: true, data: check };
    } catch {
      return error('server_unavailable', 'Не удалось проверить связь. Адрес не изменён.');
    }
  }
  async apply(value: string, token: string): Promise<ApiResult<null>> {
    const server = configuredServer(value),
      proof = this.proof;
    if (
      this.destroyed ||
      this.applying ||
      this.o.locked ||
      !server ||
      !proof ||
      proof.token !== token ||
      proof.url !== server.origin ||
      Date.now() >= proof.until
    )
      return error('stale_check', 'Перед применением проверьте связь с этим адресом ещё раз.');
    this.proof = undefined;
    if (server.origin === this.o.current?.origin) return { ok: true, data: null };
    this.applying = true;
    try {
      await this.o.activate(server);
      return { ok: true, data: null };
    } catch {
      return error('configuration_failed', 'Адрес не изменён. Повторите настройку подключения.');
    } finally {
      this.applying = false;
    }
  }
  destroy(): void {
    this.destroyed = true;
    this.generation++;
    this.proof = undefined;
  }
}
