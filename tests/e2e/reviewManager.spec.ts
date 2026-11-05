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

// Замечания руководителя 05.11: поле ввода, сведения о чате, стикеры, фото профиля, тема окон.
const ROOT = resolve(__dirname, '..', '..');
let stub: ClientStub | undefined;
let app: ElectronApplication | undefined;
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub?.close();
  stub = undefined;
});

async function authenticated(server: ClientStub, settings: Record<string, unknown> = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'stdesk-review-'));
  existingProfile(profile, settings);
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: server.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
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
async function openChat(page: Page) {
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await expect(page.locator('.messages-scroll[data-chat-id="4"]')).toBeVisible();
  await expect(page.locator('[data-message-id="102"]')).toBeAttached();
}

test('поле ввода растёт от 1 до 8 строк, дальше — прокрутка, без уголка изменения размера', async () => {
  stub = await startClientStub();
  const page = await authenticated(stub);
  await openChat(page);
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  const height = () => input.evaluate((node) => node.getBoundingClientRect().height);
  const one = await height();
  expect(one).toBeLessThan(40);
  expect(await input.evaluate((node) => getComputedStyle(node).resize)).toBe('none');
  await input.click();
  await input.pressSequentially('Первая строка');
  await input.press('Shift+Enter');
  await input.pressSequentially('Вторая строка');
  await input.press('Shift+Enter');
  await input.pressSequentially('Третья строка');
  await expect(input).toHaveValue('Первая строка\nВторая строка\nТретья строка');
  const three = await height();
  expect(three).toBeGreaterThan(one + 30);
  // Без внутренней прокрутки, пока строк не больше восьми.
  expect(await input.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThan(2);
  await input.fill(Array.from({ length: 20 }, (_, i) => `Строка ${i + 1}`).join('\n'));
  const tall = await height();
  expect(tall).toBeGreaterThan(three);
  expect(tall).toBeLessThanOrEqual(181);
  expect(await input.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await input.fill('');
  expect(await height()).toBeLessThan(40);
  // Enter без Shift по-прежнему отправляет.
  await input.pressSequentially('Одна строка');
  await input.press('Enter');
  await expect(page.locator('.message-row.outgoing', { hasText: 'Одна строка' })).toBeVisible();
});
