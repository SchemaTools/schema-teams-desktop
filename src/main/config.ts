// Адрес сервера (ТЗ, 9.1): зашит в сборку из закрытого .env, может быть поправлен в настройках.
// Переменная окружения SCHEMA_TEAMS_SERVER_URL — для разработки и сквозных тестов.
// Список серверов бюро для путей `\\сервер\…` (ТЗ, 7.2) — тоже из закрытого .env (UNC_HOSTS).
import { readFileSync } from 'node:fs';
import { parseServerUrl } from './navigation';
import { normalizeBureauValues, type BureauValues } from './plugins/bureauSettings';

export interface BuildConfig {
  serverUrl?: string;
  /** Имена или IP серверов бюро, к которым пути открываются без подтверждения. */
  uncHosts?: string[];
  /** Папки бюро для %APPDATA%\Schema\bureau.txt (BUREAU_* в закрытом .env). */
  bureau?: BureauValues;
}

/** Разбор списка `host1,host2`: пробелы и пустые элементы отбрасываются, заглушки `<…>` — тоже. */
export function parseUncHosts(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const hosts = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const host = item.trim().toLowerCase();
    if (host && !host.includes('<') && host.length <= 253) hosts.add(host);
  }
  return [...hosts];
}

export function readBuildConfig(file: string): BuildConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw === 'object' && raw !== null) {
      const record = raw as Record<string, unknown>;
      const config: BuildConfig = {};
      if (typeof record.serverUrl === 'string') config.serverUrl = record.serverUrl;
      const uncHosts = parseUncHosts(record.uncHosts);
      if (uncHosts.length) config.uncHosts = uncHosts;
      const bureau = normalizeBureauValues(record.bureau);
      if (Object.keys(bureau).length) config.bureau = bureau;
      return config;
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
