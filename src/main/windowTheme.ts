// Тема рамок окон Windows. Заголовок окна рисует система: при светлой теме Windows он светлый,
// даже если приложение в тёмной. Electron на Windows 10 1809+ и Windows 11 сам делает рамку
// тёмной, когда nativeTheme тёмная, поэтому выбор темы приложения («Как в Windows · Светлая ·
// Тёмная», ТЗ 4.3) передаётся в nativeTheme.themeSource — для всех окон сразу (замечание
// руководителя 05.11). Обычная рамка Windows сохраняется (ТЗ 4.3).
import { nativeTheme } from 'electron';

export type ThemePreference = 'system' | 'light' | 'dark';

/** Цвет окна до загрузки страницы: без белой вспышки в тёмной теме (фон из theme.css). */
export const windowBackground = (dark: boolean): string => (dark ? '#0e1621' : '#e9eefb');

/** Передаёт выбор темы системе и возвращает, тёмная ли тема сейчас. */
export function applyWindowTheme(preference: ThemePreference): boolean {
  if (nativeTheme.themeSource !== preference) nativeTheme.themeSource = preference;
  return nativeTheme.shouldUseDarkColors;
}
