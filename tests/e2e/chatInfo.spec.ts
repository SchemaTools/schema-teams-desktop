// Сведения о чате (замечание 5 к PR #6): щелчок по шапке — участники, картинки и файлы чата,
// у чата объекта — переход «Об объекте».
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
  profile = mkdtempSync(join(tmpdir(), 'stdesk-chatinfo-'));
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
    timeout: 35_000,
  });
  const pending = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeEnabled();
  return page;
}

const panel = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Сведения о чате' });

test('щелчок по названию — сведения: вид чата, участники, картинки и файлы', async () => {
  stub.files.set(701, { bytes: png(220, 60, 60), mime: 'image/png' });
  stub.files.set(702, { bytes: Buffer.from('план'), mime: 'text/plain' });
  const page = await openChat();
  stub.pushMessage({
    ...fixtureMessage(950, 4, 'Схема и пояснение'),
    files: [
      {
        fileId: 701,
        fileName: 'Схема узла.png',
        size: png(220, 60, 60).length,
        mime: 'image/png',
        isImage: true,
      },
      { fileId: 702, fileName: 'Пояснение.txt', size: 8, mime: 'text/plain', isImage: false },
    ],
  });
  await expect(page.locator('.message-row[data-message-id="950"]')).toBeVisible();

  const title = page.locator('.conversation-header h1 button');
  await title.click();
  await expect(panel(page)).toBeVisible();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page).locator('.chat-info-cover h3')).toHaveText('Тестовый чат');
  await expect(panel(page).getByText(/Личный чат · Участников: 2/)).toBeVisible();
  const members = panel(page).locator('.chat-info-members li');
  await expect(members).toHaveCount(2);
  await expect(members.last()).toContainText('Вы');
  // значок участника — круг, а не растянутый овал
  const box = await members.first().locator('.avatar').boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(Math.round(box?.height ?? -1));
  // у личного чата перехода «Об объекте» нет
  await expect(panel(page).getByRole('button', { name: 'Об объекте' })).toHaveCount(0);

  const images = panel(page).locator('.chat-info-image-grid .chat-info-media-item');
  await expect(images).toHaveCount(1);
  await expect
    .poll(() =>
      images
        .first()
        .locator('img.attachment-preview')
        .evaluate((img: HTMLImageElement) => img.naturalWidth)
        .catch(() => 0),
    )
    .toBe(2);
  const files = panel(page).locator('.chat-info-file-list .chat-info-media-item');
  await expect(files).toHaveCount(1);
  await expect(files.first()).toContainText('Пояснение.txt');
  const calls = stub.state.calls.filter((c) => c.path.startsWith('/api/chats/4/attachments'));
  expect(calls.map((c) => c.path).sort()).toEqual([
    '/api/chats/4/attachments?kind=file',
    '/api/chats/4/attachments?kind=image',
  ]);
  await page.screenshot({ path: test.info().outputPath('chat-info.png') });

  // Esc — закрыть, фокус возвращается на название
  await panel(page).getByRole('button', { name: 'Закрыть сведения о чате' }).press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(title).toBeFocused();
});

test('щелчок по обложке тоже открывает; у чата объекта — переход «Об объекте»', async () => {
  stub.state.objectChat = true;
  const page = await openChat();
  await page.locator('.conversation-header .avatar').click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByText(/Чат объекта/)).toBeVisible();
  await expect(panel(page).getByText('В чате пока нет картинок.')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Об объекте' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Сведения об объекте' })).toBeVisible();
  // кнопка ⓘ и сведения о чате не открыты одновременно
  await page.locator('.conversation-header h1 button').click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Сведения об объекте' })).toHaveCount(0);
});
