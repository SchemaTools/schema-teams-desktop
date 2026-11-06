import { existingProfile } from './existingProfile';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';

// Ревью PR #6: дыра в истории, «в сети» без WebSocket, запасной polling, событие session.
const ROOT = resolve(__dirname, '..', '..');
let stub: ClientStub | undefined;
let app: ElectronApplication | undefined;
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub?.close();
  stub = undefined;
});

async function authenticated(server: ClientStub) {
  const profile = mkdtempSync(join(tmpdir(), 'stdesk-pr6-'));
  existingProfile(profile);
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: server.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut', {
    // первый запрос на холодном раннере CI может висеть до DEADLINE (15 с) + повтор
    timeout: 35_000,
  });
  const pending = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect(page.locator('.chat-row[data-chat-id="4"]')).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().startsWith('file:'),
    );
    w?.show();
    w?.focus();
  });
  return page;
}
const shownIds = (page: import('@playwright/test').Page) =>
  page
    .locator('.messages-scroll [data-message-id]')
    .evaluateAll((nodes) => nodes.map((node) => Number((node as HTMLElement).dataset.messageId)));
async function openChat(page: import('@playwright/test').Page) {
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await expect(page.locator('.messages-scroll[data-chat-id="4"]')).toBeVisible();
  await expect(page.locator('[data-message-id="102"]')).toBeAttached();
}

test('пропущенное во время разрыва дозапрашивается страницами after без дыры', async () => {
  stub = await startClientStub();
  const page = await authenticated(stub);
  await openChat(page);
  const missed = stub.pushMany(120);
  stub.emit('chat:list', undefined);
  const last = missed[missed.length - 1]?.id ?? 0;
  await expect(page.locator(`[data-message-id="${last}"]`)).toBeAttached();
  const expected = stub.messages().map((message) => message.id);
  expect(await shownIds(page)).toEqual(expected);
  const afterCalls = stub.state.calls.filter(
    (call) => call.path.startsWith('/api/chats/4/messages?after=') && call.method === 'GET',
  );
  expect(afterCalls.map((call) => call.path)).toEqual([
    '/api/chats/4/messages?after=102',
    `/api/chats/4/messages?after=${missed[49]?.id}`,
  ]);
});

test('незакрываемый разрыв заменяет ленту новейшей страницей, а не склеивает', async () => {
  stub = await startClientStub();
  const page = await authenticated(stub);
  await openChat(page);
  const missed = stub.pushMany(250);
  stub.emit('chat:list', undefined);
  const last = missed[missed.length - 1]?.id ?? 0;
  await expect(page.locator(`[data-message-id="${last}"]`)).toBeAttached();
  await expect(page.locator('[data-message-id="102"]')).toHaveCount(0);
  const ids = await shownIds(page);
  expect(ids).toEqual(missed.slice(-50).map((message) => message.id));
  await expect(
    page.getByRole('button', { name: 'Предыдущие сообщения', exact: true }),
  ).toBeVisible();
});

test('без WebSocket приложение остаётся «в сети»: история и отправка по REST', async () => {
  stub = await startClientStub();
  stub.state.socketBlocked = true;
  const page = await authenticated(stub);
  expect(stub.state.socketConnections).toBe(0);
  await openChat(page);
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await expect(input).toBeEnabled();
  await input.fill('Отправка без сокета');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(stub.messages().some((message) => message.text === 'Отправка без сокета')).toBe(true);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
});

test('разрыв сокета при живом сервере не показывает «Нет связи»', async () => {
  stub = await startClientStub();
  const page = await authenticated(stub);
  await expect.poll(() => stub?.state.socketConnections ?? 0).toBeGreaterThan(0);
  stub.state.socketBlocked = true;
  stub.disconnect();
  await page.waitForTimeout(1500);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  // Сокет вернулся, затем сервер стал недоступен — «Нет связи».
  const connections = stub.state.socketConnections;
  stub.state.socketBlocked = false;
  await expect
    .poll(() => stub?.state.socketConnections ?? 0, { timeout: 15000 })
    .toBeGreaterThan(connections);
  stub.state.healthOnline = false;
  stub.disconnect();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'offline');
});

test('запасной транспорт: при сервере только с long-polling события сокета доходят', async () => {
  stub = await startClientStub({ socketTransports: ['polling'] });
  const page = await authenticated(stub);
  await expect.poll(() => stub?.state.socketTransports ?? []).toContain('polling');
  const pushed = stub.push('Сообщение через polling');
  await expect(page.locator('.chat-row[data-chat-id="4"] .preview')).toContainText(pushed.text);
});

test('событие session того же пользователя не сбрасывает черновик и вход', async () => {
  stub = await startClientStub();
  const page = await authenticated(stub);
  await openChat(page);
  const epoch = () =>
    page.evaluate(async () => {
      const result = await window.teams.request({ kind: 'init' });
      if (!result.ok) throw new Error('init failed');
      return result.data.epoch;
    });
  const before = await epoch();
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Черновик до события session');
  const auth = () => stub?.state.calls.filter((call) => call.path === '/api/auth/me').length ?? 0;
  const reads = auth();
  stub.emit('session', undefined);
  await expect.poll(auth).toBeGreaterThan(reads);
  await page.waitForTimeout(500);
  expect(await epoch()).toBe(before);
  await expect(input).toHaveValue('Черновик до события session');
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
});

test('окно вокруг найденного сообщения продолжается страницей after, а не склеивается с новейшей', async () => {
  stub = await startClientStub();
  const missed = stub.pushMany(200);
  const page = await authenticated(stub);
  await page.locator('.chat-row[data-chat-id="4"]').click();
  const newest = missed[missed.length - 1]?.id ?? 0;
  await expect(page.locator(`[data-message-id="${newest}"]`)).toBeAttached();
  await page.getByRole('button', { name: 'Поиск в чате', exact: true }).click();
  await page.getByLabel('Текст поиска в чате', { exact: true }).fill('Пропущенное 10');
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  const target = missed[9]?.id ?? 0;
  // После перехода прочитанным не отмечается ничего дальше загруженного окна.
  const reads = () =>
    stub?.state.calls
      .filter((call) => call.path === '/api/chats/4/read')
      .map((call) => Number(call.body?.upTo)) ?? [];
  await expect.poll(() => reads().length).toBeGreaterThan(0);
  const readsBefore = reads().length;
  const jumpReads = () => reads().slice(readsBefore);
  await page
    .locator('.chat-search-results button')
    .filter({ hasText: /^.*Пропущенное 10$/ })
    .click();
  await expect(page.locator(`[data-message-id="${target}"]`)).toBeAttached();
  await expect(page.locator(`[data-message-id="${newest}"]`)).toHaveCount(0);
  const all = stub.messages().map((message) => message.id);
  const contiguous = async () => {
    const ids = await shownIds(page);
    const start = all.indexOf(ids[0] ?? -1);
    expect(ids).toEqual(all.slice(start, start + ids.length));
    return ids;
  };
  const windowIds = await contiguous();
  const windowLast = windowIds[windowIds.length - 1] ?? 0;
  expect(Math.max(0, ...jumpReads())).toBeLessThanOrEqual(windowLast);
  await page
    .locator('.messages-scroll')
    .evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
  stub.emit('chat:list', undefined);
  await expect
    .poll(() => stub?.state.calls.some((call) => call.path.includes(`?after=${windowLast}`)))
    .toBe(true);
  await expect(
    page.locator(`[data-message-id="${all[all.indexOf(windowLast) + 1]}"]`),
  ).toBeAttached();
  const extended = await contiguous();
  expect(extended.length).toBeGreaterThan(windowIds.length);
  expect(extended).not.toContain(newest);
  const shownMax = extended[extended.length - 1] ?? 0;
  expect(Math.max(0, ...jumpReads())).toBeLessThanOrEqual(shownMax);
});
