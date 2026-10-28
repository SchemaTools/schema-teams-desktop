// Свои уведомления Д2: клавиатура, однократная отправка и граница IPC.
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const TITLE = 'Schema Teams — уведомление';
const SENT = 'Отправлено в «Иванова И.И.»';

interface Context {
  app: ElectronApplication;
  popup: Page;
  profile: string;
}

interface ReplyRecord {
  event: string;
  source?: string;
  toast?: string;
  replyLength?: number;
  replyMatches?: boolean;
}

interface ToastOptions {
  scenario?: string;
  workArea?: { width: number; height: number };
}

const journal = (profile: string) => {
  const file = join(profile, 'toast-experiment.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

const records = (profile: string): ReplyRecord[] =>
  journal(profile)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReplyRecord);

const replies = (profile: string) =>
  records(profile).filter((r) => r.event === 'reply' && r.source === 'custom');

const mainVisible = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === 'Schema Teams')
      ?.isVisible(),
  );

async function withToast(
  run: (context: Context) => Promise<void>,
  options: ToastOptions = {},
): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'stdesk-custom-toast-'));
  const app = await electron.launch({
    args: [ROOT, '--hidden'],
    env: {
      ...process.env,
      SCHEMA_TEAMS_USER_DATA: profile,
      // Опыт не должен зависеть от доступности или данных настоящего Teams.
      SCHEMA_TEAMS_SERVER_URL: '',
      SCHEMA_TEAMS_EXPERIMENT: 'toast',
      SCHEMA_TEAMS_EXPERIMENT_RUN: options.scenario ?? 'custom:reply',
    },
  });
  try {
    if (options.workArea) {
      // Подмена до первого показа (он отложен на 2 с); размер настоящего монитора не меняется.
      await app.evaluate(({ screen }, size) => {
        const display = screen.getPrimaryDisplay();
        screen.getPrimaryDisplay = () => ({
          ...display,
          workArea: { x: display.workArea.x, y: display.workArea.y, ...size },
          workAreaSize: size,
        });
      }, options.workArea);
    }
    let popup: Page | undefined;
    await expect
      .poll(
        async () => {
          for (const page of app.windows()) {
            if ((await page.title()) === TITLE) {
              popup = page;
              return true;
            }
          }
          return false;
        },
        { timeout: 10000, intervals: [100] },
      )
      .toBe(true);
    if (!popup) throw new Error('Окно уведомления не появилось');
    await expect(popup.locator('#reply')).toBeVisible();
    await run({ app, popup, profile });
  } finally {
    await app.close();
  }
}

test('Enter отправляет один раз, текст ответа не попадает в журналы', async () => {
  await withToast(async ({ popup, profile }) => {
    const text = 'секретный ответ e2e-4b13';
    await popup.locator('#reply').fill(text);
    await popup.locator('#reply').press('Enter');
    await popup.keyboard.press('Enter');
    await popup.keyboard.press('Enter');
    await expect(popup.locator('#status')).toHaveText(SENT);
    // Ждём завершения подтверждения: повторный Enter не должен отправить ответ позднее.
    await expect.poll(() => popup.isClosed()).toBe(true);
    expect(replies(profile)).toEqual([
      expect.objectContaining({
        event: 'reply',
        source: 'custom',
        replyLength: [...text].length,
        replyMatches: false,
      }),
    ]);
    expect(journal(profile)).not.toContain(text);
    expect(readFileSync(join(profile, 'logs', 'app.log'), 'utf8')).not.toContain(text);
  });
});

test('Shift+Enter вставляет новую строку, кнопка отправляет многострочный ответ', async () => {
  await withToast(async ({ popup, profile }) => {
    const field = popup.locator('#reply');
    await field.fill('первая строка');
    await field.press('Shift+Enter');
    await popup.keyboard.insertText('вторая строка');
    const text = 'первая строка\nвторая строка';
    await expect(field).toHaveValue(text);
    expect(replies(profile)).toHaveLength(0);
    await popup.locator('#send').click();
    await expect(popup.locator('#status')).toHaveText(SENT);
    await expect.poll(() => popup.isClosed()).toBe(true);
    expect(replies(profile)).toEqual([
      expect.objectContaining({ replyLength: [...text].length, replyMatches: false }),
    ]);
    expect(journal(profile)).not.toContain('первая строка');
    expect(journal(profile)).not.toContain('вторая строка');
  });
});

test('пустота и Enter во время композиции не отправляются', async () => {
  await withToast(async ({ popup, profile }) => {
    const field = popup.locator('#reply');
    await field.press('Enter');
    await field.fill('   \n  ');
    await field.press('Enter');
    // Кнопка может быть отключена для пустого ответа; искусственный click проверяет обработчик.
    await popup.locator('#send').dispatchEvent('click');
    await field.fill('проверка');
    await field.dispatchEvent('compositionstart');
    await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    await field.dispatchEvent('compositionend');
    await expect(field).toHaveValue('проверка');
    await expect(popup.locator('#status')).not.toHaveText(SENT);
    expect(replies(profile)).toHaveLength(0);
    await field.press('Enter');
    await expect(popup.locator('#status')).toHaveText(SENT);
    await expect.poll(() => popup.isClosed()).toBe(true);
    expect(replies(profile)).toEqual([
      expect.objectContaining({ replyLength: 8, replyMatches: true }),
    ]);
  });
});

test('окно изолировано, сообщения IPC от главного окна отклоняются', async () => {
  await withToast(async ({ app, popup, profile }) => {
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === 'Schema Teams — уведомление',
      );
      if (!w) throw new Error('Нет окна уведомления');
      const wc = w.webContents as unknown as {
        getLastWebPreferences: () => Record<string, unknown>;
      };
      const p = wc.getLastWebPreferences();
      return {
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      };
    });
    expect(preferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(await popup.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
      'undefined',
    );
    await app.evaluate(({ BrowserWindow, ipcMain }) => {
      const main = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Schema Teams');
      if (!main) throw new Error('Нет главного окна');
      const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
      ipcMain.emit('desktop:toast', event, { action: 'reply', text: 'поддельный ответ' });
      ipcMain.emit('desktop:toast', event, { action: 'close' });
    });
    await expect(popup.locator('#reply')).toBeVisible();
    await expect(popup.locator('#status')).not.toHaveText(SENT);
    expect(replies(profile)).toHaveLength(0);
    // После отклонённой подделки настоящий отправитель остаётся работоспособным.
    await popup.locator('#reply').fill('проверка');
    await popup.locator('#reply').press('Enter');
    await expect(popup.locator('#status')).toHaveText(SENT);
    await expect.poll(() => replies(profile).length).toBe(1);
  });
});

test('«Открыть» показывает скрытое главное окно', async () => {
  await withToast(async ({ app, popup, profile }) => {
    expect(await mainVisible(app)).toBe(false);
    await popup.locator('[data-action="0"]').click();
    await expect.poll(() => mainVisible(app)).toBe(true);
    expect(replies(profile)).toHaveLength(0);
  });
});

test('щелчок по заголовку уведомления показывает скрытое главное окно', async () => {
  await withToast(async ({ app, popup, profile }) => {
    expect(await mainVisible(app)).toBe(false);
    await popup.locator('h1').click();
    await expect.poll(() => mainVisible(app)).toBe(true);
    expect(replies(profile)).toHaveLength(0);
  });
});

test('уведомление с черновиком сохраняется дольше 8 с без мыши и фокуса', async () => {
  await withToast(async ({ popup, profile }) => {
    const field = popup.locator('#reply');
    const text = 'черновик ждёт продолжения';
    await field.fill(text);
    await popup.mouse.move(-20, -20);
    await field.evaluate((input) => input.blur());
    // Проверка реального времени жизни окна, а не локального состояния обработчика.
    await popup.waitForTimeout(8500);
    expect(popup.isClosed()).toBe(false);
    await expect(field).toBeVisible();
    await expect(field).toHaveValue(text);
    expect(replies(profile)).toHaveLength(0);
    expect(journal(profile)).not.toContain(text);
  });
});

for (const display of [
  { width: 640, height: 480, visible: 1 },
  { width: 1024, height: 768, visible: 2 },
]) {
  test(`стопка помещается в рабочую область ${display.width}×${display.height}`, async () => {
    await withToast(
      async ({ app, popup, profile }) => {
        // Этот сценарий — стопка без удержания мышью. Физический курсор пользователя
        // может оказаться над первым окном и по правилам законно удержать его.
        await popup.mouse.move(-20, -20);
        await expect
          .poll(() => records(profile).some((r) => r.event === 'show' && r.toast === 'burst-3'), {
            timeout: 10000,
            intervals: [100],
          })
          .toBe(true);
        const windowBounds = () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .filter((w) => w.getTitle() === 'Schema Teams — уведомление')
              .map((w) => w.getBounds())
              .sort((a, b) => a.y - b.y),
          );
        await expect.poll(async () => (await windowBounds()).length).toBe(display.visible);
        const bounds = await windowBounds();
        const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
        for (const box of bounds) {
          expect(box.x).toBeGreaterThanOrEqual(area.x);
          expect(box.y).toBeGreaterThanOrEqual(area.y);
          expect(box.x + box.width).toBeLessThanOrEqual(area.x + display.width);
          expect(box.y + box.height).toBeLessThanOrEqual(area.y + display.height);
        }
        for (let index = 1; index < bounds.length; index++) {
          const previous = bounds[index - 1];
          const current = bounds[index];
          if (!previous || !current) throw new Error('Нет ожидаемого окна в стопке');
          expect(previous.y + previous.height).toBeLessThanOrEqual(current.y);
        }
      },
      { scenario: 'custom:burst', workArea: { width: display.width, height: display.height } },
    );
  });
}

test('перенос неподвижного окна за пределы монитора возвращает его в стопку', async () => {
  await withToast(async ({ app, popup }) => {
    await popup.mouse.move(-20, -20);
    const area = await app.evaluate(({ screen, BrowserWindow }) => {
      const area = screen.getPrimaryDisplay().workArea;
      const win = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === 'Schema Teams — уведомление',
      );
      if (!win) throw new Error('Нет окна уведомления');
      win.setPosition(area.x + area.width + 100, area.y + 60);
      return area;
    });
    await expect
      .poll(async () =>
        app.evaluate(({ BrowserWindow }, area) => {
          const win = BrowserWindow.getAllWindows().find(
            (w) => w.getTitle() === 'Schema Teams — уведомление',
          );
          if (!win) return false;
          const bounds = win.getBounds();
          return (
            bounds.x >= area.x &&
            bounds.y >= area.y &&
            bounds.x + bounds.width <= area.x + area.width &&
            bounds.y + bounds.height <= area.y + area.height
          );
        }, area),
      )
      .toBe(true);
  });
});

test('закрытие уведомления не отправляет набранный черновик', async () => {
  await withToast(async ({ popup, profile }) => {
    await popup.locator('#reply').fill('неотправленный черновик');
    await popup.locator('#close').click();
    await expect.poll(() => popup.isClosed()).toBe(true);
    expect(replies(profile)).toHaveLength(0);
    expect(journal(profile)).not.toContain('неотправленный черновик');
  });
});
