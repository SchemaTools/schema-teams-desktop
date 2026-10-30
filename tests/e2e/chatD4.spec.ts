import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';
import type { ChatSummary, NotificationItem } from '../../src/shared/client';
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
const chat = (id: number, count: number | null | undefined): ChatSummary => ({
  id,
  kind: 'object',
  title: 'Одинаковый объект',
  peer: null,
  objectId: id + 100,
  objectCode: `ОБ-${id}`,
  memberCount: 2,
  last: null,
  unread: 0,
  mentioned: false,
  photoFileId: null,
  myActiveTasks: count,
  top: false,
});
const item = (id: number, event: string): NotificationItem => ({
  id,
  event,
  at: new Date().toISOString(),
  read: false,
  author: null,
  task: null,
  changes: [],
  reason: null,
  subject: 'Событие на объекте',
  link: '/albums/7',
});
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-d4-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
async function open(theme: 'light' | 'dark' = 'light'): Promise<Page> {
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ theme, onboardingComplete: true, autostart: false }),
  );
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  const pending = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect(page.locator('.chat-row[data-chat-id="4"]')).toBeVisible();
  await expect.poll(() => stub.state.socketConnections).toBeGreaterThan(0);
  return page;
}
const top = (page: Page, id: number) =>
  page.locator(`.chat-row-wrap:has([data-chat-id="${id}"]) .chat-top-action`);

test('группы используют ID и мои задачи; пять личных закреплений, шестой отказ без ложного успеха', async () => {
  stub.state.extraChats = [
    chat(10, 2),
    chat(11, 0),
    chat(12, null),
    chat(13, undefined),
    chat(14, 1),
    chat(15, 0),
  ];
  const page = await open();
  await expect(page.locator('[data-chat-group="active"] .chat-row')).toHaveCount(2);
  await expect(page.locator('[data-chat-group="other"] [data-chat-id="12"]')).toBeVisible();
  for (const id of [4, 10, 11, 12, 13]) {
    await top(page, id).click();
    await expect(top(page, id)).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(page.locator('[data-chat-group="top"] .chat-row')).toHaveCount(5);
  await top(page, 14).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Закрепить можно не больше 5 чатов.' }),
  ).toBeVisible();
  await expect(top(page, 14)).toHaveAttribute('aria-pressed', 'false');
  await top(page, 4).click();
  await expect(top(page, 4)).toHaveAttribute('aria-pressed', 'false');
  await top(page, 14).click();
  await expect(top(page, 14)).toHaveAttribute('aria-pressed', 'true');
  const calls = stub.state.calls.filter((c) => c.path.endsWith('/top'));
  expect(
    calls.every(
      (c) =>
        c.method === 'PUT' &&
        c.userId === 1 &&
        c.csrf !== null &&
        Object.keys(c.body ?? {}).join() === 'top',
    ),
  ).toBe(true);
});
test('старый сервер явно отключает закрепление; отказ прав не меняет строку', async () => {
  stub.state.legacyChatFields = true;
  const page = await open();
  await expect(top(page, 4)).toBeDisabled();
  await expect(top(page, 4)).toHaveAttribute(
    'title',
    'Закрепление чатов недоступно на этом сервере',
  );
  expect(stub.state.calls.filter((c) => c.path.endsWith('/top'))).toHaveLength(0);
});
test('ошибка прав закрепления не показывает подтверждение', async () => {
  stub.state.chatTopStatus = 403;
  const page = await open();
  await top(page, 4).click();
  await expect(page.getByRole('status').filter({ hasText: 'Недостаточно прав' })).toBeVisible();
  await expect(top(page, 4)).toHaveAttribute('aria-pressed', 'false');
});
test('quiet push остаётся непрочитанным, повтор и догрузка истории не создают popup', async () => {
  const page = await open();
  if (!app) throw Error('No app');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith('file:'))
      ?.hide();
  });
  const message = stub.push('Тихое сообщение', 4, false);
  stub.emit('chat:message', { ...message, quiet: true });
  await expect(page.locator('[data-chat-id="4"].chat-row .preview')).toContainText(
    'Тихое сообщение',
  );
  await expect(page.locator('[data-chat-id="4"].chat-row .unread-badge')).toBeVisible();
  stub.emit('chat:message', { ...message, quiet: false });
  stub.push('Догрузка истории', 4, false);
  stub.emit('chat:list', {});
  await expect(page.locator('[data-chat-id="4"].chat-row .preview')).toContainText(
    'Догрузка истории',
  );
  expect(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith('data:'))
          .length,
    ),
  ).toBe(0);
});
test('закрепления одного пользователя не появляются у следующего вошедшего пользователя', async () => {
  const page = await open();
  await top(page, 4).click();
  await expect(top(page, 4)).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(async () => {
    const state = await window.teams.request({ kind: 'init' });
    if (!state.ok) throw Error('No snapshot');
    await window.teams.request({ kind: 'logout', epoch: state.data.epoch });
  });
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  stub.state.loginUserId = 2;
  if (!app) throw Error('No app');
  const pending = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect(page.locator('[data-chat-id="8"].chat-row')).toBeVisible();
  await expect(page.locator('[data-chat-group="top"]')).toHaveCount(0);
  await expect(top(page, 8)).toHaveAttribute('aria-pressed', 'false');
});
for (const theme of ['light', 'dark'] as const)
  test(`8 Fluent реакций и Lucide stroke в теме ${theme}`, async () => {
    const page = await open(theme);
    await page.locator('[data-chat-id="4"].chat-row').click();
    const row = page.locator('.message-row[data-message-id="101"]');
    await row.hover();
    await expect(row.locator('[data-reaction-action]')).toHaveCount(6);
    expect(
      await row
        .locator('[data-reaction-action]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-reaction-action'))),
    ).toEqual(['like', 'heart', 'fire', 'done', 'look', 'party']);
    for (const kind of ['fire', 'party']) {
      await row.locator(`[data-reaction-action="${kind}"]`).click();
      await expect(row.locator(`[data-reaction-kind="${kind}"]`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    await row.getByRole('button', { name: 'Другие реакции' }).click();
    for (const kind of ['laugh', 'question']) {
      await row.locator(`[data-reaction-action="${kind}"]`).click();
      await expect(row.locator(`[data-reaction-kind="${kind}"]`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    expect(
      await row
        .locator('.reaction-badge')
        .evaluateAll((badges) => badges.map((b) => b.querySelectorAll('img').length)),
    ).toEqual([1, 1, 1, 1]);
    const bounds = await row.locator('.message-quick-reactions').evaluate((panel) => {
      const view = panel.closest('.messages-scroll');
      if (!view) throw Error('No viewport');
      const box = panel.getBoundingClientRect(),
        viewport = view.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
      };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.viewportTop);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportBottom);
    await row.locator('[data-reaction-action="fire"]').click();
    await expect(row.locator('[data-reaction-kind="fire"]')).toHaveCount(0);
    await row.locator('[data-reaction-action="fire"]').click();
    await expect(row.locator('[data-reaction-kind="fire"]')).toHaveCount(1);
    stub.emit('chat:list', {});
    await expect
      .poll(() =>
        row
          .locator('.reaction-badge')
          .evaluateAll((badges) => badges.map((b) => b.querySelectorAll('img').length)),
      )
      .toEqual([1, 1, 1, 1]);
    const last = page.locator('.message-row').last();
    const more = last.getByRole('button', { name: 'Другие реакции' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(() =>
        last.locator('.message-quick-reactions').evaluate((panel) => {
          const box = panel.getBoundingClientRect(),
            viewport = panel.closest('.messages-scroll')?.getBoundingClientRect();
          return !!viewport && box.top >= viewport.top && box.bottom <= viewport.bottom;
        }),
      )
      .toBe(true);
    expect(
      await last.locator('[data-reaction-action="question"]').evaluate((button) => {
        const box = button.getBoundingClientRect();
        return (
          document
            .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            ?.closest('button') === button
        );
      }),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toBeFocused();
    await expect
      .poll(() =>
        row
          .locator('.reaction-choice img')
          .evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).naturalWidth > 0)),
      )
      .toBe(true);
    const glyph = page.locator('.folder-button svg').first();
    await expect(glyph).toHaveAttribute('fill', 'none');
    await expect(glyph).toHaveAttribute('stroke', 'currentColor');
    await expect(glyph).toHaveAttribute('stroke-width', '2');
    await page.screenshot({ path: test.info().outputPath(`d4-lucide-${theme}.png`) });
  });

for (const theme of ['light', 'dark'] as const)
  test(`панель длинного сообщения доступна с клавиатуры в пределах viewport: ${theme}`, async () => {
    const first = stub.messages()[0];
    if (!first) throw Error('No message');
    first.text = 'Длинное сообщение\n'.repeat(80);
    const page = await open(theme);
    await page.locator('.chat-row[data-chat-id="4"]').click();
    const row = page.locator('.message-row[data-message-id="101"]');
    const more = row.getByRole('button', { name: 'Другие реакции' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(() =>
        row.locator('.message-quick-reactions').evaluate((panel) => {
          const box = panel.getBoundingClientRect(),
            view = panel.closest('.messages-scroll')?.getBoundingClientRect();
          return !!view && box.top >= view.top && box.bottom <= view.bottom;
        }),
      )
      .toBe(true);
    expect(
      await row.locator('[data-reaction-action="question"]').evaluate((button) => {
        const box = button.getBoundingClientRect();
        return (
          document
            .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            ?.closest('button') === button
        );
      }),
    ).toBe(true);
  });

test('live выдача при reduce истекает без animationend и не оживает после normal/повторного открытия', async () => {
  const page = await open();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.chat-row[data-chat-id="events"]').click();
  const value = item(900, 'album_issued');
  stub.notifications.push(value);
  stub.emit('notification', {
    item: value,
    kind: value.event,
    notificationId: value.id,
    quiet: false,
  });
  const card = page.locator('[data-notification-id="900"]');
  await expect(card).toHaveAttribute('data-event-kind', 'issued');
  expect(
    await card.locator('.event-icon').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  await expect(card).not.toHaveAttribute('data-celebration');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(
    await card.locator('.event-icon').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await page.locator('.chat-row[data-chat-id="events"]').click();
  stub.emit('notification', {
    item: value,
    kind: value.event,
    notificationId: value.id,
    quiet: false,
  });
  await expect(card).not.toHaveAttribute('data-celebration');
  expect(
    await card.locator('.event-icon').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
});
test('выдача/закрытие определяются kind+id; неизвестное событие спокойно; reduce отключает праздник', async () => {
  const page = await open();
  await page.locator('.chat-row[data-chat-id="events"]').click();
  const issued = item(801, 'album_issued');
  stub.notifications.push(issued);
  stub.emit('notification', {
    item: issued,
    kind: issued.event,
    notificationId: issued.id,
    quiet: false,
  });
  const card = page.locator('[data-notification-id="801"]');
  await expect(card).toHaveAttribute('data-event-kind', 'issued');
  await expect(card).toHaveAttribute('data-celebration', '801');
  await expect(card.locator('h2')).toHaveText('Альбом выдан');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await card.locator('.event-icon').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  for (const [id, event, category] of [
    [802, 'remarks_closed', 'closed'],
    [803, 'future_event', 'other'],
    [804, 'future_assigned', 'other'],
    [805, 'future_mention', 'other'],
    [806, 'future_deadline', 'other'],
  ] as const) {
    const value = item(id, event);
    value.subject = 'Альбом выдан';
    stub.notifications.push(value);
    stub.emit('notification', { item: value, kind: event, notificationId: id, quiet: false });
    const current = page.locator(`[data-notification-id="${id}"]`);
    await expect(current).toHaveAttribute('data-event-kind', category);
    await expect(current).not.toHaveAttribute('data-celebration');
  }
});
