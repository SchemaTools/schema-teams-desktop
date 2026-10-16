import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from '../../src/main/logger';

const tmp = () => mkdtempSync(join(tmpdir(), 'log-'));

describe('Logger', () => {
  it('пишет строку со временем, уровнем и подробностями', () => {
    const dir = tmp();
    const log = new Logger({ dir, now: () => new Date('2026-01-02T03:04:05Z') });
    log.warn('сервер не открылся', { code: -102 });
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe(
      '2026-01-02T03:04:05.000Z WARN  сервер не открылся {"code":-102}\n',
    );
  });
  it('по кругу: не больше 5 файлов, каждый не больше предела', () => {
    const dir = tmp();
    const log = new Logger({ dir, maxBytes: 200, files: 5 });
    for (let i = 0; i < 100; i++) log.info(`строка ${i}`);
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['app.1.log', 'app.2.log', 'app.3.log', 'app.4.log', 'app.log']);
    for (const f of files) expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(200);
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toContain('строка 99');
    expect(existsSync(join(dir, 'app.5.log'))).toBe(false);
  });
  it('ошибка пишется с текстом и стеком', () => {
    const dir = tmp();
    new Logger({ dir }).error('сбой', { err: new Error('boom') });
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toContain('"message":"boom"');
  });
});
