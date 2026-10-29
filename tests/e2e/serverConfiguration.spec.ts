import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';
const ROOT = resolve(__dirname, '../..');
let old: ClientStub, next: ClientStub, app: ElectronApplication | undefined, profile: string;
const panel = (page: Page) =>
  page.getByRole('region', { name: 'Подключение к Schema Teams', exact: true });
function activeApp(): ElectronApplication {
  if (!app) throw Error('App unavailable');
  return app;
}
test.beforeEach(async () => {
  old = await startClientStub();
  next = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-connection-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await old.close();
  await next.close();
});
async function launch(configured = true, environment = false) {
  if (configured)
    writeFileSync(
      join(profile, 'settings.json'),
      JSON.stringify({
        serverUrl: old.url,
        theme: 'light',
        recentTimeTaskIds: { '1': [703] },
        timerReminderSeen: { '1': '2026-10-29' },
      }),
    );
  app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      SCHEMA_TEAMS_USER_DATA: profile,
      SCHEMA_TEAMS_SERVER_URL: environment ? old.url : '',
    },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute(
    'data-connection',
    configured ? 'signedOut' : 'noServer',
  );
  return page;
}
async function login(page: Page) {
  if (!app) throw Error();
  const pending = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
}
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  return page.getByRole('dialog', { name: 'Настройки', exact: true });
}
async function check(page: Page, url = next.url) {
  await panel(page).getByRole('textbox', { name: 'Адрес сервера' }).fill(url);
  await panel(page).getByRole('button', { name: 'Проверить связь', exact: true }).click();
}
async function apply(page: Page) {
  if (!app) throw Error();
  await panel(page)
    .getByRole('checkbox', { name: /Подтверждаю смену адреса/ })
    .check();
  const pending = app.waitForEvent('window');
  await panel(page)
    .getByRole('button', { name: 'Применить адрес и выйти из Teams', exact: true })
    .click();
  const fresh = await pending;
  await expect(fresh.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  return fresh;
}
test('проверка чужого адреса без cookie; применение только после подтверждения, вход изолирован даже на том же хосте', async () => {
  const page = await launch();
  await login(page);
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Старый черновик');
  const oldPartition = await activeApp().evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module');
    const load = createRequire(`${app.getAppPath()}/package.json`);
    return (load('./dist/main/index.js') as { client: { partition: string } }).client.partition;
  });
  await settings(page);
  await check(page);
  await expect(panel(page)).toContainText('✓ Сервер отвечает, версия 0.11.2');
  const checked = next.state.calls.filter((c) => c.path === '/api/health');
  expect(checked).toHaveLength(1);
  expect(checked[0]).toMatchObject({ cookie: null, csrf: null, userId: null });
  const save = panel(page).getByRole('button', {
    name: 'Применить адрес и выйти из Teams',
    exact: true,
  });
  await expect(save).toBeDisabled();
  const fresh = await apply(page);
  await expect(fresh.locator('.chat-row')).toHaveCount(0);
  const persisted = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
  expect(persisted.serverUrl).toBe(new URL(next.url).origin);
  expect(persisted.serverPartition).not.toBe(oldPartition);
  expect(persisted.recentTimeTaskIds).toEqual({});
  expect(persisted.timerReminderSeen).toEqual({});
  const oldCookies = await activeApp().evaluate(
    async ({ session }, partition) => session.fromPartition(partition).cookies.get({}),
    oldPartition,
  );
  expect(oldCookies).toEqual([]);
  expect(
    next.state.calls.filter((c) => c.path === '/api/auth/me').every((c) => c.cookie === null),
  ).toBe(true);
  await login(fresh);
  await fresh.locator('.chat-row[data-chat-id="4"]').click();
  await expect(fresh.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('');
  const sourceHealth = old.state.calls.filter((c) => c.path === '/api/health').length;
  await activeApp().close();
  app = undefined;
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: '' },
  });
  const again = await app.firstWindow();
  await expect(again.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  expect(old.state.calls.filter((c) => c.path === '/api/health')).toHaveLength(sourceHealth);
  expect(next.state.timerWrites).toHaveLength(0);
  expect(
    next.state.calls.filter((c) => c.method !== 'GET' && c.path !== '/api/auth/login'),
  ).toHaveLength(0);
  await settings(again);
  await check(again, old.url);
  await expect(panel(again)).toContainText('Сервер отвечает');
  const returned = await apply(again);
  await expect(returned.locator('.chat-row')).toHaveCount(0);
  expect(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).serverPartition).not.toBe(
    persisted.serverPartition,
  );
});
test('неверная версия, отказ и redirect не меняют текущий вход или адрес', async () => {
  const page = await launch();
  await login(page);
  await settings(page);
  for (const version of ['0.9.0', '0.10.99']) {
    next.state.healthVersion = version;
    await check(page);
    await expect(panel(page)).toContainText('Нужен Schema Teams 0.11.0');
  }
  next.state.healthVersion = '0.11.2';
  next.state.healthOnline = false;
  await check(page);
  await expect(panel(page)).toContainText('Сервер не подтвердил готовность');
  next.state.healthOnline = true;
  next.state.healthRedirect = old.url + '/api/health';
  const before = old.state.calls.filter((c) => c.path === '/api/health').length;
  await check(page);
  await expect(panel(page)).toContainText('Сервер не подтвердил готовность');
  expect(old.state.calls.filter((c) => c.path === '/api/health')).toHaveLength(before);
  await check(page, 'https://user:password@example.org');
  await expect(panel(page)).toContainText('без пути, пароля и параметров');
  await expect(
    panel(page).getByRole('button', { name: 'Применить адрес и выйти из Teams', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  expect(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).serverUrl).toBe(old.url);
});
test('редактирование во время проверки отменяет её результат; обе темы и узкое окно читаемы', async () => {
  const page = await launch();
  const prefs = await settings(page);
  next.state.healthDelayMs = 250;
  await check(page);
  await panel(page)
    .getByRole('textbox', { name: 'Адрес сервера' })
    .fill('https://changed.example.test');
  await expect(
    panel(page).getByRole('button', { name: 'Проверить связь', exact: true }),
  ).toBeEnabled();
  await expect(panel(page).getByRole('checkbox')).toHaveCount(0);
  next.state.healthDelayMs = 0;
  await check(page);
  await expect(panel(page)).toContainText('Сервер отвечает');
  for (const theme of ['light', 'dark']) {
    await prefs.getByRole('combobox', { name: 'Тема оформления' }).selectOption(theme);
    await panel(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`server-${theme}.png`) });
  }
  await activeApp().evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'));
    w?.setSize(920, 700);
  });
  await panel(page).getByRole('checkbox').scrollIntoViewIfNeeded();
  expect(await panel(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});
test('сборка без адреса предлагает подключение до входа и сохраняет выбранный сервер', async () => {
  const page = await launch(false);
  await check(page);
  await expect(panel(page)).toContainText('Сервер отвечает');
  const fresh = await apply(page);
  await login(fresh);
  expect(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).serverUrl).toBe(
    new URL(next.url).origin,
  );
});
test('окружение запуска не допускает скрытого сохранения другого адреса', async () => {
  const page = await launch(true, true);
  await settings(page);
  await expect(panel(page).getByRole('textbox', { name: 'Адрес сервера' })).toBeDisabled();
  await expect(panel(page)).toContainText('только для чтения');
  const result = await page.evaluate(
    (url) => window.teams.request({ kind: 'server.check', url }),
    next.url,
  );
  expect(result).toMatchObject({ ok: false, code: 'configuration_locked' });
  expect(next.state.calls).toHaveLength(0);
});
test('запоздавшее подтверждение прежней отправки не попадает в новое окно и не повторяется на новом сервере', async () => {
  const page = await launch();
  await login(page);
  await page.locator('.chat-row[data-chat-id="4"]').click();
  old.state.sendDelayMs = 4000;
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Старое намерение');
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).press('Enter');
  await expect
    .poll(
      () =>
        old.state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chats/4/messages')
          .length,
    )
    .toBe(1);
  await settings(page);
  await check(page);
  await expect(panel(page)).toContainText('Сервер отвечает');
  const fresh = await apply(page);
  await login(fresh);
  await fresh.locator('.chat-row[data-chat-id="4"]').click();
  await expect
    .poll(() => old.messages().filter((message) => message.text === 'Старое намерение').length)
    .toBe(1);
  await expect(fresh.locator('.messages-scroll')).not.toContainText('Старое намерение');
  expect(
    next.state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chats/4/messages'),
  ).toHaveLength(0);
  await expect(fresh.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('');
});
test('сбой сохранения восстанавливает прежнее подключение и показывает причину', async () => {
  const page = await launch();
  await settings(page);
  await check(page);
  await expect(panel(page)).toContainText('Сервер отвечает');
  await activeApp().evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module');
    const load = createRequire(`${app.getAppPath()}/package.json`);
    const active = (
      load('./dist/main/index.js') as {
        client: { o: { settings: { update: (patch: unknown) => void } } };
      }
    ).client;
    active.o.settings.update = () => {
      throw Error('private failure');
    };
  });
  await panel(page).getByRole('checkbox').check();
  const pending = activeApp().waitForEvent('window');
  await panel(page)
    .getByRole('button', { name: 'Применить адрес и выйти из Teams', exact: true })
    .click();
  const fresh = await pending;
  await expect(fresh.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  await expect(panel(fresh)).toContainText('Адрес не изменён');
  await expect(panel(fresh).getByRole('textbox', { name: 'Адрес сервера' })).toHaveValue(
    new URL(old.url).origin,
  );
  expect(next.state.calls.filter((c) => c.path === '/api/auth/me')).toHaveLength(0);
});
