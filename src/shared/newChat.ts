// Новый чат (по замечаниям руководителя 06.11.2026): личный — `POST /api/chats/direct`,
// групповой — `POST /api/chats/group`; коллеги — `GET /api/chats/people?q=`. Проверки общие
// для окна (до отправки) и главного процесса (белый список IPC и клиент API).
import type { PersonRef } from './client';
import { CHAT_GROUP_MAX, CHAT_TITLE_MAX, PEOPLE_QUERY_MAX } from './client';

const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Название группы: после обрезки пробелов 1…80 знаков, без переводов строки. */
export function groupTitleValid(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > CHAT_TITLE_MAX * 2) return false;
  const title = v.trim();
  return title.length >= 1 && title.length <= CHAT_TITLE_MAX && !/[\r\n]/.test(title);
}
/** Участники кроме себя: 1…49 разных ид (создатель добавляется сервером). */
export function groupMembersValid(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= CHAT_GROUP_MAX - 1 &&
    v.every(positive) &&
    new Set(v).size === v.length
  );
}
export function peopleQueryValid(v: unknown): v is string {
  return typeof v === 'string' && v.length <= PEOPLE_QUERY_MAX;
}

// ---------- умный поиск по фамилии ----------

const LATIN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const CYRILLIC = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const LAYOUT = new Map([...LATIN].map((ch, i) => [ch, CYRILLIC[i] ?? ch]));

/** Строчные, «ё» как «е», лишние пробелы убраны. */
export function normalizeName(v: string): string {
  return v.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}
/** Набрано в английской раскладке («bdfyjdf») — то же в русской («иванова»). */
export function fromLatinLayout(v: string): string {
  return [...v.toLocaleLowerCase('ru-RU')].map((ch) => LAYOUT.get(ch) ?? ch).join('');
}
/**
 * Что отправить серверу: русская раскладка; сервер ищет вхождение и не приравнивает «е» к «ё»,
 * поэтому уходит самый длинный кусок без «е/ё» («Петров» → «тров»), остальное доделывает
 * отбор в окне (`rankPeople`).
 */
export function peopleServerQuery(raw: string): string {
  const typed = raw.trim().slice(0, PEOPLE_QUERY_MAX);
  const cyr = /[a-z]/i.test(typed) ? fromLatinLayout(typed) : typed;
  const needle = cyr.toLocaleLowerCase('ru-RU');
  return needle
    .split(/[её]/)
    .map((part) => part.trim())
    .reduce((best, part) => (part.length > best.length ? part : best), '');
}
/**
 * Отбор и порядок: сначала фамилия с начала, затем любое слово с начала, затем вхождение;
 * учитываются «ё»/«е» и английская раскладка. Пустой запрос — все по алфавиту.
 */
export function rankPeople(list: readonly PersonRef[], raw: string): PersonRef[] {
  const typed = normalizeName(raw);
  const variants = [...new Set([typed, normalizeName(fromLatinLayout(typed))])].filter(Boolean);
  const score = (person: PersonRef): number => {
    if (!variants.length) return 3;
    const name = normalizeName(person.shortName);
    const words = name.split(/[\s.]+/).filter(Boolean);
    let best = 0;
    for (const needle of variants) {
      if (name.startsWith(needle)) best = Math.max(best, 3);
      else if (words.some((w) => w.startsWith(needle))) best = Math.max(best, 2);
      else if (name.includes(needle)) best = Math.max(best, 1);
    }
    return best;
  };
  return list
    .map((person) => ({ person, score: score(person) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.person.shortName.localeCompare(b.person.shortName, 'ru') ||
        a.person.id - b.person.id,
    )
    .map((row) => row.person);
}
