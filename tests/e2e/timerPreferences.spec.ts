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
import type { DesktopBridge, DesktopTimer } from '../../src/bridge/protocol';
import { startDesktopStub } from './desktopStub';

const ROOT = resolve(__dirname, '../..');
interface Fixture extends Window {
  schemaDesktop: DesktopBridge;
  startBridge: () => Promise<void>;
  calls: { name: string; data: Record<string, unknown> }[];
}

let server: Awaited<ReturnType<typeof startDesktopStub>>;
const running: ElectronApplication[] = [];

test.beforeAll(async () => {
  server = await startDesktopStub();
});
test.afterAll(async () => {
  await server.close();
});
test.afterEach(async () => {
  for (const app of running.splice(0)) await app.close();
});

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'stdesk-timer-preferences-'));
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      autostart: false,
      trayHintShown: true,
      notifications: { sound: false },
      timer: { pauseOnLock: true, askOnUnlock: true, reminderTime: '23:30' },
    }),
  );
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      SCHEMA_TEAMS_USER_DATA: profile,
      SCHEMA_TEAMS_SERVER_URL: server.url,
      SCHEMA_TEAMS_EXPERIMENT: '',
      SCHEMA_TEAMS_EXPERIMENT_RUN: '',
    },
  });
  running.push(app);
  const page = await app.firstWindow();
  await expect(page.locator('#chat')).toBeVisible();
  const nativeWindow = await app.browserWindow(page);
  await expect.poll(() => nativeWindow.evaluate((win) => win.isVisible())).toBe(true);
  await app.evaluate(() => {
    const morning = new Date();
    morning.setHours(9, 0, 0, 0);
    Date.now = () => morning.getTime();
  });
  await page.evaluate(() => (window as unknown as Fixture).startBridge());
  return { app, page, profile };
}

async function menu(app: ElectronApplication): Promise<Page> {
  await app.evaluate(({ app, screen }) => {
    const load = process
      .getBuiltinModule('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const { desktop } = load(`${app.getAppPath()}/dist/main/index.js`) as {
      desktop: import('../../src/main/desktop/app').DesktopApp;
    };
    const area = screen.getPrimaryDisplay().workArea;
    desktop.showMenu({
      x: area.x + area.width - 50,
      y: area.y + area.height,
      width: 24,
      height: 24,
    });
  });
  await expect.poll(() => app.windows().length).toBeGreaterThan(1);
  const page = app
    .windows()
    .find((item) => item.url().includes(encodeURIComponent('data-action="open"')));
  if (!page) throw new Error('Меню не открылось');
  await expect(page.locator('[data-action="timer-settings"]')).toBeVisible();
  const nativeWindow = await app.browserWindow(page);
  await expect.poll(() => nativeWindow.evaluate((win) => win.isVisible())).toBe(true);
  return page;
}

async function preferences(app: ElectronApplication): Promise<Page> {
  const trayMenu = await menu(app);
  const next = app.waitForEvent('window');
  await trayMenu.locator('[data-action="timer-settings"]').click();
  const page = await next;
  await expect(page.locator('#reminder-time')).toBeVisible();
  return page;
}

test('настройки времени сохраняются; недоступная автопауза объяснена, окно изолировано', async () => {
  const { app, profile } = await launch();
  let settings = await preferences(app);
  await expect(settings.locator('#pause-on-lock')).toBeDisabled();
  await expect(settings.locator('#ask-on-unlock')).toBeDisabled();
  await expect(settings.locator('#pause-on-lock')).toBeChecked();
  await expect(settings.locator('#ask-on-unlock')).toBeChecked();
  await expect(settings.locator('.notice')).toContainText('требует обновления сервера');
  await expect(settings.locator('#workday-end')).toHaveText('Не передан сервером');
  await expect(settings.locator('#reminder-time option')).toHaveCount(48);
  await expect(settings.locator('#reminder-time')).toHaveValue('23:30');
  expect(
    await settings.evaluate(() => ({
      bridge: typeof (window as unknown as Fixture).schemaDesktop,
      node: typeof (window as unknown as { require?: unknown }).require,
    })),
  ).toEqual({ bridge: 'undefined', node: 'undefined' });
  await settings.screenshot({ path: test.info().outputPath('timer-preferences.png') });
  await settings.locator('#reminder-time').selectOption('17:00');
  const closed = settings.waitForEvent('close');
  await settings.locator('#save').click();
  await closed;
  expect(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))).toMatchObject({
    autostart: false,
    notifications: { sound: false },
    timer: { pauseOnLock: true, askOnUnlock: true, reminderTime: '17:00' },
  });
  settings = await preferences(app);
  await expect(settings.locator('#reminder-time')).toHaveValue('17:00');
  const cancelled = settings.waitForEvent('close');
  await settings.locator('#close').click();
  await cancelled;
});

test('после открытого выбора задачи команда «Закончить» открывает свежую форму завершения', async () => {
  const { app, page } = await launch();
  const timer: DesktopTimer = {
    state: 'run',
    task: { id: 4, mark: 'АР1', title: 'Тестовая задача' },
    startedAt: '2026-10-28T04:00:00.000Z',
    elapsedSec: 1800,
    reason: null,
  };
  await page.evaluate(
    (timer) => (window as unknown as Fixture).schemaDesktop.send('timer', timer),
    timer,
  );
  let trayMenu = await menu(app);
  const pickOpened = app.waitForEvent('window');
  await trayMenu.locator('[data-action="change"]').click();
  const pick = await pickOpened;
  await expect(pick).toHaveURL(`${server.url}desktop/pick`);
  trayMenu = await menu(app);
  const pickClosed = pick.waitForEvent('close');
  const finishOpened = app.waitForEvent('window');
  await trayMenu.locator('[data-action="stop"]').click();
  const finish = await finishOpened;
  await pickClosed;
  await expect(finish).toHaveURL(`${server.url}desktop/finish`);
  expect(pick.isClosed()).toBe(true);
  expect(app.windows().filter((item) => item.url().startsWith(`${server.url}desktop/`))).toEqual([
    finish,
  ]);
  expect(
    await finish.evaluate(() => ({
      bridge: typeof (window as unknown as Fixture).schemaDesktop,
      node: typeof (window as unknown as { require?: unknown }).require,
    })),
  ).toEqual({ bridge: 'undefined', node: 'undefined' });
  expect(
    await page.evaluate(() =>
      (window as unknown as Fixture).calls.filter((c) => c.name === 'timer'),
    ),
  ).toEqual([]);
});

test('переход выбора в завершение сохраняет черновик при повторном открытии и раннем push idle', async () => {
  const { app, page } = await launch();
  const timer: DesktopTimer = {
    state: 'run',
    task: { id: 4, mark: 'АР1', title: 'Тестовая задача' },
    startedAt: '2026-10-28T04:00:00.000Z',
    elapsedSec: 1800,
    reason: null,
  };
  await page.evaluate(
    (timer) => (window as unknown as Fixture).schemaDesktop.send('timer', timer),
    timer,
  );
  let trayMenu = await menu(app);
  const opened = app.waitForEvent('window');
  await trayMenu.locator('[data-action="change"]').click();
  const finish = await opened;
  await expect(finish).toHaveURL(`${server.url}desktop/pick`);
  // Серверная SPA меняет маршрут самостоятельно, не создавая новое окно.
  await finish.evaluate(() => {
    history.pushState({}, '', '/desktop/finish?next=5');
    const draft = document.createElement('textarea');
    draft.id = 'finish-draft';
    draft.value = 'Черновик трудозатрат';
    document.body.append(draft);
  });
  trayMenu = await menu(app);
  const newWindows: Page[] = [];
  const record = (window: Page) => newWindows.push(window);
  app.on('window', record);
  await trayMenu.locator('[data-action="stop"]').click();
  const nativeMenu = await app.browserWindow(trayMenu);
  await expect.poll(() => nativeMenu.evaluate((win) => win.isVisible())).toBe(false);
  await expect(finish).toHaveURL(`${server.url}desktop/finish?next=5`);
  await expect(finish.locator('#finish-draft')).toHaveValue('Черновик трудозатрат');
  expect(newWindows).toEqual([]);
  expect(app.windows().filter((item) => item.url().startsWith(`${server.url}desktop/`))).toEqual([
    finish,
  ]);
  app.removeListener('window', record);

  // Сокет может доставить idle раньше, чем форма обработала ответ записи.
  await page.evaluate(() =>
    (window as unknown as Fixture).schemaDesktop.send('timer', {
      state: 'idle',
      task: null,
      startedAt: null,
      elapsedSec: 0,
      reason: null,
    }),
  );
  expect(finish.isClosed()).toBe(false);
  await expect(finish).toHaveURL(`${server.url}desktop/finish?next=5`);
  await expect(finish.locator('#finish-draft')).toHaveValue('Черновик трудозатрат');
});
