import { posix } from 'node:path';
import { safeArchiveRelativePath, reject } from './archivePaths';

/**
 * Файлы .addin без XML-библиотеки и без внешнего помощника.
 *
 * Свой .addin (из архива сборки) разбирается узко: корень RevitAddIns, элементы AddIn
 * с атрибутом Type и простыми текстовыми полями. Всё прочее (DTD, CDATA, вложенные
 * элементы, неизвестные сущности) — отказ: архив собирает бюро, формат простой.
 * Итоговый .addin для Revit пишет само приложение заново, с экранированием.
 *
 * Чужой .addin (Dynamo, pyRevit, Enscape…) читается мягко: ищутся только AddInId и
 * Assembly. Неизвестные теги, типы DBApplication, кодировки и ошибки разбора не мешают.
 */
export type Year = 2025 | 2026;
export interface AddinEntry {
  type: 'Application' | 'Command';
  /** Поля в исходном порядке; Assembly — путь относительно папки .addin. */
  fields: [string, string][];
  addInId: string;
  assembly: string;
}
export const ADDIN_MAX_BYTES = 1024 * 1024;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** UTF-8 (с BOM и без) и UTF-16 с BOM — как пишут .addin Visual Studio и установщики. */
export function decodeAddin(bytes: Buffer, fatal = true): string {
  if (bytes.length > ADDIN_MAX_BYTES) reject('addin-size');
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le', { fatal }).decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be', { fatal }).decode(bytes.subarray(2));
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8', { fatal }).decode(bytes.subarray(start));
}
function unescape(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]+);?/g, (whole, name: string) => {
    if (!whole.endsWith(';')) reject('addin-entity');
    if (name.startsWith('#')) {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isInteger(code) || code < 9 || code > 0x10ffff) reject('addin-entity');
      return String.fromCodePoint(code);
    }
    const value = NAMED[name];
    if (value === undefined) reject('addin-entity');
    return value;
  });
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  );
const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '');

/** Свой .addin из архива сборки; путь Assembly проверяется отдельно (resolveAssembly). */
export function parseOwnAddin(bytes: Buffer): AddinEntry[] {
  let text: string;
  try {
    text = decodeAddin(bytes);
  } catch {
    reject('addin-encoding');
  }
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(text)) reject('addin-dtd');
  text = stripComments(text);
  const root = /^\s*(?:<\?xml[^?]*\?>)?\s*<RevitAddIns>([\s\S]*)<\/RevitAddIns>\s*$/.exec(text);
  if (!root?.[1]) reject('addin-root');
  const body = root[1];
  const entries: AddinEntry[] = [];
  let at = 0;
  const addIn = /\s*<AddIn\s+Type\s*=\s*"(Application|Command)"\s*>([\s\S]*?)<\/AddIn>\s*/y;
  while (at < body.length) {
    addIn.lastIndex = at;
    const match = addIn.exec(body);
    if (!match?.[1] || match[2] === undefined) reject('addin-element');
    at = addIn.lastIndex;
    if (entries.length >= 32) reject('addin-count');
    const fields: [string, string][] = [],
      inner = match[2],
      field = /\s*<([A-Za-z][A-Za-z0-9]{0,63})>([^<]*)<\/\1>\s*/y;
    let pos = 0;
    while (pos < inner.length) {
      field.lastIndex = pos;
      const f = field.exec(inner);
      if (!f?.[1] || f[2] === undefined) reject('addin-field');
      pos = field.lastIndex;
      const value = unescape(f[2]).trim();
      if (value.length > 1024 || fields.some(([name]) => name === f[1])) reject('addin-field');
      fields.push([f[1], value]);
    }
    const get = (name: string) => fields.find(([n]) => n === name)?.[1] ?? '';
    const addInId = get('AddInId'),
      assembly = get('Assembly'),
      fullClass = get('FullClassName');
    if (
      !GUID.test(addInId) ||
      /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(addInId) ||
      !assembly ||
      !/^[A-Za-z_][A-Za-z0-9_.+`]{0,511}$/.test(fullClass) ||
      (match[1] === 'Application' && !get('Name'))
    )
      reject('addin-required');
    entries.push({
      type: match[1] as AddinEntry['type'],
      fields,
      addInId: addInId.toLowerCase(),
      assembly,
    });
  }
  if (!entries.length) reject('addin-empty');
  const ids = entries.map((e) => e.addInId);
  if (new Set(ids).size !== ids.length) reject('addin-duplicate-id');
  return entries;
}

/** Assembly своего .addin — только путь внутри той же папки сборки (без диска, UNC и ..). */
export function resolveAssembly(addinRelativePath: string, assembly: string): string {
  // Без диска, UNC, переменных окружения; сначала сама ссылка (без ..), потом путь от .addin.
  if (/^[A-Za-z]:|^[\\/]|%/.test(assembly)) reject('addin-assembly');
  const reference = safeArchiveRelativePath(assembly.replaceAll('\\', '/'));
  const resolved = safeArchiveRelativePath(posix.join(posix.dirname(addinRelativePath), reference));
  if (!/\.dll$/i.test(resolved)) reject('addin-assembly');
  return resolved;
}

/** Итоговый .addin для Revit: те же поля, Assembly — абсолютный путь к сборке в папке версии. */
export function renderAddin(
  entries: readonly { entry: AddinEntry; assemblyPath: string }[],
): string {
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<RevitAddIns>'];
  for (const { entry, assemblyPath } of entries) {
    lines.push(`  <AddIn Type="${entry.type}">`);
    for (const [name, value] of entry.fields)
      lines.push(`    <${name}>${escape(name === 'Assembly' ? assemblyPath : value)}</${name}>`);
    lines.push('  </AddIn>');
  }
  lines.push('</RevitAddIns>', '');
  return lines.join('\r\n');
}

/** Мягкое чтение чужого .addin: пары AddInId → Assembly, что удалось найти. Не бросает. */
export function softAddinEntries(bytes: Buffer): { addInId: string; assembly: string | null }[] {
  try {
    const text = stripComments(decodeAddin(bytes, false));
    const result: { addInId: string; assembly: string | null }[] = [];
    const blocks = text.match(/<AddIn\b[\s\S]*?<\/AddIn\s*>/gi) ?? [];
    for (const block of blocks.length ? blocks : [text]) {
      const id = /<AddInId\s*>\s*([0-9a-fA-F-]{36})\s*<\/AddInId\s*>/i.exec(block)?.[1];
      if (!id || !GUID.test(id)) continue;
      const assembly = /<Assembly\s*>([^<]{1,1024})<\/Assembly\s*>/i.exec(block)?.[1];
      let path: string | null = null;
      try {
        path = assembly ? unescape(assembly).trim() || null : null;
      } catch {
        path = null;
      }
      result.push({ addInId: id.toLowerCase(), assembly: path });
    }
    return result.slice(0, 256);
  } catch {
    return [];
  }
}
