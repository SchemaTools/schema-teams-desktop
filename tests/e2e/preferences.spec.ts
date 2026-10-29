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
import { timerFixture } from '../fixtures/time';
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
const panel = (page: Page) => page.getByRole('dialog', { name: 'Настройки', exact: true });
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-preferences-'));
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ timer: { pauseOnLock: false, askOnUnlock: false, reminderTime: '19:00' } }),
  );
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
async function launch(auth = false) {
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
async function open(page: Page, about = false) {
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page
    .getByRole('button', { name: about ? 'О программе' : 'Настройки', exact: true })
    .click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Закрыть настройки' })).toBeEnabled();
}
test('настройки доступны до входа, автозапуск и тема сохраняются после перезапуска', async () => {
  const page = await launch();
  await open(page);
  const p = panel(page),
    auto = p.getByRole('checkbox', { name: /Запускать вместе с Windows/ });
  await expect(auto).toBeChecked();
  await auto.click();
  await expect(p).toContainText('Настройки сохранены.');
  await expect(auto).not.toBeChecked();
  await p.getByRole('combobox', { name: 'Тема оформления' }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const raw = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
  expect(raw.autostart).toBe(false);
  expect(raw.timer).toEqual({ pauseOnLock: false, askOnUnlock: false, reminderTime: '19:00' });
  if (!app) throw Error('App unavailable');
  await app.close();
  app = undefined;
  const again = await launch();
  await open(again);
  await expect(
    panel(again).getByRole('checkbox', { name: /Запускать вместе с Windows/ }),
  ).not.toBeChecked();
  await expect(panel(again).getByRole('combobox', { name: 'Тема оформления' })).toHaveValue('dark');
});
test('уведомления выключаются сразу; скрытие текста и звук действуют на настоящую карточку', async () => {
  const page = await launch(true);
  if (!app) throw Error('App unavailable');
  await app.evaluate(({ app, shell }) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`),
      host = load('./dist/main/index.js') as {
        client?: { policy: { allows: () => Promise<boolean> } };
      };
    if (host.client) host.client.policy.allows = async () => true;
    (globalThis as typeof globalThis & { beeps: number }).beeps = 0;
    shell.beep = () => {
      (globalThis as typeof globalThis & { beeps: number }).beeps++;
    };
  });
  await open(page);
  const p = panel(page);
  await p.getByRole('tab', { name: 'Уведомления', exact: true }).click();
  await p.getByRole('checkbox', { name: /Всплывающие уведомления/ }).click();
  await expect(p).toContainText('Настройки сохранены.');
  await expect(p.getByRole('checkbox', { name: /Всплывающие уведомления/ })).not.toBeChecked();
  stub.push('Подавленное сообщение');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const s = await window.teams.request({ kind: 'init' });
        return s.ok ? s.data.chats[0]?.last?.preview : '';
      }),
    )
    .toBe('Подавленное сообщение');
  expect(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith('data:'))
          .length,
    ),
  ).toBe(0);
  await p.getByRole('checkbox', { name: /Показывать текст сообщения/ }).click();
  await expect(p.getByRole('checkbox', { name: /Показывать текст сообщения/ })).not.toBeChecked();
  await p.getByRole('checkbox', { name: /Звук уведомлений/ }).click();
  await expect(p.getByRole('checkbox', { name: /Звук уведомлений/ })).not.toBeChecked();
  await p.getByRole('checkbox', { name: /Всплывающие уведомления/ }).click();
  await expect(p.getByRole('checkbox', { name: /Всплывающие уведомления/ })).toBeChecked();
  const pending = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith('file:'))
      ?.hide(),
  );
  stub.push('Секретный текст фикстуры');
  const toast = await pending;
  await expect(toast.getByText('Новое сообщение', { exact: true })).toBeVisible();
  await expect(toast.locator('body')).not.toContainText('Секретный текст фикстуры');
  expect(
    await app.evaluate(() => (globalThis as typeof globalThis & { beeps: number }).beeps),
  ).toBe(0);
});
test('О программе показывает версии и открывает только фиксированную папку журналов', async () => {
  const page = await launch(true);
  if (!app) throw Error('App unavailable');
  await app.evaluate(({ shell }) => {
    shell.openPath = async (path) => {
      (globalThis as typeof globalThis & { logPath?: string }).logPath = path;
      return '';
    };
  });
  await open(page, true);
  const p = panel(page);
  await expect(p).toContainText('Версия приложения');
  await expect(p).toContainText('0.11.2');
  await expect(p).toContainText('В сети');
  await p.getByRole('button', { name: 'Открыть папку журналов' }).click();
  await expect(p).toContainText('Папка журналов открыта.');
  expect(
    await app.evaluate(() => (globalThis as typeof globalThis & { logPath?: string }).logPath),
  ).toBe(join(profile, 'logs'));
  await app.evaluate(({ shell }) => {
    shell.openPath = async () => 'C:/private/logs access denied';
  });
  await p.getByRole('button', { name: 'Открыть папку журналов' }).click();
  await expect(p.getByRole('alert')).toHaveText('Не удалось открыть папку журналов.');
  await expect(p).not.toContainText('C:/private');
});
test('учёт времени использует сохранённую настройку и серверный конец дня; остальные вкладки её не меняют', async () => {
  const page = await launch(true);
  await open(page);
  const p = panel(page);
  await p.getByRole('tab', { name: 'Учёт времени', exact: true }).click();
  await expect(p.getByRole('combobox', { name: 'Время напоминания' })).toHaveValue('19:00');
  await expect(p.locator('.timer-settings dd')).toHaveText('18:00');
  await p.getByRole('tab', { name: 'Общие', exact: true }).click();
  await p.getByRole('combobox', { name: 'Тема оформления' }).selectOption('dark');
  await p.getByRole('tab', { name: 'Учёт времени', exact: true }).click();
  await expect(p.getByRole('combobox', { name: 'Время напоминания' })).toHaveValue('19:00');
  await p.getByRole('tab', { name: 'Плагины Revit', exact: true }).click();
  await expect(p).toContainText('Каталог плагинов пока недоступен.');
});
test('настройки открываются из настоящего меню трея', async () => {
  const page = await launch(true);
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
  await tray.getByRole('button', { name: 'О программе', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('tab', { name: 'О программе', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
test('ошибка сохранения видна и не переводит переключатель в ложное состояние', async () => {
  const page = await launch();
  await open(page);
  if (!app) throw Error('App unavailable');
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`),
      host = load('./dist/main/index.js') as {
        client?: { o: { settings: { update: (p: unknown) => void } } };
      };
    if (!host.client) throw Error('Client unavailable');
    host.client.o.settings.update = () => {
      throw Error('private-file-path');
    };
  });
  const p = panel(page);
  await p.getByRole('tab', { name: 'Уведомления', exact: true }).click();
  const sound = p.getByRole('checkbox', { name: /Звук уведомлений/ });
  await sound.click();
  await expect(p.getByRole('alert')).toContainText('Не удалось сохранить настройки.');
  await expect(sound).toBeChecked();
  await expect(p).not.toContainText('private-file-path');
});
test('обе темы, узкое окно и клавиатура не ломают вкладки или возврат фокуса', async () => {
  const page = await launch(true);
  await open(page);
  const p = panel(page);
  if (!app) throw Error('App unavailable');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith('file:'))
      ?.setSize(800, 650),
  );
  for (const mode of ['light', 'dark'] as const) {
    await p.getByRole('combobox', { name: 'Тема оформления' }).selectOption(mode);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    expect(await p.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`preferences-${mode}.png`) });
  }
  await p.getByRole('tab', { name: 'Общие', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(p.getByRole('tab', { name: 'О программе', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(p.getByRole('tab', { name: 'Общие', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(p).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Меню', exact: true })).toBeFocused();
});
test('открытие настроек из трея сохраняет введённое примечание проверки таймера', async () => {
  stub.state.timers[1] = timerFixture('pause');
  const page = await launch(true);
  await page.getByRole('button', { name: 'Таймер', exact: true }).click();
  const timer = page.getByRole('dialog', { name: 'Учёт времени', exact: true });
  await timer.getByRole('button', { name: 'Закончить и проверить' }).click();
  await timer.getByLabel('Примечание', { exact: true }).fill('Не терять при настройках');
  await page.evaluate(() => window.teams.request({ kind: 'settings.open', tab: 'general' }));
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Закрыть настройки' }).click();
  await expect(timer).toBeVisible();
  await expect(timer.getByLabel('Примечание', { exact: true })).toHaveValue(
    'Не терять при настройках',
  );
  expect(stub.state.timerWrites).toHaveLength(0);
});
