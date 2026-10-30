import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { startClientStub, type ClientStub } from './clientStub';
import { existingProfile } from './existingProfile';
function active(): ElectronApplication {
  if (!app) throw Error('No app');
  return app;
}
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string, target: string;
const panel = (page: Page) =>
  page.getByRole('dialog', { name: 'Сообщить о проблеме', exact: true });
const calls = (path: string) => stub.state.calls.filter((c) => c.path === path);
const uploads = () => calls('/api/desktop/support/files');
const posts = () => calls('/api/desktop/support');
function configure(support = true, morning = false, capability = true) {
  stub.state.healthVersion = '0.12.1-b';
  stub.state.timers[1] = null;
  stub.state.desktopConfig = {
    bureau: { timeZone: 'Asia/Yekaterinburg', workEnd: '18:00' },
    serverNow: '2026-10-31T04:00:00.000Z',
    supportChatId: support ? 9 : null,
    capabilities: {
      timerControl: 2,
      ...(capability && { support: 1 }),
      ...(morning && { morning: 1 }),
    },
  };
}
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-d7-'));
  target = join(profile, 'reviewed.zip');
  configure();
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
async function launch(restart = false, allowed = true) {
  if (!existsSync(join(profile, 'settings.json')))
    writeFileSync(
      join(profile, 'settings.json'),
      JSON.stringify({ autostart: false, notifications: { sound: false } }),
    );
  existingProfile(profile);
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await app.evaluate(
    ({ app, dialog, shell, powerMonitor }, data) => {
      const g = globalThis as typeof globalThis & { d7External: string[]; d7Revealed: string[] };
      g.d7External = [];
      g.d7Revealed = [];
      shell.openExternal = async (url) => {
        g.d7External.push(url);
      };
      shell.showItemInFolder = (path) => {
        g.d7Revealed.push(path);
      };
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: data.target,
      })) as typeof dialog.showSaveDialog;
      powerMonitor.getSystemIdleState = () => 'active';
      const { createRequire } = process.getBuiltinModule('module'),
        load = createRequire(`${app.getAppPath()}/package.json`);
      const host = load('./dist/main/index.js') as {
        client?: { policy: { allows: () => Promise<boolean> } };
      };
      if (!host.client) throw Error('No client');
      host.client.policy.allows = async () => data.allowed;
    },
    { target, allowed },
  );
  if (!restart) {
    await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
    const pending = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await (await pending).locator('#sign-in').click();
  }
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
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
async function prepare(page: Page, text = 'Одобренное обращение') {
  await panel(page).getByRole('textbox', { name: 'Что случилось', exact: true }).fill(text);
  await panel(page).getByRole('button', { name: 'Подготовить и просмотреть' }).click();
  await expect(panel(page).getByRole('region', { name: 'Что войдёт в архив' })).toBeVisible();
}
async function send(page: Page) {
  await panel(page).getByRole('button', { name: 'Отправить в поддержку', exact: true }).click();
}
async function unknown(page: Page) {
  await expect(panel(page).getByRole('status')).toContainText(
    'Результат отправки пока неизвестен',
    { timeout: 25000 },
  );
}

test('реальные HTTP ZIP bytes совпадают с одобренным preview; повтор confirmed IPC не создаёт второго обращения', async () => {
  const page = await launch();
  await open(page);
  await panel(page)
    .getByRole('checkbox', { name: /Журналы приложения/ })
    .check();
  await prepare(page);
  await panel(page)
    .getByRole('combobox', { name: 'Просмотр файла диагностики' })
    .selectOption('application/app.log');
  const approved = await panel(page)
    .getByRole('textbox', { name: 'Содержимое файла диагностики' })
    .inputValue();
  writeFileSync(
    join(profile, 'logs', 'app.log'),
    '2026-10-31T04:01:00.000Z INFO запуск {"app":"9.9.9","packaged":true}\n',
  );
  await send(page);
  await expect(panel(page).getByRole('status')).toContainText('Обращение отправлено');
  expect(uploads()).toHaveLength(1);
  expect(posts()).toHaveLength(1);
  expect(stub.state.supportMessages).toHaveLength(1);
  const uploaded = [...stub.supportFiles.values()][0];
  if (!uploaded) throw Error('No uploaded bytes');
  const entries = unzipSync(uploaded.bytes);
  expect(strFromU8(entries['application/app.log'] ?? new Uint8Array())).toBe(approved);
  expect(strFromU8(entries['report.txt'] ?? new Uint8Array())).toContain('Одобренное обращение');
  expect(uploads()[0]).toMatchObject({
    contentType: 'application/octet-stream',
    fileName: encodeURIComponent('Schema Teams report.zip'),
    bytes: uploaded.bytes.length,
  });
  const ledger = JSON.parse(readFileSync(join(profile, 'support-send-ledger.json'), 'utf8')),
    record = ledger.records[0];
  expect(record.files[0].sha256).toBe(createHash('sha256').update(uploaded.bytes).digest('hex'));
  const repeated = await page.evaluate(async (id) => {
    const state = await window.teams.request({ kind: 'init' });
    if (!state.ok) throw Error('No snapshot');
    return window.teams.request({ kind: 'report.send', epoch: state.data.epoch, id });
  }, record.previewId);
  expect(repeated).toMatchObject({
    ok: true,
    data: { status: 'confirmed', receipt: { messageId: record.receipt.messageId } },
  });
  expect(uploads()).toHaveLength(1);
  expect(posts()).toHaveLength(1);
  expect(stub.state.calls.some((c) => c.path.startsWith('/api/chats/9/'))).toBe(false);
});
test('lost final response survives close/edit/new preview; retry keeps exact body/key without another upload', async () => {
  stub.state.supportFinalLostResponse = true;
  const page = await launch();
  await open(page);
  await prepare(page, 'Первый одобренный текст');
  await send(page);
  await unknown(page);
  expect(stub.state.supportMessages).toHaveLength(1);
  const first = posts()[0];
  const attempts = posts().length;
  await panel(page).getByRole('button', { name: 'Закрыть сообщение о проблеме' }).click();
  await open(page);
  await prepare(page, 'Другой текст нового предпросмотра');
  await expect(
    panel(page).getByRole('button', { name: 'Отправить в поддержку', exact: true }),
  ).toBeDisabled();
  await expect(panel(page)).toContainText('Сначала проверьте результат предыдущей отправки');
  stub.state.supportFinalLostResponse = false;
  await panel(page).getByRole('button', { name: 'Проверить отправку', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('Предыдущее обращение отправлено');
  expect(posts()).toHaveLength(attempts + 1);
  for (const call of posts()) {
    expect(call.body).toEqual(first?.body);
    expect(call.requestId).toBe(first?.requestId);
  }
  expect(uploads()).toHaveLength(1);
  expect(stub.state.supportMessages).toHaveLength(1);
});
test('restart restores unresolved final without auto-send; explicit retry uses original file IDs', async () => {
  stub.state.supportFinalLostResponse = true;
  let page = await launch();
  await open(page);
  await prepare(page);
  await send(page);
  await unknown(page);
  const first = posts()[0];
  const attempts = posts().length;
  await app?.close();
  app = undefined;
  page = await launch(true);
  await open(page);
  await expect(panel(page)).toContainText('Результат отправки пока неизвестен');
  expect(posts()).toHaveLength(attempts);
  expect(uploads()).toHaveLength(1);
  stub.state.supportFinalLostResponse = false;
  await panel(page).getByRole('button', { name: 'Проверить отправку', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('Предыдущее обращение отправлено');
  expect(posts()).toHaveLength(attempts + 1);
  expect(posts().at(-1)?.body).toEqual(first?.body);
  expect(posts().at(-1)?.requestId).toBe(first?.requestId);
  expect(uploads()).toHaveLength(1);
  expect(stub.state.supportMessages).toHaveLength(1);
  writeFileSync(
    test.info().outputPath('support-transport.json'),
    JSON.stringify(
      {
        initialPhysicalPosts: attempts,
        totalPhysicalPosts: posts().length,
        explicitSendActions: 1,
        explicitRetryActions: 1,
        uploads: uploads().length,
        serverMessages: stub.state.supportMessages.length,
        allSameKey: posts().every((c) => c.requestId === first?.requestId),
        allSameBody: posts().every((c) => JSON.stringify(c.body) === JSON.stringify(first?.body)),
      },
      null,
      2,
    ),
  );
});
test('lost upload never guesses ID/final; next explicit send uses the same approved ZIP and only confirmed attachment', async () => {
  stub.state.supportUploadLostResponse = true;
  const page = await launch();
  await open(page);
  await prepare(page);
  await send(page);
  await expect(panel(page).getByRole('alert')).toContainText('Загрузка файла не подтверждена', {
    timeout: 25000,
  });
  expect(posts()).toHaveLength(0);
  const orphans = stub.supportFiles.size;
  expect(orphans).toBeGreaterThan(0);
  expect(uploads()).toHaveLength(orphans);
  stub.state.supportUploadLostResponse = false;
  await send(page);
  await expect(panel(page).getByRole('status')).toContainText('Обращение отправлено');
  expect(uploads()).toHaveLength(orphans + 1);
  expect(posts()).toHaveLength(1);
  const files = [...stub.supportFiles.entries()];
  const last = files.at(-1);
  for (const orphan of files.slice(0, orphans)) {
    expect(orphan[1].bytes.equals(last?.[1].bytes ?? Buffer.alloc(0))).toBe(true);
    expect(orphan[1].used).toBe(false);
  }
  expect(stub.state.supportMessages[0]?.fileIds).toEqual([last?.[0]]);
  writeFileSync(
    test.info().outputPath('support-upload-transport.json'),
    JSON.stringify(
      {
        initialPhysicalUploads: orphans,
        totalPhysicalUploads: uploads().length,
        explicitSendActions: 2,
        orphanAttachments: files.filter((f) => !f[1].used).length,
        confirmedAttachments: files.filter((f) => f[1].used).length,
        finalPosts: posts().length,
        serverMessages: stub.state.supportMessages.length,
      },
      null,
      2,
    ),
  );
});
test('expired unknown final stays locked across restart and new preview; no new key or final request', async () => {
  stub.state.supportFinalLostResponse = true;
  let page = await launch();
  await open(page);
  await prepare(page);
  await send(page);
  await unknown(page);
  const attempts = posts().length;
  await app?.close();
  app = undefined;
  if (!stub.state.desktopConfig) throw Error('No config');
  stub.state.desktopConfig.serverNow = '2026-11-02T04:00:00.000Z';
  page = await launch(true);
  await open(page);
  await expect(
    panel(page).getByRole('button', { name: 'Проверить отправку', exact: true }),
  ).toBeDisabled();
  await prepare(page, 'Новый предпросмотр не снимает неизвестный исход');
  await expect(
    panel(page).getByRole('button', { name: 'Отправить в поддержку', exact: true }),
  ).toBeDisabled();
  expect(posts()).toHaveLength(attempts);
  expect(uploads()).toHaveLength(1);
  await panel(page)
    .getByRole('checkbox', { name: 'Я проверил результат с поддержкой', exact: true })
    .check();
  await panel(page)
    .getByRole('button', { name: 'Результат проверен вручную', exact: true })
    .click();
  await expect(
    panel(page).getByRole('button', { name: 'Отправить в поддержку', exact: true }),
  ).toBeEnabled();
  stub.state.supportFinalLostResponse = false;
  await send(page);
  await expect(panel(page).getByRole('status')).toContainText('Обращение отправлено');
  expect(stub.state.supportMessages).toHaveLength(2);
  expect(posts().at(-1)?.requestId).not.toBe(posts()[0]?.requestId);
  expect(uploads()).toHaveLength(2);
});

test('no-support after unknown never releases the old attempt or feedback lock; restored chat retries original intent', async () => {
  stub.state.supportFinalLostResponse = true;
  const page = await launch();
  await open(page);
  await prepare(page);
  await send(page);
  await unknown(page);
  const record = JSON.parse(readFileSync(join(profile, 'support-send-ledger.json'), 'utf8'))
      .records[0],
    attempts = posts().length;
  if (!stub.state.desktopConfig) throw Error('No config');
  stub.state.desktopConfig.supportChatId = null;
  const refused = await page.evaluate(async (id) => {
    const state = await window.teams.request({ kind: 'init' });
    if (!state.ok) throw Error('No snapshot');
    return window.teams.request({ kind: 'report.retry', epoch: state.data.epoch, id });
  }, record.id);
  expect(refused).toMatchObject({ ok: false, code: 'no_support_chat' });
  expect(posts()).toHaveLength(attempts);
  await panel(page).getByRole('button', { name: 'Сохранить архив', exact: true }).click();
  await expect(
    panel(page).getByRole('button', { name: 'Открыть обратную связь на сайте' }),
  ).toBeDisabled();
  const kept = JSON.parse(readFileSync(join(profile, 'support-send-ledger.json'), 'utf8'))
    .records[0];
  expect(kept).toMatchObject({
    key: record.key,
    payload: record.payload,
    status: 'unresolved',
    mayHaveCommitted: true,
  });
  stub.state.desktopConfig.supportChatId = 9;
  stub.state.supportFinalLostResponse = false;
  await panel(page).getByRole('button', { name: 'Закрыть сообщение о проблеме' }).click();
  await open(page);
  await expect(
    panel(page).getByRole('button', { name: 'Проверить отправку', exact: true }),
  ).toBeEnabled();
  await panel(page).getByRole('button', { name: 'Проверить отправку', exact: true }).click();
  await expect(panel(page).getByRole('status')).toContainText('Предыдущее обращение отправлено');
  expect(stub.state.supportMessages).toHaveLength(1);
  expect(uploads()).toHaveLength(1);
  expect(posts().at(-1)?.body).toEqual(record.payload);
  expect(posts().at(-1)?.requestId).toBe(record.key);
});
test('no-support fallback opens only actual mine URL and reveals exact approved export; never uploads to feedback', async () => {
  configure(false);
  const page = await launch();
  await open(page);
  await prepare(page);
  await expect(
    panel(page).getByRole('button', { name: 'Отправить в поддержку', exact: true }),
  ).toBeDisabled();
  await panel(page).getByRole('button', { name: 'Сохранить архив', exact: true }).click();
  await expect(panel(page)).toContainText('Архив сохранён');
  await panel(page).getByRole('button', { name: 'Открыть обратную связь на сайте' }).click();
  expect(
    await active().evaluate(() => {
      const g = globalThis as typeof globalThis & { d7External: string[]; d7Revealed: string[] };
      return { urls: g.d7External, paths: g.d7Revealed };
    }),
  ).toEqual({ urls: [new URL('/?feedback=mine', stub.url).href], paths: [target] });
  expect(existsSync(target)).toBe(true);
  expect(stub.state.calls.some((c) => c.method === 'POST' && /support|feedback/.test(c.path))).toBe(
    false,
  );
});
test('corrupt ledger blocks send and feedback fallback even through IPC; local export still works', async () => {
  configure(false);
  writeFileSync(join(profile, 'support-send-ledger.json'), '{broken');
  const page = await launch();
  await open(page);
  await expect(panel(page).getByRole('alert')).toContainText(
    'Сохранённое состояние отправки недоступно',
  );
  const result = await page.evaluate(async () => {
    const state = await window.teams.request({ kind: 'init' });
    if (!state.ok) throw Error('No snapshot');
    const preview = await window.teams.request({
      kind: 'report.prepare',
      options: {
        description: 'Локальный архив',
        applicationLogs: false,
        revitYear: null,
        includeScreenshot: false,
      },
    });
    if (!preview.ok) throw Error('No preview');
    const saved = await window.teams.request({ kind: 'report.export', id: preview.data.id });
    if (!saved.ok || !saved.data) throw Error('No export');
    return window.teams.request({
      kind: 'report.fallback',
      epoch: state.data.epoch,
      id: saved.data.id,
    });
  });
  expect(result).toMatchObject({ ok: false, code: 'support_storage' });
  expect(existsSync(target)).toBe(true);
  expect(
    await active().evaluate(() => {
      const g = globalThis as typeof globalThis & { d7External: string[]; d7Revealed: string[] };
      return [g.d7External.length, g.d7Revealed.length];
    }),
  ).toEqual([0, 0]);
  expect(uploads()).toHaveLength(0);
  expect(posts()).toHaveLength(0);
});

const morningSeen = (): string[] =>
  JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).morningSeen ?? [];
async function checkMorning(allowed = true) {
  if (!app) throw Error('No app');
  await expect
    .poll(() =>
      active().evaluate(({ app }) => {
        const { createRequire } = process.getBuiltinModule('module'),
          load = createRequire(`${app.getAppPath()}/package.json`);
        return (load('./dist/main/index.js') as { client?: { morningFlight: boolean } }).client
          ?.morningFlight;
      }),
    )
    .toBe(false);
  await app.evaluate(async ({ app }, allowed) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`);
    const host = load('./dist/main/index.js') as {
      client?: {
        policy: { allows: () => Promise<boolean> };
        morningAttempt: unknown;
        checkMorning: () => Promise<void>;
      };
    };
    if (!host.client) throw Error('No client');
    host.client.policy.allows = async () => allowed;
    host.client.morningAttempt = undefined;
    await host.client.checkMorning();
  }, allowed);
}
async function toastSlots() {
  return active().evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`);
    return (
      load('./dist/main/index.js') as { client?: { toasts: { entries: Map<string, unknown> } } }
    ).client?.toasts.entries.size;
  });
}
test('morning zero does not consume day; positive server-working Saturday shows mixed counts once and restart retains marker', async () => {
  configure(false, true);
  await launch();
  await expect.poll(() => calls('/api/desktop/morning').length).toBeGreaterThan(0);
  await checkMorning();
  expect(morningSeen()).toEqual([]);
  stub.state.morningSummary = {
    date: '2026-10-31',
    workday: true,
    dueToday: 2,
    review: 0,
    newRemarks: 3,
  };
  if (!app) throw Error('No app');
  const pending = app.waitForEvent('window');
  await checkMorning();
  const popup = await pending;
  await expect(popup.locator('h1')).toHaveText('Доброе утро');
  await expect(popup.locator('.body')).toHaveText('Сроки сегодня: 2 · Новых замечаний: 3');
  await expect.poll(() => morningSeen().length).toBe(1);
  await popup.screenshot({ path: test.info().outputPath('morning-positive.png') });
  await popup.locator('#close').click();
  const before = calls('/api/desktop/morning').length;
  await app.close();
  app = undefined;
  const page = await launch(true);
  await checkMorning();
  expect(calls('/api/desktop/morning')).toHaveLength(before);
  expect(morningSeen()).toHaveLength(1);
  expect(
    await active().evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith('data:'))
          .length,
    ),
  ).toBe(0);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
});
test('morning DND and server holiday never consume day; later eligible native show does', async () => {
  configure(false, true);
  stub.state.morningSummary = {
    date: '2026-10-31',
    workday: true,
    dueToday: 1,
    review: 0,
    newRemarks: 0,
  };
  await launch(false, false);
  await checkMorning(false);
  await expect.poll(toastSlots).toBe(0);
  expect(morningSeen()).toEqual([]);
  stub.state.morningSummary.workday = false;
  await checkMorning(true);
  expect(morningSeen()).toEqual([]);
  expect(
    await active().evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith('data:'))
          .length,
    ),
  ).toBe(0);
  stub.state.morningSummary.workday = true;
  if (!app) throw Error('No app');
  const pending = app.waitForEvent('window');
  await checkMorning(true);
  const popup = await pending;
  await expect(popup.locator('.body')).toHaveText('Сроки сегодня: 1');
  await expect.poll(() => morningSeen().length).toBe(1);
});
test('morning late HTTP response after the separate settings toggle is off does not display or persist', async () => {
  configure(false, true);
  stub.state.morningSummary = {
    date: '2026-10-31',
    workday: true,
    dueToday: 2,
    review: 0,
    newRemarks: 0,
  };
  stub.state.morningDelayMs = 2000;
  const page = await launch();
  await expect.poll(() => calls('/api/desktop/morning').length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('tab', { name: 'Уведомления', exact: true }).click();
  await page.getByRole('checkbox', { name: /Утренняя сводка/ }).uncheck();
  await expect.poll(() => stub.state.morningResponses).toBeGreaterThan(0);
  await expect
    .poll(async () =>
      active().evaluate(({ app }) => {
        const { createRequire } = process.getBuiltinModule('module'),
          load = createRequire(`${app.getAppPath()}/package.json`);
        return (load('./dist/main/index.js') as { client?: { morningFlight: boolean } }).client
          ?.morningFlight;
      }),
    )
    .toBe(false);
  expect(morningSeen()).toEqual([]);
  expect(
    await active().evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith('data:'))
          .length,
    ),
  ).toBe(0);
  expect(
    JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).notifications.morning,
  ).toBe(false);
});
test('missing morning/support capabilities are honest local-only behavior, no business endpoints are called', async () => {
  configure(false, false, false);
  const page = await launch();
  await checkMorning();
  await open(page);
  await prepare(page);
  await expect(
    panel(page).getByRole('button', { name: 'Отправить в поддержку', exact: true }),
  ).toBeDisabled();
  expect(calls('/api/desktop/morning')).toHaveLength(0);
  expect(uploads()).toHaveLength(0);
  expect(posts()).toHaveLength(0);
  expect(morningSeen()).toEqual([]);
});
