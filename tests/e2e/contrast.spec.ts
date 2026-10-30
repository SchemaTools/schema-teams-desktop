import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { source } from 'axe-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startClientStub, type ClientStub } from './clientStub';
import { collectNonText } from './nonTextContrast';

const ROOT = resolve(__dirname, '../..');
let stub: ClientStub, app: ElectronApplication | undefined, profile: string;
test.beforeEach(async () => {
  stub = await startClientStub();
  stub.state.objectChat = true;
  for (const [id, event] of [
    [801, 'album_issued'],
    [802, 'remarks_closed'],
  ] as const)
    stub.notifications.push({
      id,
      event,
      at: new Date().toISOString(),
      read: false,
      author: null,
      task: null,
      changes: [],
      reason: null,
      subject: 'Проверка нового события',
      link: '/albums/7',
    });
  profile = mkdtempSync(join(tmpdir(), 'stdesk-contrast-'));
});
test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await stub.close();
});

async function launch(theme: 'light' | 'dark', setup = false) {
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({ theme, onboardingComplete: !setup, autostart: false }),
  );
  app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: stub.url },
  });
  const page = await app.firstWindow();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  return page;
}

async function login(page: Page, setup = false) {
  if (!app) throw Error('App unavailable');
  const pending = app.waitForEvent('window');
  await page.getByRole('button', { name: setup ? 'Войти в Teams' : 'Войти', exact: true }).click();
  await (await pending).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
}

async function audit(page: Page, name: string, context = 'html') {
  await page.locator(context).waitFor({ state: 'visible' });
  // Inject only in test Chromium. Production CSP and the packaged renderer stay unchanged.
  await page.evaluate(source);
  const result = await page.evaluate(async (selector) => {
    const axe = (window as unknown as { axe: typeof import('axe-core') }).axe;
    axe.configure({
      checks: [
        {
          id: 'color-contrast',
          // The product specification also requires 4.5:1 for large text.
          options: { contrastRatio: { normal: { expected: 4.5 }, large: { expected: 4.5 } } },
        },
      ],
    });
    return axe.run(selector, { runOnly: { type: 'rule', values: ['color-contrast'] } });
  }, context);
  await test.info().attach(name, {
    body: JSON.stringify({
      violations: result.violations,
      incomplete: result.incomplete,
      passes: result.passes,
    }),
    contentType: 'application/json',
  });
  // Gradient/obscured/short-text nodes in incomplete remain reported, never counted as passes.
  expect(
    result.passes.some((rule) => rule.nodes.length > 0),
    name,
  ).toBe(true);
  expect(result.violations, name).toEqual([]);
  const nonText = await page.evaluate(collectNonText, context);
  await test.info().attach(`${name}-non-text`, {
    body: JSON.stringify(nonText),
    contentType: 'application/json',
  });
  for (const sample of nonText.samples) {
    if (sample.width !== undefined)
      expect(parseFloat(sample.width), sample.target).toBeGreaterThan(0);
    const foreground = rgb(sample.foreground),
      background = rgb(sample.background),
      alpha = foreground[3] ?? 1;
    const blended = foreground
      .slice(0, 3)
      .map((v, i) => v * alpha + (background[i] ?? 0) * (1 - alpha));
    expect(contrast(blended, background), `${sample.kind}:${sample.target}`).toBeGreaterThanOrEqual(
      3,
    );
  }
}

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
function contrast(foreground: number[], background: number[]): number {
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

async function gradientBounds(page: Page) {
  const styles = await page.evaluate(() => {
    // Resolve custom properties through computed colors, including rgb/hex syntax.
    const probe = document.createElement('span');
    document.body.append(probe);
    const colors = ['a', 'b', 'c', 'd'].map((id) => {
      probe.style.color = `var(--wall-${id})`;
      return getComputedStyle(probe).color;
    });
    const avatars = Array.from({ length: 6 }, (_, i) => {
      probe.className = `avatar color-${i}`;
      probe.style.color = '';
      return {
        color: getComputedStyle(probe).color,
        image: getComputedStyle(probe).backgroundImage,
      };
    });
    probe.remove();
    const style = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw Error(`Missing ${selector}`);
      const css = getComputedStyle(element);
      return { color: css.color, background: css.backgroundColor };
    };
    const wall = document.querySelector('.chat-wall');
    const url = wall && /url\("([^"]+)"\)/.exec(getComputedStyle(wall).backgroundImage)?.[1];
    if (!url?.startsWith('data:image/svg+xml,')) throw Error('Unexpected wall pattern');
    const svg = new DOMParser().parseFromString(
      decodeURIComponent(url.slice('data:image/svg+xml,'.length)),
      'image/svg+xml',
    ).documentElement;
    return {
      colors,
      avatars,
      compose: style('.compose-meta'),
      day: style('.day-divider span'),
      pattern: {
        stroke: svg.getAttribute('stroke'),
        fill: svg.getAttribute('fill'),
        alpha: Number(svg.getAttribute('stroke-opacity')),
        shapes: [...svg.children].map((shape) => ({
          tag: shape.tagName,
          overrides: ['stroke', 'fill', 'stroke-opacity', 'opacity', 'style'].some((a) =>
            shape.hasAttribute(a),
          ),
        })),
      },
    };
  });
  const wall = styles.colors.map(rgb);
  expect(styles.pattern.stroke).toBe('#000');
  expect(styles.pattern.fill).toBe('none');
  expect(styles.pattern.alpha).toBeGreaterThan(0);
  expect(styles.pattern.alpha).toBeLessThan(1);
  expect(styles.pattern.shapes.length).toBeGreaterThan(0);
  for (const shape of styles.pattern.shapes) {
    expect(['rect', 'path', 'circle']).toContain(shape.tag);
    expect(shape.overrides).toBe(false);
  }
  // Every blend lies inside these conservative per-channel bounds. The top SVG pattern
  // may overlap: assume every shape contributes its stroke at the same pixel.
  const transmission = (1 - styles.pattern.alpha) ** styles.pattern.shapes.length;
  const low = [0, 1, 2].map((i) => Math.min(...wall.map((c) => c[i] ?? 0)) * transmission);
  const high = [0, 1, 2].map((i) => Math.max(...wall.map((c) => c[i] ?? 0)));
  const compose = rgb(styles.compose.color);
  const overlay = rgb(styles.day.background);
  for (const background of [low, high]) {
    expect(contrast(compose, background), 'composer hint over wall bounds').toBeGreaterThanOrEqual(
      4.5,
    );
    const alpha = overlay[3] ?? 1;
    const blended = background.map((v, i) => (overlay[i] ?? 0) * alpha + v * (1 - alpha));
    expect(contrast(rgb(styles.day.color), blended), 'day over wall bounds').toBeGreaterThanOrEqual(
      4.5,
    );
  }
  for (const avatar of styles.avatars) {
    const stops = avatar.image.match(/rgba?\([^)]+\)/g);
    expect(stops?.length).toBe(2);
    if (!stops) throw Error('Missing gradient stops');
    // A component-wise upper bound is conservative even for crossing RGB channels.
    const brightest = [0, 1, 2].map((i) => Math.max(...stops.map((stop) => rgb(stop)[i] ?? 0)));
    expect(contrast(rgb(avatar.color), brightest)).toBeGreaterThanOrEqual(4.5);
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: контраст чата, событий, объекта, настроек, отчёта, таймера и трея`, async () => {
    const page = await launch(theme);
    await audit(page, 'signed-out');
    await login(page);
    await page.locator('.chat-row[data-chat-id="4"]').click();
    await expect(page.locator('.message-row')).toHaveCount(2);
    await page.locator('.chat-top-action').first().click();
    await expect(page.locator('.chat-top-action').first()).toHaveAttribute('aria-pressed', 'true');
    await audit(page, 'chat');
    await gradientBounds(page);
    const composer = page.getByRole('textbox', { name: 'Сообщение', exact: true });
    await composer.focus();
    await expect(page.locator('.composer-field')).toHaveCSS('outline-style', 'solid');
    const focus = await page.locator('.composer-field').evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        color: style.outlineColor,
        width: style.outlineWidth,
        offset: style.outlineOffset,
        dpr: window.devicePixelRatio,
      };
    });
    expect(parseFloat(focus.width) * focus.dpr).toBeGreaterThanOrEqual(2);
    expect(parseFloat(focus.offset)).toBeGreaterThan(0);
    await page.locator('.chat-row[data-chat-id="events"]').click();
    await expect(page.locator('.event-card').first()).toBeVisible();
    await audit(page, 'events');
    await page.screenshot({ path: test.info().outputPath(`d4-events-${theme}.png`) });
    await page.locator('.chat-row[data-chat-id="4"]').click();
    await page.getByRole('button', { name: 'Об объекте', exact: true }).click();
    await audit(page, 'object', '.object-info-panel');
    await page.getByRole('button', { name: 'Закрыть сведения об объекте' }).click();
    await page.getByRole('button', { name: 'Меню', exact: true }).click();
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    for (const tab of ['Общие', 'Уведомления', 'Плагины Revit', 'Учёт времени', 'О программе']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await audit(page, `settings-${tab}`, '.preferences-panel');
    }
    await page.getByRole('button', { name: 'Сообщить о проблеме', exact: true }).click();
    await audit(page, 'report', '.report-panel');
    await page.getByRole('button', { name: 'Закрыть сообщение о проблеме' }).click();
    await page.getByRole('button', { name: 'Таймер', exact: true }).click();
    await expect(page.locator('.timer-task').first()).toBeVisible();
    await audit(page, 'timer', '.timer-panel');
    await page.getByRole('button', { name: 'Закрыть таймер' }).click();
    if (!app) throw Error('App unavailable');
    const pending = app.waitForEvent('window');
    await app.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('module');
      const host = createRequire(`${app.getAppPath()}/package.json`)('./dist/main/index.js') as {
        client: {
          showMenu: (bounds: { x: number; y: number; width: number; height: number }) => void;
        };
      };
      host.client.showMenu({ x: 1000, y: 700, width: 24, height: 24 });
    });
    await audit(await pending, 'tray');
  });

  test(`${theme}: контраст четырёх шагов первого запуска`, async () => {
    const page = await launch(theme, true);
    await audit(page, 'setup-connection', '.setup-panel');
    await page.getByRole('button', { name: 'Проверить связь', exact: true }).click();
    await expect(page.locator('.setup-panel')).toContainText('✓ Сервер отвечает');
    await page.getByRole('button', { name: 'Далее', exact: true }).click();
    await audit(page, 'setup-login', '.setup-panel');
    await login(page, true);
    await page.getByRole('button', { name: 'Далее', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Проверить папки ещё раз' })).toBeEnabled();
    await audit(page, 'setup-revit', '.setup-panel');
    await page.getByRole('button', { name: 'Далее', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Готово', exact: true })).toBeVisible();
    await audit(page, 'setup-done', '.setup-panel');
  });
}

test('контраст настоящей карточки уведомления, поля ответа и результата отправки', async () => {
  const page = await launch('light');
  await login(page);
  if (!app) throw Error('App unavailable');
  await app.evaluate(({ app, BrowserWindow }) => {
    const { createRequire } = process.getBuiltinModule('module');
    const host = createRequire(`${app.getAppPath()}/package.json`)('./dist/main/index.js') as {
      client: { policy: { allows: () => Promise<boolean> } };
    };
    host.client.policy.allows = async () => true;
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().startsWith('file:'))
      ?.hide();
  });
  const pending = app.waitForEvent('window');
  stub.push('Текст тестового уведомления');
  const toast = await pending;
  await toast.screenshot({ path: test.info().outputPath('lucide-native-popup.png') });
  await audit(toast, 'toast');
  await toast.getByRole('textbox', { name: 'Ответить…' }).fill('Проверка контраста');
  await toast.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(toast.locator('#status')).not.toBeEmpty();
  await audit(toast, 'toast-result');
});
