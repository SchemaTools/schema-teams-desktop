// Сквозные тесты каркаса (шаг Д1): окно с сервером, вход после перезапуска, ✕ в трей,
// запуск со скрытым окном, один экземпляр, переходы вне сервера, «нет связи».
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStub, type Stub } from './stub';

const ROOT = resolve(__dirname, '..', '..');

let stub: Stub;
test.beforeAll(async () => {
  stub = await startStub();
});
test.afterAll(async () => {
  await stub.close();
});

function launch(userData: string, serverUrl: string, args: string[] = []) {
  return electron.launch({
    args: [ROOT, ...args],
    env: {
      ...process.env,
      SCHEMA_TEAMS_USER_DATA: userData,
      SCHEMA_TEAMS_SERVER_URL: serverUrl,
    },
  });
}

/** Подменяет shell.openExternal, чтобы тест не открывал настоящий браузер. */
async function captureExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    shell.openExternal = async (url: string) => {
      g.opened.push(url);
    };
  });
}

const opened = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);

const mainState = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return null;
    // getLastWebPreferences есть в Electron, но не описан в его типах
    const wc = w.webContents as unknown as {
      getLastWebPreferences: () => Record<string, unknown> | null;
    };
    const p = wc.getLastWebPreferences();
    return {
      visible: w.isVisible(),
      title: w.getTitle(),
      url: w.webContents.getURL(),
      contextIsolation: p?.contextIsolation,
      sandbox: p?.sandbox,
      nodeIntegration: p?.nodeIntegration,
    };
  });

const newProfile = () => mkdtempSync(join(tmpdir(), 'stdesk-'));

test('окно открывает сервер с безопасными настройками', async () => {
  const app = await launch(newProfile(), stub.url);
  const page = await app.firstWindow();
  await expect(page.locator('#who')).toBeVisible();
  await expect.poll(async () => (await mainState(app))?.visible).toBe(true);
  expect(await mainState(app)).toMatchObject({
    title: 'Schema Teams',
    url: stub.url,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  });
  await app.close();
});

test('вход запоминается после перезапуска', async () => {
  const profile = newProfile();
  const first = await launch(profile, stub.url);
  await expect((await first.firstWindow()).locator('#who')).toHaveText('вход');
  await first.evaluate(({ app }) => app.quit());
  await first.waitForEvent('close');

  const second = await launch(profile, stub.url);
  await expect((await second.firstWindow()).locator('#who')).toHaveText('вошли');
  await second.close();
});

test('✕ прячет окно, приложение работает, подсказка показана один раз', async () => {
  const profile = newProfile();
  const app = await launch(profile, stub.url);
  await app.firstWindow();
  await expect.poll(async () => (await mainState(app))?.visible).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(async () => (await mainState(app))?.visible).toBe(false);
  const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
  expect(settings.trayHintShown).toBe(true);
  expect(settings.window.bounds.width).toBeGreaterThan(0);
  await app.close();
});

test('автозапуск с --hidden: окна не видно, страница загружена', async () => {
  const app = await launch(newProfile(), stub.url, ['--hidden']);
  await expect((await app.firstWindow()).locator('#who')).toBeAttached();
  expect((await mainState(app))?.visible).toBe(false);
  await app.close();
});

test('повторный запуск не открывает второе приложение, а показывает окно', async () => {
  const profile = newProfile();
  const app = await launch(profile, stub.url, ['--hidden']);
  await (await app.firstWindow()).locator('#who').waitFor({ state: 'attached' });
  const electronPath = (await import('electron')).default as unknown as string;
  const code = await new Promise<number | null>((done) => {
    const p = spawn(electronPath, [ROOT], {
      env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
      stdio: 'ignore',
    });
    p.on('exit', done);
  });
  expect(code).toBe(0);
  await expect.poll(async () => (await mainState(app))?.visible).toBe(true);
  await app.close();
});

test('ссылки не на сервер уходят в браузер, file:// запрещён', async () => {
  const app = await launch(newProfile(), stub.url);
  const page = await app.firstWindow();
  await page.locator('#who').waitFor();
  await captureExternal(app);
  // щелчок внутри страницы: page.click ждёт перехода, который приложение отменяет
  for (const id of ['ext', 'blank', 'file']) {
    await page.evaluate((i) => document.getElementById(i)?.click(), id);
  }
  await expect
    .poll(() => opened(app))
    .toEqual(['https://example.com/', 'https://example.com/blank']);
  expect((await mainState(app))?.url).toBe(stub.url);
  expect(app.windows()).toHaveLength(1);
  await app.close();
});

test('сервер не отвечает — страница «Нет связи», в журнале запись', async () => {
  const profile = newProfile();
  // порт 9 (discard) на 127.0.0.1 закрыт
  const app = await launch(profile, 'http://127.0.0.1:9/');
  const page = await app.firstWindow();
  await expect(page.locator('h1')).toHaveText('Нет связи с сервером');
  const logFile = join(profile, 'logs', 'app.log');
  await expect
    .poll(() => existsSync(logFile) && readFileSync(logFile, 'utf8'))
    .toContain('сервер не открылся');
  await app.close();
});
