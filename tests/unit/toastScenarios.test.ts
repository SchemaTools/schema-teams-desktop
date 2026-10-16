import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBuildConfig } from '../../src/main/config';
import {
  replyFacts,
  scenarios,
  secondsBetween,
  toJsonLine,
} from '../../src/main/experiments/toastScenarios';

describe('сценарии опыта', () => {
  const all = scenarios(1);

  it('шесть сценариев с уникальными ключами', () => {
    expect(all.map((s) => s.key)).toEqual(['reply', 'delayed', 'task', 'replace', 'long', 'burst']);
  });
  it('сообщения — с полем ответа и кнопками «Открыть», «Прочитано»; задача — без ответа', () => {
    const reply = all.find((s) => s.key === 'reply')?.toasts[0];
    expect(reply?.hasReply).toBe(true);
    expect(reply?.buttons).toEqual(['Открыть', 'Прочитано']);
    const task = all.find((s) => s.key === 'task')?.toasts[0];
    expect(task?.hasReply).toBe(false);
    expect(task?.buttons).toEqual(['Открыть', '▶ Начать работу']);
  });
  it('замена: два уведомления с одним ид, второе позже', () => {
    const [a, b] = all.find((s) => s.key === 'replace')?.toasts ?? [];
    expect(a?.id).toBe(b?.id);
    expect(b?.delayMs).toBeGreaterThan(a?.delayMs ?? 0);
  });
  it('повторный показ не совпадает по ид с прежним', () => {
    expect(scenarios(2)[0]?.toasts[0]?.id).not.toBe(all[0]?.toasts[0]?.id);
  });
  it('длинный текст — больше 400 знаков', () => {
    expect(all.find((s) => s.key === 'long')?.toasts[0]?.body.length).toBeGreaterThan(400);
  });
});

describe('итоги опыта', () => {
  it('текст ответа не пишется — только длина и совпадение с образцом', () => {
    expect(replyFacts(' Проверка ')).toEqual({ replyLength: 10, replyMatches: true });
    expect(replyFacts('ok')).toEqual({ replyLength: 2, replyMatches: false });
  });
  it('строка JSON с переводом строки', () => {
    expect(toJsonLine({ at: 't', event: 'show' })).toBe('{"at":"t","event":"show"}\n');
  });
  it('секунды с одним знаком', () => {
    expect(secondsBetween(1000, 3460)).toBe(2.5);
  });
});

describe('пробная сборка', () => {
  it('режим опыта читается только со значением toast', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    writeFileSync(join(dir, 'a.json'), '{"serverUrl":"","experiment":"toast"}');
    writeFileSync(join(dir, 'b.json'), '{"serverUrl":"","experiment":"other"}');
    expect(readBuildConfig(join(dir, 'a.json')).experiment).toBe('toast');
    expect(readBuildConfig(join(dir, 'b.json')).experiment).toBeUndefined();
  });
});
