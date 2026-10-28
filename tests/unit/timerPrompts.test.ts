import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { DesktopCommandResult } from '../../src/bridge/protocol';
import type { CustomToasts } from '../../src/main/notifications/toasts';
import type { ToastSpec } from '../../src/main/notifications/types';
import type { Logger } from '../../src/main/logger';
import type { SettingsStore } from '../../src/main/settings';

type ToastOptions = ConstructorParameters<typeof CustomToasts>[0];
const harness = vi.hoisted(() => ({
  idle: vi.fn<() => 'active' | 'idle' | 'locked' | 'unknown'>(),
  allows: vi.fn<() => Promise<boolean>>(),
  show: vi.fn<(spec: ToastSpec) => void>(),
  clear: vi.fn<() => void>(),
  dismiss: vi.fn<(id: string) => void>(),
  destroy: vi.fn<() => void>(),
  options: null as ToastOptions | null,
  active: new Map<string, ToastSpec>(),
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: harness.idle }) };
});
vi.mock('../../src/main/desktop/notificationState', () => ({
  WindowsNotificationPolicy: class {
    allows = harness.allows;
  },
}));
import { powerMonitor } from 'electron';
import { initialState } from '../../src/main/desktop/state';
import { normalizeSettings } from '../../src/main/settings';
import { TimerPrompts } from '../../src/main/timer/prompts';
import { S } from '../../src/main/strings';

const NOW = new Date(2026, 9, 28, 19).getTime();
const cleanups: (() => void)[] = [];
function fixture(reminderTime = '18:30') {
  const state = initialState();
  state.ready = true;
  state.online = true;
  state.user = { id: 1, shortName: 'Тест' };
  state.timer = {
    state: 'run',
    task: { id: 4, mark: 'АР1', title: 'Тестовая задача' },
    startedAt: new Date(2026, 9, 28, 9).toISOString(),
    elapsedSec: 36000,
    reason: null,
  };
  state.timerReceivedAt = NOW;
  const settings = normalizeSettings({ timer: { reminderTime } });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const callbacks = {
    onAway: vi.fn<() => void>(),
    onChange: vi.fn<() => void>(),
    onOpen: vi.fn<() => void>(),
    onFinish: vi.fn<() => Promise<DesktopCommandResult>>().mockResolvedValue({ ok: true }),
    onResult: vi.fn<(result: DesktopCommandResult) => void>(),
    beep: vi.fn<() => void>(),
  };
  const log = { info: vi.fn() };
  // Тот же host обслуживает чат и таймер. Здесь воспроизводим маршрутизацию
  // callback главного приложения, не создавая второй CustomToasts.
  const host = {
    show(spec: ToastSpec): void {
      harness.active.set(spec.id, spec);
      harness.show(spec);
    },
    clear(): void {
      harness.clear();
      for (const spec of harness.active.values()) harness.options?.onClose(spec);
      harness.active.clear();
    },
    dismiss(id: string): void {
      harness.dismiss(id);
      const spec = harness.active.get(id);
      harness.active.delete(id);
      if (spec) harness.options?.onClose(spec);
    },
    destroy: harness.destroy,
  };
  const prompts = new TimerPrompts({
    win: win as unknown as BrowserWindow,
    getState: () => state,
    settings: { get: () => settings } as unknown as SettingsStore,
    log: log as unknown as Logger,
    toasts: host as unknown as CustomToasts,
    ...callbacks,
  });
  harness.options = {
    beforeShow: (spec) => prompts.beforeShow(spec),
    onReply: () => ({ ok: false, error: 'Ответ не предусмотрен' }),
    onButton: (spec, index) => prompts.button(spec, index),
    onOpen: (spec) => prompts.open(spec),
    onShow: (spec) => prompts.shown(spec),
    onClose: (spec) => prompts.closed(spec),
  };
  cleanups.push(() => prompts.destroy());
  return { prompts, state, settings, win, log, ...callbacks };
}
function options(): ToastOptions {
  if (!harness.options) throw new Error('CustomToasts не создан');
  return harness.options;
}
function lastSpec(): ToastSpec {
  const spec = harness.show.mock.calls.at(-1)?.[0];
  if (!spec) throw new Error('Напоминание не создано');
  return spec;
}
async function present(spec: ToastSpec): Promise<boolean> {
  const allowed = await options().beforeShow?.(spec);
  if (allowed) options().onShow(spec);
  else options().onClose(spec);
  return Boolean(allowed);
}
function forward(minutes = 1): void {
  vi.setSystemTime(Date.now() + minutes * 60_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  harness.idle.mockReset().mockReturnValue('active');
  harness.allows.mockReset().mockResolvedValue(true);
  harness.show.mockClear();
  harness.clear.mockClear();
  harness.dismiss.mockClear();
  harness.destroy.mockClear();
  harness.active.clear();
  harness.options = null;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe('TimerPrompts: политика показа и явные действия', () => {
  it('отмечает напоминание только в onShow, а не после одной проверки политики', async () => {
    const f = fixture();
    f.prompts.poll();
    const first = lastSpec();
    await expect(options().beforeShow?.(first)).resolves.toBe(true);
    forward();
    f.prompts.poll();
    const second = lastSpec();
    expect(harness.show).toHaveBeenCalledTimes(2);
    expect(second.id).toBe(first.id);
    await expect(options().beforeShow?.(first)).resolves.toBe(false);
    await expect(present(second)).resolves.toBe(true);
    expect(f.beep).toHaveBeenCalledTimes(1);
    forward();
    f.prompts.poll();
    expect(harness.show).toHaveBeenCalledTimes(2);
    expect(f.onFinish).not.toHaveBeenCalled();
  });

  it('DND не засчитывает показ: через минуту повторяется только актуальное напоминание', async () => {
    const f = fixture();
    harness.allows.mockResolvedValue(false);
    f.prompts.poll();
    await expect(present(lastSpec())).resolves.toBe(false);
    expect(f.beep).not.toHaveBeenCalled();
    f.prompts.poll();
    expect(harness.show).toHaveBeenCalledTimes(1);
    forward();
    harness.allows.mockResolvedValue(true);
    f.prompts.poll();
    await expect(present(lastSpec())).resolves.toBe(true);
    expect(harness.show).toHaveBeenCalledTimes(2);
    expect(f.beep).toHaveBeenCalledTimes(1);
    forward();
    f.prompts.poll();
    expect(harness.show).toHaveBeenCalledTimes(2);
  });

  it.each(['lock', 'logout'] as const)(
    'разрешение политики после %s не даёт запоздалого показа или звука',
    async (change) => {
      const f = fixture();
      let finish: ((answer: boolean) => void) | undefined;
      harness.allows.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
      f.prompts.poll();
      const pending = present(lastSpec());
      expect(harness.allows).toHaveBeenCalledTimes(1);
      if (change === 'lock') powerMonitor.emit('lock-screen');
      else {
        f.state.user = null;
        f.state.ready = false;
        f.prompts.reset();
      }
      if (!finish) throw new Error('Политика не запрошена');
      finish(true);
      await expect(pending).resolves.toBe(false);
      expect(f.beep).not.toHaveBeenCalled();
      expect(f.onFinish).not.toHaveBeenCalled();
    },
  );

  it('lock/suspend независимы: resume не разрешает popup до unlock', async () => {
    const f = fixture('20:00');
    powerMonitor.emit('lock-screen');
    powerMonitor.emit('suspend');
    forward(20);
    powerMonitor.emit('resume');
    await vi.runOnlyPendingTimersAsync();
    expect(f.prompts.away).toBe(true);
    expect(harness.show).not.toHaveBeenCalled();
    expect(f.prompts.warning).toBe('');
    powerMonitor.emit('unlock-screen');
    await vi.runOnlyPendingTimersAsync();
    expect(f.prompts.away).toBe(false);
    const warning = lastSpec();
    expect(warning.title).toBe(S.timerUnconfirmedTitle);
    expect(warning.body).toContain('мог продолжать идти');
    expect(warning.body).not.toContain('не учтено');
    await expect(present(warning)).resolves.toBe(true);
    expect(f.prompts.warning).toBe(S.timerUnconfirmed);
    options().onClose(warning);
    forward();
    f.prompts.poll();
    expect(harness.show).toHaveBeenCalledTimes(1);
    expect(f.prompts.warning).toBe(S.timerUnconfirmed);
    expect(f.onFinish).not.toHaveBeenCalled();
    expect(f.onOpen).not.toHaveBeenCalled();
    f.prompts.dismissWarning();
    expect(f.prompts.warning).toBe('');
  });

  it('«Ещё работаю» ничего не меняет, finish вызывается только явной кнопкой', async () => {
    const f = fixture();
    const originalTimer = structuredClone(f.state.timer);
    f.prompts.poll();
    const spec = lastSpec();
    await present(spec);
    options().onButton(spec, 1);
    expect(f.onFinish).not.toHaveBeenCalled();
    expect(f.state.timer).toEqual(originalTimer);
    options().onButton(spec, 0);
    await Promise.resolve();
    expect(f.onFinish).toHaveBeenCalledTimes(1);
    expect(f.onResult).toHaveBeenCalledWith({ ok: true });
  });

  it.each(['offline', 'task', 'pause', 'owner'] as const)(
    'старая кнопка finish при %s не выполняет действие',
    async (change) => {
      const f = fixture();
      f.prompts.poll();
      const spec = lastSpec();
      await present(spec);
      if (change === 'offline') f.state.online = false;
      else if (change === 'pause') f.state.timer.state = 'pause';
      else if (change === 'owner') f.state.user = { id: 2, shortName: 'Другой' };
      else f.state.timer.task = { id: 5, mark: 'АР2', title: 'Другая задача' };
      f.prompts.poll();
      expect(harness.dismiss).toHaveBeenCalledWith(spec.id);
      options().onButton(spec, 0);
      expect(f.onFinish).not.toHaveBeenCalled();
      expect(f.onResult).toHaveBeenCalledWith({ ok: false, error: S.timerChanged });
    },
  );

  it('смена настроек инвалидирует старые кнопки до создания нового напоминания', async () => {
    const f = fixture();
    f.prompts.poll();
    const previous = lastSpec();
    await present(previous);
    f.settings.timer.reminderTime = '20:00';
    f.prompts.settingsChanged();
    expect(harness.dismiss).toHaveBeenCalledWith(previous.id);
    expect(harness.clear).not.toHaveBeenCalled();
    options().onButton(previous, 0);
    expect(f.onFinish).not.toHaveBeenCalled();
    expect(f.onResult).toHaveBeenCalledWith({ ok: false, error: S.timerChanged });
  });

  it('предупреждение без связи сохраняется и открывает Teams только по кнопке', async () => {
    const f = fixture('20:00');
    f.state.online = false;
    const originalTimer = structuredClone(f.state.timer);
    powerMonitor.emit('lock-screen');
    forward(20);
    powerMonitor.emit('unlock-screen');
    await vi.runOnlyPendingTimersAsync();
    const spec = lastSpec();
    await expect(present(spec)).resolves.toBe(true);
    expect(f.prompts.warning).toBe(S.timerUnconfirmed);
    expect(f.onOpen).not.toHaveBeenCalled();
    expect(f.onFinish).not.toHaveBeenCalled();
    expect(f.state.timer).toEqual(originalTimer);
    options().onButton(spec, 0);
    expect(f.onOpen).toHaveBeenCalledTimes(1);
    expect(f.onFinish).not.toHaveBeenCalled();
    expect(f.prompts.warning).toBe('');
  });

  it('неизвестное состояние Windows и отключённые уведомления запрещают popup', async () => {
    const f = fixture();
    f.prompts.poll();
    const spec = lastSpec();
    harness.idle.mockReturnValue('unknown');
    await expect(present(spec)).resolves.toBe(false);
    expect(f.prompts.away).toBe(true);
    expect(f.beep).not.toHaveBeenCalled();
    expect(harness.allows).not.toHaveBeenCalled();
    harness.idle.mockReturnValue('active');
    f.settings.notifications.enabled = false;
    await expect(present(spec)).resolves.toBe(false);
    expect(harness.allows).not.toHaveBeenCalled();
  });

  it('фокус и выключенные уведомления не занимают место в общей стопке', () => {
    const f = fixture();
    f.state.focusUntil = new Date(NOW + 3600000).toISOString();
    f.prompts.poll();
    expect(harness.show).not.toHaveBeenCalled();
    f.state.focusUntil = null;
    f.settings.notifications.enabled = false;
    forward();
    f.prompts.poll();
    expect(harness.show).not.toHaveBeenCalled();
    f.settings.notifications.enabled = true;
    forward();
    f.prompts.poll();
    expect(harness.show).toHaveBeenCalledTimes(1);
  });

  it('destroy снимает слушатели и закрывает только собственные окна общего host', () => {
    const f = fixture();
    f.prompts.poll();
    const timer = lastSpec();
    const chat: ToastSpec = { ...timer, id: 'chat:7', key: 'chat:7', title: 'Чат' };
    harness.active.set(chat.id, chat);
    expect(f.prompts.owns(timer)).toBe(true);
    expect(f.prompts.owns(chat)).toBe(false);
    expect(powerMonitor.listenerCount('lock-screen')).toBe(1);
    f.prompts.destroy();
    for (const name of ['lock-screen', 'unlock-screen', 'suspend', 'resume'])
      expect(powerMonitor.listenerCount(name)).toBe(0);
    expect(f.win.listenerCount('session-end')).toBe(0);
    expect(harness.dismiss).toHaveBeenCalledExactlyOnceWith(timer.id);
    expect(harness.active.get(chat.id)).toBe(chat);
    expect(harness.clear).not.toHaveBeenCalled();
    expect(harness.destroy).not.toHaveBeenCalled();
  });

  it('unlock ждёт обновления WTS-кэша перед чтением locked/active', async () => {
    const f = fixture('20:00');
    harness.idle.mockReturnValue('locked');
    powerMonitor.emit('lock-screen');
    const before = harness.idle.mock.calls.length;
    forward(20);
    powerMonitor.emit('unlock-screen');
    // Во время самой рассылки ОС кэш ещё старый; повторного снимка здесь нет.
    expect(harness.idle).toHaveBeenCalledTimes(before);
    expect(harness.show).not.toHaveBeenCalled();
    harness.idle.mockReturnValue('active');
    await vi.runOnlyPendingTimersAsync();
    expect(f.prompts.away).toBe(false);
    expect(f.prompts.warning).toBe(S.timerUnconfirmed);
    expect(lastSpec().title).toBe(S.timerUnconfirmedTitle);
  });

  it.each(['reset', 'destroy'] as const)(
    '%s отменяет отложенный poll возврата и запоздалые UI-callback',
    async (action) => {
      const f = fixture('20:00');
      powerMonitor.emit('lock-screen');
      forward(20);
      powerMonitor.emit('unlock-screen');
      const snapshots = harness.idle.mock.calls.length;
      const changes = f.onChange.mock.calls.length;
      f.prompts[action]();
      await vi.runOnlyPendingTimersAsync();
      expect(harness.idle).toHaveBeenCalledTimes(snapshots);
      expect(f.onChange).toHaveBeenCalledTimes(changes);
      expect(harness.show).not.toHaveBeenCalled();
      expect(f.prompts.warning).toBe('');
      expect(f.onFinish).not.toHaveBeenCalled();
    },
  );
});
