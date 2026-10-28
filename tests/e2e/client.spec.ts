import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureMessage, startClientStub, type ClientStub } from './clientStub';

const ROOT = resolve(__dirname, '..', '..');
let stub: ClientStub;
let app: ElectronApplication | undefined;
let profile: string;
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-client-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});

async function start() {
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  return { app, page };
}
async function signIn(app: ElectronApplication, page: Page) {
  const pending = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const login = await pending;
  await expect(login.locator('#sign-in')).toBeVisible();
  return login;
}
async function authenticated() {
  const { app, page } = await start();
  const login = await signIn(app, page);
  await login.locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect(page.locator('.chat-row[data-chat-id="4"]')).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().startsWith('file:'),
    );
    w?.show();
    w?.focus();
  });
  return { app, page };
}
async function selectChat(page: Page) {
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await expect(page.locator('.messages-scroll[data-chat-id="4"]')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeEnabled();
}
const sends = () =>
  stub.state.calls.filter(
    (call) => call.path === '/api/chats/4/messages' && call.method === 'POST',
  );
const epoch = (page: Page) =>
  page.evaluate(async () => {
    const result = await window.teams.request({ kind: 'init' });
    if (!result.ok) throw new Error('init failed');
    return result.data.epoch;
  });

test('вход изолирован от bridge, cookie/CSRF остаются в main, renderer fetch блокируется CSP', async () => {
  const { app, page } = await start();
  const login = await signIn(app, page);
  expect(
    await login.evaluate(() => ({
      bridge: typeof (window as unknown as { teams?: unknown }).teams,
      node: typeof (window as unknown as { require?: unknown }).require,
      cookie: document.cookie,
    })),
  ).toEqual({ bridge: 'undefined', node: 'undefined', cookie: '' });
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().startsWith('http:'),
    );
    const p = (
      w?.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }
    ).getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      preload: p.preload,
    };
  });
  expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  expect(prefs.preload).toBeFalsy();
  await login.locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  const snapshot = await page.evaluate(async () =>
    JSON.stringify(await window.teams.request({ kind: 'init' })),
  );
  expect(snapshot).not.toMatch(/csrf-test-only|fixture-session-|st_session/);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  const before = stub.state.calls.length;
  expect(
    await page.evaluate(async (url) => {
      try {
        await fetch(new URL('/api/auth/me', url));
        return 'allowed';
      } catch {
        return 'blocked';
      }
    }, stub.url),
  ).toBe('blocked');
  expect(stub.state.calls).toHaveLength(before);
  expect(stub.state.socketConnections).toBeGreaterThan(0);
  expect(
    stub.state.socketCookies.every((cookie) => /^st_session=fixture-session-/.test(cookie)),
  ).toBe(true);
});

test('свой чат загружает историю, Shift+Enter переносит строку, Enter отправляет один API-запрос', async () => {
  stub
    .messages()
    .unshift(
      ...Array.from({ length: 60 }, (_, index) =>
        fixtureMessage(index + 1, 4, `История ${index + 1}`),
      ),
    );
  const { page } = await authenticated();
  await selectChat(page);
  await expect(page.getByText('Проверьте узел 5', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Предыдущие сообщения', exact: true }).click();
  await expect(page.locator('[data-message-id="1"]')).toBeAttached();
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Первая строка');
  await input.press('Shift+Enter');
  await input.type('Вторая строка');
  expect(sends()).toHaveLength(0);
  await expect(input).toHaveValue('Первая строка\nВторая строка');
  stub.state.sendDelayMs = 350;
  await input.press('Enter');
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue('Первая строка\nВторая строка');
  await expect(input).toHaveValue('');
  expect(sends()).toHaveLength(1);
  expect(sends()[0]).toMatchObject({
    userId: 1,
    csrf: 'csrf-test-only-user-1',
    body: { text: 'Первая строка\nВторая строка' },
  });
  expect(sends()[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(
    stub.messages().filter((message) => message.text === 'Первая строка\nВторая строка'),
  ).toHaveLength(1);
});

test('потерянное подтверждение сохраняет черновик и повторяет тот же UUID без дубликата', async () => {
  const { page } = await authenticated();
  await selectChat(page);
  stub.state.lostAckOnce = true;
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Проверка потерянного подтверждения');
  await input.press('Enter');
  await expect(
    page.getByText('Отправка не подтверждена. При повторе приложение проверит ту же отправку.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(input).toHaveValue('Проверка потерянного подтверждения');
  expect(
    stub.messages().filter((message) => message.text === 'Проверка потерянного подтверждения'),
  ).toHaveLength(1);
  await page.getByRole('button', { name: 'Повторить отправку', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(sends()).toHaveLength(2);
  expect(sends()[0]?.requestId).toBe(sends()[1]?.requestId);
  expect(
    stub.messages().filter((message) => message.text === 'Проверка потерянного подтверждения'),
  ).toHaveLength(1);
});

test('реальный Socket.IO обновляет непрочитанное и после reconnect восстанавливает пропущенную историю', async () => {
  const { page } = await authenticated();
  const pushed = stub.push('Сообщение через WebSocket');
  await expect(page.locator('.chat-row[data-chat-id="4"] .preview')).toContainText(pushed.text);
  await expect(page.locator('.chat-row[data-chat-id="4"] .unread-badge')).toHaveText('3');
  await selectChat(page);
  await expect(page.locator(`[data-message-id="${pushed.id}"]`)).toContainText(pushed.text);
  const connections = stub.state.socketConnections;
  stub.disconnect();
  const missed = stub.push('Сообщение во время разрыва', 4, false);
  await expect
    .poll(() => stub.state.socketConnections, { timeout: 15000 })
    .toBeGreaterThan(connections);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect(page.locator(`[data-message-id="${missed.id}"]`)).toContainText(missed.text);
});

test('открытый сфокусированный чат не показывает popup, скрытое окно получает уведомление', async () => {
  const { app, page } = await authenticated();
  await app.evaluate(({ app, shell, powerMonitor }) => {
    const { createRequire } = process.getBuiltinModule('module');
    const load = createRequire(`${app.getAppPath()}/package.json`);
    const policy = load('./dist/main/desktop/notificationState.js') as {
      WindowsNotificationPolicy: { prototype: { allows(): Promise<boolean> } };
    };
    policy.WindowsNotificationPolicy.prototype.allows = async () => true;
    shell.beep = () => undefined;
    powerMonitor.getSystemIdleState = () => 'active';
  });
  await selectChat(page);
  const visible = stub.push('Видимое сообщение без popup');
  await expect(page.locator(`[data-message-id="${visible.id}"]`)).toBeAttached();
  expect(app.windows().filter((window) => window !== page)).toHaveLength(0);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith('file:'))
      ?.hide(),
  );
  const popup = app.waitForEvent('window');
  stub.push('Фоновое сообщение с popup');
  const notice = await popup;
  await expect(notice.locator('body')).toContainText('Фоновое сообщение с popup');
});

test('выход очищает экран и черновик, старый epoch не отправляет данные за нового пользователя', async () => {
  const { app, page } = await authenticated();
  await selectChat(page);
  const oldEpoch = await epoch(page);
  await page
    .getByRole('textbox', { name: 'Сообщение', exact: true })
    .fill('Секретный черновик владельца A');
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'Выйти из учётной записи', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveCount(0);
  stub.state.loginUserId = 2;
  const login = await signIn(app, page);
  await login.locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect(page.locator('.chat-row[data-chat-id="8"]')).toBeVisible();
  const before = stub.state.calls.length;
  const stale = await page.evaluate(
    async (epoch) => [
      await window.teams.request({
        kind: 'chat.send',
        epoch,
        chatId: 8,
        text: 'Секретный черновик владельца A',
        requestId: crypto.randomUUID(),
      }),
      await window.teams.request({ kind: 'chat.read', epoch, chatId: 8, upTo: 301 }),
      await window.teams.request({
        kind: 'open.path',
        epoch,
        path: '\\\\server\\project\\plan.pdf',
        reveal: false,
      }),
    ],
    oldEpoch,
  );
  expect(stale.map((result) => result.ok)).toEqual([false, false, false]);
  expect(stub.state.calls.slice(before).filter((call) => call.method === 'POST')).toHaveLength(0);
  await page.locator('.chat-row[data-chat-id="8"]').click();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('');
  await expect(page.locator('body')).not.toContainText('Исходные данные готовы');
  const log = readFileSync(join(profile, 'logs', 'app.log'), 'utf8');
  expect(log).not.toMatch(/csrf-test-only|fixture-session-|st_session=|Секретный черновик/);
});

test('служебный чат показывает реальные события и открывает путь на сайте через main', async () => {
  const { app, page } = await authenticated();
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    shell.openExternal = async (url: string) => {
      g.opened.push(url);
    };
  });
  await page.locator('.chat-row[data-chat-id="events"]').click();
  await expect(page.locator('.event-card')).toContainText('Тестовая задача');
  await page.getByRole('button', { name: 'Открыть на сайте', exact: true }).click();
  expect(await app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([
    new URL('/albums/21', stub.url).href,
  ]);
  await expect
    .poll(() =>
      stub.state.calls.some(
        (call) =>
          call.path === '/api/notifications/71/read' &&
          call.method === 'POST' &&
          call.csrf === 'csrf-test-only-user-1',
      ),
    )
    .toBe(true);
});

test('смена временного пароля завершается без смены cookie и URL окна входа', async () => {
  stub.state.mustChangePassword = true;
  const { app, page } = await start();
  const login = await signIn(app, page);
  await login.locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'passwordChange');
  await expect(page.getByRole('heading', { name: 'Завершите вход', exact: true })).toBeVisible();
  const cookies = await app.evaluate(async ({ session }) =>
    session.fromPartition('persist:teams').cookies.get({ name: 'st_session' }),
  );
  const url = login.url();
  stub.state.mustChangePassword = false;
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online', {
    timeout: 10000,
  });
  expect(login.isClosed()).toBe(true);
  expect(url).toContain('/signed-in');
  expect(
    await app.evaluate(async ({ session }) =>
      session.fromPartition('persist:teams').cookies.get({ name: 'st_session' }),
    ),
  ).toEqual(cookies);
  expect(stub.state.calls.filter((call) => call.path === '/api/auth/login')).toHaveLength(1);
});

test('карточка трея отправляет быстрый ответ в API и сохраняет общую тему', async () => {
  const { app, page } = await authenticated();
  const pending = app.waitForEvent('window');
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module');
    const load = createRequire(`${app.getAppPath()}/package.json`);
    const host = load('./dist/main/index.js') as {
      client?: { showMenu(bounds: { x: number; y: number; width: number; height: number }): void };
    };
    host.client?.showMenu({ x: 1000, y: 700, width: 24, height: 24 });
  });
  const tray = await pending;
  await expect(tray.locator('[data-surface="tray"]')).toBeVisible();
  const reply = tray.getByRole('textbox', { name: 'Ответить…', exact: true });
  await expect(reply).toBeEnabled();
  await tray.screenshot({ path: test.info().outputPath('tray-light.png') });
  await reply.fill('Ответ из трея');
  await reply.press('Enter');
  await expect(tray.getByText('Отправлено', { exact: true })).toBeVisible();
  expect(sends()).toHaveLength(1);
  expect(stub.messages().filter((message) => message.text === 'Ответ из трея')).toHaveLength(1);
  await tray.getByRole('combobox', { name: 'Тема', exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(tray.locator('html')).toHaveAttribute('data-theme', 'dark');
  await selectChat(page);
  await expect(page.getByText('Ответ из трея', { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('main-dark.png') });
  await page.evaluate(() => window.teams.request({ kind: 'theme', mode: 'light' }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(tray.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: test.info().outputPath('main-light.png') });
});
