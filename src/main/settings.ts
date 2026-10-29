// Настройки приложения — %APPDATA%\Schema Teams\settings.json (ТЗ, 10).
// На шаге Д1 — только то, что нужно каркасу; окно настроек — шаг Д6.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRect, type WindowState } from './windowState';
import { isoDay } from '../shared/time';
import { serverPartitionValid } from '../shared/serverConfiguration';

export interface Settings {
  /** Адрес сервера; пусто — адрес из сборки */
  serverUrl?: string;
  /** New isolated authentication storage after an explicit server change. */
  serverPartition?: string;
  onboardingComplete: boolean;
  /** Запускать вместе с Windows (ТЗ, 4.4: включено по умолчанию) */
  autostart: boolean;
  window: WindowState;
  /** Масштаб страницы Ctrl+колесо (ТЗ, 4.3) */
  zoomLevel: number;
  /** Подсказка «работает в трее» уже показана (ТЗ, 4.3, Д-О-3) */
  trayHintShown: boolean;
  theme: 'system' | 'light' | 'dark';
  notifications: { enabled: boolean; sound: boolean; preview: boolean };
  /** Локальные настройки учёта времени; автопауза пока зависит от сервера. */
  timer: { pauseOnLock: boolean; askOnUnlock: boolean; reminderTime: string };
  recentTimeTaskIds: Record<string, number[]>;
  timerReminderSeen: Record<string, string>;
}

export const DEFAULTS: Settings = {
  onboardingComplete: false,
  autostart: true,
  window: {},
  zoomLevel: 0,
  trayHintShown: false,
  theme: 'system',
  notifications: { enabled: true, sound: true, preview: true },
  timer: { pauseOnLock: true, askOnUnlock: true, reminderTime: '18:30' },
  recentTimeTaskIds: {},
  timerReminderSeen: {},
};

export const ZOOM_MIN = -3;
export const ZOOM_MAX = 3;

/** Приводит прочитанный файл к настройкам: неизвестное и негодное — по умолчанию. */
export function normalizeSettings(raw: unknown): Settings {
  const s: Settings = {
    ...DEFAULTS,
    window: {},
    notifications: { ...DEFAULTS.notifications },
    timer: { ...DEFAULTS.timer },
    recentTimeTaskIds: {},
    timerReminderSeen: {},
  };
  if (typeof raw !== 'object' || raw === null) return s;
  const r = raw as Record<string, unknown>;
  if (typeof r.onboardingComplete === 'boolean') s.onboardingComplete = r.onboardingComplete;
  if (
    typeof r.timerReminderSeen === 'object' &&
    r.timerReminderSeen !== null &&
    !Array.isArray(r.timerReminderSeen)
  ) {
    for (const [owner, date] of Object.entries(r.timerReminderSeen).slice(-30))
      if (/^[1-9]\d{0,15}$/.test(owner) && Number.isSafeInteger(Number(owner)) && isoDay(date))
        s.timerReminderSeen[owner] = date;
  }
  if (
    typeof r.recentTimeTaskIds === 'object' &&
    r.recentTimeTaskIds !== null &&
    !Array.isArray(r.recentTimeTaskIds)
  ) {
    for (const [owner, ids] of Object.entries(r.recentTimeTaskIds).slice(-30)) {
      if (
        !/^[1-9]\d{0,15}$/.test(owner) ||
        !Number.isSafeInteger(Number(owner)) ||
        !Array.isArray(ids)
      )
        continue;
      s.recentTimeTaskIds[owner] = [
        ...new Set(
          ids.filter(
            (id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
          ),
        ),
      ].slice(0, 3);
    }
  }
  if (typeof r.serverUrl === 'string' && r.serverUrl.trim() !== '')
    s.serverUrl = r.serverUrl.trim();
  if (serverPartitionValid(r.serverPartition)) s.serverPartition = r.serverPartition;
  if (typeof r.autostart === 'boolean') s.autostart = r.autostart;
  if (typeof r.trayHintShown === 'boolean') s.trayHintShown = r.trayHintShown;
  if (r.theme === 'system' || r.theme === 'light' || r.theme === 'dark') s.theme = r.theme;
  if (typeof r.notifications === 'object' && r.notifications !== null) {
    const n = r.notifications as Record<string, unknown>;
    for (const key of ['enabled', 'sound', 'preview'] as const)
      if (typeof n[key] === 'boolean') s.notifications[key] = n[key];
  }
  if (typeof r.timer === 'object' && r.timer !== null) {
    const t = r.timer as Record<string, unknown>;
    for (const key of ['pauseOnLock', 'askOnUnlock'] as const)
      if (typeof t[key] === 'boolean') s.timer[key] = t[key];
    if (
      typeof t.reminderTime === 'string' &&
      t.reminderTime.length === 5 &&
      /^([01]\d|2[0-3]):(00|30)$/.test(t.reminderTime)
    )
      s.timer.reminderTime = t.reminderTime;
  }
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
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const value = normalizeSettings(raw);
      // Existing users keep working; the wizard remains available in General settings.
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && !('onboardingComplete' in raw))
        value.onboardingComplete = true;
      return value;
    } catch {
      return normalizeSettings(null);
    }
  }

  get(): Readonly<Settings> {
    return this.value;
  }

  update(patch: Partial<Settings>): void {
    const next = normalizeSettings({ ...this.value, ...patch });
    this.save(next);
    this.value = next;
  }

  private save(next: Settings): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // запись через временный файл: при сбое посреди записи старые настройки не теряются
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
