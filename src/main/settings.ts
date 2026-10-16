// Настройки приложения — %APPDATA%\Schema Teams\settings.json (ТЗ, 10).
// На шаге Д1 — только то, что нужно каркасу; окно настроек — шаг Д6.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRect, type WindowState } from './windowState';

export interface Settings {
  /** Адрес сервера; пусто — адрес из сборки */
  serverUrl?: string;
  /** Запускать вместе с Windows (ТЗ, 4.4: включено по умолчанию) */
  autostart: boolean;
  window: WindowState;
  /** Масштаб страницы Ctrl+колесо (ТЗ, 4.3) */
  zoomLevel: number;
  /** Подсказка «работает в трее» уже показана (ТЗ, 4.3, Д-О-3) */
  trayHintShown: boolean;
}

export const DEFAULTS: Settings = {
  autostart: true,
  window: {},
  zoomLevel: 0,
  trayHintShown: false,
};

export const ZOOM_MIN = -3;
export const ZOOM_MAX = 3;

/** Приводит прочитанный файл к настройкам: неизвестное и негодное — по умолчанию. */
export function normalizeSettings(raw: unknown): Settings {
  const s: Settings = { ...DEFAULTS, window: {} };
  if (typeof raw !== 'object' || raw === null) return s;
  const r = raw as Record<string, unknown>;
  if (typeof r.serverUrl === 'string' && r.serverUrl.trim() !== '')
    s.serverUrl = r.serverUrl.trim();
  if (typeof r.autostart === 'boolean') s.autostart = r.autostart;
  if (typeof r.trayHintShown === 'boolean') s.trayHintShown = r.trayHintShown;
  if (typeof r.zoomLevel === 'number' && Number.isFinite(r.zoomLevel)) {
    s.zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, r.zoomLevel));
  }
  if (typeof r.window === 'object' && r.window !== null) {
    const w = r.window as Record<string, unknown>;
    if (isRect(w.bounds)) s.window.bounds = { ...w.bounds };
    if (typeof w.maximized === 'boolean') s.window.maximized = w.maximized;
  }
  return s;
}

export class SettingsStore {
  private value: Settings;

  constructor(private readonly file: string) {
    this.value = SettingsStore.read(file);
  }

  private static read(file: string): Settings {
    try {
      return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return normalizeSettings(null);
    }
  }

  get(): Readonly<Settings> {
    return this.value;
  }

  update(patch: Partial<Settings>): void {
    this.value = normalizeSettings({ ...this.value, ...patch });
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // запись через временный файл: при сбое посреди записи старые настройки не теряются
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
