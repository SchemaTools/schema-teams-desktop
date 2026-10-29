import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_MESSAGES, projectLog } from '../logPolicy';
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
          message = LOG_MESSAGES.find((m) => body === m || body.startsWith(`${m} {`));
        if (!message) return `${prefix[1]} ${prefix[2]} [строка исключена]`;
        let raw: Record<string, unknown> | undefined;
        try {
          raw = JSON.parse(body.slice(message.length).trim() || '{}') as Record<string, unknown>;
        } catch {
          /* Malformed details never pass through. */
        }
        const { details } = projectLog(message, raw);
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
