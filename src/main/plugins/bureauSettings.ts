import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * %APPDATA%\Schema\bureau.txt — настройки бюро для плагинов (читает Schema.Tools). Раньше
 * писал установщик Inno; теперь Desktop пишет его из значений сборки, только если файла
 * нет (решение руководителя 06.11). Существующий файл не трогается, пустые значения не пишутся.
 * Формат — как у установщика Inno: UTF-8 с BOM, строки `Ключ=значение`, комментарии `#`.
 */
export interface BureauValues {
  feedbackFolder?: string;
  deleteLogFolder?: string;
  mcpScenarios?: string;
  libraryFolder?: string;
  settingsFolder?: string;
}
const KEYS: readonly [keyof BureauValues, string, string][] = [
  [
    'feedbackFolder',
    'FeedbackFolder',
    '# FeedbackFolder — папка «Обратная связь» на сервере: таблица отзывов, памятка, папка «Вложения».',
  ],
  [
    'deleteLogFolder',
    'DeleteLogFolder',
    '# DeleteLogFolder — папка «Журнал удалений» на сервере: записи об удалениях, файл «_доступ.txt».',
  ],
  [
    'mcpScenarios',
    'McpScenarios',
    '# McpScenarios — папка «Сценарии SchemaMCP» на сервере: общие сценарии бюро для Claude.',
  ],
  [
    'libraryFolder',
    'LibraryFolder',
    '# LibraryFolder — папка «Библиотека» на сервере: «Семейства», «Спецификации», «ФОП», «_index».',
  ],
  [
    'settingsFolder',
    'SettingsFolder',
    '# SettingsFolder — папка «Настройки Schema» на сервере: schema-settings.json.',
  ],
];

const BOM = String.fromCharCode(0xfeff);
/** Годное значение: непустое, без управляющих символов и заглушек `<…>` из .env.example. */
export function bureauValue(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.trim().length > 0 &&
    v.length <= 1024 &&
    !/[\p{Cc}\p{Cf}<>"|?*]/u.test(v)
  );
}
export function normalizeBureauValues(raw: unknown): BureauValues {
  const result: BureauValues = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const r = raw as Record<string, unknown>;
  for (const [key] of KEYS) {
    const value = r[key];
    if (bureauValue(value)) result[key] = value.trim();
  }
  return result;
}

/** Текст файла или null, если писать нечего. */
export function renderBureauSettings(values: BureauValues): string | null {
  const lines = [
    '# Настройки бюро для плагинов Schema. Записывает Schema Teams; путь можно поправить вручную.',
  ];
  for (const [key, name, comment] of KEYS) {
    const value = values[key];
    if (bureauValue(value)) lines.push(comment, `${name}=${value.trim()}`);
  }
  // BOM — как у SaveStringsToUTF8File установщика Inno.
  return lines.length > 1 ? `${BOM}${lines.join('\r\n')}\r\n` : null;
}

/** Пишет файл только при его отсутствии (создание с флагом wx — без гонки с чужой записью). */
export async function ensureBureauSettings(
  file: string,
  values: BureauValues,
): Promise<'exists' | 'written' | 'empty'> {
  const text = renderBureauSettings(values);
  if (!text) return 'empty';
  await mkdir(dirname(file), { recursive: true });
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST') return 'exists';
    throw e;
  }
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return 'written';
}
