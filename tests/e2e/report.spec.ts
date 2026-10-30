import { existingProfile } from './existingProfile';
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
import { unzipSync, strFromU8 } from 'fflate';
import { startClientStub, type ClientStub } from './clientStub';
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string, target: string;
const panel = (page: Page) =>
  page.getByRole('dialog', { name: 'Сообщить о проблеме', exact: true });
function active() {
  if (!app) throw Error('App unavailable');
  return app;
}
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-report-e2e-'));
  target = join(profile, 'reviewed.zip');
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
async function launch(auth = false) {
  existingProfile(profile);
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  await app.evaluate(({ desktopCapturer, dialog, shell }, target) => {
    const state = globalThis as typeof globalThis & {
      reportScreenCalls: number;
      reportChoices: number;
      reportCancel: boolean;
      reportReveal: string;
    };
    state.reportScreenCalls = 0;
    state.reportChoices = 0;
    state.reportCancel = false;
    state.reportReveal = '';
    // These tests never capture the user's desktop or open a native chooser.
    desktopCapturer.getSources = async () => {
      state.reportScreenCalls++;
      return [];
    };
    dialog.showSaveDialog = (async () => {
      state.reportChoices++;
      return state.reportCancel
        ? { canceled: true, filePath: '' }
        : { canceled: false, filePath: target };
    }) as typeof dialog.showSaveDialog;
    shell.showItemInFolder = (path) => {
      state.reportReveal = path;
    };
  }, target);
  if (auth) {
    const pending = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await (await pending).locator('#sign-in').click();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'));
    w?.show();
    w?.focus();
  });
  return page;
}
async function open(page: Page) {
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'О программе', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Настройки', exact: true })
    .getByRole('button', { name: 'Сообщить о проблеме', exact: true })
    .click();
  await expect(panel(page)).toBeVisible();
}
async function description(page: Page, value = 'Окно перестало отвечать') {
  await panel(page).getByRole('textbox', { name: 'Что случилось' }).fill(value);
}
async function prepare(page: Page) {
  await panel(page).getByRole('button', { name: 'Подготовить и просмотреть' }).click();
  await expect(panel(page).getByRole('region', { name: 'Что войдёт в архив' })).toBeVisible();
}
test('до входа доступны описание, клавиатура и честные ограничения; ничего не собирается автоматически', async () => {
  const page = await launch();
  await open(page);
  const p = panel(page);
  await expect(p).toContainText('Отправка в поддержку сейчас недоступна');
  await expect(p.getByRole('button', { name: 'Подготовить и просмотреть' })).toBeDisabled();
  for (const checkbox of await p.getByRole('checkbox').all())
    await expect(checkbox).not.toBeChecked();
  await expect(p.getByRole('checkbox', { name: /Журналы плагинов/ })).toBeDisabled();
  expect(
    await active().evaluate(
      () => (globalThis as typeof globalThis & { reportScreenCalls: number }).reportScreenCalls,
    ),
  ).toBe(0);
  await description(page);
  await prepare(page);
  await expect(p.getByRole('textbox', { name: 'Содержимое файла диагностики' })).toContainText(
    'Окно перестало отвечать',
  );
  await expect(
    p.getByRole('combobox', { name: 'Просмотр файла диагностики' }).locator('option'),
  ).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('report-light.png') });
  await page.evaluate(() => window.teams.request({ kind: 'theme', mode: 'dark' }));
  await page.screenshot({ path: test.info().outputPath('report-dark.png') });
  await p.getByRole('button', { name: 'Закрыть сообщение о проблеме' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(p.getByRole('button', { name: 'Сохранить архив' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(p).toHaveCount(0);
  expect(stub.state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
});
test('журналы и реальный снимок своего окна просматриваются и сохраняются в точности один раз', async () => {
  const page = await launch(true);
  writeFileSync(
    join(profile, 'logs', 'app.1.log'),
    '2026-10-29T19:00:00.000Z INFO запуск {"app":"0.6.4","server":"https://private.example.org","error":"hidden-value"}\n',
  );
  await open(page);
  const p = panel(page);
  await description(page, 'Проверка ZIP');
  await p.getByRole('checkbox', { name: /Журналы приложения/ }).check();
  await p.getByRole('button', { name: 'Сделать снимок', exact: true }).click();
  await expect(p.getByRole('img', { name: 'Снимок для диагностики', exact: true })).toBeVisible();
  await expect(p.getByRole('checkbox', { name: 'Снимок экрана', exact: true })).toBeChecked();
  const screenshot = await p
    .getByRole('img', { name: 'Снимок для диагностики', exact: true })
    .getAttribute('src');
  await prepare(page);
  const select = p.getByRole('combobox', { name: 'Просмотр файла диагностики' }),
    expected: Record<string, string> = {};
  for (const value of await select
    .locator('option')
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))) {
    await select.selectOption(value);
    if (value !== 'screenshot.png')
      expected[value] = await p
        .getByRole('textbox', { name: 'Содержимое файла диагностики' })
        .inputValue();
  }
  expect(expected['application/app.1.log']).not.toMatch(/private|hidden-value/);
  writeFileSync(join(profile, 'logs', 'app.1.log'), 'changed after preview');
  await p.getByRole('button', { name: 'Сохранить архив' }).dblclick();
  await expect(p.getByRole('status')).toContainText('Архив сохранён: reviewed.zip');
  const zip = unzipSync(readFileSync(target));
  expect(Object.keys(zip)).toHaveLength(Object.keys(expected).length + 1);
  for (const [name, text] of Object.entries(expected)) {
    const bytes = zip[name];
    if (!bytes) throw Error('Missing ZIP entry');
    expect(strFromU8(bytes)).toBe(text);
  }
  const screenshotBytes = zip['screenshot.png'];
  if (!screenshotBytes) throw Error('Missing screenshot');
  expect(Buffer.from(screenshotBytes).toString('base64')).toBe(screenshot?.split(',')[1]);
  await p.getByRole('button', { name: 'Показать сохранённый архив' }).click();
  expect(
    await active().evaluate(
      () => (globalThis as typeof globalThis & { reportReveal: string }).reportReveal,
    ),
  ).toBe(target);
  expect(
    await active().evaluate(
      () => (globalThis as typeof globalThis & { reportChoices: number }).reportChoices,
    ),
  ).toBe(1);
  expect(
    await active().evaluate(
      () => (globalThis as typeof globalThis & { reportScreenCalls: number }).reportScreenCalls,
    ),
  ).toBe(0);
});
test('отсутствующий журнал показан итогом, отмена сохранения позволяет повторить без новой сборки', async () => {
  const page = await launch();
  await active().evaluate(({ app }) => {
    const load = process
        .getBuiltinModule('module')
        .createRequire(`${app.getAppPath()}/package.json`),
      host = load('./dist/main/index.js') as {
        client: { report: { o: { readRevit: () => Promise<null> } } };
      };
    host.client.report.o.readRevit = async () => null;
  });
  await open(page);
  const p = panel(page);
  await description(page);
  await p.getByRole('checkbox', { name: 'Последний журнал Revit', exact: true }).check();
  await p.getByRole('combobox', { name: 'Версия Revit для журнала' }).selectOption('2026');
  await prepare(page);
  await expect(p).toContainText('Журнал Revit 2026 не найден или недоступен.');
  await active().evaluate(() => {
    (globalThis as typeof globalThis & { reportCancel: boolean }).reportCancel = true;
  });
  await p.getByRole('button', { name: 'Сохранить архив' }).click();
  await expect(p.getByRole('button', { name: 'Сохранить архив' })).toBeEnabled();
  await expect(p.getByRole('status')).toHaveCount(0);
  await active().evaluate(() => {
    (globalThis as typeof globalThis & { reportCancel: boolean }).reportCancel = false;
  });
  await p.getByRole('button', { name: 'Сохранить архив' }).click();
  await expect(p.getByRole('status')).toContainText('Архив сохранён');
  expect(Object.keys(unzipSync(readFileSync(target)))).toEqual(['report.txt']);
});
test('правка состава исключает снимок, закрытие удаляет описание и прежний предпросмотр', async () => {
  const page = await launch();
  await open(page);
  const p = panel(page);
  await description(page, 'Первый вариант');
  await p.getByRole('button', { name: 'Сделать снимок', exact: true }).click();
  await expect(p.getByRole('img', { name: 'Снимок для диагностики', exact: true })).toBeVisible();
  await prepare(page);
  await p.getByRole('button', { name: 'Изменить описание и вложения' }).click();
  await p.getByRole('checkbox', { name: 'Снимок экрана', exact: true }).uncheck();
  await description(page, 'Исправленный вариант');
  await prepare(page);
  await expect(p.getByRole('textbox', { name: 'Содержимое файла диагностики' })).toContainText(
    'Исправленный вариант',
  );
  await expect(
    p.getByRole('combobox', { name: 'Просмотр файла диагностики' }).locator('option'),
  ).toHaveCount(1);
  await p.getByRole('button', { name: 'Закрыть сообщение о проблеме' }).click();
  await open(page);
  await expect(panel(page).getByRole('textbox', { name: 'Что случилось' })).toHaveValue('');
  await expect(panel(page).locator('.report-image')).toHaveCount(0);
});
test('выход очищает описание, снимок и доказательство экспорта', async () => {
  const page = await launch(true);
  await open(page);
  await description(page, 'Частный отчёт первого входа');
  await prepare(page);
  const result = await page.evaluate(async () => {
    const snapshot = await window.teams.request({ kind: 'init' });
    if (snapshot.ok) return window.teams.request({ kind: 'logout', epoch: snapshot.data.epoch });
  });
  expect(result?.ok).toBe(true);
  await expect(panel(page).getByRole('textbox', { name: 'Что случилось' })).toHaveValue('');
  await expect(panel(page)).toContainText('Вход изменился. Диагностика очищена.');
  await expect(panel(page).getByRole('button', { name: 'Сохранить архив' })).toHaveCount(0);
});
test('настоящее меню трея открывает диагностику; ошибка снимка не выдаёт системные подробности', async () => {
  const page = await launch();
  const pending = active().waitForEvent('window');
  await active().evaluate(({ app }) => {
    const load = process
        .getBuiltinModule('module')
        .createRequire(`${app.getAppPath()}/package.json`),
      host = load('./dist/main/index.js') as {
        client: {
          showMenu: (b: { x: number; y: number; width: number; height: number }) => void;
          report: { o: { capture: () => Promise<Uint8Array> } };
        };
      };
    host.client.report.o.capture = async () => {
      throw Error('private path C:/hidden access denied');
    };
    host.client.showMenu({ x: 1000, y: 700, width: 24, height: 24 });
  });
  const tray = await pending;
  await tray.getByRole('button', { name: 'Сообщить о проблеме', exact: true }).click();
  const p = panel(page);
  await expect(p).toBeVisible();
  await p.getByRole('button', { name: 'Сделать снимок', exact: true }).click();
  await expect(p.getByRole('alert')).toHaveText(
    'Не удалось сделать снимок. Выберите источник и повторите.',
  );
  await expect(p).not.toContainText('C:/hidden');
  await expect(p.getByRole('checkbox', { name: 'Снимок экрана', exact: true })).not.toBeChecked();
});
test('выход до кадра захвата отменяет сам снимок, а не только его показ', async () => {
  const page = await launch(true);
  await open(page);
  await active().evaluate(({ app }) => {
    const load = process
        .getBuiltinModule('module')
        .createRequire(`${app.getAppPath()}/package.json`),
      host = load('./dist/main/index.js') as {
        client: { report: { o: { capture: () => Promise<Uint8Array> } } };
      };
    const state = globalThis as typeof globalThis & { reportCaptures: number };
    state.reportCaptures = 0;
    host.client.report.o.capture = async () => {
      state.reportCaptures++;
      throw Error('Should not be called');
    };
  });
  await page.evaluate(() => {
    const state = window as typeof window & {
      reportFrames: FrameRequestCallback[];
      reportRaf: typeof requestAnimationFrame;
    };
    state.reportFrames = [];
    state.reportRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      state.reportFrames.push(callback);
      return state.reportFrames.length;
    };
  });
  await panel(page)
    .getByRole('button', { name: 'Сделать снимок', exact: true })
    .dispatchEvent('click');
  await page.evaluate(async () => {
    const snapshot = await window.teams.request({ kind: 'init' });
    if (snapshot.ok) await window.teams.request({ kind: 'logout', epoch: snapshot.data.epoch });
  });
  await expect(panel(page)).toContainText('Вход изменился. Диагностика очищена.');
  await page.evaluate(() => {
    const state = window as typeof window & {
      reportFrames: FrameRequestCallback[];
      reportRaf: typeof requestAnimationFrame;
    };
    window.requestAnimationFrame = state.reportRaf;
    for (const callback of state.reportFrames.splice(0)) callback(performance.now());
  });
  // Two real compositor frames allow the old continuation to resume and be rejected.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(
    await active().evaluate(
      () => (globalThis as typeof globalThis & { reportCaptures: number }).reportCaptures,
    ),
  ).toBe(0);
  await expect(panel(page).locator('.report-image')).toHaveCount(0);
});
