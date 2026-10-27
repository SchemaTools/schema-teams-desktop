import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  DesktopBridge,
  DesktopNotify,
  DesktopEventName,
  DesktopEvents,
} from '../../src/bridge/protocol';
import { startDesktopStub } from './desktopStub';

const ROOT = resolve(__dirname, '../..');
interface Fixture extends Window {
  schemaDesktop: DesktopBridge;
  startBridge: (protocol?: string, user?: number) => Promise<void>;
  failReplies: number;
  calls: { name: string; data: Record<string, unknown> }[];
  delivered: { requestId: string; text: string }[];
}
interface PolicyHarness {
  allowNotice: boolean;
  lastTip: string;
  beepCount: number;
  policyCalls: number;
  answers: boolean[];
  holdPolicy: boolean;
  finishPolicy?: (answer: boolean) => void;
}
const message: DesktopNotify = {
  key: 'chat:7',
  kind: 'message',
  title: 'Тестовый чат',
  text: 'Сообщение стенда',
  author: 'Иванова И.И.',
  link: '/chat/7?m=11',
  chatId: 7,
  messageId: 11,
  count: 1,
  buttons: ['reply', 'open', 'read'],
  read: { kind: 'chat', chatId: 7, messageId: 11 },
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

async function launch(protocol = '1.1', preferences: { sound?: boolean; enabled?: boolean } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'stdesk-bridge-'));
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ notifications: { sound: false, ...preferences }, trayHintShown: true }),
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
  const mainWindow = await app.browserWindow(page);
  await expect.poll(() => mainWindow.evaluate((win) => win.isVisible())).toBe(true);
  // Управляем только системной политикой. Все IPC, preload и команды — реальные.
  await app.evaluate(({ app, Tray, shell }) => {
    const load = process
      .getBuiltinModule('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const { WindowsNotificationPolicy } = load(
      `${app.getAppPath()}/dist/main/desktop/notificationState.js`,
    ) as {
      WindowsNotificationPolicy: typeof import('../../src/main/desktop/notificationState').WindowsNotificationPolicy;
    };
    const g = globalThis as unknown as PolicyHarness;
    g.allowNotice = true;
    g.lastTip = '';
    g.beepCount = 0;
    g.policyCalls = 0;
    g.answers = [];
    g.holdPolicy = false;
    WindowsNotificationPolicy.prototype.allows = () => {
      g.policyCalls++;
      const answer = g.answers.shift();
      if (typeof answer === 'boolean') return Promise.resolve(answer);
      if (g.holdPolicy) return new Promise<boolean>((finish) => (g.finishPolicy = finish));
      return Promise.resolve(g.allowNotice);
    };
    shell.beep = () => {
      g.beepCount++;
    };
    const original = Tray.prototype.setToolTip;
    Tray.prototype.setToolTip = function (text: string) {
      g.lastTip = text;
      original.call(this, text);
    };
  });
  await page.evaluate((protocol) => (window as unknown as Fixture).startBridge(protocol), protocol);
  return { app, page, profile };
}
async function send<E extends DesktopEventName>(page: Page, name: E, data: DesktopEvents[E]) {
  await page.evaluate(
    ({ name, data }) => (window as unknown as Fixture).schemaDesktop.send(name, data),
    { name, data },
  );
}
async function popup(app: ElectronApplication, page: Page, data = message) {
  const next = app.waitForEvent('window');
  await send(page, 'notify', data);
  const notice = await next;
  await expect(notice.locator('body')).toContainText(data.title);
  return notice;
}
async function menu(app: ElectronApplication) {
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
  const p = app.windows().find((p) => p.url().startsWith('data:'));
  if (!p) throw new Error('Меню не открылось');
  await expect(p.locator('[data-action="open"]')).toBeVisible();
  const nativeWindow = await app.browserWindow(p);
  await expect.poll(() => nativeWindow.evaluate((win) => win.isVisible())).toBe(true);
  return p;
}
const tip = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { lastTip: string }).lastTip);
const policy = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as PolicyHarness;
    return {
      calls: g.policyCalls,
      beeps: g.beepCount,
      pending: typeof g.finishPolicy === 'function',
    };
  });
const notificationWindows = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows().filter(
      (win) => win.getTitle() === 'Schema Teams — уведомление',
    );
    return { total: windows.length, visible: windows.filter((win) => win.isVisible()).length };
  });

test('быстрый ответ: ошибка сохраняет текст, повтор с тем же requestId доставляет один ответ', async () => {
  const { app, page, profile } = await launch();
  await page.evaluate(() => ((window as unknown as Fixture).failReplies = 1));
  const notice = await popup(app, page);
  const field = notice.locator('#reply');
  await field.fill('первая');
  await field.press('Shift+Enter');
  await field.pressSequentially('вторая');
  await expect(field).toHaveValue('первая\nвторая');
  await field.press('Enter');
  await expect(notice.locator('#status')).toHaveText('Не отправлено: Нет связи');
  await expect(field).toHaveValue('первая\nвторая');
  await field.press('Enter');
  await expect(notice.locator('#status')).toHaveText('Отправлено в «Тестовый чат»');
  const calls = await page.evaluate(() =>
    (window as unknown as Fixture).calls.filter((c) => c.name === 'reply'),
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]?.data.requestId).toEqual(expect.any(String));
  expect(calls[0]?.data.requestId).toBe(calls[1]?.data.requestId);
  expect(await page.evaluate(() => (window as unknown as Fixture).delivered)).toHaveLength(1);
  expect(readFileSync(join(profile, 'logs/app.log'), 'utf8')).not.toContain('первая');
});

test('щелчок по уведомлению открывает нужный чат, кнопки передают точные цели', async () => {
  const { app, page } = await launch();
  let notice = await popup(app, page);
  await notice.screenshot({ path: test.info().outputPath('notification.png') });
  await notice.locator('h1').click();
  await expect(page).toHaveURL(`${server.url}chat/7?m=11`);
  notice = await popup(app, page, { ...message, key: 'read' });
  await notice.getByRole('button', { name: 'Прочитано', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Fixture).calls.find((c) => c.name === 'markRead')?.data,
      ),
    )
    .toMatchObject({ kind: 'chat', chatId: 7, messageId: 11 });
  notice = await popup(app, page, {
    ...message,
    key: 'task',
    kind: 'notification',
    buttons: ['open', 'startTimer'],
    taskId: 4,
  });
  await notice.getByRole('button', { name: 'Начать работу', exact: false }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Fixture).calls.find((c) => c.name === 'timer')?.data,
      ),
    )
    .toMatchObject({ action: 'start', taskId: 4 });
});

test('счётчики, потеря связи, фокус и выход не дают запоздавших уведомлений', async () => {
  const { app, page } = await launch();
  await send(page, 'counters', { chat: 3, notifications: 4 });
  await expect.poll(() => tip(app)).toContain('7');
  await send(page, 'connection', 'offline');
  await expect.poll(() => tip(app)).toContain('Нет связи');
  await send(page, 'notify', message);
  expect(app.windows()).toHaveLength(1);
  await send(page, 'connection', 'online');
  await expect.poll(() => tip(app)).not.toContain('Нет связи');
  await send(page, 'focus', { until: new Date(Date.now() + 60000).toISOString() });
  await send(page, 'notify', message);
  expect(app.windows()).toHaveLength(1);
  const mention = await popup(app, page, { ...message, kind: 'mention' });
  await mention.locator('#reply').fill('черновик');
  await send(page, 'signedOut', {});
  await expect.poll(() => app.windows().length).toBe(1);
  await expect.poll(() => tip(app)).toContain('Нет связи');
  await send(page, 'notify', message);
  expect(app.windows()).toHaveLength(1);
  await page.evaluate(() => (window as unknown as Fixture).startBridge('1.1', 2));
  await expect.poll(() => tip(app)).not.toContain('7');
});

test('несовместимая версия работает только как окно; iframe не получает мост', async () => {
  const { app, page } = await launch('2.0');
  await expect(page.locator('#schema-desktop-warning')).toBeVisible();
  await send(page, 'notify', message);
  expect(app.windows()).toHaveLength(1);
  const result = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.src = '/child';
    document.body.append(frame);
    await new Promise((resolve) => (frame.onload = resolve));
    return typeof (frame.contentWindow as unknown as Fixture).schemaDesktop;
  });
  expect(result).toBe('undefined');
  // main loadURL используется только тестом: проверяем preload при чужом origin.
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('Нет главного окна');
    await win.loadURL('data:text/html,<h1>other</h1>');
  });
  expect(await page.evaluate(() => typeof (window as unknown as Fixture).schemaDesktop)).toBe(
    'undefined',
  );
});

test('меню открывает колокольчик, включает фокус и отдельную серверную страницу таймера', async () => {
  const { app, page } = await launch();
  let trayMenu = await menu(app);
  await trayMenu.locator('[data-action="notifications"]').click();
  await expect(page.locator('#bell')).toBeVisible();
  trayMenu = await menu(app);
  await trayMenu.locator('summary').click();
  await trayMenu.locator('[data-action="focus-30"]').click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as Fixture).calls.find((c) => c.name === 'focus')?.data.until,
      ),
    )
    .toEqual(expect.any(String));
  trayMenu = await menu(app);
  await expect(trayMenu.locator('header')).toContainText('фокусе');
  const next = app.waitForEvent('window');
  await trayMenu.locator('[data-action="start"]').click();
  const timer = await next;
  await expect(timer).toHaveURL(`${server.url}desktop/pick`);
  expect(await timer.evaluate(() => typeof (window as unknown as Fixture).schemaDesktop)).toBe(
    'undefined',
  );
  expect(
    await timer.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
  ).toBe('undefined');
});

test('системный запрет скрывает сообщение и упоминание без звука; после него приходит только новое событие', async () => {
  const { app, page } = await launch('1.1', { sound: true });
  await app.evaluate(
    () => ((globalThis as unknown as { allowNotice: boolean }).allowNotice = false),
  );
  await send(page, 'counters', { chat: 2, notifications: 0 });
  await send(page, 'notify', message);
  await send(page, 'notify', { ...message, key: 'mention:11', kind: 'mention' });
  await expect.poll(async () => (await policy(app)).calls).toBe(2);
  await expect.poll(() => tip(app)).toContain('2');
  // Барьер двух процессов: событие уже принято, async policy успела завершиться.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  expect(await notificationWindows(app)).toEqual({ total: 0, visible: 0 });
  expect((await policy(app)).beeps).toBe(0);
  await app.evaluate(() => {
    (globalThis as unknown as PolicyHarness).allowNotice = true;
  });
  // Снятие запрета само по себе не должно воспроизводить пропущенные события.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  expect(await notificationWindows(app)).toEqual({ total: 0, visible: 0 });
  expect((await policy(app)).beeps).toBe(0);
  const notice = await popup(app, page, {
    ...message,
    key: 'new-event',
    text: 'Только новое событие',
  });
  await expect(notice.locator('body')).toContainText('Только новое событие');
  await expect(notice.locator('body')).not.toContainText(message.text);
  await expect.poll(async () => (await policy(app)).beeps).toBe(1);
  expect(await notificationWindows(app)).toEqual({ total: 1, visible: 1 });
});

test('разрешённое уведомление показывает одно окно и проигрывает один звук после двух проверок', async () => {
  const { app, page } = await launch('1.1', { sound: true });
  await popup(app, page);
  await expect.poll(async () => (await policy(app)).calls).toBe(2);
  await expect.poll(async () => (await policy(app)).beeps).toBe(1);
  expect(await notificationWindows(app)).toEqual({ total: 1, visible: 1 });
});

test('выключенные уведомления подавляют окно и звук до запроса системной политики', async () => {
  const { app, page } = await launch('1.1', { enabled: false, sound: true });
  await send(page, 'notify', message);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  expect(await notificationWindows(app)).toEqual({ total: 0, visible: 0 });
  expect(await policy(app)).toEqual({ calls: 0, beeps: 0, pending: false });
});

test('выключенный звук сохраняет показ разрешённого уведомления', async () => {
  const { app, page } = await launch('1.1', { sound: false });
  await popup(app, page);
  await expect.poll(() => notificationWindows(app)).toEqual({ total: 1, visible: 1 });
  expect((await policy(app)).beeps).toBe(0);
});

test('включение системного запрета перед фактическим показом не даёт окна и звука', async () => {
  const { app, page } = await launch('1.1', { sound: true });
  await app.evaluate(() => {
    const g = globalThis as unknown as PolicyHarness;
    g.allowNotice = false;
    g.answers = [true, false];
  });
  await send(page, 'notify', message);
  await expect.poll(async () => (await policy(app)).calls).toBe(2);
  await expect.poll(() => notificationWindows(app)).toEqual({ total: 0, visible: 0 });
  expect((await policy(app)).beeps).toBe(0);
});

for (const change of ['signedOut', 'offline'] as const) {
  test(`ожидание повторной политики и ${change} не оставляют запоздалого окна или звука`, async () => {
    const { app, page } = await launch('1.1', { sound: true });
    await app.evaluate(() => {
      const g = globalThis as unknown as PolicyHarness;
      g.answers = [true];
      g.holdPolicy = true;
    });
    await send(page, 'notify', message);
    await expect.poll(async () => (await policy(app)).pending).toBe(true);
    expect((await policy(app)).calls).toBe(2);
    expect((await notificationWindows(app)).visible).toBe(0);
    if (change === 'signedOut') await send(page, 'signedOut', {});
    else await send(page, 'connection', 'offline');
    await app.evaluate(async () => {
      const g = globalThis as unknown as PolicyHarness;
      g.holdPolicy = false;
      const finish = g.finishPolicy;
      delete g.finishPolicy;
      finish?.(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    await expect.poll(() => notificationWindows(app)).toEqual({ total: 0, visible: 0 });
    expect((await policy(app)).beeps).toBe(0);
  });
}
