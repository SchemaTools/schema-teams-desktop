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
import { timerFixture } from '../fixtures/time';
const ROOT = resolve(__dirname, '../..');
const liveTimer = (state: 'run' | 'pause' = 'run', taskId = 21) => {
  const now = new Date(),
    from = new Date(now.getTime() - 40 * 60000).toISOString();
  return {
    ...timerFixture(state, taskId),
    startedAt: from,
    updatedAt: now.toISOString(),
    serverNow: now.toISOString(),
    segments: [{ from, to: state === 'run' ? null : now.toISOString() }],
  };
};
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-timer-'));
  const now = new Date(),
    day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ timerReminderSeen: { '1': day, '2': day } }),
  );
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Учёт времени' });
const writes = () =>
  stub.state.calls.filter((c) => c.path.startsWith('/api/time/timer') && c.method !== 'GET');
async function launch() {
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  const next = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await next).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith('file:'),
    );
    win?.show();
    win?.focus();
  });
  await page.getByRole('button', { name: 'Таймер', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).getByRole('button', { name: 'Обновить состояние', exact: true }),
  ).toBeEnabled();
  return page;
}
async function prepare(page: Page) {
  await dialog(page).getByRole('button', { name: 'Закончить и проверить' }).click();
  await expect(dialog(page).getByRole('region', { name: 'Запись трудозатрат' })).toBeVisible();
}
test('выбор, поиск, запуск, пауза/продолжение и запись редактируемых строк в своём окне', async () => {
  const page = await launch(),
    p = dialog(page);
  await p.getByRole('textbox', { name: 'Поиск задачи для таймера' }).fill('первого');
  await expect(p.locator('.timer-task')).toHaveCount(1);
  await p.locator('.timer-task').click();
  await expect(p.locator('.timer-state')).toHaveText('Идёт работа');
  await p.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(p.locator('.timer-state')).toHaveText('На паузе');
  await p.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(p.locator('.timer-state')).toHaveText('Идёт работа');
  await prepare(page);
  await p.getByLabel('С 1', { exact: true }).selectOption('510');
  await p.getByLabel('До 1', { exact: true }).selectOption('600');
  await p.getByLabel('Примечание', { exact: true }).fill('Проверка фасадов');
  await p.getByRole('button', { name: 'Записать', exact: true }).click();
  await expect(p).toContainText('Трудозатраты записаны.');
  expect(stub.state.timerWrites).toEqual([
    {
      userId: 1,
      rows: [{ taskId: 21, date: '2026-10-29', from: 510, to: 600 }],
      note: 'Проверка фасадов',
    },
  ]);
  expect(writes().map((c) => [c.method, c.path])).toEqual([
    ['POST', '/api/time/timer/start'],
    ['POST', '/api/time/timer/pause'],
    ['POST', '/api/time/timer/resume'],
    ['POST', '/api/time/timer/pause'],
    ['POST', '/api/time/timer/finish'],
  ]);
});
test('пересечение выделяет строку, сохраняет ввод и позволяет исправить', async () => {
  stub.state.timers[1] = liveTimer();
  stub.state.timerFinishError = true;
  const page = await launch(),
    p = dialog(page);
  await prepare(page);
  await p.getByLabel('Примечание', { exact: true }).fill('Не терять ввод');
  await p.getByRole('button', { name: 'Записать', exact: true }).click();
  await expect(p).toContainText('Проверьте строку 1');
  await expect(p.locator('.timer-row.invalid')).toHaveCount(1);
  await expect(p.getByLabel('Примечание', { exact: true })).toHaveValue('Не терять ввод');
  await expect(p).not.toContainText('private detail');
  stub.state.timerFinishError = false;
  await p.getByLabel('До 1', { exact: true }).selectOption('600');
  await p.getByRole('button', { name: 'Записать', exact: true }).click();
  await expect(p).toContainText('Трудозатраты записаны.');
  expect(stub.state.timerWrites).toHaveLength(1);
});
test('потерянное подтверждение записи не запускает следующую задачу и не повторяет finish', async () => {
  stub.state.timers[1] = liveTimer();
  stub.state.timerFinishLostAck = true;
  const page = await launch(),
    p = dialog(page);
  await p.getByRole('button', { name: 'Выбрать другую задачу' }).click();
  await p.locator('.timer-task').filter({ hasText: 'Узлы фасада' }).click();
  await p.getByLabel('Примечание', { exact: true }).fill('Осталось в форме');
  await p.getByRole('button', { name: 'Записать и начать новую' }).click();
  await expect(p).toContainText('Результат действия неизвестен');
  await expect(p.getByRole('button', { name: 'Записать и начать новую' })).toBeDisabled();
  await expect(p.getByLabel('Примечание', { exact: true })).toHaveValue('Осталось в форме');
  await p.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
  await expect(p.getByRole('button', { name: 'Записать и начать новую' })).toBeDisabled();
  expect(stub.state.timerWrites).toHaveLength(1);
  expect(writes().filter((c) => c.path.endsWith('/start'))).toHaveLength(0);
  expect(writes().filter((c) => c.path.endsWith('/finish'))).toHaveLength(1);
});
test('смена задачи сначала записывает текущую, затем запускает выбранную', async () => {
  stub.state.timers[1] = liveTimer();
  const page = await launch(),
    p = dialog(page);
  await p.getByRole('button', { name: 'Выбрать другую задачу' }).click();
  await p.locator('.timer-task').filter({ hasText: 'Узлы фасада' }).click();
  await p.getByRole('button', { name: 'Записать и начать новую' }).click();
  await expect(p).toContainText('Новая задача начата.');
  await expect(p.locator('.timer-current')).toContainText('Узлы фасада');
  expect(writes().map((c) => c.path)).toEqual([
    '/api/time/timer/pause',
    '/api/time/timer/finish',
    '/api/time/timer/start',
  ]);
  expect(stub.state.timerWrites).toHaveLength(1);
});
test('изменение таймера другим клиентом блокирует старую форму; повторной команды нет', async () => {
  stub.state.timers[1] = liveTimer();
  const page = await launch(),
    p = dialog(page);
  await prepare(page);
  stub.pushTimer({ ...liveTimer('pause', 22), version: 20 });
  await expect(p.locator('.timer-current')).toContainText('Узлы фасада');
  await expect(p).toContainText('Таймер изменился. Эти интервалы');
  await expect(p.getByRole('button', { name: 'Записать', exact: true })).toBeDisabled();
  expect(writes().filter((c) => c.path.endsWith('/finish'))).toHaveLength(0);
});
test('нулевое округление не создаёт запись; сброс требует отдельного подтверждения', async () => {
  stub.state.timers[1] = liveTimer();
  stub.state.timerProposal.rows = [];
  const page = await launch(),
    p = dialog(page);
  await prepare(page);
  await expect(p).toContainText('нет интервалов для записи');
  await expect(p.getByRole('button', { name: 'Записать', exact: true })).toBeDisabled();
  await p.getByRole('button', { name: 'Сбросить', exact: true }).click();
  expect(writes().filter((c) => c.method === 'DELETE')).toHaveLength(0);
  await p.getByRole('button', { name: 'Отмена', exact: true }).click();
  await p.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await p.getByRole('button', { name: 'Да, сбросить', exact: true }).click();
  await expect(p).toContainText('Таймер сброшен без записи.');
  expect(stub.state.timerWrites).toHaveLength(0);
  expect(writes().filter((c) => c.method === 'DELETE')).toHaveLength(1);
});
test('открытие и блокировка компьютера не отправляют неподдержанную автопаузу; выход очищает окно', async () => {
  stub.state.timers[1] = liveTimer();
  const page = await launch(),
    p = dialog(page);
  expect(writes()).toHaveLength(0);
  if (!app) throw new Error('App unavailable');
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit('lock-screen');
    powerMonitor.emit('unlock-screen');
  });
  await expect(p).toContainText('Проверьте время после возвращения');
  await expect(p).toContainText('Автоматическая пауза не подтверждена.');
  expect(writes()).toHaveLength(0);
  await page.evaluate(async () => {
    const state = await window.teams.request({ kind: 'init' });
    if (state.ok) await window.teams.request({ kind: 'logout', epoch: state.data.epoch });
  });
  await expect(p).toHaveCount(0);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
});
test('окно в обеих темах: интервалы не выходят за границы, Escape возвращает фокус', async () => {
  stub.state.timers[1] = liveTimer();
  const page = await launch(),
    p = dialog(page);
  await prepare(page);
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((mode) => window.teams.request({ kind: 'theme', mode }), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await p.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`timer-${theme}.png`) });
  }
  await p.getByRole('button', { name: 'Закрыть таймер' }).press('Escape');
  await expect(p).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Таймер', exact: true })).toBeFocused();
});
test('три недавние задачи сохраняются для владельца после перезапуска и не показываются другому входу', async () => {
  const page = await launch(),
    p = dialog(page);
  await p.locator('.timer-task').filter({ hasText: 'Обучение' }).click();
  await expect(p.locator('.timer-current')).toContainText('Обучение');
  await p.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await p.getByRole('button', { name: 'Да, сбросить' }).click();
  await expect(p).toContainText('Таймер сброшен без записи.');
  if (!app) throw new Error('App unavailable');
  await app.close();
  app = undefined;
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const reopened = await app.firstWindow();
  await expect(reopened.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await reopened.getByRole('button', { name: 'Таймер', exact: true }).click();
  await expect(dialog(reopened).getByRole('heading', { name: 'Недавние' })).toBeVisible();
  await expect(dialog(reopened).locator('.timer-task').first()).toContainText('Обучение');
  await reopened.evaluate(async () => {
    const s = await window.teams.request({ kind: 'init' });
    if (s.ok) await window.teams.request({ kind: 'logout', epoch: s.data.epoch });
  });
  stub.state.loginUserId = 2;
  const pending = app.waitForEvent('window');
  await reopened.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(reopened.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await reopened.getByRole('button', { name: 'Таймер', exact: true }).click();
  await expect(dialog(reopened)).toContainText('Подходящих доступных задач нет.');
  await expect(dialog(reopened)).not.toContainText('Обучение');
});
test('offline запрещает запись и сохраняет редактирование формы', async () => {
  stub.state.timers[1] = liveTimer();
  const page = await launch(),
    p = dialog(page);
  await prepare(page);
  await p.getByLabel('Примечание', { exact: true }).fill('Черновик при обрыве');
  stub.state.healthOnline = false;
  stub.disconnect();
  await expect(p).toContainText('Нет связи. Изменение таймера');
  await expect(p.getByRole('button', { name: 'Записать', exact: true })).toBeDisabled();
  await expect(p.getByLabel('Примечание', { exact: true })).toHaveValue('Черновик при обрыве');
  expect(stub.state.timerWrites).toHaveLength(0);
});
test('назначение открывает собственный выбор задачи без автоматического запуска', async () => {
  stub.state.timers[1] = liveTimer();
  const page = await launch();
  await dialog(page).getByRole('button', { name: 'Закрыть таймер' }).click();
  await page
    .getByRole('navigation', { name: 'Папки' })
    .getByRole('button', { name: /^События(?: |$)/ })
    .click();
  await page.getByRole('button', { name: 'Начать работу', exact: true }).click();
  await expect(dialog(page).locator('.timer-task.suggested')).toContainText('План первого этажа');
  expect(writes()).toHaveLength(0);
});
test('таймер в настоящей карточке трея открывает то же собственное окно', async () => {
  stub.state.timers[1] = liveTimer();
  const page = await launch();
  await dialog(page).getByRole('button', { name: 'Закрыть таймер' }).click();
  if (!app) throw new Error('App unavailable');
  const pending = app.waitForEvent('window');
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`);
    const host = load('./dist/main/index.js') as {
      client?: {
        showMenu: (bounds: { x: number; y: number; width: number; height: number }) => void;
      };
    };
    host.client?.showMenu({ x: 1000, y: 700, width: 24, height: 24 });
  });
  const tray = await pending;
  await expect(tray.getByRole('region', { name: 'Таймер работы' })).toContainText(
    'План первого этажа',
  );
  await tray.getByRole('button', { name: 'Открыть таймер', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.timer-current')).toContainText('План первого этажа');
  expect(writes()).toHaveLength(0);
});
