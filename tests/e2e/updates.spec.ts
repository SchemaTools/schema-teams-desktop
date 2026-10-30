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
import { releaseFixture } from '../fixtures/updates';
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
const banner = (page: Page) => page.getByRole('region', { name: 'Новая версия приложения' });
const about = (page: Page) => page.getByRole('dialog', { name: 'Настройки', exact: true });
const feedCalls = () => stub.state.calls.filter((c) => c.path === '/api/desktop/latest');
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-updates-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
async function launch(auth = false) {
  existingProfile(profile);
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  if (auth) {
    const pending = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await (await pending).locator('#sign-in').click();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'));
    w?.show();
    w?.focus();
  });
  return page;
}
async function openAbout(page: Page) {
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'О программе', exact: true }).click();
  await expect(about(page)).toBeVisible();
}
test('проверка при запуске работает до входа; заметки показаны текстом без загрузки установщика', async () => {
  stub.state.latest = {
    ...releaseFixture(),
    notes: 'Что нового\n<img src="https://example.test/secret" onerror="alert(1)">',
    privateToken: 'discard',
  };
  const page = await launch();
  await expect(banner(page)).toContainText('1.1.0');
  expect(feedCalls()).toHaveLength(1);
  expect(feedCalls()[0]?.userId).toBeNull();
  await banner(page).getByRole('button', { name: 'Что нового' }).click();
  const p = about(page);
  await expect(p.getByRole('region', { name: 'Что нового' })).toContainText('<img src=');
  await expect(p.getByRole('region', { name: 'Что нового' }).locator('img')).toHaveCount(0);
  await expect(p).toContainText(
    'Установка из приложения станет доступна после подключения сертификата бюро.',
  );
  expect(stub.state.calls.filter((c) => c.path.startsWith('/api/desktop/files/'))).toHaveLength(0);
  const snapshot = await page.evaluate(async () =>
    JSON.stringify(await window.teams.request({ kind: 'init' })),
  );
  expect(snapshot).not.toMatch(/privateToken|discard|sha256|Setup/);
  await page.screenshot({ path: test.info().outputPath('update-notes-light.png') });
  await page.evaluate(() => window.teams.request({ kind: 'theme', mode: 'dark' }));
  await page.screenshot({ path: test.info().outputPath('update-notes-dark.png') });
});
test('нет опубликованной сборки отличается от последней версии и от ошибки', async () => {
  const page = await launch();
  await openAbout(page);
  const p = about(page);
  await expect(p).toContainText('Администратор ещё не опубликовал сборку приложения.');
  stub.state.latest = releaseFixture('0.1.0');
  await p.getByRole('button', { name: 'Проверить обновления' }).click();
  await expect(p).toContainText('Новых опубликованных версий нет.');
  for (const mode of ['light', 'dark'] as const) {
    await page.evaluate((mode) => window.teams.request({ kind: 'theme', mode }), mode);
    await expect(p).toContainText('Установлена на этом компьютере:');
    await expect(p).toContainText('Опубликована на сервере: 0.1.0');
  }
  stub.state.latestStatus = 500;
  await p.getByRole('button', { name: 'Проверить обновления' }).click();
  await expect(p.getByRole('alert')).toContainText('Не удалось проверить обновления.');
  await expect(banner(page)).toHaveCount(0);
});
test('«Позже» скрывает ровно эту версию, новая версия и перезапуск возвращают баннер', async () => {
  stub.state.latest = releaseFixture();
  const page = await launch();
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole('button', { name: 'Позже' }).click();
  await expect(banner(page)).toHaveCount(0);
  await page.evaluate(() => window.teams.request({ kind: 'updates.check' }));
  await expect(banner(page)).toHaveCount(0);
  stub.state.latest = releaseFixture('1.2.0');
  await page.evaluate(() => window.teams.request({ kind: 'updates.check' }));
  await expect(banner(page)).toContainText('1.2.0');
  await banner(page).getByRole('button', { name: 'Позже' }).click();
  await expect(banner(page)).toHaveCount(0);
  if (!app) throw Error('App unavailable');
  await app.close();
  app = undefined;
  const again = await launch();
  await expect(banner(again)).toContainText('1.2.0');
});
test('поддельный URL и неверный манифест не дают баннер и не мешают чату', async () => {
  stub.state.latest = { ...releaseFixture(), url: 'https://other.example.test/evil.exe' };
  const page = await launch(true);
  await openAbout(page);
  await expect(about(page).getByRole('alert')).toContainText(
    'Сведения об обновлении не прошли проверку.',
  );
  await expect(banner(page)).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  expect(stub.state.calls.filter((c) => c.path.startsWith('/api/desktop/files/'))).toHaveLength(0);
});
test('совпадающие запросы coalesced, повтор не создаёт параллельных загрузок метаданных', async () => {
  const page = await launch();
  await expect.poll(() => feedCalls().length).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const s = await window.teams.request({ kind: 'init' });
        return s.ok ? s.data.updates?.status : '';
      }),
    )
    .toBe('unpublished');
  stub.state.latest = releaseFixture();
  stub.state.latestDelayMs = 500;
  const before = feedCalls().length;
  await page.evaluate(() =>
    Promise.all(Array.from({ length: 3 }, () => window.teams.request({ kind: 'updates.check' }))),
  );
  expect(feedCalls()).toHaveLength(before + 1);
  await expect(banner(page)).toBeVisible();
});
test('меню трея показывает доступную версию и открывает своё О программе', async () => {
  stub.state.latest = releaseFixture();
  const page = await launch(true);
  await expect(banner(page)).toBeVisible();
  if (!app) throw Error('App unavailable');
  const pending = app.waitForEvent('window');
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`),
      host = load('./dist/main/index.js') as {
        client?: { showMenu: (b: { x: number; y: number; width: number; height: number }) => void };
      };
    host.client?.showMenu({ x: 1000, y: 700, width: 24, height: 24 });
  });
  const tray = await pending;
  await tray.getByRole('button', { name: 'Доступна версия 1.1.0', exact: true }).click();
  await expect(about(page)).toBeVisible();
  await expect(about(page).getByRole('region', { name: 'Что нового' })).toContainText(
    releaseFixture().notes,
  );
});
