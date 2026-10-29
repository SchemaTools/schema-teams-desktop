import { existingProfile } from './existingProfile';
// Семь базовых сценариев Д1 сохранены для локального клиента v4.
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';

const ROOT = resolve(__dirname, '..', '..');
let stub: ClientStub;
const running = new Set<ElectronApplication>();
test.beforeEach(async () => {
  stub = await startClientStub();
});
test.afterEach(async () => {
  for (const app of running) await app.close().catch(() => undefined);
  running.clear();
  await stub.close();
});
async function launch(profile: string, url = stub.url, args: string[] = []) {
  existingProfile(profile);
  const app = await electron.launch({
    args: [ROOT, ...args],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: url },
  });
  running.add(app);
  return app;
}
const newProfile = () => mkdtempSync(join(tmpdir(), 'stdesk-v4-'));
async function login(app: ElectronApplication, page: Page) {
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  const popup = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const auth = await popup;
  await auth.locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect(page.locator('.chat-row[data-chat-id="4"]')).toBeVisible();
}
const mainState = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) =>
        w.webContents.getURL().startsWith('file:') && !w.webContents.getURL().includes('surface='),
    );
    if (!win) return null;
    const prefs = (
      win.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }
    ).getLastWebPreferences();
    return {
      visible: win.isVisible(),
      title: win.getTitle(),
      url: win.webContents.getURL(),
      contextIsolation: prefs.contextIsolation,
      sandbox: prefs.sandbox,
      nodeIntegration: prefs.nodeIntegration,
    };
  });

test('главное окно загружает локальный клиент с безопасными настройками', async () => {
  const app = await launch(newProfile());
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toBeVisible();
  const state = await mainState(app);
  expect(state).toMatchObject({
    title: 'Schema Teams',
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  });
  expect(state?.url).toMatch(/^file:.*\/dist\/renderer\/index\.html$/);
  expect(
    await page.evaluate(() => ({
      node: typeof (window as unknown as { require?: unknown }).require,
      bridge: typeof window.teams.request,
    })),
  ).toEqual({ node: 'undefined', bridge: 'function' });
  await expect.poll(async () => (await mainState(app))?.visible).toBe(true);
});

test('отдельный вход сохраняет HttpOnly cookie после перезапуска', async () => {
  const profile = newProfile();
  const first = await launch(profile);
  await login(first, await first.firstWindow());
  const cookies = await first.evaluate(async ({ session }) =>
    (await session.fromPartition('persist:teams').cookies.get({ name: 'st_session' })).map(
      ({ httpOnly, sameSite }) => ({ httpOnly, sameSite }),
    ),
  );
  expect(cookies).toEqual([{ httpOnly: true, sameSite: 'strict' }]);
  const closed = first.waitForEvent('close');
  await first.evaluate(({ app }) => app.quit());
  await closed;
  running.delete(first);
  const second = await launch(profile);
  const page = await second.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect(page.locator('.chat-row[data-chat-id="4"]')).toBeVisible();
  expect(stub.state.calls.filter((call) => call.path === '/api/auth/login')).toHaveLength(1);
});

test('✕ прячет окно, процесс остаётся, подсказка сохраняется один раз', async () => {
  const profile = newProfile();
  const app = await launch(profile);
  await expect((await app.firstWindow()).locator('.app-shell')).toBeAttached();
  await expect.poll(async () => (await mainState(app))?.visible).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(async () => (await mainState(app))?.visible).toBe(false);
  const readSettings = () =>
    JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) as {
      trayHintShown: boolean;
      window: { bounds: { width: number } };
    };
  expect(readSettings().trayHintShown).toBe(true);
  expect(readSettings().window.bounds.width).toBeGreaterThan(0);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.show();
    w?.close();
  });
  expect(readSettings().trayHintShown).toBe(true);
});

test('автозапуск --hidden загружает локальную страницу без показа окна', async () => {
  const app = await launch(newProfile(), stub.url, ['--hidden']);
  await expect((await app.firstWindow()).locator('.app-shell')).toBeAttached();
  expect((await mainState(app))?.visible).toBe(false);
});

test('повторный запуск показывает существующее окно и завершает второй процесс', async () => {
  const profile = newProfile();
  const app = await launch(profile, stub.url, ['--hidden']);
  await expect((await app.firstWindow()).locator('.app-shell')).toBeAttached();
  const electronPath = (await import('electron')).default as unknown as string;
  const code = await new Promise<number | null>((done, reject) => {
    const child = spawn(electronPath, [ROOT], {
      env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', done);
  });
  expect(code).toBe(0);
  await expect.poll(async () => (await mainState(app))?.visible).toBe(true);
});

test('разрешённые внешние ссылки уходят в браузер, file и неизвестный RPC отклоняются', async () => {
  const app = await launch(newProfile());
  const page = await app.firstWindow();
  await login(app, page);
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    shell.openExternal = async (url: string) => {
      g.opened.push(url);
    };
  });
  const results = await page.evaluate(async () => {
    const init = await window.teams.request({ kind: 'init' });
    if (!init.ok) throw new Error('init failed');
    const epoch = init.data.epoch;
    return [
      await window.teams.request({ kind: 'open.link', epoch, url: 'https://example.com/' }),
      await window.teams.request({
        kind: 'open.link',
        epoch,
        url: 'file:///C:/Windows/notepad.exe',
      }),
      await window.teams.request({ kind: 'open.site', epoch, path: '//example.com/' }),
      await window.teams.request({ kind: 'execute' } as never),
    ];
  });
  expect(results.map((result) => result.ok)).toEqual([true, false, false, false]);
  expect(await app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([
    'https://example.com/',
  ]);
  expect((await mainState(app))?.url).toMatch(/^file:/);
  expect(app.windows()).toHaveLength(1);
});

test('недоступный сервер показывает «Нет связи», журнал не раскрывает секреты', async () => {
  const profile = newProfile();
  const app = await launch(profile, 'http://127.0.0.1:9/');
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'offline');
  await expect(
    page.getByRole('heading', { name: 'Нет связи с сервером', exact: true }),
  ).toBeVisible();
  const log = readFileSync(join(profile, 'logs', 'app.log'), 'utf8');
  expect(log).toContain('запуск');
  expect(log).not.toMatch(/csrf-test-only|fixture-session-|st_session=/);
});
