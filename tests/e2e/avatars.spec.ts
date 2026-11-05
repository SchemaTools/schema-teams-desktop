// Фото профиля (замечание 6 к PR #6): список чатов, шапка разговора, сообщения, меню трея.
import { existingProfile } from './existingProfile';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';
import { png } from './pngFixture';

const ROOT = resolve(__dirname, '..', '..');
let stub: ClientStub;
let app: ElectronApplication | undefined;
let profile: string;

test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-avatars-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});

async function signedIn() {
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
  return { app, page };
}

/** Фото в значке загрузилось и показано вместо букв. */
const photoShown = (avatar: import('@playwright/test').Locator) =>
  avatar.evaluate((el) => {
    const img = el.querySelector('img.avatar-photo') as HTMLImageElement | null;
    return (
      !!img &&
      img.complete &&
      img.naturalWidth === 2 &&
      el.classList.contains('with-photo') &&
      getComputedStyle(img).opacity === '1'
    );
  });

test('фото собеседника — в списке чатов, шапке разговора и у сообщений; своё — в меню трея', async () => {
  stub.files.set(901, { bytes: png(200, 40, 40), mime: 'image/png' });
  stub.files.set(902, { bytes: png(40, 200, 40), mime: 'image/png' });
  stub.state.userPhotos.set(1, 901);
  stub.state.userPhotos.set(2, 902);
  const { app, page } = await signedIn();

  const row = page.locator('.chat-row[data-chat-id="4"] .avatar');
  await expect.poll(() => photoShown(row)).toBe(true);

  await page.locator('.chat-row[data-chat-id="4"]').click();
  await expect.poll(() => photoShown(page.locator('.conversation-header .avatar'))).toBe(true);
  const authorAvatar = page.locator('.message-row:not(.outgoing) .avatar').first();
  await expect.poll(() => photoShown(authorAvatar)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('avatars-window.png') });

  const pending = app.waitForEvent('window');
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module');
    const load = createRequire(`${app.getAppPath()}/package.json`);
    const host = load('./dist/main/index.js') as {
      client?: { showMenu(bounds: { x: number; y: number; width: number; height: number }): void };
    };
    host.client?.showMenu({ x: 1000, y: 700, width: 24, height: 24 });
  });
  const tray = await pending;
  await expect(tray.locator('[data-surface="tray"]')).toBeVisible();
  await expect.poll(() => photoShown(tray.locator('.avatar').first())).toBe(true);
  await expect(tray.locator('.avatar').first().locator('img')).toHaveAttribute(
    'src',
    'schema-attachment://avatar/901',
  );

  // фото скачаны один раз, хотя показаны в нескольких местах
  const fileCalls = (id: number) =>
    stub.state.calls.filter((c) => c.path === `/api/files/${id}`).length;
  expect(fileCalls(902)).toBe(1);
  expect(fileCalls(901)).toBe(1);
});

test('фото недоступно или не картинка — остаются буквы', async () => {
  stub.files.set(902, { bytes: Buffer.from('<html>не картинка</html>'), mime: 'image/png' });
  stub.state.userPhotos.set(2, 902);
  stub.state.userPhotos.set(1, 999); // такого файла нет — 404
  const { page } = await signedIn();
  const row = page.locator('.chat-row[data-chat-id="4"] .avatar');
  await expect(row.locator('img.avatar-photo')).toHaveCount(0);
  await expect(row).not.toHaveClass(/with-photo/);
  await expect(row).toHaveText(/\S/);
});
