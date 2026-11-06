import { existingProfile } from './existingProfile';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
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

/** Флаг DWMWA_USE_IMMERSIVE_DARK_MODE (20) окна: так Windows 10 1809+ и 11 красят рамку. */
function frameDark(hwnd: string): boolean {
  const script = `Add-Type -Namespace W -Name D -MemberDefinition '[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);'; $v = 0; [void][W.D]::DwmGetWindowAttribute([IntPtr]${hwnd}, 20, [ref]$v, 4); $v`;
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
    },
  );
  return out.trim().endsWith('1');
}

test('тёмная тема приложения делает тёмной и рамку окна Windows', async () => {
  stub = await startClientStub();
  const page = await authenticated(stub, { theme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const current = app;
  if (!current) throw new Error('Приложение не запущено');
  const read = () =>
    current.evaluate(({ BrowserWindow, nativeTheme }) => {
      const w = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().startsWith('file:'),
      );
      const handle = w?.getNativeWindowHandle();
      return {
        source: nativeTheme.themeSource,
        dark: nativeTheme.shouldUseDarkColors,
        hwnd: handle
          ? (handle.length >= 8
              ? handle.readBigUInt64LE(0)
              : BigInt(handle.readUInt32LE(0))
            ).toString()
          : '0',
      };
    });
  const dark = await read();
  expect(dark).toMatchObject({ source: 'dark', dark: true });
  if (process.platform === 'win32') await expect.poll(() => frameDark(dark.hwnd)).toBe(true);
  // Переключение в настройках сразу перекрашивает рамку.
  await page.evaluate(() =>
    (window as unknown as { teams: { request: (r: unknown) => Promise<unknown> } }).teams.request({
      kind: 'theme',
      mode: 'light',
    }),
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const light = await read();
  expect(light).toMatchObject({ source: 'light', dark: false });
  if (process.platform === 'win32') await expect.poll(() => frameDark(light.hwnd)).toBe(false);
});
