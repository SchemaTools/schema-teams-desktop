import { existingProfile } from './existingProfile';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';

const ROOT = resolve(__dirname, '..', '..');
let stub: ClientStub;
let app: ElectronApplication | undefined;
let profile: string;

test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-reactions-'));
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
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  const pending = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const login = await pending;
  await login.locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith('file:'),
    );
    win?.show();
    win?.focus();
  });
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await expect(page.locator('.messages-scroll[data-chat-id="4"]')).toBeVisible();
  return page;
}
const message = (page: Page) => page.locator('.message-row[data-message-id="101"]');
const choice = (page: Page, kind: string) =>
  message(page).locator(`.reaction-choice[data-reaction-action="${kind}"]`);
const badge = (page: Page, kind: string) =>
  message(page).locator(`.reaction-badge[data-reaction-kind="${kind}"]`);
const mutations = () =>
  stub.state.calls.filter(
    (call) =>
      /^\/api\/chats\/4\/messages\/101\/reactions(?:\/[^/]+)?$/.test(call.path) &&
      ['POST', 'DELETE'].includes(call.method),
  );
const fixture = () => {
  const value = stub.messages()[0];
  if (!value) throw new Error('Reaction fixture missing');
  return value;
};

test('реакция ставится и снимается по ответу API, счётчик и собственная отметка совпадают', async () => {
  fixture().reactions = [{ kind: 'like', users: [{ id: 2, shortName: 'Петров П.П.' }] }];
  const page = await openChat();
  await expect(badge(page, 'like')).toHaveAttribute('data-reaction-count', '1');
  await expect(badge(page, 'like')).toHaveAttribute('aria-pressed', 'false');
  await message(page).hover();
  await expect
    .poll(() =>
      message(page).evaluate((row) => {
        const panel = row.querySelector('.message-quick-reactions')?.getBoundingClientRect();
        const view = row.closest('.messages-scroll')?.getBoundingClientRect();
        return !!panel && !!view && panel.top >= view.top && panel.bottom <= view.bottom;
      }),
    )
    .toBe(true);
  await expect(choice(page, 'like')).toHaveAccessibleName('Поставить реакцию «Нравится»');
  await choice(page, 'like').click();
  await expect(badge(page, 'like')).toHaveAttribute('data-reaction-count', '2');
  await expect(badge(page, 'like')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => mutations().length).toBe(1);
  expect(mutations()[0]).toMatchObject({
    method: 'POST',
    path: '/api/chats/4/messages/101/reactions',
    body: { kind: 'like' },
    userId: 1,
    csrf: 'csrf-test-only-user-1',
  });
  await page.screenshot({ path: test.info().outputPath('reactions-light.png') });
  await page.evaluate(() => window.teams.request({ kind: 'theme', mode: 'dark' }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await message(page).hover();
  await page.screenshot({ path: test.info().outputPath('reactions-dark.png') });
  await badge(page, 'like').click();
  await expect(badge(page, 'like')).toHaveAttribute('data-reaction-count', '1');
  await expect(badge(page, 'like')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => mutations().length).toBe(2);
  expect(mutations()[1]).toMatchObject({
    method: 'DELETE',
    path: '/api/chats/4/messages/101/reactions/like',
    userId: 1,
    csrf: 'csrf-test-only-user-1',
  });
  expect(
    fixture()
      .reactions.find((item) => item.kind === 'like')
      ?.users.map((user) => user.id),
  ).toEqual([2]);
});

test('ожидающая реакция блокирует повтор и не создаёт плашку до подтверждения', async () => {
  stub.state.reactionDelayMs = 1200;
  const page = await openChat();
  await message(page).hover();
  await choice(page, 'heart').click();
  await expect.poll(() => mutations().length).toBe(1);
  await expect(choice(page, 'heart')).toBeDisabled();
  await expect(choice(page, 'like')).toBeDisabled();
  await expect(message(page).getByRole('status')).toHaveText('Сохранение реакции…');
  await expect(badge(page, 'heart')).toHaveCount(0);
  await expect(badge(page, 'heart')).toHaveAttribute('data-reaction-count', '1');
  await expect(badge(page, 'heart')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice(page, 'heart')).toBeEnabled();
  expect(mutations()).toHaveLength(1);
});

test('отказ 403 показывает ошибку и сохраняет прежние реакции без ложного успеха', async () => {
  fixture().reactions = [{ kind: 'like', users: [{ id: 2, shortName: 'Петров П.П.' }] }];
  stub.state.reactionStatus = 403;
  const page = await openChat();
  await message(page).hover();
  await choice(page, 'heart').click();
  await expect(message(page).locator('.reaction-error')).toHaveText(
    'Недостаточно прав для этого действия.',
  );
  await expect(badge(page, 'heart')).toHaveCount(0);
  await expect(badge(page, 'like')).toHaveAttribute('data-reaction-count', '1');
  await expect(badge(page, 'like')).toHaveAttribute('aria-pressed', 'false');
  await expect(choice(page, 'heart')).toBeEnabled();
  expect(mutations()).toHaveLength(1);
  expect(fixture().reactions).toEqual([
    { kind: 'like', users: [{ id: 2, shortName: 'Петров П.П.' }] },
  ]);
});

test('неизвестная реакция пропускается, локальные Fluent-картинки работают без сети и без анимаций при reduce', async () => {
  fixture().reactions = [
    { kind: 'future-reaction', users: [{ id: 2, shortName: 'Петров П.П.' }] },
    { kind: 'done', users: [{ id: 2, shortName: 'Петров П.П.' }] },
  ];
  const page = await openChat();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await message(page).hover();
  await expect(message(page).locator('.reaction-badge')).toHaveCount(1);
  await expect(badge(page, 'done')).toHaveAttribute('data-reaction-count', '1');
  await expect(badge(page, 'future-reaction')).toHaveCount(0);
  await expect(
    message(page).getByRole('button', { name: 'Открыть сообщение в Teams', exact: true }),
  ).toHaveCount(0);
  const pictures = message(page).locator('.reaction-choice img');
  await expect(pictures).toHaveCount(6);
  await expect
    .poll(() =>
      pictures.evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toBe(true);
  const urls = await pictures.evaluateAll((images) =>
    images.map((image) => (image as HTMLImageElement).src),
  );
  expect(urls.every((url) => url.startsWith('file:'))).toBe(true);
  expect(
    await pictures.evaluateAll((images) =>
      images.map((image) => getComputedStyle(image).animationName),
    ),
  ).toEqual(Array.from({ length: 6 }, () => 'none'));
  await page.context().setOffline(true);
  try {
    const widths = await page.evaluate(
      async (urls) =>
        Promise.all(
          urls.map(
            (url) =>
              new Promise<number>((resolve) => {
                const image = new Image();
                image.onload = () => resolve(image.naturalWidth);
                image.onerror = () => resolve(0);
                image.src = `${url}?offline-test=1`;
              }),
          ),
        ),
      urls,
    );
    expect(widths.every((width) => width > 0)).toBe(true);
  } finally {
    await page.context().setOffline(false);
  }
  await message(page).getByRole('button', { name: 'Другие реакции' }).click();
  await choice(page, 'question').click();
  await expect(badge(page, 'question')).toHaveAttribute('aria-pressed', 'true');
  expect(
    await badge(page, 'question')
      .locator('img')
      .evaluate((image) => getComputedStyle(image).animationName),
  ).toBe('none');
  expect(
    await badge(page, 'question')
      .locator('.reaction-ring')
      .evaluate((ring) => getComputedStyle(ring).display),
  ).toBe('none');
});
