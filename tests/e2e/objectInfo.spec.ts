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
  stub.state.objectChat = true;
  profile = mkdtempSync(join(tmpdir(), 'stdesk-object-'));
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
async function openChat() {
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
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await expect(page.locator('.messages-scroll[data-chat-id="4"]')).toBeVisible();
  return page;
}
const panel = (page: Page) => page.getByRole('region', { name: 'Сведения об объекте' });
async function openInfo(page: Page) {
  await page.getByRole('button', { name: 'Об объекте', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
const objectCalls = () => stub.state.calls.filter((c) => c.path.startsWith('/api/objects/'));
test('сведения своего объекта показаны в обеих темах, данные не подменяются данными задачи', async () => {
  const page = await openChat();
  await openInfo(page);
  await expect(panel(page).getByRole('heading', { name: 'ОБ-А · Объект А' })).toBeVisible();
  for (const text of [
    'Тестовый заказчик',
    'Условный адрес',
    'Иванова И.И.',
    'Петров П.П.',
    'Не назначен',
    'Рабочая документация',
    '01.01.2026 — 31.12.2026',
  ])
    await expect(panel(page)).toContainText(text);
  expect(objectCalls().map((c) => [c.method, c.path])).toEqual([['GET', '/api/objects/7']]);
  await page.screenshot({ path: test.info().outputPath('object-info-light.png') });
  await page.evaluate(() => window.teams.request({ kind: 'theme', mode: 'dark' }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: test.info().outputPath('object-info-dark.png') });
  await panel(page).getByRole('button', { name: 'Закрыть сведения об объекте' }).press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Об объекте', exact: true })).toBeFocused();
});
test('служебные упоминания, назначения и сроки различаются по виду в обеих темах', async () => {
  const seed = stub.notifications[0];
  if (!seed) throw Error('Missing notification fixture');
  stub.notifications.push(
    {
      ...seed,
      id: 72,
      event: 'chat_mention',
      task: null,
      subject: 'Вас упомянули в чате',
      link: '/chat/4?m=101',
    },
    { ...seed, id: 73, event: 'due_soon', subject: 'Приближается срок' },
  );
  const page = await openChat();
  await page.locator('.chat-row[data-chat-id="events"]').click();
  await expect(page.locator('.event-stack')).toHaveCount(3);
  for (const [id, kind] of [
    [71, 'assigned'],
    [72, 'mention'],
    [73, 'deadline'],
  ] as const)
    await expect(page.locator(`.event-stack[data-notification-id="${id}"]`)).toHaveAttribute(
      'data-event-kind',
      kind,
    );
  const colors = await page
    .locator('.event-icon')
    .evaluateAll((nodes) => nodes.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(colors).size).toBe(3);
  await expect(page.locator('.event-deadline h2')).toHaveText('Срок приближается');
  await page.screenshot({ path: test.info().outputPath('events-light.png') });
  await page.evaluate(() => window.teams.request({ kind: 'theme', mode: 'dark' }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dark = await page
    .locator('.event-icon')
    .evaluateAll((nodes) => nodes.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(dark).size).toBe(3);
  expect(dark).not.toEqual(colors);
  await page.screenshot({ path: test.info().outputPath('events-dark.png') });
});
test('открыть на сайте использует проверенный объект и не открывает браузер в тесте', async () => {
  const page = await openChat();
  if (!app) throw Error('Missing app');
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      (globalThis as typeof globalThis & { objectSite?: string }).objectSite = url;
    };
  });
  await openInfo(page);
  await panel(page).getByRole('button', { name: 'Открыть на сайте', exact: true }).click();
  await expect
    .poll(() =>
      app?.evaluate(() => (globalThis as typeof globalThis & { objectSite?: string }).objectSite),
    )
    .toBe(new URL('/objects/7', stub.url).href);
});
test('отказ прав виден, повтор загружает сведения, подготовленный текст остаётся', async () => {
  stub.state.objectInfoStatus = 403;
  const page = await openChat();
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Черновик сохраняется');
  await openInfo(page);
  await expect(panel(page).getByRole('alert')).toContainText('Недостаточно прав');
  await expect(panel(page).getByRole('heading', { name: 'ОБ-А · Объект А' })).toHaveCount(0);
  stub.state.objectInfoStatus = null;
  await panel(page).getByRole('button', { name: 'Повторить загрузку сведений' }).click();
  await expect(panel(page).getByRole('heading', { name: 'ОБ-А · Объект А' })).toBeVisible();
  await expect(input).toHaveValue('Черновик сохраняется');
  expect(objectCalls()).toHaveLength(2);
});
test('в личном чате кнопки объекта нет и API объекта не вызывается', async () => {
  stub.state.objectChat = false;
  const page = await openChat();
  await expect(page.getByRole('button', { name: 'Об объекте', exact: true })).toHaveCount(0);
  expect(objectCalls()).toHaveLength(0);
});
test('архивный объект читается без разрешения отправки и помещается в узком окне', async () => {
  stub.state.canWrite = false;
  stub.state.objectInfo.status = 'archive';
  stub.state.objectInfo.currentStageId = null;
  stub.state.objectInfo.stages = [];
  stub.state.objectInfo.client = null;
  stub.state.objectInfo.gip = null;
  const page = await openChat();
  if (!app) throw Error('Missing app');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith('file:'))
      ?.setContentSize(1000, 720);
  });
  await openInfo(page);
  await expect(panel(page)).toContainText('В архиве');
  await expect(panel(page)).toContainText('Не указан');
  await expect(panel(page)).toContainText('Не выбрана');
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeDisabled();
  const bounds = await panel(page).boundingBox();
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  if (!bounds || !viewport) throw Error('Missing viewport');
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  await page.screenshot({ path: test.info().outputPath('object-info-narrow.png') });
});
test('поздние сведения после выхода не появляются у другого пользователя', async () => {
  stub.state.objectInfoDelayMs = 1000;
  const page = await openChat();
  await openInfo(page);
  await expect.poll(() => objectCalls().length).toBe(1);
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'Выйти из учётной записи', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  await expect(panel(page)).toHaveCount(0);
  stub.state.loginUserId = 2;
  if (!app) throw Error('Missing app');
  await signIn(app, page);
  await page.locator('.chat-row[data-chat-id="8"]').click();
  await expect(page.locator('.messages-scroll[data-chat-id="8"]')).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Тестовый заказчик');
  await expect(panel(page)).toHaveCount(0);
});
