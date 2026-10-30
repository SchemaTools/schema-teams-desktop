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
import { source } from 'axe-core';
import { collectNonText } from './nonTextContrast';
import { startClientStub, type ClientStub } from './clientStub';
import type { PluginCatalog } from '../../src/shared/plugins';
const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
const initial = (): PluginCatalog => ({
  tester: true,
  plugins: [
    {
      code: 'floor-plans',
      name: 'Планы этажей',
      short: 'ПЭ',
      stable: {
        id: 1,
        version: '1.10',
        verified: true,
        revit: [2025, 2026],
        notes: 'Исправлены подписи помещений.\nНовая проверка уровней.',
        size: 4,
        sha256: 'a'.repeat(64),
        url: '/api/desktop/plugins/files/1',
        publishedAt: '2026-10-31T04:00:00.000Z',
        requires: [{ plugin: 'schema-tools', minVersion: '2.0' }],
      },
      beta: {
        id: 2,
        version: '1.11',
        verified: false,
        revit: [2026],
        notes: 'Пробная сборка',
        size: 4,
        sha256: 'b'.repeat(64),
        url: '/api/desktop/plugins/files/2',
        publishedAt: '2026-10-31T04:00:00.000Z',
        requires: [],
      },
    },
  ],
});
const calls = () => stub.state.calls.filter((c) => c.path === '/api/desktop/plugins');
test.beforeEach(async () => {
  stub = await startClientStub();
  profile = mkdtempSync(join(tmpdir(), 'stdesk-plugins-'));
  stub.state.desktopConfig = {
    bureau: { timeZone: 'Asia/Yekaterinburg', workEnd: '18:00' },
    serverNow: new Date().toISOString(),
    supportChatId: null,
    capabilities: { timerControl: 2, plugins: 1 },
  };
  stub.state.pluginCatalog = initial();
});
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  await stub.close();
});
const pagePlugins = (page: Page) =>
  page.getByRole('region', { name: 'Плагины Revit', exact: true });
async function launch(theme: 'light' | 'dark' = 'light') {
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
  await expect.poll(() => stub.state.socketConnections).toBeGreaterThan(0);
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module'),
      load = createRequire(`${app.getAppPath()}/package.json`);
    const host = load('./dist/main/index.js') as {
      client?: { inventory: { inspect: () => Promise<unknown> } };
    };
    if (!host.client) throw Error('No host');
    host.client.inventory.inspect = async () => ({
      checkedAt: Date.now(),
      years: [
        {
          year: 2025,
          executable: 'found',
          addins: [{ scope: 'user', status: 'ok', names: ['unmanaged.addin'], truncated: false }],
        },
      ],
    });
  });
  await page.getByRole('button', { name: 'Плагины', exact: true }).click();
  return page;
}
for (const theme of ['light', 'dark'] as const)
  test(`approved plugin hero/cards/notes/settings and keyboard without false installed state: ${theme}`, async () => {
    const page = await launch(theme),
      panel = pagePlugins(page);
    await expect(panel.getByRole('heading', { name: 'Планы этажей' })).toBeVisible();
    await expect(panel).toContainText('1.10');
    await expect(panel).toContainText('доверенный издатель не настроен');
    await expect(panel).toContainText('unmanaged.addin — версия неизвестна');
    const summary = panel.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toContainText('Исправлены подписи помещений.');
    await expect(panel.getByRole('button', { name: 'Установить', exact: true })).toBeDisabled();
    await expect(panel).not.toContainText('всё установлено');
    await page.evaluate(source);
    const contrast = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: typeof import('axe-core') }).axe;
      axe.configure({
        checks: [
          {
            id: 'color-contrast',
            options: { contrastRatio: { normal: { expected: 4.5 }, large: { expected: 4.5 } } },
          },
        ],
      });
      return axe.run('.plugins-page', { runOnly: { type: 'rule', values: ['color-contrast'] } });
    });
    expect(contrast.violations).toEqual([]);
    await test.info().attach(`plugins-${theme}-text`, {
      body: JSON.stringify({
        violations: contrast.violations,
        incomplete: contrast.incomplete,
        passes: contrast.passes,
      }),
      contentType: 'application/json',
    });
    expect(contrast.passes.some((r) => r.nodes.length > 0)).toBe(true);
    const nonText = await page.evaluate(collectNonText, '.plugins-page');
    await test.info().attach(`plugins-${theme}-non-text`, {
      body: JSON.stringify(nonText),
      contentType: 'application/json',
    });
    for (const sample of nonText.samples) {
      const fg = rgb(sample.foreground),
        bg = rgb(sample.background),
        alpha = fg[3] ?? 1;
      const blended = fg.slice(0, 3).map((v, i) => v * alpha + (bg[i] ?? 0) * (1 - alpha));
      expect(colorContrast(blended, bg), sample.target).toBeGreaterThanOrEqual(3);
    }
    await page.screenshot({ path: test.info().outputPath(`plugins-${theme}.png`) });
    expect(
      stub.state.calls.some(
        (c) =>
          c.path.startsWith('/api/desktop/plugins/files/') ||
          c.path.startsWith('/api/admin/plugins'),
      ),
    ).toBe(false);
    const before = calls().length;
    await panel.getByRole('button', { name: 'Проверить', exact: true }).click();
    await expect.poll(() => calls().length).toBe(before + 1);
  });
test('tester opt-in switches beta; revocation/tester removal removes old metadata and rejects forged preference', async () => {
  const page = await launch(),
    panel = pagePlugins(page);
  await expect(panel.getByRole('checkbox', { name: 'Пробные сборки' })).toBeEnabled();
  await panel.getByRole('checkbox', { name: 'Пробные сборки' }).check();
  await expect(panel).toContainText('1.11');
  stub.state.pluginCatalog.tester = false;
  const plugin = stub.state.pluginCatalog.plugins[0];
  if (!plugin) throw Error('Missing fixture plugin');
  plugin.beta = null;
  plugin.stable = null;
  stub.emit('desktop:plugins', undefined);
  await expect(panel).toContainText('Нет доступной сборки');
  await expect(panel).not.toContainText('1.11');
  await expect(panel.getByRole('checkbox', { name: 'Пробные сборки' })).toHaveCount(0);
  const forged = await page.evaluate(async () => {
    const s = await window.teams.request({ kind: 'init' });
    if (!s.ok) throw Error('No snapshot');
    return window.teams.request({ kind: 'plugins.preferences', epoch: s.data.epoch, beta: true });
  });
  expect(forged).toMatchObject({ ok: false, code: 'forbidden' });
  expect(stub.state.calls.some((c) => c.path.includes('/plugins/files/'))).toBe(false);
});
test('empty catalog, forbidden response and retry are honest; no install or background downloads', async () => {
  stub.state.pluginCatalog = { tester: false, plugins: [] };
  const page = await launch(),
    panel = pagePlugins(page);
  await expect(panel).toContainText('Это не означает, что всё установлено');
  await expect(panel.getByRole('checkbox', { name: 'Пробные сборки' })).toHaveCount(0);
  stub.state.pluginCatalogStatus = 403;
  await panel.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Недостаточно прав');
  stub.state.pluginCatalogStatus = null;
  stub.state.pluginCatalog = initial();
  await panel.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Планы этажей' })).toBeVisible();
});
test('missing capability never calls catalog; stale IPC epoch is rejected', async () => {
  if (!stub.state.desktopConfig) throw Error('No config');
  stub.state.desktopConfig.capabilities = { timerControl: 2 };
  const page = await launch(),
    panel = pagePlugins(page);
  await expect(panel).toContainText('не предоставляет каталог');
  await panel.getByRole('button', { name: 'Проверить', exact: true }).click();
  expect(calls()).toHaveLength(0);
  const stale = await page.evaluate(() =>
    window.teams.request({ kind: 'plugins.refresh', epoch: 0 }),
  );
  expect(stale).toMatchObject({ ok: false, code: 'stale_session' });
});
test('logout during catalog read hides stale owner metadata and old response cannot restore it', async () => {
  const page = await launch(),
    panel = pagePlugins(page);
  await expect(panel.getByRole('heading', { name: 'Планы этажей' })).toBeVisible();
  stub.state.pluginCatalogDelayMs = 400;
  const before = calls().length;
  const work = page.evaluate(async () => {
    const s = await window.teams.request({ kind: 'init' });
    if (!s.ok) throw Error('No snapshot');
    return window.teams.request({ kind: 'plugins.refresh', epoch: s.data.epoch });
  });
  await expect.poll(() => calls().length).toBe(before + 1);
  await page.evaluate(async () => {
    const s = await window.teams.request({ kind: 'init' });
    if (!s.ok) throw Error('No snapshot');
    await window.teams.request({ kind: 'logout', epoch: s.data.epoch });
  });
  expect(await work).toMatchObject({ ok: false, code: 'stale_session' });
  await expect(panel.getByRole('heading', { name: 'Планы этажей' })).toHaveCount(0);
  await expect(panel).toContainText('Войдите');
});
function rgb(color: string): number[] {
  if (color.startsWith('color(srgb ')) {
    const values = color.match(/[\d.]+/g)?.map(Number);
    if (!values || values.length < 3) throw Error(`Unsupported computed color: ${color}`);
    return values.map((v, i) => (i < 3 ? v * 255 : v));
  }
  if (!/^rgba?\(/.test(color)) throw Error(`Unsupported computed color: ${color}`);
  const values = color.match(/[\d.]+/g)?.map(Number);
  if (!values || values.length < 3) throw Error(`Unsupported computed color: ${color}`);
  return values;
}
function colorContrast(foreground: number[], background: number[]): number {
  const luminance = (color: number[]) =>
    color.slice(0, 3).reduce((sum, value, i) => {
      const channel = value / 255;
      return (
        sum +
        (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
          ([0.2126, 0.7152, 0.0722][i] ?? 0)
      );
    }, 0);
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
