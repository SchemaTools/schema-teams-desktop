import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
export interface LogSnapshot {
  name: string;
  text: string;
  truncated: boolean;
}
const LIMIT = 1024 * 1024;
async function readTail(path: string): Promise<{ text: string; truncated: boolean }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw Error('not_regular');
  const file = await open(path, 'r');
  try {
    const current = await file.stat();
    if (current.dev !== before.dev || current.ino !== before.ino || !current.isFile())
      throw Error('changed');
    const head = Buffer.alloc(2);
    await file.read(head, 0, 2, 0);
    const utf16 = head[0] === 255 && head[1] === 254;
    let offset = Math.max(0, current.size - LIMIT);
    if (utf16 && offset % 2) offset++;
    const bytes = Buffer.alloc(Math.min(LIMIT, current.size - offset)),
      result = await file.read(bytes, 0, bytes.length, offset);
    const text = bytes
      .subarray(0, result.bytesRead)
      .toString(utf16 ? 'utf16le' : 'utf8')
      .replace(/^\uFEFF/, '');
    return { text, truncated: offset > 0 };
  } finally {
    await file.close();
  }
}
const messages = new Set([
  'запуск',
  'выход',
  'необработанная ошибка',
  'необработанный отказ',
  'запуск не удался',
  'cookie не сохранены',
  'не удалось сохранить день напоминания',
  'событие клиента',
  'неподдержанное событие чата',
  'неподдержанное уведомление',
  'не удалось восстановить настройку автозапуска',
  'локальное окно не загружено',
  'открытие пути',
  'архив диагностики сохранён',
]);
const events = new Set([
  'chat:message',
  'chat:updated',
  'chat:read',
  'chat:typing',
  'chat:reaction',
  'chat:pin',
  'notification:new',
  'notification:read',
  'time:timer',
  'session',
  'reconnect',
]);
/** A projection of known application events. Arbitrary errors, paths and unknown text are excluded. */
export function applicationLog(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const prefix = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (INFO|WARN|ERROR)\s+(.+)$/.exec(line);
        if (!prefix) return '[строка исключена]';
        const body = prefix[3] ?? '',
          message = [...messages].find((m) => body === m || body.startsWith(`${m} {`));
        if (!message) return `${prefix[1]} ${prefix[2]} [строка исключена]`;
        const details: Record<string, unknown> = {};
        try {
          const raw = JSON.parse(body.slice(message.length).trim() || '{}') as Record<
            string,
            unknown
          >;
          for (const key of ['app', 'electron', 'chrome', 'windows'])
            if (typeof raw[key] === 'string' && /^\d+(?:[.\-+][A-Za-z0-9]+)*$/.test(raw[key]))
              details[key] = raw[key];
          for (const key of ['packaged', 'hidden'])
            if (typeof raw[key] === 'boolean') details[key] = raw[key];
          if (['ok', 'unavailable', 'blocked'].includes(String(raw.result)))
            details.result = raw.result;
          if (raw.reason === 'invalid-or-closed') details.reason = raw.reason;
          if (typeof raw.event === 'string' && events.has(raw.event)) details.event = raw.event;
        } catch {
          /* Malformed details never pass through. */
        }
        return `${prefix[1]} ${prefix[2]} ${message}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ''}`;
      })
      .join('\n') + '\n'
  );
}
/** Revit journals can contain model data; remove quoted values, credentials and local/network paths. */
export function revitLog(text: string): string {
  return text
    .replace(/"(?:[^"\r\n]|"")*"/g, '"[значение скрыто]"')
    .replace(
      /^.*(?:password|passwd|authorization|cookie|csrf|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|bearer).*$/gim,
      '[строка с данными доступа исключена]',
    )
    .replace(/(?:https?:\/\/|[A-Za-z]:[\\/]|\\\\)[^\s<>]+/gi, '[путь или адрес скрыт]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[почта скрыта]')
    .replace(
      /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{20,}|stt_[A-Za-z0-9_-]{43})\b/g,
      '[токен скрыт]',
    )
    .replace(/\p{Cc}/gu, (character) => ('\r\n\t'.includes(character) ? character : ''));
}
export async function applicationLogs(root: string): Promise<LogSnapshot[]> {
  const snapshots: LogSnapshot[] = [];
  for (let index = 0; index < 5; index++) {
    const name = index ? `app.${index}.log` : 'app.log';
    try {
      const data = await readTail(join(root, name));
      snapshots.push({
        name: `application/${name}`,
        text: applicationLog(data.text),
        truncated: data.truncated,
      });
    } catch {
      /* Missing, replaced or inaccessible logs are not attached. */
    }
  }
  return snapshots;
}
export async function latestRevitLog(
  localAppData: string,
  year: 2025 | 2026,
): Promise<LogSnapshot | null> {
  if (!localAppData) return null;
  const folder = join(localAppData, 'Autodesk', 'Revit', `Autodesk Revit ${year}`, 'Journals');
  let latest: { name: string; number: number } | undefined;
  try {
    const directory = await opendir(folder);
    let count = 0;
    for await (const entry of directory) {
      if (++count > 512) throw Error('too_many_journals');
      const match = /^journal\.(\d{1,10})\.txt$/i.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const number = Number(match[1]);
      if (!latest || number > latest.number) latest = { name: entry.name, number };
    }
    if (!latest) return null;
    const data = await readTail(join(folder, latest.name));
    return {
      name: `revit/revit-${year}.txt`,
      text: revitLog(data.text),
      truncated: data.truncated,
    };
  } catch {
    return null;
  }
}
