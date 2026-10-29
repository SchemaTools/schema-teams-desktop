import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';

const ROOT = resolve(__dirname, '..', '..');
let stub: ClientStub;
let app: ElectronApplication | undefined;
let profile: string;

test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-composer-'));
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
async function signIn(current: ElectronApplication, page: Page) {
  const pending = current.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const login = await pending;
  await expect(login.locator('#sign-in')).toBeVisible();
  await login.locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
}
async function authenticated() {
  const { app, page } = await start();
  await signIn(app, page);
  await expect(page.locator('.chat-row[data-chat-id="4"]')).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith('file:'),
    );
    win?.show();
    win?.focus();
  });
  return { app, page };
}
async function selectChat(page: Page, writable = true, chatId = 4) {
  await page.locator(`.chat-row[data-chat-id="${chatId}"]`).click();
  await expect(page.locator(`.messages-scroll[data-chat-id="${chatId}"]`)).toBeVisible();
  if (writable)
    await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeEnabled();
}
async function choose(current: ElectronApplication, filePaths: string[], canceled = false) {
  await current.evaluate(
    ({ dialog }, selection) => {
      dialog.showOpenDialog = async () => selection;
    },
    { canceled, filePaths },
  );
}
function fixtureFile(name = 'Пояснение.txt', content = 'Вложение тестового чата') {
  const file = join(profile, name);
  const bytes = Buffer.from(content, 'utf8');
  writeFileSync(file, bytes);
  return { file, bytes };
}
const uploads = () =>
  stub.state.calls.filter((call) => call.path === '/api/chats/4/files' && call.method === 'POST');
const sends = () =>
  stub.state.calls.filter(
    (call) => call.path === '/api/chats/4/messages' && call.method === 'POST',
  );
const chips = (page: Page) => page.locator('.composer-upload-chip');
async function attach(page: Page) {
  await page.getByRole('button', { name: 'Прикрепить файл', exact: true }).click();
}

test('выбранный файл загружается с CSRF, остаётся черновиком и отправляется без текста', async () => {
  const file = fixtureFile();
  const { app, page } = await authenticated();
  await choose(app, [file.file]);
  await selectChat(page);
  await attach(page);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page)).toContainText('Пояснение.txt');
  expect(sends()).toHaveLength(0);
  expect(uploads()).toHaveLength(1);
  const upload = uploads()[0];
  expect(upload).toMatchObject({
    csrf: 'csrf-test-only-user-1',
    userId: 1,
    bytes: file.bytes.length,
    body: null,
  });
  expect(decodeURIComponent(upload?.fileName ?? '')).toBe(basename(file.file));
  const fileId = Number(await chips(page).getAttribute('data-file-id'));
  expect(stub.files.get(fileId)?.bytes).toEqual(file.bytes);
  await page.screenshot({ path: test.info().outputPath('upload-draft-light.png') });
  await page.evaluate(() => window.teams.request({ kind: 'theme', mode: 'dark' }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: test.info().outputPath('upload-draft-dark.png') });
  const send = page.getByRole('button', { name: 'Отправить', exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(chips(page)).toHaveCount(0);
  expect(sends()).toHaveLength(1);
  expect(sends()[0]?.body).toEqual({ text: '', fileIds: [fileId] });
  const sent = stub.messages().filter((message) => message.author?.id === 1);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.files.map((item) => item.fileId)).toEqual([fileId]);
  expect(sent[0]?.text).toBe('');
});

test('убрать вложение и отменить выбор можно без отправки сообщения или новой загрузки', async () => {
  const file = fixtureFile();
  const { app, page } = await authenticated();
  await choose(app, [file.file]);
  await selectChat(page);
  await attach(page);
  await expect(chips(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Убрать Пояснение.txt', exact: true }).click();
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeDisabled();
  await choose(app, [], true);
  await attach(page);
  await expect(page.getByRole('button', { name: 'Прикрепить файл', exact: true })).toBeEnabled();
  await expect(chips(page)).toHaveCount(0);
  expect(uploads()).toHaveLength(1);
  expect(sends()).toHaveLength(0);
});

test('исполняемый файл отклоняется до сетевой загрузки и не появляется во вложениях', async () => {
  const file = fixtureFile('Проверка.exe', 'MZ fixture only');
  const { app, page } = await authenticated();
  await choose(app, [file.file]);
  await selectChat(page);
  await attach(page);
  await expect(page.locator('.compose-meta')).toHaveClass(/error-copy/);
  await expect(page.locator('.compose-meta')).not.toHaveText('');
  await expect(page.getByRole('button', { name: 'Прикрепить файл', exact: true })).toBeEnabled();
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeDisabled();
  expect(uploads()).toHaveLength(0);
  expect(sends()).toHaveLength(0);
});

test('картинка из буфера готовится главным процессом, подпись и файл уходят вместе', async () => {
  const { app, page } = await authenticated();
  await app.evaluate(({ clipboard, ClipboardItem }, png) => {
    // Only the method in this disposable Electron process is replaced. The OS clipboard is untouched.
    clipboard.read = async () => [
      new ClipboardItem({
        'image/png': new Blob([Buffer.from(png, 'base64')], { type: 'image/png' }),
      }),
    ];
  }, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jEpoAAAAASUVORK5CYII=');
  await selectChat(page);
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Картинка с подписью');
  await input.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([0])], 'clipboard.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page)).toContainText(/\.png/i);
  await expect(input).toHaveValue('Картинка с подписью');
  expect(sends()).toHaveLength(0);
  const fileId = Number(await chips(page).getAttribute('data-file-id'));
  expect(stub.files.get(fileId)?.mime).toBe('image/png');
  await input.press('Enter');
  await expect(chips(page)).toHaveCount(0);
  await expect(input).toHaveValue('');
  expect(sends()).toHaveLength(1);
  expect(sends()[0]?.body).toEqual({ text: 'Картинка с подписью', fileIds: [fileId] });
});

test('неподтверждённая отправка файла сохраняет IDs и повторяет тот же ключ без дубля', async () => {
  const file = fixtureFile();
  const { app, page } = await authenticated();
  await choose(app, [file.file]);
  await selectChat(page);
  await attach(page);
  await expect(chips(page)).toHaveCount(1);
  const fileId = Number(await chips(page).getAttribute('data-file-id'));
  stub.state.lostAckOnce = true;
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Повторить отправку', exact: true })).toBeVisible();
  await expect(chips(page)).toHaveCount(1);
  expect(sends()).toHaveLength(1);
  expect(sends()[0]?.body).toEqual({ text: '', fileIds: [fileId] });
  await page.getByRole('button', { name: 'Повторить отправку', exact: true }).click();
  await expect(chips(page)).toHaveCount(0);
  expect(sends()).toHaveLength(2);
  expect(sends()[1]?.requestId).toBe(sends()[0]?.requestId);
  expect(sends()[1]?.body).toEqual(sends()[0]?.body);
  expect(stub.messages().filter((message) => message.author?.id === 1)).toHaveLength(1);
  expect(uploads()).toHaveLength(1);
});

test('частичный успех выбора сохраняет допустимый файл и объясняет отказ второго', async () => {
  const good = fixtureFile();
  const blocked = fixtureFile('Проверка.cmd', '@echo fixture only');
  const { app, page } = await authenticated();
  await choose(app, [good.file, blocked.file]);
  await selectChat(page);
  await attach(page);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page)).toContainText('Пояснение.txt');
  await expect(chips(page)).not.toContainText('Проверка.cmd');
  await expect(page.locator('.compose-meta')).toHaveClass(/error-copy/);
  await expect(page.locator('.compose-meta')).not.toHaveText('');
  await expect(page.getByRole('button', { name: 'Прикрепить файл', exact: true })).toBeEnabled();
  expect(uploads()).toHaveLength(1);
  expect(sends()).toHaveLength(0);
});

test('в разговоре только для чтения нельзя прикрепить или отправить файл', async () => {
  stub.state.canWrite = false;
  const { page } = await authenticated();
  await selectChat(page, false);
  await expect(page.getByRole('button', { name: 'Прикрепить файл', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeDisabled();
  expect(uploads()).toHaveLength(0);
  expect(sends()).toHaveLength(0);
});

test('выход во время загрузки не переносит вложение прежнего пользователя в новый чат', async () => {
  const file = fixtureFile();
  const { app, page } = await authenticated();
  await choose(app, [file.file]);
  await selectChat(page);
  stub.state.uploadDelayMs = 1000;
  await attach(page);
  await expect.poll(() => uploads().length).toBe(1);
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'Выйти из учётной записи', exact: true }).click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  await expect(chips(page)).toHaveCount(0);
  stub.state.loginUserId = 2;
  await signIn(app, page);
  await selectChat(page, true, 8);
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeDisabled();
  expect(sends()).toHaveLength(0);
});
