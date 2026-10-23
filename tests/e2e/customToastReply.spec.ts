// Д3, ТЗ 5.4: ждать результат отправки, сохранять черновик при ошибке, давать повтор.
// Реальный серверный протокол не подменяется: здесь проверяется только UI и callback.
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CustomToasts, ReplyResult } from '../../src/main/notifications/toasts';

const ROOT = resolve(__dirname, '..', '..');

interface ReplyHarness {
  attempts: number;
  finish?: (result: ReplyResult) => void;
  manager: CustomToasts;
}

async function openControlledToast(reject = false) {
  const profile = mkdtempSync(join(tmpdir(), 'stdesk-reply-'));
  const app = await electron.launch({
    args: [ROOT, '--hidden'],
    env: {
      ...process.env,
      SCHEMA_TEAMS_USER_DATA: profile,
      SCHEMA_TEAMS_SERVER_URL: '',
      SCHEMA_TEAMS_EXPERIMENT: '',
      SCHEMA_TEAMS_EXPERIMENT_RUN: '',
    },
  });
  await app.firstWindow();
  const shown = app.waitForEvent('window').catch(() => null);
  await app.evaluate(({ app }, reject) => {
    // Импорт из фактической сборки, не копия обработчика UI.
    // Electron evaluate не поддерживает dynamic import callback; используем Node createRequire.
    const loadModule = process
      .getBuiltinModule('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const { CustomToasts } = loadModule(
      `${app.getAppPath()}/dist/main/notifications/toasts.js`,
    ) as {
      CustomToasts: typeof import('../../src/main/notifications/toasts').CustomToasts;
    };
    const global = globalThis as unknown as { replyHarness: ReplyHarness };
    const state = { attempts: 0 } as ReplyHarness;
    state.manager = new CustomToasts({
      onReply: () => {
        state.attempts++;
        if (reject) return Promise.reject(new Error('sensitive-failure-fixture'));
        if (state.attempts > 1) return { ok: true };
        return new Promise<ReplyResult>((finish) => (state.finish = finish));
      },
      onButton: () => {},
      onShow: () => {},
      onClose: () => {},
    });
    global.replyHarness = state;
    state.manager.show({
      key: 'reply',
      id: 'reply',
      groupId: 'chat',
      title: 'Тестовый чат',
      body: 'Сообщение',
      hasReply: true,
      buttons: ['Открыть', 'Прочитано'],
      delayMs: 0,
    });
  }, reject);
  const popup = await shown;
  if (!popup) throw new Error('Окно уведомления не появилось');
  await expect(popup.locator('#reply')).toBeVisible();
  return { app, popup, profile };
}

async function close(app: ElectronApplication): Promise<void> {
  try {
    await app.evaluate(() => {
      (globalThis as unknown as { replyHarness: ReplyHarness }).replyHarness.manager.destroy();
    });
  } finally {
    await app.close();
  }
}

test('ожидание не подтверждает отправку; ошибка сохраняет текст и разрешает повтор', async () => {
  const { app, popup } = await openControlledToast();
  try {
    const field = popup.locator('#reply');
    const text = 'первая\nвторая';
    await field.fill(text);
    await field.press('Enter');
    await expect(field).toBeDisabled();
    await expect(popup.locator('#status')).toBeEmpty();
    await field.dispatchEvent('keydown', { key: 'Enter' });
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { replyHarness: ReplyHarness }).replyHarness.attempts,
      ),
    ).toBe(1);
    await app.evaluate(() => {
      (globalThis as unknown as { replyHarness: ReplyHarness }).replyHarness.finish?.({
        ok: false,
        error: 'нет связи',
      });
    });
    await expect(popup.locator('#status')).toHaveText('Не отправлено: нет связи');
    await expect(field).toBeEnabled();
    await expect(field).toHaveValue(text);
    await popup.waitForTimeout(8500);
    await expect(field).toHaveValue(text);
    await field.press('Enter');
    await expect(popup.locator('#status')).toHaveText('Отправлено в «Тестовый чат»');
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { replyHarness: ReplyHarness }).replyHarness.attempts,
      ),
    ).toBe(2);
  } finally {
    await close(app);
  }
});

test('отклонённый callback не закрывает окно и не раскрывает текст исключения', async () => {
  const { app, popup, profile } = await openControlledToast(true);
  try {
    await popup.locator('#reply').fill('сохранить ответ');
    await popup.locator('#send').click();
    await expect(popup.locator('#status')).toHaveText(
      'Не отправлено: не удалось связаться с сервером. Повторите отправку.',
    );
    await expect(popup.locator('#reply')).toBeEnabled();
    await expect(popup.locator('#reply')).toHaveValue('сохранить ответ');
    expect(await popup.locator('body').innerText()).not.toContain('sensitive-failure-fixture');
    expect(readFileSync(join(profile, 'logs/app.log'), 'utf8')).not.toContain(
      'sensitive-failure-fixture',
    );
  } finally {
    await close(app);
  }
});
