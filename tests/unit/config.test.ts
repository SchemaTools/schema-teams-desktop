import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBuildConfig, resolveServerUrl } from '../../src/main/config';

describe('адрес сервера', () => {
  it('порядок: окружение, настройки, сборка; негодные пропускаются', () => {
    expect(
      resolveServerUrl({ env: 'http://a.test', settings: 'http://b.test', build: 'http://c.test' })
        ?.host,
    ).toBe('a.test');
    expect(resolveServerUrl({ env: '', settings: 'мусор', build: 'http://c.test' })?.host).toBe(
      'c.test',
    );
    expect(resolveServerUrl({})).toBeNull();
  });
  it('файл сборки: нет файла — пусто', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    expect(readBuildConfig(join(dir, 'нет.json'))).toEqual({});
    writeFileSync(join(dir, 'b.json'), '{"serverUrl":"http://c.test"}');
    expect(readBuildConfig(join(dir, 'b.json'))).toEqual({ serverUrl: 'http://c.test' });
  });
});
