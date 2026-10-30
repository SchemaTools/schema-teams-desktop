import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../../src/main/logger';

const tmp = () => mkdtempSync(join(tmpdir(), 'log-'));

describe('Logger', () => {
  it('пишет время, уровень и только разрешённые служебные поля', () => {
    const dir = tmp();
    const log = new Logger({ dir, now: () => new Date('2026-01-02T03:04:05Z') });
    log.warn('состояние соединения', {
      state: 'offline',
      server: 'https://example.org/private',
      error: 'private error',
    });
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe(
      '2026-01-02T03:04:05.000Z WARN  состояние соединения {"state":"offline"}\n',
    );
  });
  it('по кругу: не больше 5 файлов, каждый не больше предела', () => {
    const dir = tmp();
    const log = new Logger({ dir, maxBytes: 200, files: 5 });
    for (let i = 0; i < 100; i++)
      log.info('состояние соединения', { state: i % 2 ? 'online' : 'offline' });
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['app.1.log', 'app.2.log', 'app.3.log', 'app.4.log', 'app.log']);
    for (const f of files) expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(200);
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toContain('"state":"online"');
    expect(existsSync(join(dir, 'app.5.log'))).toBe(false);
  });
  it('ошибка сохраняет только фиксированный вид, исключая сообщение, стек и причину', () => {
    const dir = tmp();
    const err = new TypeError('private password cookie C:/private');
    err.stack = 'private stack';
    new Logger({ dir }).error('необработанная ошибка', { err, cause: 'private cause' });
    const text = readFileSync(join(dir, 'app.log'), 'utf8');
    expect(text).toContain('"errorType":"TypeError"');
    expect(text).not.toMatch(/private|password|cookie|stack|cause/);
  });
  it('неизвестный текст и произвольные поля не попадают на диск, включая циклы и большие строки', () => {
    const dir = tmp(),
      log = new Logger({ dir }),
      details: Record<string, unknown> = {
        password: 'dummy password',
        cookie: 'dummy cookie',
        text: 'dummy message',
        huge: 'x'.repeat(2 * 1024 * 1024),
      };
    details.cycle = details;
    log.info('dummy message\nforged log line', details);
    log.info('запуск', { ...details, app: '0.6.5', server: 'https://example.org/private' });
    const text = readFileSync(join(dir, 'app.log'), 'utf8');
    expect(text).toContain('событие исключено');
    expect(text).toContain('"app":"0.6.5"');
    expect(text).not.toMatch(/dummy|forged|password|cookie|text|cycle|huge|private/);
    expect(Buffer.byteLength(text)).toBeLessThan(500);
  });
  it('подставленное имя исключения не превращается в содержимое журнала', () => {
    const dir = tmp(),
      err = new Error('hidden message');
    err.name = 'hidden name';
    new Logger({ dir }).error('необработанный отказ', { err });
    const text = readFileSync(join(dir, 'app.log'), 'utf8');
    expect(text).toContain('"errorType":"Error"');
    expect(text).not.toContain('hidden');
  });
});
