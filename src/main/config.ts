// Адрес сервера (ТЗ, 9.1): зашит в сборку из закрытого .env, может быть поправлен в настройках.
// Переменная окружения SCHEMA_TEAMS_SERVER_URL — для разработки и сквозных тестов.
import { readFileSync } from 'node:fs';
import { parseServerUrl } from './navigation';

export interface BuildConfig {
  serverUrl?: string;
}

export function readBuildConfig(file: string): BuildConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw === 'object' && raw !== null) {
      const v = (raw as Record<string, unknown>).serverUrl;
      return typeof v === 'string' ? { serverUrl: v } : {};
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
