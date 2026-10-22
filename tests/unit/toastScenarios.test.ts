import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ID, TOAST_ACTIVATOR_CLSID } from '../../src/main/appIdentity';
import { readBuildConfig } from '../../src/main/config';
import {
  ActivationDedup,
  replyFacts,
  scenarios,
  secondsBetween,
  tagOf,
  toJsonLine,
  toastXml,
} from '../../src/main/experiments/toastScenarios';

describe('своё уведомление (toastXml)', () => {
  const reply = scenarios(3).find((s) => s.key === 'reply')?.toasts[0];
  const task = scenarios(3).find((s) => s.key === 'task')?.toasts[0];
  if (!reply || !task) throw new Error('нет сценариев');

  it('сообщение: поле ответа, «Отправить» рядом с полем, кнопки по порядку', () => {
    const xml = toastXml(reply, { sendIcon: 'send.png' });
    expect(xml).toContain('<input id="reply" type="text" placeHolderContent="Ответить…"/>');
    expect(xml).toMatch(
      /<action content="Отправить"[^>]*hint-inputId="reply"[^>]*imageUri="send.png"[^>]*arguments="type=reply&amp;tag=chat1-3"/,
    );
    expect(xml).toContain('arguments="type=action&amp;action=0&amp;tag=chat1-3"');
    expect(xml).toContain('arguments="type=action&amp;action=1&amp;tag=chat1-3"');
    expect(xml).not.toContain('Reply');
  });
  it('задача: без поля ответа', () => {
    const xml = toastXml(task);
    expect(xml).not.toContain('<input');
    expect(xml).toContain('content="▶ Начать работу"');
  });
  it('группа чата — заголовок header по названию чата', () => {
    const second = scenarios(1).find((s) => s.key === 'replace')?.toasts[1];
    if (!second) throw new Error('нет сценария');
    expect(toastXml(second, { header: second.header })).toContain(
      '<header id="chat3" title="Сидоров С.С."',
    );
  });
  it('спецсимволы экранируются', () => {
    const xml = toastXml({ ...task, title: 'A & B <c> "d"', buttons: [] });
    expect(xml).toContain('<text>A &amp; B &lt;c&gt; &quot;d&quot;</text>');
  });
  it('ид уведомления — из аргументов активации', () => {
    expect(tagOf('type=action&action=0&tag=task-4')).toBe('task-4');
    expect(tagOf('type=reply&tag=chat1-9')).toBe('chat1-9');
    expect(tagOf('type=click')).toBeUndefined();
  });
});

describe('повторы нажатий', () => {
  it('то же нажатие в пределах 2 с — повтор, позже — нет', () => {
    let t = 0;
    const d = new ActivationDedup(2000, () => t);
    expect(d.isRepeat('reply', 'type=reply&tag=a', 'проверка')).toBe(false);
    t = 15;
    expect(d.isRepeat('reply', 'type=reply&tag=a', 'проверка')).toBe(true);
    t = 3000;
    expect(d.isRepeat('reply', 'type=reply&tag=a', 'проверка')).toBe(false);
  });
  it('другой ответ или другая кнопка — не повтор', () => {
    const d = new ActivationDedup(2000, () => 0);
    expect(d.isRepeat('reply', 'type=reply&tag=a', 'да')).toBe(false);
    expect(d.isRepeat('reply', 'type=reply&tag=a', 'нет')).toBe(false);
    expect(d.isRepeat('action', 'type=action&action=0&tag=a')).toBe(false);
    expect(d.isRepeat('action', 'type=action&action=1&tag=a')).toBe(false);
  });
});

describe('регистрация в установщике', () => {
  const nsh = readFileSync(join(__dirname, '../../installer/windows.nsh'), 'utf8');
  it('имя приложения и код активатора — как в приложении', () => {
    expect(nsh).toContain(`AppUserModelId\\${APP_ID}"`);
    expect(nsh).toContain(`"${TOAST_ACTIVATOR_CLSID}"`);
  });
  it('код активатора — постоянный GUID в фигурных скобках', () => {
    expect(TOAST_ACTIVATOR_CLSID).toMatch(/^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/);
  });
  it('electron-builder подключает дополнение', () => {
    const yml = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/include: installer\/windows\.nsh/);
  });
});

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
