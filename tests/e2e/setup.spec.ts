import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
const wizard = (page: Page) =>
  page.getByRole('dialog', { name: 'Настройка Schema Teams', exact: true });
const settingsFile = () => join(profile, 'settings.json');
const settingsValue = () =>
  existsSync(settingsFile())
    ? (JSON.parse(readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>)
    : {};
function active(): ElectronApplication {
  if (!app) throw Error('App unavailable');
  return app;
}
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-setup-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
async function launch(url = stub.url) {
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toBeVisible();
  return page;
}
async function checked(page: Page) {
  const p = wizard(page);
  await expect(p).toBeVisible();
  await expect(p.getByRole('button', { name: 'Далее', exact: true })).toBeDisabled();
  await p.getByRole('button', { name: 'Проверить связь', exact: true }).click();
  await expect(p).toContainText('✓ Сервер отвечает');
  await p.getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(p.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
}
async function login(page: Page) {
  const pending = active().waitForEvent('window');
  await wizard(page).getByRole('button', { name: 'Войти в Teams', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(wizard(page)).toContainText('Вход выполнен:');
}
async function toDone(page: Page, inventoryFailure = false) {
  await checked(page);
  if (await wizard(page).getByRole('button', { name: 'Войти в Teams', exact: true }).count())
    await login(page);
  if (inventoryFailure)
    await active().evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('module'),
        load = createRequire(`${app.getAppPath()}/package.json`),
        host = load('./dist/main/index.js') as {
          client: { inventory: { read: () => Promise<unknown> } };
        };
      host.client.inventory.read = async () => {
        throw Error('private-folder-error');
      };
    });
  await wizard(page).getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(wizard(page)).toContainText('Каталог плагинов бюро пока недоступен');
  await expect(
    wizard(page).getByRole('button', { name: 'Проверить папки ещё раз', exact: true }),
  ).toBeEnabled();
  await wizard(page)
    .getByRole('button', {
      name: inventoryFailure ? 'Продолжить без проверки Revit' : 'Далее',
      exact: true,
    })
    .click();
  await expect(wizard(page).getByRole('heading', { name: 'Готово', exact: true })).toBeVisible();
}
test('первый запуск проходит четыре шага, сохраняет готовность и не возвращает мастер после перезапуска', async () => {
  const page = await launch();
  await toDone(page);
  const p = wizard(page);
  await p.getByRole('checkbox', { name: 'Запускать вместе с Windows', exact: true }).uncheck();
  await p.getByRole('button', { name: 'Завершить настройку', exact: true }).click();
  await expect(p).toHaveCount(0);
  expect(settingsValue()).toMatchObject({ onboardingComplete: true, autostart: false });
  await app?.close();
  app = undefined;
  const again = await launch();
  await expect(again.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect(wizard(again)).toHaveCount(0);
  expect(
    stub.state.calls.filter((c) => c.method !== 'GET' && c.path !== '/api/auth/login'),
  ).toHaveLength(0);
});
test('старый сервер и отсутствие связи не разрешают продолжить первый шаг или закончить настройку', async () => {
  stub.state.healthVersion = '0.10.0';
  const page = await launch();
  const p = wizard(page);
  await expect(p).toBeVisible();
  await p.getByRole('button', { name: 'Проверить связь', exact: true }).click();
  await expect(p).toContainText('Нужен Schema Teams 0.11.0');
  await expect(p.getByRole('button', { name: 'Далее', exact: true })).toBeDisabled();
  const result = await page.evaluate(() =>
    window.teams.request({ kind: 'setup.finish', epoch: 0, autostart: true }),
  );
  expect(result.ok).toBe(false);
  expect(settingsValue().onboardingComplete).not.toBe(true);
  stub.state.healthVersion = '0.11.2';
  stub.state.healthOnline = false;
  await p.getByRole('button', { name: 'Проверить связь', exact: true }).click();
  await expect(p).toContainText('Сервер не подтвердил готовность');
});
test('прерванный после входа мастер начинается с проверки связи и сохраняет существующую авторизацию', async () => {
  const page = await launch();
  await checked(page);
  await login(page);
  await app?.close();
  app = undefined;
  const again = await launch();
  await expect(
    wizard(again).getByRole('heading', { name: 'Подключение', exact: true }),
  ).toBeVisible();
  await expect(again.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await toDone(again);
  await wizard(again).getByRole('button', { name: 'Завершить настройку', exact: true }).click();
  await expect(wizard(again)).toHaveCount(0);
  expect(stub.state.calls.filter((c) => c.path === '/api/auth/login')).toHaveLength(1);
});
test('прежний профиль не прерывается; повторная настройка закрывается с клавиатуры и сохраняет черновик', async () => {
  writeFileSync(settingsFile(), JSON.stringify({ theme: 'light', autostart: false }));
  const page = await launch();
  await expect(wizard(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  const pending = active().waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Сохранённый черновик');
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Пройти настройку заново', exact: true }).click();
  await expect(wizard(page)).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(
      (mode) => window.teams.request({ kind: 'settings.patch', patch: { theme: mode } }),
      theme,
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ path: test.info().outputPath(`setup-${theme}.png`) });
  }
  await active().evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith('file:'))
      ?.setSize(920, 700),
  );
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    expect(await wizard(page).evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  expect(await wizard(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(
    true,
  );
  await page.keyboard.press('Escape');
  await expect(wizard(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue(
    'Сохранённый черновик',
  );
});
test('ошибка сохранения не завершает мастер и не раскрывает подробности файловой системы', async () => {
  const page = await launch();
  await toDone(page);
  await active().evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`),
      host = load('./dist/main/index.js') as {
        client: { o: { settings: { update: (p: Record<string, unknown>) => void } } };
      },
      store = host.client.o.settings,
      update = store.update.bind(store);
    store.update = (patch) => {
      if (patch.onboardingComplete === true) throw Error('private-folder-error');
      update(patch);
    };
  });
  await wizard(page).getByRole('button', { name: 'Завершить настройку', exact: true }).click();
  await expect(wizard(page).getByRole('alert')).toContainText('Не удалось');
  await expect(wizard(page)).not.toContainText('private-folder-error');
  expect(settingsValue().onboardingComplete).not.toBe(true);
  await expect(
    wizard(page).getByRole('button', { name: 'Завершить настройку', exact: true }),
  ).toBeEnabled();
});
test('неудачная проверка Revit видна и допускает явное продолжение без установки плагинов', async () => {
  const page = await launch();
  await toDone(page, true);
  await wizard(page).getByRole('button', { name: 'Завершить настройку', exact: true }).click();
  await expect(wizard(page)).toHaveCount(0);
  expect(settingsValue().onboardingComplete).toBe(true);
  expect(stub.state.calls.some((c) => /plugins/.test(c.path))).toBe(false);
});
test('пустая сборка сохраняет подключение и продолжает мастер в новом окне', async () => {
  const page = await launch('');
  const p = wizard(page);
  await expect(p).toBeVisible();
  await p.getByRole('textbox', { name: 'Адрес сервера' }).fill(stub.url);
  await p.getByRole('button', { name: 'Проверить связь', exact: true }).click();
  await expect(p).toContainText('Сервер отвечает');
  await expect(p.getByRole('button', { name: 'Далее', exact: true })).toBeDisabled();
  await p.getByRole('checkbox', { name: /Подтверждаю смену адреса/ }).check();
  const pending = active().waitForEvent('window');
  await p.getByRole('button', { name: 'Применить адрес и выйти из Teams', exact: true }).click();
  const fresh = await pending;
  await toDone(fresh);
  await wizard(fresh).getByRole('button', { name: 'Завершить настройку', exact: true }).click();
  await expect(wizard(fresh)).toHaveCount(0);
  expect(settingsValue()).toMatchObject({
    onboardingComplete: true,
    serverUrl: new URL(stub.url).origin,
  });
});
