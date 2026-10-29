import { existingProfile } from './existingProfile';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
const log = () => readFileSync(join(profile, 'logs', 'app.log'), 'utf8');
function active() {
  if (!app) throw Error('App unavailable');
  return app;
}
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-logging-'));
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ notifications: { enabled: false, sound: false, preview: false } }),
  );
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
  if (auth) {
    const next = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await (await next).locator('#sign-in').click();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  }
  return page;
}
test('обработчики ошибок и путь пишут только безопасные поля; новый журнал и предпросмотр без исходных данных', async () => {
  const page = await launch();
  await active().evaluate(({ app }) => {
    const load = process
        .getBuiltinModule('module')
        .createRequire(`${app.getAppPath()}/package.json`),
      host = load('./dist/main/index.js') as {
        client: {
          o: { log: { info: (message: string, details: Record<string, unknown>) => void } };
        };
      };
    process.emit('uncaughtException', new TypeError('dummy-password dummy-cookie private stack'));
    process.emit('unhandledRejection', 'dummy-password dummy-cookie', Promise.resolve());
    host.client.o.log.info('dynamic dummy-message\nforged line', { password: 'dummy-password' });
    host.client.o.log.info('открытие пути', { path: '\\\\server\\private-folder', result: 'ok' });
  });
  const text = log();
  expect(text).toContain('"errorType":"TypeError"');
  expect(text).toContain('"state":"signedOut"');
  expect(text).toContain('событие исключено');
  expect(text).toContain('открытие пути {"result":"ok"}');
  expect(text).not.toMatch(/dummy-|private|forged|https?:|127\.0\.0\.1/);
  const preview = await page.evaluate(() =>
    window.teams.request({
      kind: 'report.prepare',
      options: {
        description: 'Проверка журнала',
        applicationLogs: true,
        revitYear: null,
        includeScreenshot: false,
      },
    }),
  );
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw Error('No preview');
  const file = preview.data.files.find((f) => f.name === 'application/app.log');
  expect(file?.text).toContain('"errorType":"TypeError"');
  expect(file?.text).toContain('"state":"signedOut"');
  expect(JSON.stringify(preview)).not.toMatch(/dummy-|private|forged|https?:|127\.0\.0\.1/);
  expect(stub.state.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
});
test('таймер журналирует подтверждение, неизвестный исход и отказ preflight без повторов или содержимого задачи', async () => {
  const page = await launch(true);
  stub.state.timerFinishLostAck = true;
  const result = await page.evaluate(async () => {
    const init = await window.teams.request({ kind: 'init' });
    if (!init.ok) throw Error('No state');
    const epoch = init.data.epoch;
    const expected = (timer: { version: number; task: { id: number }; startedAt: string }) => ({
      version: timer.version,
      taskId: timer.task.id,
      startedAt: timer.startedAt,
    });
    const start = await window.teams.request({
      kind: 'timer.start',
      epoch,
      taskId: 21,
      expected: null,
    });
    if (!start.ok || !start.data) throw Error('Start failed');
    const pause = await window.teams.request({
      kind: 'timer.pause',
      epoch,
      expected: expected(start.data),
    });
    if (!pause.ok || !pause.data) throw Error('Pause failed');
    const resume = await window.teams.request({
      kind: 'timer.resume',
      epoch,
      expected: expected(pause.data),
    });
    if (!resume.ok || !resume.data) throw Error('Resume failed');
    const finish = await window.teams.request({
      kind: 'timer.finish',
      epoch,
      expected: expected(resume.data),
      rows: [{ taskId: 21, date: '2026-10-29', from: 540, to: 570 }],
      note: 'dummy-private-note',
    });
    const reset = await window.teams.request({
      kind: 'timer.reset',
      epoch,
      expected: expected(resume.data),
    });
    const another = await window.teams.request({
      kind: 'timer.start',
      epoch,
      taskId: 23,
      expected: null,
    });
    if (!another.ok || !another.data) throw Error('Second start failed');
    const confirmedReset = await window.teams.request({
      kind: 'timer.reset',
      epoch,
      expected: expected(another.data),
    });
    return { finish, reset, confirmedReset };
  });
  expect(result.finish).toMatchObject({ ok: false, uncertain: true });
  expect(result.reset).toMatchObject({ ok: false, code: 'timer_changed' });
  expect(result.confirmedReset.ok).toBe(true);
  expect(stub.state.timerWrites).toHaveLength(1);
  const lines = log()
      .split('\n')
      .filter((line) => line.includes('команда таймера ')),
    records = lines.map(
      (line) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>,
    );
  expect(records).toHaveLength(14);
  expect(records.filter((r) => r.phase === 'result' && r.outcome === 'uncertain')).toEqual([
    { command: 'finish', phase: 'result', outcome: 'uncertain', code: 'server_error' },
  ]);
  expect(records).toContainEqual({
    command: 'reset',
    phase: 'result',
    outcome: 'rejected',
    code: 'timer_changed',
  });
  expect(records).toContainEqual({ command: 'reset', phase: 'result', outcome: 'ok' });
  expect(log()).toContain('"state":"online"');
  expect(log()).toContain('"event":"time:timer"');
  expect(log()).not.toMatch(
    /dummy-|План первого этажа|Объект А|csrf-test-only|fixture-session-|taskId|startedAt|rows|note|server:/,
  );
  expect(
    stub.state.calls.filter((c) => c.method === 'POST' && c.path === '/api/time/timer/finish'),
  ).toHaveLength(1);
});
