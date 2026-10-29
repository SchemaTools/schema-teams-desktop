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
import { startClientStub, type ClientStub } from './clientStub';
import { timerFixture } from '../fixtures/time';
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
const liveTimer = (state: 'run' | 'pause') => {
  const now = new Date().toISOString(),
    from = new Date(Date.now() - 40 * 60000).toISOString();
  return {
    ...timerFixture(state),
    startedAt: from,
    serverNow: now,
    updatedAt: now,
    segments: [{ from, to: state === 'run' ? null : now }],
  };
};
const writes = () =>
  stub.state.calls.filter((c) => c.path.startsWith('/api/time/timer') && c.method !== 'GET');
const shownDay = () =>
  (
    JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) as {
      timerReminderSeen?: Record<string, string>;
    }
  ).timerReminderSeen ?? {};
test.beforeEach(async () => {
  stub = await startClientStub();
  stub.state.timers[1] = liveTimer('pause');
  profile = mkdtempSync(join(tmpdir(), 'stdesk-reminder-'));
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      timer: { pauseOnLock: true, askOnUnlock: true, reminderTime: '00:00' },
      notifications: { enabled: true, sound: false, preview: true },
    }),
  );
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
async function launch() {
  existingProfile(profile);
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
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'));
    w?.show();
    w?.focus();
  });
  return page;
}
async function policy(allowed: boolean, refresh = false) {
  if (!app) throw Error('App unavailable');
  await app.evaluate(
    ({ app }, config) => {
      const { createRequire } = process.getBuiltinModule('module'),
        load = createRequire(`${app.getAppPath()}/package.json`);
      const host = load('./dist/main/index.js') as {
        client?: {
          policy: { allows: () => Promise<boolean> };
          reminders: { reset: () => void };
          checkReminder: () => void;
        };
      };
      if (!host.client) throw Error('Client unavailable');
      host.client.policy.allows = async () => config.allowed;
      if (config.refresh) {
        host.client.reminders.reset();
        host.client.checkReminder();
      }
    },
    { allowed, refresh },
  );
}
async function fire() {
  if (!app) throw Error('App unavailable');
  const pending = app.waitForEvent('window');
  stub.pushTimer(liveTimer('run'));
  return pending;
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const s = await window.teams.request({ kind: 'init' });
    if (!s.ok) throw Error('State unavailable');
    return s.data;
  });
}
test('напоминание показывает таймер, завершение открывает проверку без команды паузы', async () => {
  const page = await launch();
  await policy(true);
  const toast = await fire();
  await expect(toast.getByText('Таймер ещё идёт', { exact: true })).toBeVisible();
  await expect(toast.getByText(/План первого этажа/)).toBeVisible();
  expect(writes()).toHaveLength(0);
  await expect.poll(() => Object.keys(shownDay()).length).toBe(1);
  await toast.getByRole('button', { name: '■ Закончить работу', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Учёт времени' })).toBeVisible();
  await expect(page.locator('.timer-state')).toHaveText('Идёт работа');
  expect(writes()).toHaveLength(0);
});
test('«Ещё работаю» закрывает напоминание, день не повторяется после перезапуска', async () => {
  const page = await launch();
  await policy(true);
  const toast = await fire();
  await expect(toast.getByText('Таймер ещё идёт', { exact: true })).toBeVisible();
  // DOM loads while the native window is still hidden and awaiting its display policy.
  // The restart scenario starts only after onShow records the actual presentation.
  await expect.poll(() => Object.keys(shownDay())).toEqual(['1']);
  await toast.getByRole('button', { name: 'Ещё работаю', exact: true }).click();
  // Restart after the native close has completed, not while its IPC handler is closing it.
  await expect.poll(() => toast.isClosed()).toBe(true);
  expect(writes()).toHaveLength(0);
  if (!app) throw Error('App unavailable');
  await app.close();
  app = undefined;
  existingProfile(profile);
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const reopened = await app.firstWindow();
  await expect(reopened.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect.poll(async () => (await snapshot(reopened)).timerReady).toBe(true);
  await policy(true, true);
  expect(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith('data:'))
          .length,
    ),
  ).toBe(0);
  expect(Object.keys(shownDay())).toEqual(['1']);
  expect(writes()).toHaveLength(0);
  expect(page.isClosed()).toBe(true);
});
test('отказ системной политики не засчитывает показ; после разрешения напоминание доступно', async () => {
  await launch();
  await policy(false);
  const denied = await fire();
  if (!app) throw Error('App unavailable');
  await expect.poll(() => denied.isClosed()).toBe(true);
  expect(shownDay()).toEqual({});
  const pending = app.waitForEvent('window');
  await policy(true, true);
  const allowed = await pending;
  await expect(allowed.getByText('Таймер ещё идёт', { exact: true })).toBeVisible();
  await expect.poll(() => Object.keys(shownDay()).length).toBe(1);
  expect(writes()).toHaveLength(0);
});
test('Фокус подавляет напоминание, после его завершения текущий таймер остаётся доступным', async () => {
  const page = await launch();
  await policy(true);
  let state = await snapshot(page);
  await page.evaluate(
    (epoch) => window.teams.request({ kind: 'focus.set', epoch, minutes: 30 }),
    state.epoch,
  );
  stub.pushTimer(liveTimer('run'));
  await expect.poll(async () => (await snapshot(page)).timer?.state).toBe('run');
  if (!app) throw Error('App unavailable');
  expect(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith('data:'))
          .length,
    ),
  ).toBe(0);
  expect(shownDay()).toEqual({});
  state = await snapshot(page);
  await page.evaluate(
    (epoch) => window.teams.request({ kind: 'focus.set', epoch, minutes: 0 }),
    state.epoch,
  );
  const pending = app.waitForEvent('window');
  await policy(true, true);
  const toast = await pending;
  await expect(toast.getByText('Таймер ещё идёт', { exact: true })).toBeVisible();
  expect(writes()).toHaveLength(0);
});
test('настройка скрытого текста не раскрывает задачу в напоминании', async () => {
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      timer: { reminderTime: '00:00' },
      notifications: { enabled: true, sound: false, preview: false },
    }),
  );
  await launch();
  await policy(true);
  const toast = await fire();
  await expect(
    toast.getByText('Таймер ещё идёт. Проверьте трудозатраты.', { exact: true }),
  ).toBeVisible();
  await expect(toast.locator('body')).not.toContainText('План первого этажа');
  expect(writes()).toHaveLength(0);
});
test('своё окно настроек сохраняет время с шагом 30 минут и показывает конец дня только для чтения', async () => {
  const page = await launch();
  await page.getByRole('button', { name: 'Таймер', exact: true }).click();
  const p = page.getByRole('dialog', { name: 'Учёт времени' });
  await p.getByText('Настройки учёта времени', { exact: true }).click();
  const time = p.getByRole('combobox', { name: 'Время напоминания' });
  await expect(time.locator('option')).toHaveCount(48);
  await expect(time).toHaveValue('00:00');
  await time.selectOption('19:00');
  await p.getByRole('button', { name: 'Сохранить время напоминания' }).click();
  await expect(p).toContainText('Время напоминания сохранено на этом компьютере.');
  await expect(p.locator('.timer-settings dd')).toHaveText('18:00');
  await expect(p.getByRole('checkbox', { name: 'Пауза при блокировке компьютера' })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('timer-settings-light.png') });
  await page.evaluate(() => window.teams.request({ kind: 'theme', mode: 'dark' }));
  await page.screenshot({ path: test.info().outputPath('timer-settings-dark.png') });
  await p.getByRole('button', { name: 'Закрыть таймер' }).click();
  await page.getByRole('button', { name: 'Таймер', exact: true }).click();
  await page.getByText('Настройки учёта времени', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Время напоминания' })).toHaveValue('19:00');
  expect(writes()).toHaveLength(0);
});
test('утреннее событие сервера показывает реальный итог и открывает трудозатраты нужного дня', async () => {
  const seed = stub.notifications[0];
  if (!seed) throw Error('Missing notification fixture');
  const link = '/time?view=list&period=custom&from=2026-10-28&to=2026-10-28';
  stub.notifications.push({
    ...seed,
    id: 72,
    event: 'timer_stopped',
    task: null,
    author: null,
    subject: 'АР3',
    reason:
      'Вчерашний таймер остановлен в полночь · АР3: записано до 18:00 с пометкой «проверить». Пропущено пересечение 10:00–11:00.',
    changes: [
      { field: 'subject', from: null, to: 'АР3' },
      { field: 'date', from: null, to: '2026-10-28' },
    ],
    link,
  });
  const page = await launch();
  if (!app) throw Error('App unavailable');
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      (globalThis as typeof globalThis & { timerSite?: string }).timerSite = url;
    };
  });
  await page
    .getByRole('navigation', { name: 'Папки' })
    .getByRole('button', { name: /^События(?: |$)/ })
    .click();
  const card = page.locator('[data-notification-id="72"]');
  await expect(card).toHaveAttribute('data-event-kind', 'timer');
  await expect(card.getByRole('heading')).toHaveText('Вчерашний таймер остановлен в полночь');
  await expect(card).toContainText('Пропущено пересечение 10:00–11:00.');
  await expect(card).not.toContainText('subject:');
  await card.getByRole('button', { name: 'Проверить запись', exact: true }).click();
  await expect
    .poll(() =>
      app?.evaluate(() => (globalThis as typeof globalThis & { timerSite?: string }).timerSite),
    )
    .toBe(new URL(link, stub.url).href);
  expect(writes()).toHaveLength(0);
});
