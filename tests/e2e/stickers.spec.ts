// Стикеры бюро (замечание 1 к PR #6; постановка Teams 0.9.0, п. 4.4).
import { existingProfile } from './existingProfile';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureMessage, startClientStub, type ClientStub } from './clientStub';
import { png } from './pngFixture';

const ROOT = resolve(__dirname, '..', '..');
let stub: ClientStub;
let app: ElectronApplication | undefined;
let profile: string;

test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-stickers-'));
  stub.files.set(801, { bytes: png(250, 200, 0), mime: 'image/png' });
  stub.files.set(802, { bytes: png(0, 120, 250), mime: 'image/png' });
  stub.files.set(803, { bytes: png(0, 0, 0), mime: 'image/png' });
  stub.state.stickers = [
    {
      id: 11,
      kind: 'sticker',
      name: '',
      fileId: 801,
      author: { id: 2, shortName: 'Петров П.П.' },
    },
    { id: 12, kind: 'sticker', name: '', fileId: 802, author: null },
    // свой эмодзи — не стикер: во вкладке стикеров его нет
    { id: 13, kind: 'emoji', name: 'кофе', fileId: 803, author: null },
  ];
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});

async function openChat() {
  existingProfile(profile);
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut', {
    timeout: 15_000,
  });
  const pending = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeEnabled();
  return page;
}

const stickerSends = () =>
  stub.state.calls.filter((c) => c.path === '/api/chats/4/messages' && c.method === 'POST');

test('вкладка «Стикеры бюро»: стикер уходит отдельным сообщением и показан без «облачка»', async () => {
  const page = await openChat();
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('черновик остаётся');
  await page.getByRole('button', { name: 'Эмодзи и стикеры', exact: true }).click();
  await page.getByRole('tab', { name: 'Стикеры бюро', exact: true }).click();
  const choices = page.locator('.sticker-choice');
  await expect(choices).toHaveCount(2);
  await expect(choices.first()).toHaveAttribute('title', 'Добавил Петров П.П.');
  await expect
    .poll(() =>
      choices
        .first()
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(2);
  await page.screenshot({ path: test.info().outputPath('stickers-panel.png') });

  await choices.first().click();
  await expect.poll(() => stickerSends().length).toBe(1);
  expect(stickerSends()[0]?.body).toMatchObject({ text: '', stickerId: 11 });

  const sticker = page.locator('.message-row.outgoing .message-sticker').last();
  await expect(sticker).toHaveAttribute('src', 'schema-attachment://sticker/801');
  await expect.poll(() => sticker.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
  const bubble = page.locator('.message-row.outgoing .message-bubble.sticker-message').last();
  expect(await bubble.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgba(0, 0, 0, 0)',
  );
  await expect(page.locator('.fallback-content')).toHaveCount(0);
  // черновик в поле ввода не тронут
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue(
    'черновик остаётся',
  );
  await page.screenshot({ path: test.info().outputPath('stickers-message.png') });
});

test('эмодзи по-прежнему вставляются в поле ввода; набор перечитывается по событию сервера', async () => {
  const page = await openChat();
  await page.getByRole('button', { name: 'Эмодзи и стикеры', exact: true }).click();
  await page.getByRole('button', { name: 'Вставить эмодзи «Нравится»', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('👍');

  await page.getByRole('button', { name: 'Эмодзи и стикеры', exact: true }).click();
  await page.getByRole('tab', { name: 'Стикеры бюро', exact: true }).click();
  await expect(page.locator('.sticker-choice')).toHaveCount(2);
  await page.keyboard.press('Escape');

  stub.state.stickers = stub.state.stickers.filter((s) => s.id !== 12);
  stub.stickersChanged();
  await page.getByRole('button', { name: 'Эмодзи и стикеры', exact: true }).click();
  await page.getByRole('tab', { name: 'Стикеры бюро', exact: true }).click();
  await expect(page.locator('.sticker-choice')).toHaveCount(1);
});

test('пустой набор — подсказка; стикер, удалённый администратором, — подпись', async () => {
  stub.state.stickers = [];
  const page = await openChat();
  await page.getByRole('button', { name: 'Эмодзи и стикеры', exact: true }).click();
  await page.getByRole('tab', { name: 'Стикеры бюро', exact: true }).click();
  await expect(page.getByText(/В наборе бюро пока нет стикеров/)).toBeVisible();
  await page.keyboard.press('Escape');

  stub.pushMessage({
    ...fixtureMessage(990, 4, ''),
    sticker: { id: 99, fileId: null },
  });
  await expect(page.getByText('Стикер удалён', { exact: true })).toBeVisible();
});

test('эмодзи бюро: вставляется кодом, в ленте — картинкой; незнакомый код остаётся текстом', async () => {
  const page = await openChat();
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Перерыв ');
  await page.getByRole('button', { name: 'Эмодзи и стикеры', exact: true }).click();
  await expect(page.getByText('Эмодзи бюро', { exact: true })).toBeVisible();
  // во вкладке эмодзи — только свои эмодзи, без стикеров
  await expect(page.locator('.bureau-emoji-grid button')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('bureau-emoji-panel.png') });
  // одна строка эмодзи — без полосы прокрутки
  expect(
    await page.locator('.bureau-emoji-grid').evaluate((el) => el.scrollHeight <= el.clientHeight),
  ).toBe(true);
  await page.getByRole('button', { name: 'Вставить эмодзи «:кофе:»', exact: true }).click();
  await expect(input).toHaveValue('Перерыв :кофе:');
  await input.press('End');
  await input.pressSequentially(' и :чай:');
  await input.press('Enter');

  const sent = page.locator('.message-row.outgoing .message-text').last();
  await expect(sent).toContainText('Перерыв');
  const img = sent.locator('img.bureau-emoji');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('alt', ':кофе:');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(2);
  await expect(sent).toContainText(':чай:');
  await page.screenshot({ path: test.info().outputPath('bureau-emoji-message.png') });
});
