import { describe, expect, it } from 'vitest';
import { findUncPath, historyJoin, readableUpTo } from '../../src/renderer/model';
import type { ChatMessage } from '../../src/shared/client';

const message = (id: number) => ({ id }) as ChatMessage;
const page = (ids: number[], hasMore = true) => ({ items: ids.map(message), hasMore });

describe('стык истории (Ч1 ревью PR #6)', () => {
  it('пустая лента заменяется страницей', () => {
    expect(historyJoin([], page([10, 11]))).toBe('replace');
  });
  it('общий ID или начало страницы не позже последнего показанного — склейка подтверждена', () => {
    const shown = [10, 20, 30].map(message);
    expect(historyJoin(shown, page([30, 40]))).toBe('merge');
    expect(historyJoin(shown, page([25, 40]))).toBe('merge');
    expect(historyJoin(shown, page([], false))).toBe('merge');
  });
  it('страница доходит до начала чата — дыры быть не может', () => {
    expect(historyJoin([message(10)], page([50, 60], false))).toBe('merge');
  });
  it('страница целиком новее показанного и есть более старые — дыра, склеивать нельзя', () => {
    // ID сквозные: 31 после 30 тоже не доказывает отсутствие сообщений этого чата между ними.
    expect(historyJoin([message(30)], page([31, 32]))).toBe('gap');
    expect(historyJoin([message(30)], page([500, 501]))).toBe('gap');
  });
  it('прочитанным отмечается только видимое и не дальше непрерывного участка', () => {
    expect(readableUpTo([10, 12, 11], null)).toBe(12);
    expect(readableUpTo([10, 12, 99], 12)).toBe(12);
    expect(readableUpTo([99, 100], 12)).toBe(0);
    expect(readableUpTo([], null)).toBe(0);
  });
});

describe('путь UNC в строке сообщения', () => {
  const path = (line: string) => findUncPath(line)?.path ?? null;
  it.each([
    ['\\\\server\\share\\object-a', '\\\\server\\share\\object-a'],
    ['Модель: \\\\server\\share\\Объект А\\АР', '\\\\server\\share\\Объект А\\АР'],
    ['\\\\server\\share\\Объект А — см. лист 3', '\\\\server\\share\\Объект А'],
    ['\\\\server\\share\\Объект А – смотри', '\\\\server\\share\\Объект А'],
    ['\\\\server\\share\\Раздел - обновлено', '\\\\server\\share\\Раздел'],
    ['\\\\server\\share\\папка https://example.test/x', '\\\\server\\share\\папка'],
    ['\\\\server\\share\\папка.', '\\\\server\\share\\папка'],
    ['\\\\server\\share\\папка, посмотрите', '\\\\server\\share\\папка, посмотрите'],
    ['(путь \\\\server\\share\\папка)', '\\\\server\\share\\папка'],
    ['\\\\server\\share\\Проект (2026)\\АР', '\\\\server\\share\\Проект (2026)\\АР'],
    ['«\\\\server\\share\\папка» — готово', '\\\\server\\share\\папка'],
    ['\\\\server\\share\\ЖК «Объект А»\\АР', '\\\\server\\share\\ЖК «Объект А»\\АР'],
    ['"\\\\server\\share\\папка" готово', '\\\\server\\share\\папка'],
    ['“\\\\server\\share\\папка” готово', '\\\\server\\share\\папка'],
  ])('%s', (line, expected) => expect(path(line)).toBe(expected));
  it('без папки после сервера или без пути — не путь', () => {
    expect(findUncPath('\\\\server\\')).toBeNull();
    expect(findUncPath('обычный текст')).toBeNull();
    expect(findUncPath('\\\\server')).toBeNull();
  });
  it('границы указывают на исходную строку, хвост остаётся текстом', () => {
    const line = 'См. \\\\server\\share\\папка — там всё';
    const found = findUncPath(line);
    expect(found).not.toBeNull();
    expect(line.slice(found?.start, found?.end)).toBe('\\\\server\\share\\папка');
    expect(line.slice(found?.end)).toBe(' — там всё');
  });
});
