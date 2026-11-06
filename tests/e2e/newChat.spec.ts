// По замечаниям руководителя 06.11.2026: «Новый чат» (личный и групповой) и точки «в сети».
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;

test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-new-chat-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
async function open(): Promise<Page> {
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ theme: 'light', onboardingComplete: true, autostart: false }),
  );
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut', {
    timeout: 35_000,
  });
  const pending = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect(page.locator('.chat-row[data-chat-id="4"]')).toBeVisible();
  await expect.poll(() => stub.state.socketConnections).toBeGreaterThan(0);
  return page;
}
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Новый чат' });
async function newChat(page: Page) {
  await page.getByRole('button', { name: 'Новый чат' }).click();
  await expect(dialog(page)).toBeVisible();
  return dialog(page);
}
const calls = (path: string) => stub.state.calls.filter((c) => c.path === path);

test('личный чат: создаётся и открывается, повторно с тем же коллегой — тот же чат', async () => {
  const page = await open();
  let d = await newChat(page);
  // умный поиск: английская раскладка и «е» вместо «ё»
  await d.getByRole('searchbox', { name: 'Фамилия или имя' }).fill('ctvtyjdf');
  await expect(d.locator('.new-chat-person')).toHaveCount(1);
  await expect(d.locator('.new-chat-person')).toContainText('Семёнова А.А.');
  await d.getByRole('searchbox', { name: 'Фамилия или имя' }).fill('Сидор');
  await d.locator('.new-chat-person[data-person-id="3"]').click();
  await expect(dialog(page)).toBeHidden();
  const row = page.locator('.chat-row[data-chat-id="500"]');
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.conversation-header h1')).toHaveText('Сидоров С.С.');
  const [first] = calls('/api/chats/direct');
  expect(first?.body).toEqual({ userId: 3 });
  expect(first?.csrf).toBe('csrf-test-only-user-1');

  // снова тот же коллега — сервер возвращает прежний чат, второй строки нет
  await page.locator('.chat-row[data-chat-id="4"]').click();
  d = await newChat(page);
  await d.getByRole('searchbox', { name: 'Фамилия или имя' }).fill('Сидоров');
  await d.locator('.new-chat-person[data-person-id="3"]').click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.chat-row')).toHaveCount(3); // 4, 500 и служебный
  expect(calls('/api/chats/direct')).toHaveLength(2);

  // уже существующий личный чат с Петровым — открывается он же (4)
  d = await newChat(page);
  await d.getByRole('searchbox', { name: 'Фамилия или имя' }).fill('Петров');
  await d.locator('.new-chat-person[data-person-id="2"]').click();
  await expect(page.locator('.chat-row[data-chat-id="4"]')).toHaveAttribute('aria-pressed', 'true');
});

test('групповой чат: название и несколько коллег, ключ повтора, открывается после создания', async () => {
  const page = await open();
  const d = await newChat(page);
  await d.getByRole('tab', { name: 'Группа' }).click();
  await d.getByRole('button', { name: 'Создать группу' }).click();
  await expect(d.getByRole('alert')).toHaveText('Укажите название');
  await d.getByLabel('Название').fill('  Группа по объекту А ');
  await d.getByRole('button', { name: 'Создать группу' }).click();
  await expect(d.getByRole('alert')).toHaveText('Выберите хотя бы одного коллегу');
  await d.locator('.new-chat-person[data-person-id="2"]').click();
  await d.locator('.new-chat-person[data-person-id="3"]').click();
  await expect(d.getByRole('list', { name: 'Выбрано: 2' })).toBeVisible();
  await d.getByRole('button', { name: 'Убрать Петров П.П.' }).click();
  await d.locator('.new-chat-person[data-person-id="5"]').click();
  await d.getByRole('button', { name: 'Создать группу' }).click();
  await expect(dialog(page)).toBeHidden();
  const row = page.locator('.chat-row[data-chat-id="500"]');
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expect(row).toContainText('Группа по объекту А');
  await expect(page.locator('.conversation-header h1')).toHaveText('Группа по объекту А');
  const created = calls('/api/chats/group');
  expect(created).toHaveLength(1);
  expect(created[0]?.body).toEqual({ title: 'Группа по объекту А', userIds: [3, 5] });
  expect(created[0]?.csrf).toBe('csrf-test-only-user-1');
  expect(created[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  // у группы точки «в сети» нет — только у личных чатов
  stub.presence(3, true);
  await expect(page.locator('.chat-row[data-chat-id="500"] .presence-dot')).toHaveCount(0);
});

test('отказ сервера в группе — понятное сообщение, окно остаётся открытым', async () => {
  stub.state.groupStatus = 403;
  const page = await open();
  const d = await newChat(page);
  await d.getByRole('tab', { name: 'Группа' }).click();
  await d.getByLabel('Название').fill('Группа А');
  await d.locator('.new-chat-person[data-person-id="2"]').click();
  await d.getByRole('button', { name: 'Создать группу' }).click();
  await expect(d.getByRole('alert')).toHaveText(
    'Сервер не разрешил создать группу. Обратитесь к администратору.',
  );
  await expect(page.locator('.chat-row[data-chat-id="500"]')).toHaveCount(0);
});

test('точка «в сети»: снимок при входе, появляется и исчезает по событию, «был(а) в сети»', async () => {
  stub.state.presenceOnline = [3];
  const page = await open();
  await expect.poll(() => calls('/api/chats/presence').length).toBeGreaterThan(0);
  const dot = page.locator('.chat-row[data-chat-id="4"] .presence-dot');
  await expect(dot).toHaveCount(0);
  await page.locator('.chat-row[data-chat-id="4"]').click();
  const status = page.locator('.conversation-header [data-presence-status="2"]');
  await expect(status).toHaveText('не в сети');
  // лента не перерисовывается целиком: тот же узел сообщения остаётся
  const bubble = page.locator('[data-message-id="102"]').first();
  await expect(bubble).toBeVisible();
  await bubble.evaluate((node) => ((node as HTMLElement & { mark?: string }).mark = 'same'));

  stub.presence(2, true);
  await expect(dot).toHaveCount(1);
  await expect(page.locator('.conversation-header .presence-dot')).toHaveCount(1);
  await expect(status).toHaveText('в сети');
  // сведения о чате: точка у участника в сети, у себя — нет
  await page.locator('.conversation-title-button').click();
  const members = page.locator('.chat-info-members');
  await expect(members.locator('[data-presence-dot="2"]')).toHaveCount(1);
  await expect(members.locator('[data-presence-dot="1"]')).toHaveCount(0);

  stub.presence(2, false, new Date().toISOString());
  await expect(dot).toHaveCount(0);
  await expect(members.locator('.presence-dot')).toHaveCount(0);
  await expect(status).toHaveText(/^был\(а\) в сети в \d\d:\d\d$/);
  expect(
    await bubble.evaluate((node) => (node as HTMLElement & { mark?: string }).mark ?? ''),
  ).toBe('same');

  // в окне «Новый чат» точка у коллеги из снимка (Сидоров в сети с входа)
  const d = await newChat(page);
  await expect(d.locator('.new-chat-person[data-person-id="3"] .presence-dot')).toHaveCount(1);
  await expect(d.locator('.new-chat-person[data-person-id="2"] .presence-dot')).toHaveCount(0);
});
