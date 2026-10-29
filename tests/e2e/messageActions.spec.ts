import { existingProfile } from './existingProfile';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';
const ROOT = resolve(__dirname, '..', '..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-actions-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
async function signIn(current: ElectronApplication, page: Page) {
  const pending = current.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const login = await pending;
  await login.locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
}
async function openChat(pick = true) {
  existingProfile(profile);
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  await signIn(app, page);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'));
    w?.show();
    w?.focus();
  });
  await expect(page.locator('.chat-row[data-chat-id="4"]')).toBeVisible();
  if (pick) {
    await page.locator('.chat-row[data-chat-id="4"]').click();
    await expect(input(page)).toBeEnabled();
  }
  return page;
}
const input = (page: Page) => page.getByRole('textbox', { name: 'Сообщение', exact: true });
const row = (page: Page, id: number) => page.locator(`.message-row[data-message-id="${id}"]`);
async function send(page: Page, text: string) {
  await input(page).fill(text);
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('');
  const m = stub
    .messages()
    .filter((m) => m.author?.id === 1)
    .at(-1);
  if (!m) throw Error('Missing sent fixture');
  return m;
}
async function command(page: Page, id: number, name: string) {
  await row(page, id).hover();
  await row(page, id).getByRole('button', { name, exact: true }).click();
}
const calls = (method: string) =>
  stub.state.calls.filter(
    (c) => c.method === method && /^\/api\/chats\/4\/messages\/\d+$/.test(c.path),
  );
test('поиск внутри чата находит сообщение и открывает его без изменения черновика', async () => {
  const page = await openChat();
  await input(page).fill('Не потерять черновик');
  await page.getByRole('button', { name: 'Поиск в чате', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Поиск сообщений' });
  await panel.getByRole('textbox', { name: 'Текст поиска в чате' }).fill('узел');
  await panel.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Найдено: 1');
  await panel.getByRole('button').filter({ hasText: 'Проверьте узел 5' }).click();
  await expect(row(page, 102)).toBeInViewport();
  await expect(panel).toHaveCount(0);
  await expect(input(page)).toHaveValue('Не потерять черновик');
  expect(
    stub.state.calls.filter((c) => c.path === '/api/chats/4/search?q=%D1%83%D0%B7%D0%B5%D0%BB'),
  ).toHaveLength(1);
});
test('эмодзи вставляется в текст, а группа одного автора имеет одно имя и аватар у последнего', async () => {
  const page = await openChat();
  await expect(row(page, 101).locator('.message-author')).toHaveCount(1);
  await expect(row(page, 101).locator('.avatar')).toHaveCount(0);
  await expect(row(page, 102).locator('.message-author')).toHaveCount(0);
  await expect(row(page, 102).locator('.avatar')).toHaveCount(1);
  await input(page).fill('Привет');
  await input(page).evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(6, 6));
  await page.getByRole('button', { name: 'Эмодзи', exact: true }).click();
  await page.getByRole('button', { name: 'Вставить эмодзи «Сердце»', exact: true }).click();
  await expect(input(page)).toHaveValue('Привет❤️');
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('');
  expect(stub.messages().at(-1)?.text).toBe('Привет❤️');
  await page.evaluate(() => window.teams.request({ kind: 'theme', mode: 'dark' }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: test.info().outputPath('actions-dark.png') });
});
test('поиск требует минимум два знака и показывает пустой результат', async () => {
  const page = await openChat();
  await page.getByRole('button', { name: 'Поиск в чате', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Поиск сообщений' }),
    query = panel.getByRole('textbox', { name: 'Текст поиска в чате' });
  await query.fill('а');
  await expect(panel.getByRole('button', { name: 'Найти', exact: true })).toBeDisabled();
  await query.fill('Ненайденная строка');
  await query.press('Enter');
  await expect(panel.getByRole('status')).toHaveText('Сообщения не найдены');
  await query.press('Escape');
  await expect(panel).toHaveCount(0);
});
test('явное прочтение в списке не открывает чат и берёт последний ID из серверного списка', async () => {
  const page = await openChat(false);
  await page.locator('.chat-row[data-chat-id="4"]').hover();
  await page.getByRole('button', { name: 'Прочитано: Тестовый чат', exact: true }).click();
  await expect(page.locator('.chat-row[data-chat-id="4"] .unread-badge')).toHaveCount(0);
  await expect(page.locator('.messages-scroll[data-chat-id="4"]')).toHaveCount(0);
  const reads = stub.state.calls.filter(
    (c) => c.method === 'POST' && c.path === '/api/chats/4/read',
  );
  expect(reads.map((c) => c.body)).toEqual([{ upTo: 102 }]);
});

test('ответ с цитатой сохраняет черновик и повторяет тот же payload после потерянного ответа', async () => {
  const page = await openChat();
  await input(page).fill('Черновик ответа');
  await command(page, 101, 'Ответить с цитатой');
  await expect(page.getByRole('region', { name: 'Ответ с цитатой' })).toContainText(
    'Исходные данные готовы',
  );
  await expect(input(page)).toHaveValue('Черновик ответа');
  stub.state.lostAckOnce = true;
  await input(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Повторить отправку', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ответ с цитатой' })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить отправку', exact: true }).click();
  await expect(input(page)).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Ответ с цитатой' })).toHaveCount(0);
  const sent = stub.state.calls.filter(
    (c) => c.method === 'POST' && c.path === '/api/chats/4/messages',
  );
  expect(sent).toHaveLength(2);
  expect(sent[0]?.body).toEqual({ text: 'Черновик ответа', replyTo: 101 });
  expect(sent[0]?.requestId).toBe(sent[1]?.requestId);
  expect(stub.messages().filter((m) => m.author?.id === 1)).toHaveLength(1);
  await expect(page.locator('.outgoing .message-quote')).toContainText('Исходные данные готовы');
  await page.getByRole('button', { name: 'Перейти к исходному сообщению' }).click();
  await expect(row(page, 101)).toBeInViewport();
});
test('отмена цитаты не удаляет подготовленный текст', async () => {
  const page = await openChat();
  await input(page).fill('Сохранить текст');
  await command(page, 101, 'Ответить с цитатой');
  await page.getByRole('button', { name: 'Отменить ответ с цитатой' }).click();
  await expect(input(page)).toHaveValue('Сохранить текст');
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('');
  expect(stub.messages().at(-1)?.replyTo).toBeNull();
});
test('правка своего сообщения не меняет отдельный черновик и доступна с клавиатуры', async () => {
  const page = await openChat(),
    m = await send(page, 'Первоначальный текст');
  await input(page).fill('Другой черновик');
  await command(page, m.id, 'Изменить сообщение');
  const editor = row(page, m.id).getByRole('textbox', { name: 'Текст правки' });
  await editor.fill('Исправлено');
  await editor.press('Shift+Enter');
  await editor.pressSequentially('Вторая строка');
  await editor.press('Enter');
  await expect(row(page, m.id)).toContainText('Исправлено');
  await expect(editor).toHaveCount(0);
  await expect(input(page)).toHaveValue('Другой черновик');
  expect(calls('PATCH')).toHaveLength(1);
  expect(calls('PATCH')[0]?.body).toEqual({ text: 'Исправлено\nВторая строка' });
  await page.screenshot({ path: test.info().outputPath('actions-light.png') });
});
test('удаление требует подтверждения, отмена ничего не отправляет, результат — плашка', async () => {
  const page = await openChat(),
    m = await send(page, 'Удалить этот тест');
  await command(page, m.id, 'Удалить сообщение');
  await row(page, m.id).getByRole('button', { name: 'Отмена', exact: true }).click();
  expect(calls('DELETE')).toHaveLength(0);
  await command(page, m.id, 'Удалить сообщение');
  await row(page, m.id).getByRole('button', { name: 'Удалить у всех', exact: true }).click();
  await expect(row(page, m.id)).toContainText('Сообщение удалено');
  await expect(
    row(page, m.id).getByRole('button', { name: 'Изменить сообщение', exact: true }),
  ).toHaveCount(0);
  expect(calls('DELETE')).toHaveLength(1);
  expect(stub.messages().find((v) => v.id === m.id)?.deleted).toBe(true);
});
test('закреплённое сообщение появляется после API, открывается и открепляется', async () => {
  const page = await openChat();
  await command(page, 101, 'Закрепить сообщение');
  const pin = page.getByRole('region', { name: 'Закреплённое сообщение' });
  await expect(pin).toContainText('Исходные данные готовы');
  await pin.getByRole('button').first().click();
  await expect(row(page, 101)).toBeInViewport();
  await pin.getByRole('button', { name: 'Открепить сообщение', exact: true }).click();
  await expect(pin).toHaveCount(0);
  const requests = stub.state.calls.filter(
    (c) => c.path === '/api/chats/4/pin' && c.method === 'POST',
  );
  expect(requests.map((c) => c.body)).toEqual([{ messageId: 101 }, { messageId: null }]);
});
test('чужое сообщение и отсутствие права закрепления не предлагают запрещённые действия', async () => {
  stub.state.canPin = false;
  const page = await openChat();
  await row(page, 101).hover();
  for (const name of ['Изменить сообщение', 'Удалить сообщение', 'Закрепить сообщение'])
    await expect(row(page, 101).getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(row(page, 101).getByRole('button', { name: 'Ответить с цитатой' })).toBeEnabled();
});
test('403 и неизвестный исход правки не заменяют сообщение и сохраняют введённый текст', async () => {
  const page = await openChat(),
    m = await send(page, 'Прежний текст');
  await command(page, m.id, 'Изменить сообщение');
  await row(page, m.id).getByRole('textbox', { name: 'Текст правки' }).fill('Правка без ответа');
  stub.state.mutationStatus = 403;
  await row(page, m.id).getByRole('button', { name: 'Сохранить правку' }).click();
  await expect(row(page, m.id).getByRole('alert')).toContainText('Недостаточно прав');
  expect(stub.messages().find((v) => v.id === m.id)?.text).toBe('Прежний текст');
  stub.state.mutationStatus = 500;
  await row(page, m.id).getByRole('button', { name: 'Сохранить правку' }).click();
  await expect(row(page, m.id).getByRole('alert')).toContainText('Результат не подтверждён');
  await expect(row(page, m.id).getByRole('textbox', { name: 'Текст правки' })).toHaveValue(
    'Правка без ответа',
  );
  expect(calls('PATCH')).toHaveLength(2);
});
test('поздняя правка после выхода не меняет экран другого пользователя', async () => {
  const page = await openChat(),
    m = await send(page, 'Своя запись');
  await command(page, m.id, 'Изменить сообщение');
  await row(page, m.id).getByRole('textbox', { name: 'Текст правки' }).fill('Поздний ответ');
  stub.state.mutationDelayMs = 1000;
  await row(page, m.id).getByRole('button', { name: 'Сохранить правку' }).click();
  await expect.poll(() => calls('PATCH').length).toBe(1);
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'Выйти из учётной записи', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  stub.state.loginUserId = 2;
  if (!app) throw Error('Missing application');
  await signIn(app, page);
  await page.locator('.chat-row[data-chat-id="8"]').click();
  await expect(page.locator('.messages-scroll[data-chat-id="8"]')).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Поздний ответ');
});
test('индикатор набора гаснет через пять секунд и не перезагружает историю', async () => {
  const page = await openChat();
  await page.waitForTimeout(500);
  const reads = () =>
    stub.state.calls.filter(
      (c) => /^\/api\/chats\/4\/messages\?/.test(c.path) && c.method === 'GET',
    ).length;
  const initial = reads();
  stub.typing();
  await expect(page.locator('.typing-status')).toHaveText('Петров П.П. печатает…');
  await input(page).pressSequentially('Тест');
  await expect.poll(() => stub.state.typingReceived.length).toBe(1);
  await expect(page.locator('.typing-status')).toHaveCount(0, { timeout: 7000 });
  expect(reads()).toBe(initial);
  expect(stub.state.typingReceived).toEqual([4]);
});
test('новое сообщение не сбрасывает чтение старой истории, кнопка возвращает к последним', async () => {
  for (let i = 0; i < 90; i++) stub.push(`История ${i}`, 4, false);
  const page = await openChat();
  await page.getByRole('button', { name: 'Предыдущие сообщения', exact: true }).click();
  const viewport = page.locator('.messages-scroll');
  await viewport.evaluate((el) => {
    el.scrollTop = 120;
    el.dispatchEvent(new Event('scroll'));
  });
  const before = await viewport.evaluate((el) => el.scrollTop);
  stub.push('Новое во время чтения');
  await expect
    .poll(() => stub.state.calls.filter((c) => c.path.includes('/messages?around=')).length)
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: /К новым сообщениям/ })).toBeVisible();
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThan(before + 80);
  await page.getByRole('button', { name: /К новым сообщениям/ }).click();
  await expect(page.getByText('Новое во время чтения', { exact: true })).toBeInViewport();
});
