import { describe, expect, it } from 'vitest';
import { customToastPage, toastInitials } from '../../src/main/notifications/page';
import type { ToastSpec } from '../../src/main/notifications/types';

const spec: ToastSpec = {
  key: 'chat:4',
  id: 'chat:4',
  groupId: 'chat:4',
  delayMs: 0,
  header: 'Объект А',
  title: 'Петров П.П.',
  body: 'Проверьте <узел> 5',
  hasReply: true,
  buttons: ['Открыть', 'Прочитано'],
};
const html = (dark = false) => decodeURIComponent(customToastPage(spec, dark));

describe('вид уведомления по макету v4 (замечание 3)', () => {
  it('тёмная тема — явным классом страницы, светлая — без него', () => {
    expect(html(true)).toContain('<html lang="ru" class="dark">');
    expect(html(true)).toContain('<meta name="color-scheme" content="dark">');
    expect(html(false)).toContain('<html lang="ru">');
    expect(html(false)).not.toContain('class="dark"');
  });
  it('обложка с буквами отправителя, чат — в строке приложения', () => {
    expect(html()).toContain('>ПП</span>');
    expect(html()).toContain('Schema Teams · Объект А');
  });
  it('поле ответа, «Отправить» и кнопки сохраняют ид для preload; текст экранирован', () => {
    const page = html();
    for (const id of ['close', 'message', 'reply-box', 'reply', 'send', 'status'])
      expect(page).toContain(`id="${id}"`);
    expect(page).toContain('data-action="0"');
    expect(page).toContain('data-action="1"');
    expect(page).toContain('Проверьте &lt;узел&gt; 5');
  });
  it('знак бюро в строке приложения — два контурных квадрата, не диагональ', () => {
    const page = html();
    expect(page).toMatch(/<svg class="mark"[^>]*>.*<rect class="b"[^>]*>.*<rect class="f"/);
    expect(page).not.toContain('linear-gradient(135deg');
    expect(page).toContain(':root.dark .mark .f{stroke:#5b7bff}');
  });
  it('буквы обложки', () => {
    expect(toastInitials('Петров П.П.')).toBe('ПП');
    expect(toastInitials('Тестовый чат')).toBe('ТЧ');
    expect(toastInitials('ОБ-А · Объект А')).toBe('ОА');
    expect(toastInitials('')).toBe('·');
  });
});
