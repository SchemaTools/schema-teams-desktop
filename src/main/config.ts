// Адрес сервера (ТЗ, 9.1): зашит в сборку из закрытого .env, может быть поправлен в настройках.
// Переменная окружения SCHEMA_TEAMS_SERVER_URL — для разработки и сквозных тестов.
import { readFileSync } from 'node:fs';
import { parseServerUrl } from './navigation';

export interface BuildConfig {
  serverUrl?: string;
  /** Пробная сборка с режимом опыта (шаг Д2); в обычной сборке поля нет */
  experiment?: 'toast';
}

export function readBuildConfig(file: string): BuildConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw === 'object' && raw !== null) {
      const r = raw as Record<string, unknown>;
      const cfg: BuildConfig = {};
      if (typeof r.serverUrl === 'string') cfg.serverUrl = r.serverUrl;
      if (r.experiment === 'toast') cfg.experiment = 'toast';
      return cfg;
    }
  } catch {
    // файла нет — сборка без адреса
  }
  return {};
}

/** Первый годный адрес по порядку: окружение, настройки, сборка. */
export function resolveServerUrl(sources: {
  env?: string | undefined;
  settings?: string | undefined;
  build?: string | undefined;
}): URL | null {
  for (const v of [sources.env, sources.settings, sources.build]) {
    const u = parseServerUrl(v);
    if (u) return u;
  }
  return null;
}
