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
import { writeFileSync } from 'node:fs';
import type {
  DesktopBridge,
  DesktopEventName,
  DesktopEvents,
  DesktopTimer,
} from '../../src/bridge/protocol';
import { startDesktopStub } from './desktopStub';

const ROOT = resolve(__dirname, '../..');
interface Fixture extends Window {
  schemaDesktop: DesktopBridge;
  startBridge: (protocol?: string, user?: number) => Promise<void>;
  calls: { name: string; data: Record<string, unknown> }[];
}
interface Harness {
  timerNow: number;
  idle: 'active' | 'locked';
  timerBeeps: number;
  allowTimerNotice: boolean;
}
const run: DesktopTimer = {
  state: 'run',
  task: { id: 4, mark: 'АР1', title: 'Тестовая задача' },
  startedAt: new Date(2026, 9, 28, 9).toISOString(),
  elapsedSec: 3600,
  reason: null,
};
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

async function launch(reminderTime = '23:30') {
  const profile = mkdtempSync(join(tmpdir(), 'stdesk-timer-'));
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      trayHintShown: true,
      notifications: { sound: true },
      timer: { reminderTime },
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
  await app.evaluate(
    ({ app, powerMonitor, shell }, now) => {
      const load = process
        .getBuiltinModule('module')
        .createRequire(`${app.getAppPath()}/package.json`);
      const { WindowsNotificationPolicy } = load(
        `${app.getAppPath()}/dist/main/desktop/notificationState.js`,
      ) as {
        WindowsNotificationPolicy: typeof import('../../src/main/desktop/notificationState').WindowsNotificationPolicy;
      };
      const g = globalThis as unknown as Harness;
      g.timerNow = now;
      g.idle = 'active';
      g.timerBeeps = 0;
      g.allowTimerNotice = true;
      Date.now = () => g.timerNow;
      powerMonitor.getSystemIdleState = () => g.idle;
      shell.beep = () => {
        g.timerBeeps++;
      };
      WindowsNotificationPolicy.prototype.allows = () => Promise.resolve(g.allowTimerNotice);
    },
    new Date(2026, 9, 28, 19).getTime(),
  );
  await page.evaluate(() => (window as unknown as Fixture).startBridge());
  return { app, page };
}
async function send<E extends DesktopEventName>(page: Page, name: E, data: DesktopEvents[E]) {
  await page.evaluate(
    ({ name, data }) => (window as unknown as Fixture).schemaDesktop.send(name, data),
    { name, data },
  );
}
async function power(
  app: ElectronApplication,
  name: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume',
) {
  await app.evaluate(({ powerMonitor }, name) => {
    const g = globalThis as unknown as Harness;
    if (name === 'lock-screen') g.idle = 'locked';
    if (name === 'unlock-screen') g.idle = 'active';
    g.timerNow += 60000;
    powerMonitor.emit(name);
  }, name);
}
async function tick(app: ElectronApplication) {
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const { desktop } = load(`${app.getAppPath()}/dist/main/index.js`) as {
      desktop: { timers: { poll: () => void } };
    };
    (globalThis as unknown as Harness).timerNow += 61000;
    desktop.timers.poll();
  });
}
async function notices(app: ElectronApplication) {
  return app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        (win) => win.getTitle() === 'Schema Teams — уведомление' && win.isVisible(),
      ).length,
  );
}
async function popup(app: ElectronApplication, title: string) {
  await expect.poll(() => notices(app)).toBe(1);
  const page = app.windows().find((p) => p.url().startsWith('data:'));
  if (!page) throw new Error('Нет напоминания');
  await expect(page.locator('h1')).toHaveText(title);
  return page;
}
const timerCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as Fixture).calls.filter((call) => call.name === 'timer'));

test('lock/sleep не мутируют серверный таймер; предупреждение появляется после полного возврата', async () => {
  const { app, page } = await launch();
  await send(page, 'timer', run);
  await power(app, 'lock-screen');
  await power(app, 'suspend');
  await power(app, 'resume');
  expect(await notices(app)).toBe(0);
  expect(await timerCalls(page)).toEqual([]);
  await power(app, 'unlock-screen');
  const notice = await popup(app, 'Автоматическая пауза не подтверждена');
  await expect(notice.locator('body')).toContainText('таймер мог продолжать идти');
  await expect(notice.locator('body')).not.toContainText('это время не учтено');
  await expect(notice.getByRole('button', { name: 'Продолжить', exact: true })).toHaveCount(0);
  await notice.getByRole('button', { name: 'Понятно', exact: true }).click();
  await tick(app);
  expect(await notices(app)).toBe(0);
  expect(await timerCalls(page)).toEqual([]);
});

test('выход и другой пользователь во время блокировки отменяют прежнее предупреждение', async () => {
  const { app, page } = await launch();
  await send(page, 'timer', run);
  await power(app, 'lock-screen');
  await send(page, 'signedOut', {});
  await page.evaluate(() => (window as unknown as Fixture).startBridge('1.1', 2));
  await power(app, 'unlock-screen');
  await tick(app);
  expect(await notices(app)).toBe(0);
  expect(await timerCalls(page)).toEqual([]);
});

test('вечернее напоминание учитывает DND, показывается один раз и «Ещё работаю» не меняет таймер', async () => {
  const { app, page } = await launch('18:30');
  await app.evaluate(() => {
    (globalThis as unknown as Harness).allowTimerNotice = false;
  });
  await send(page, 'timer', run);
  await expect.poll(() => app.windows().length).toBe(1);
  expect(await app.evaluate(() => (globalThis as unknown as Harness).timerBeeps)).toBe(0);
  await app.evaluate(() => {
    (globalThis as unknown as Harness).allowTimerNotice = true;
  });
  await tick(app);
  const notice = await popup(app, 'Таймер ещё идёт');
  await notice.screenshot({ path: test.info().outputPath('timer-reminder.png') });
  await expect(notice.locator('body')).toContainText('АР1');
  await notice.getByRole('button', { name: 'Ещё работаю', exact: true }).click();
  await tick(app);
  await page.evaluate(() => (window as unknown as Fixture).startBridge());
  await send(page, 'timer', run);
  await tick(app);
  expect(await notices(app)).toBe(0);
  expect(await timerCalls(page)).toEqual([]);
  expect(await app.evaluate(() => (globalThis as unknown as Harness).timerBeeps)).toBe(1);
});

test('«Закончить работу» требует явного нажатия и открывает серверную форму', async () => {
  const { app, page } = await launch('18:30');
  await send(page, 'timer', run);
  const notice = await popup(app, 'Таймер ещё идёт');
  const next = app.waitForEvent('window');
  await notice.getByRole('button', { name: 'Закончить работу', exact: true }).click();
  const finish = await next;
  await expect(finish).toHaveURL(`${server.url}desktop/finish`);
  expect(await timerCalls(page)).toEqual([]);
});

test('изменение таймера и offline убирают устаревшее вечернее действие', async () => {
  const { app, page } = await launch('18:30');
  await send(page, 'timer', run);
  await popup(app, 'Таймер ещё идёт');
  await send(page, 'connection', 'offline');
  await expect.poll(() => notices(app)).toBe(0);
  await send(page, 'connection', 'online');
  await send(page, 'timer', { ...run, state: 'pause', reason: 'manual' });
  await tick(app);
  expect(await notices(app)).toBe(0);
  expect(await timerCalls(page)).toEqual([]);
});

test('напоминание и чат используют общую стопку; смена таймера сохраняет черновик чата', async () => {
  const { app, page } = await launch('18:30');
  await send(page, 'timer', run);
  await popup(app, 'Таймер ещё идёт');
  const next = app.waitForEvent('window');
  // Даже ключ сервера, совпадающий с локальным id, не заменяет напоминание.
  await send(page, 'notify', {
    key: 'timer-reminder:1:2026-10-28',
    kind: 'message',
    title: 'Тестовый чат',
    text: 'Сообщение стенда',
    author: null,
    link: '/chat/7',
    chatId: 7,
    messageId: 11,
    count: 1,
    buttons: ['reply'],
    read: null,
  });
  const chat = await next;
  await expect(chat.locator('#reply')).toBeVisible();
  await chat.locator('#reply').fill('Черновик для проверки');
  await expect.poll(() => notices(app)).toBe(2);
  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => win.getTitle() === 'Schema Teams — уведомление' && win.isVisible())
      .map((win) => win.getBounds())
      .sort((a, b) => a.y - b.y),
  );
  expect(bounds).toHaveLength(2);
  expect((bounds[0]?.y ?? 0) + (bounds[0]?.height ?? 0)).toBeLessThanOrEqual(bounds[1]?.y ?? 0);
  await send(page, 'timer', { ...run, state: 'pause', reason: 'manual' });
  await expect.poll(() => notices(app)).toBe(1);
  await expect(chat.locator('#reply')).toHaveValue('Черновик для проверки');
});
