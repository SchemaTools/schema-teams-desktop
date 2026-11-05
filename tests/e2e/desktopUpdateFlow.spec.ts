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
import { createHash } from 'node:crypto';
import { existingProfile } from './existingProfile';
import { startClientStub, type ClientStub } from './clientStub';
import { releaseFixture } from '../fixtures/updates';
import type {
  DesktopUpdateController,
  DesktopUpdateControllerOptions,
} from '../../src/main/desktop/updateController';
interface Probe {
  paths: string[];
  quit: number;
  holdSpawn: boolean;
  holdRead: boolean;
  releaseSpawn?: () => void;
  releaseRead?: () => void;
}
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-updater-flow-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});
async function launch(theme = 'light') {
  existingProfile(profile);
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ theme, onboardingComplete: true, autostart: false }),
  );
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut', {
    // запуск Electron на машине CI бывает дольше 5 с (05.11: plugins, timer)
    timeout: 15_000,
  });
  const login = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await login).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await expect.poll(() => stub.state.socketConnections).toBeGreaterThan(0);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'));
    w?.show();
    w?.focus();
  });
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeEnabled();
  return page;
}
async function about(page: Page) {
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('button', { name: 'О программе', exact: true }).click();
  return page.getByRole('dialog', { name: 'Настройки', exact: true });
}
/** Isolated test adapter, installed through Playwright main inspection ONLY.
 * Actual controller/stream/files/IPC/UI; inert baseline+candidate, injected
 * signature oracle and runner/quit spies. This is not production trust or U3 execution.
 */
async function prepareFixture(page: Page) {
  if (!app) throw Error('missing app');
  const bytes = Buffer.from('INERT UPDATE FIXTURE');
  stub.state.latest = {
    ...releaseFixture('1.1.0'),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const id = await app.evaluate(async ({ app }, profile) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`);
    const { writeFileSync } = process.getBuiltinModule('fs'),
      { join } = process.getBuiltinModule('path');
    const baseline = join(profile, 'inert-baseline.exe');
    writeFileSync(baseline, 'INERT BASELINE');
    const { client } = load('./dist/main/index.js') as {
      client?: {
        desktopUpdates: DesktopUpdateController;
        api: { latestRelease: () => Promise<{ ok: boolean; data?: unknown }> };
        updateContext: () => { stamp: string };
        publish: () => void;
      };
    };
    if (!client) throw Error('missing host');
    const original = (client.desktopUpdates as unknown as { o: DesktopUpdateControllerOptions }).o;
    client.desktopUpdates.destroy();
    const probe: Probe = { paths: [], quit: 0, holdSpawn: true, holdRead: false };
    (globalThis as unknown as { updateProbe: Probe }).updateProbe = probe;
    const { DesktopUpdateController } = load('./dist/main/desktop/updateController.js') as {
      DesktopUpdateController: typeof import('../../src/main/desktop/updateController').DesktopUpdateController;
    };
    client.desktopUpdates = new DesktopUpdateController({
      ...original,
      context: () => ({
        ...original.context(),
        executable: baseline,
        windows: true,
        packaged: true,
      }),
      publisherPins: () => ['a'.repeat(64)],
      stagingRoot: join(profile, 'inert-update-stage'),
      pathAllowed: async () => true,
      verify: async (path, hash) => ({
        v: 1,
        verdict: 'valid',
        reason: 'verified',
        fileSha256: hash,
        signerDerSha256: path.endsWith('.exe') ? 'a'.repeat(64) : null,
        winTrustCode: '00000000',
      }),
      fetch: async () =>
        new Response(new TextEncoder().encode('INERT UPDATE FIXTURE'), {
          status: 200,
          headers: { 'content-length': '20' },
        }),
      readLatest: async (signal) => {
        if (probe.holdRead)
          await new Promise<void>((done) => {
            probe.releaseRead = done;
          });
        return original.readLatest(signal);
      },
      handoff: async (path) => {
        probe.paths.push(path);
        if (probe.holdSpawn)
          await new Promise<void>((done) => {
            probe.releaseSpawn = done;
          });
      },
      quit: () => {
        probe.quit++;
      },
      onChange: () => client.publish(),
    });
    const latest = await client.api.latestRelease();
    if (!latest.ok) throw Error('missing latest');
    return client.desktopUpdates.setOffer(latest.data, client.updateContext().stamp);
  }, profile);
  if (!id) throw Error('missing offer');
  const result = await page.evaluate(
    (id) => window.teams.request({ kind: 'updates.prepare', offerId: id }),
    id,
  );
  expect(result.ok && result.data.phase).toBe('ready');
}
async function probe() {
  if (!app) throw Error('missing app');
  return app.evaluate(() => {
    const p = (globalThis as unknown as { updateProbe: Probe }).updateProbe;
    return { paths: p.paths, quit: p.quit, waitingRead: !!p.releaseRead };
  });
}
for (const theme of ['light', 'dark'])
  test(`explicit update confirmation preserves drafts on decline and locks mutations until spy spawn: ${theme}`, async () => {
    const page = await launch(theme);
    await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Hidden draft');
    await prepareFixture(page);
    const panel = await about(page);
    await panel
      .getByRole('button', { name: 'Установить и закрыть приложение', exact: true })
      .click();
    const confirm = panel.getByRole('group', { name: 'Подтверждение выхода для обновления' });
    await expect(confirm).toContainText('1');
    await confirm.getByRole('button', { name: 'Вернуться', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await panel
      .getByRole('button', { name: 'Установить и закрыть приложение', exact: true })
      .click();
    await confirm.getByRole('button', { name: 'Закрыть и установить', exact: true }).click();
    await expect.poll(async () => (await probe()).paths.length).toBe(1);
    expect((await probe()).quit).toBe(0);
    const blocked = await page.evaluate(async () => {
      const s = await window.teams.request({ kind: 'init' });
      if (!s.ok) throw Error('missing init');
      return window.teams.request({
        kind: 'chat.send',
        epoch: s.data.epoch,
        chatId: 4,
        text: 'must not send',
        fileIds: [],
        requestId: 'updater-blocked-1234',
      });
    });
    expect(blocked).toMatchObject({ ok: false, code: 'update_in_progress' });
    if (!app) throw Error('missing app');
    const replacement = await app.evaluate(async ({ app }) => {
      const { createRequire } = process.getBuiltinModule('module'),
        load = createRequire(`${app.getAppPath()}/package.json`);
      const module = load('./dist/main/index.js') as {
        client: { o: { server: URL; activateServer: (url: URL) => Promise<void> } };
      };
      const old = module.client;
      let denied = false;
      try {
        await old.o.activateServer(new URL(old.o.server.origin));
      } catch (error) {
        denied = error instanceof Error && error.message === 'update_in_progress';
      }
      return { denied, sameHost: module.client === old };
    });
    expect(replacement).toEqual({ denied: true, sameHost: true });
    await panel.press('Escape');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue(
      'Hidden draft',
    );
    await page.screenshot({ path: test.info().outputPath(`update-handoff-${theme}.png`) });
    if (!app) throw Error('missing app');
    await app.evaluate(() => {
      (globalThis as unknown as { updateProbe: Probe }).updateProbe.releaseSpawn?.();
    });
    await expect.poll(async () => (await probe()).quit).toBe(1);
    expect(
      stub.state.calls.filter((c) => c.method === 'POST' && c.path === '/api/chats/4/messages'),
    ).toHaveLength(0);
  });
test('cancel during final read releases both locks without discarding the chat draft', async () => {
  const page = await launch();
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Keep me');
  await prepareFixture(page);
  if (!app) throw Error('missing app');
  await app.evaluate(() => {
    (globalThis as unknown as { updateProbe: Probe }).updateProbe.holdRead = true;
  });
  const panel = await about(page);
  await panel.getByRole('button', { name: 'Установить и закрыть приложение', exact: true }).click();
  await panel.getByRole('button', { name: 'Закрыть и установить', exact: true }).click();
  await expect.poll(async () => (await probe()).waitingRead).toBe(true);
  const latePopup = await app.evaluate(({ app, BrowserWindow }) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`);
    const host = load('./dist/main/index.js') as {
      client: {
        toasts: { show: (s: import('../../src/main/notifications/types').ToastSpec) => boolean };
      };
    };
    const before = BrowserWindow.getAllWindows().length;
    const shown = host.client.toasts.show({
      id: 'late-fixture',
      key: 'late',
      groupId: 'fixture',
      delayMs: 0,
      title: 'Blocked popup',
      body: 'Inert',
      buttons: [],
      hasReply: true,
    });
    return { shown, before, after: BrowserWindow.getAllWindows().length };
  });
  expect(latePopup.shown).toBe(false);
  expect(latePopup.after).toBe(latePopup.before);
  await panel.getByRole('button', { name: 'Отменить обновление', exact: true }).click();
  await expect(panel.getByText('Завершаем отменённую проверку…', { exact: true })).toBeVisible();
  await app.evaluate(() => {
    (globalThis as unknown as { updateProbe: Probe }).updateProbe.releaseRead?.();
  });
  await expect(page.locator('.app-shell')).not.toHaveAttribute('aria-busy', 'true');
  await panel.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue(
    'Keep me',
  );
  expect((await probe()).paths).toEqual([]);
  expect((await probe()).quit).toBe(0);
});
for (const editor of ['message', 'timer'] as const)
  test(`open ${editor} editor blocks launch without silently closing it`, async () => {
    const page = await launch();
    if (editor === 'message') {
      const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
      await input.fill('Editable fixture');
      await input.press('Enter');
      await expect(input).toHaveValue('');
      const own = stub.messages().find((m) => m.text === 'Editable fixture');
      if (!own) throw Error('missing fixture message');
      const row = page.locator(`.message-row[data-message-id="${own.id}"]`);
      await row.hover();
      await row.getByRole('button', { name: 'Изменить сообщение', exact: true }).click();
      await page.getByRole('textbox', { name: 'Текст правки', exact: true }).fill('Unsaved edit');
    } else
      await page.evaluate(async () => {
        const s = await window.teams.request({ kind: 'init' });
        if (s.ok)
          await window.teams.request({ kind: 'timer.open', epoch: s.data.epoch, mode: 'pick' });
      });
    await prepareFixture(page);
    if (editor === 'timer')
      await page.evaluate(() => window.teams.request({ kind: 'settings.open', tab: 'about' }));
    const panel =
      editor === 'timer'
        ? page.getByRole('dialog', { name: 'Настройки', exact: true })
        : await about(page);
    await panel
      .getByRole('button', { name: 'Установить и закрыть приложение', exact: true })
      .click();
    await expect(panel.getByRole('alert')).toContainText('Завершите открытые формы');
    expect((await probe()).paths).toEqual([]);
    await panel.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    if (editor === 'message')
      await expect(page.getByRole('textbox', { name: 'Текст правки', exact: true })).toHaveValue(
        'Unsaved edit',
      );
    else await expect(page.locator('.timer-panel')).toBeVisible();
  });
test('hidden unsaved tray reply blocks confirmation before any installer handoff', async () => {
  const page = await launch();
  await page.locator('.folder-button').filter({ hasText: 'События' }).click();
  stub.push('Unread tray fixture', 4, false);
  stub.emit('chat:list', null);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const s = await window.teams.request({ kind: 'init' });
        return s.ok ? (s.data.chats.find((c) => c.id === 4)?.unread ?? 0) : 0;
      }),
    )
    .toBeGreaterThan(0);
  if (!app) throw Error('missing app');
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`);
    (
      load('./dist/main/index.js') as {
        client: { showMenu: (b: { x: number; y: number; width: number; height: number }) => void };
      }
    ).client.showMenu({ x: 10, y: 10, width: 20, height: 20 });
  });
  await expect.poll(() => app?.windows().some((w) => w.url().includes('surface=tray'))).toBe(true);
  const tray = app.windows().find((w) => w.url().includes('surface=tray'));
  if (!tray) throw Error('missing tray page');
  await tray.getByRole('textbox', { name: 'Ответить…', exact: true }).fill('Keep tray reply');
  await tray.evaluate(() => window.teams.request({ kind: 'window.hide' }));
  await prepareFixture(page);
  const panel = await about(page);
  await panel.getByRole('button', { name: 'Установить и закрыть приложение', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('несохранённые ответы в меню трея');
  await expect(
    panel.getByRole('group', { name: 'Подтверждение выхода для обновления' }),
  ).toHaveCount(0);
  expect((await probe()).paths).toEqual([]);
});

test('an existing popup reply remains intact and blocks updater confirmation', async () => {
  const page = await launch();
  await page.locator('.folder-button').filter({ hasText: 'События' }).click();
  if (!app) throw Error('missing app');
  await app.evaluate(({ app, BrowserWindow }) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`);
    const host = load('./dist/main/index.js') as {
      client: { policy: { allows: () => Promise<boolean> } };
    };
    host.client.policy.allows = async () => true;
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith('file:'))
      ?.hide();
  });
  stub.push('Popup draft fixture');
  await expect.poll(() => app?.windows().some((w) => w.url().startsWith('data:'))).toBe(true);
  const popup = app.windows().find((w) => w.url().startsWith('data:'));
  if (!popup) throw Error('missing popup');
  await popup.locator('textarea').fill('Keep popup reply');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('file:'));
    w?.show();
    w?.focus();
  });
  await prepareFixture(page);
  const panel = await about(page);
  await panel.getByRole('button', { name: 'Установить и закрыть приложение', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Закройте уведомления с ответом');
  await expect(
    panel.getByRole('group', { name: 'Подтверждение выхода для обновления' }),
  ).toHaveCount(0);
  await expect(popup.locator('textarea')).toHaveValue('Keep popup reply');
  expect((await probe()).paths).toEqual([]);
  expect((await probe()).quit).toBe(0);
});
