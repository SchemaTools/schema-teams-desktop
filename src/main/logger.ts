// Журнал приложения (ТЗ, 11): %APPDATA%\Schema Teams\logs\, 5 файлов по 1 МБ по кругу.
// Не пишутся тексты сообщений, пароли и cookie — вызывающий код передаёт только служебные сведения.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Level = 'info' | 'warn' | 'error';

export interface LoggerOptions {
  dir: string;
  maxBytes?: number;
  files?: number;
  now?: () => Date;
}

export class Logger {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly files: number;
  private readonly now: () => Date;

  constructor(opts: LoggerOptions) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? 1024 * 1024;
    this.files = opts.files ?? 5;
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.dir, { recursive: true });
  }

  get file(): string {
    return join(this.dir, 'app.log');
  }

  info(msg: string, details?: Record<string, unknown>): void {
    this.write('info', msg, details);
  }

  warn(msg: string, details?: Record<string, unknown>): void {
    this.write('warn', msg, details);
  }

  error(msg: string, details?: Record<string, unknown>): void {
    this.write('error', msg, details);
  }

  private write(level: Level, msg: string, details?: Record<string, unknown>): void {
    let line = `${this.now().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    if (details) line += ` ${safeJson(details)}`;
    line += '\n';
    try {
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.file, line, 'utf8');
    } catch {
      // журнал не должен ронять приложение
    }
  }

  private rotateIfNeeded(incoming: number): void {
    if (!existsSync(this.file)) return;
    if (statSync(this.file).size + incoming <= this.maxBytes) return;
    // app.log → app.1.log → … → app.(files-1).log, самый старый удаляется
    const name = (i: number) => join(this.dir, i === 0 ? 'app.log' : `app.${i}.log`);
    const last = name(this.files - 1);
    if (existsSync(last)) rmSync(last);
    for (let i = this.files - 2; i >= 0; i--) {
      if (existsSync(name(i))) renameSync(name(i), name(i + 1));
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val: unknown) =>
      val instanceof Error ? { name: val.name, message: val.message, stack: val.stack } : val,
    );
  } catch {
    return '"<не сериализуется>"';
  }
}
