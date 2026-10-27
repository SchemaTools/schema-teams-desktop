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
import { startDesktopStub } from './desktopStub';
import type { DesktopBridge } from '../../src/bridge/protocol';

const ROOT = resolve(__dirname, '../..');
const folder = String.raw`\\server\share\Папка А`;
const file = String.raw`\\server\share\Модель.rvt`;
const executable = String.raw`\\server\share\Запуск.BAT`;
interface Fixture extends Window {
  schemaDesktop: DesktopBridge;
  startBridge: () => Promise<void>;
}
interface Harness {
  kind: 'file' | 'directory' | null;
  calls: string[];
  opened: string[];
  revealed: string[];
  copied: string[];
  hold: boolean;
  finish?: (kind: 'file' | 'directory' | null) => void;
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
async function launch(ready = true) {
  const profile = mkdtempSync(join(tmpdir(), 'stdesk-paths-'));
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
  const win = await app.browserWindow(page);
  await expect.poll(() => win.evaluate((w) => w.isVisible())).toBe(true);
  await app.evaluate(({ app, shell, clipboard }) => {
    const load = process
      .getBuiltinModule('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const { PathProbe } = load(`${app.getAppPath()}/dist/main/paths/probe.js`) as {
      PathProbe: typeof import('../../src/main/paths/probe').PathProbe;
    };
    const g = globalThis as unknown as {
      pathHarness: Harness;
      pathActualInspect: typeof PathProbe.prototype.inspect;
    };
    g.pathActualInspect = PathProbe.prototype.inspect;
    g.pathHarness = { kind: 'file', calls: [], opened: [], revealed: [], copied: [], hold: false };
    PathProbe.prototype.inspect = async (path) => {
      const h = g.pathHarness;
      h.calls.push(path);
      return h.hold ? new Promise((resolve) => (h.finish = resolve)) : h.kind;
    };
    shell.openPath = async (path) => {
      g.pathHarness.opened.push(path);
      return '';
    };
    shell.showItemInFolder = (path) => {
      g.pathHarness.revealed.push(path);
    };
    clipboard.writeText = async (path) => {
      g.pathHarness.copied.push(path);
    };
  });
  if (ready) await page.evaluate(() => (window as unknown as Fixture).startBridge());
  return { app, page, profile };
}
const state = (app: ElectronApplication) =>
  app.evaluate(() => {
    const h = (globalThis as unknown as { pathHarness: Harness }).pathHarness;
    return { calls: h.calls, opened: h.opened, revealed: h.revealed, copied: h.copied };
  });
const open = (page: Page, path: string, reveal = false) =>
  page.evaluate(
    ({ path, reveal }) =>
      (window as unknown as Fixture).schemaDesktop.send('openPath', { path, reveal }),
    { path, reveal },
  );
async function kind(app: ElectronApplication, kind: Harness['kind']) {
  await app.evaluate((_e, kind) => {
    (globalThis as unknown as { pathHarness: Harness }).pathHarness.kind = kind;
  }, kind);
}

test('папки и обычные файлы открываются; исполняемые только показываются в папке', async () => {
  const { app, page, profile } = await launch();
  await kind(app, 'directory');
  expect(await open(page, folder)).toBe('ok');
  await kind(app, 'file');
  expect(await open(page, file)).toBe('ok');
  expect(await open(page, executable)).toBe('blocked');
  expect(await open(page, executable, true)).toBe('ok');
  await kind(app, 'directory');
  expect(await open(page, executable)).toBe('blocked');
  expect(await state(app)).toMatchObject({
    opened: [folder, file],
    revealed: [executable, executable, executable],
  });
  expect(readFileSync(join(profile, 'logs/app.log'), 'utf8')).toContain('открытие пути');
});

test('до hello и для не-UNC/device/traversal нет stat и открытия', async () => {
  const { app, page } = await launch(false);
  expect(await open(page, file)).toBe('blocked');
  await page.evaluate(() => (window as unknown as Fixture).startBridge());
  for (const path of [
    'C:\\file.rvt',
    'file://example.com/file',
    '\\\\?\\C:\\file',
    String.raw`\\server\share\..\file.rvt`,
  ])
    expect(await open(page, path)).toBe('blocked');
  expect(await state(app)).toMatchObject({ calls: [], opened: [], revealed: [] });
});

test('недоступный путь показывает изолированный диалог, копирование и Esc работают', async () => {
  const { app, page } = await launch();
  await kind(app, null);
  const next = app.waitForEvent('window');
  expect(await open(page, file)).toBe('unavailable');
  const dialog = await next;
  await expect(dialog.getByRole('heading')).toHaveText('Папка недоступна');
  await expect(dialog.locator('#path')).toHaveText(file);
  await dialog.getByRole('button', { name: 'Скопировать путь' }).click();
  await expect(dialog.getByRole('button', { name: 'Скопировано' })).toBeVisible();
  expect((await state(app)).copied).toEqual([file]);
  expect(await dialog.evaluate(() => typeof (window as unknown as Fixture).schemaDesktop)).toBe(
    'undefined',
  );
  expect(
    await dialog.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
  ).toBe('undefined');
  await dialog.screenshot({ path: test.info().outputPath('unavailable-path.png') });
  // Окно закрывается на keydown, до отправки Playwright события keyup.
  await dialog
    .locator('body')
    .press('Escape')
    .catch((error) => {
      if (!dialog.isClosed()) throw error;
    });
  await expect.poll(() => dialog.isClosed()).toBe(true);
  expect(await state(app)).toMatchObject({ opened: [], revealed: [] });
});

test('во время stat мост отвечает; выход не открывает запоздалый путь', async () => {
  const { app, page } = await launch();
  await app.evaluate(() => {
    (globalThis as unknown as { pathHarness: Harness }).pathHarness.hold = true;
  });
  const pending = open(page, file);
  await expect.poll(async () => (await state(app)).calls.length).toBe(1);
  await page.evaluate(async () => {
    await (window as unknown as Fixture).schemaDesktop.send('counters', {
      chat: 4,
      notifications: 0,
    });
    await (window as unknown as Fixture).schemaDesktop.send('signedOut', {});
  });
  await app.evaluate(() => {
    (globalThis as unknown as { pathHarness: Harness }).pathHarness.finish?.('file');
  });
  expect(await pending).toBe('blocked');
  expect(await state(app)).toMatchObject({ opened: [], revealed: [] });
  expect(app.windows()).toHaveLength(1);
});

test('неподходящий WebContents и отсутствующий senderFrame не могут вызвать pathservice', async () => {
  const { app, profile } = await launch();
  const preload = join(profile, 'intruder.cjs');
  // Sandboxed fixture имеет только тестовый IPC; в production такого API нет.
  writeFileSync(
    preload,
    "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('intruder',(path)=>ipcRenderer.invoke('desktop:event','openPath',{path,reveal:false}));",
  );
  const next = app.waitForEvent('window');
  await app.evaluate(
    async ({ BrowserWindow }, { preload, url }) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      await win.loadURL(url);
    },
    { preload, url: server.url },
  );
  const intruder = await next;
  expect(
    await intruder.evaluate(
      (path) =>
        (window as unknown as { intruder: (path: string) => Promise<unknown> }).intruder(path),
      file,
    ),
  ).toBe('blocked');
  const result = await app.evaluate(({ app, BrowserWindow }, path) => {
    const load = process
      .getBuiltinModule('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const { desktop } = load(`${app.getAppPath()}/dist/main/index.js`) as {
      desktop: { bridge: { receive: (event: object, name: string, data: unknown) => unknown } };
    };
    const main = BrowserWindow.getAllWindows()[0];
    if (!main) throw new Error('Нет окна');
    return desktop.bridge.receive({ sender: main.webContents, senderFrame: null }, 'openPath', {
      path,
      reveal: false,
    });
  }, file);
  expect(result).toBe('blocked');
  expect((await state(app)).calls).toEqual([]);
});

test('настоящий utility worker завершается через 3 с; неверный путь отвергается самим worker', async () => {
  const { app, page } = await launch();
  const pending = app.evaluate(async ({ app, utilityProcess }) => {
    const load = process
      .getBuiltinModule('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const { PathProbe } = load(`${app.getAppPath()}/dist/main/paths/probe.js`) as {
      PathProbe: typeof import('../../src/main/paths/probe').PathProbe;
    };
    let exited: Promise<void> = Promise.resolve();
    const probe = new PathProbe(() => {
      const child = utilityProcess.fork(
        `${app.getAppPath()}/tests/fixtures/hangingPathWorker.cjs`,
        [],
        { stdio: 'ignore' },
      );
      exited = new Promise((resolve) => child.once('exit', () => resolve()));
      return child;
    });
    const started = Date.now();
    const actual = (
      globalThis as unknown as { pathActualInspect: typeof PathProbe.prototype.inspect }
    ).pathActualInspect;
    const result = await actual.call(probe, 'unused');
    await exited;
    const invalid = utilityProcess.fork(`${app.getAppPath()}/dist/main/paths/statWorker.js`, [], {
      stdio: 'ignore',
    });
    const answer = new Promise<unknown>((resolve) =>
      invalid.once('message', (message: unknown) => {
        invalid.kill();
        resolve(message);
      }),
    );
    invalid.postMessage({ path: 'C:\\local-file.rvt' });
    return { result, elapsed: Date.now() - started, invalid: await answer };
  });
  await expect(page.locator('#chat')).toBeVisible();
  const result = await pending;
  expect(result.result).toBeNull();
  expect(result.elapsed).toBeGreaterThanOrEqual(2800);
  expect(result.elapsed).toBeLessThan(6500);
  expect(result.invalid).toBeNull();
});
