// Локальные напоминания. Протокол 1.1 не разрешает безопасную автоматическую
// паузу: здесь намеренно нет команд timer, очереди или воспроизведения событий.
import { powerMonitor, type BrowserWindow } from 'electron';
import type { DesktopCommandResult } from '../../bridge/protocol';
import type { SettingsStore } from '../settings';
import type { Logger } from '../logger';
import { S } from '../strings';
import type { CustomToasts } from '../notifications/toasts';
import type { ToastSpec } from '../notifications/types';
import { WindowsNotificationPolicy } from '../desktop/notificationState';
import { elapsed, focusOn, hoursMinutes, type DesktopState } from '../desktop/state';
import { TimerAbsence, type AbsenceWarning } from './absence';
import { TimerReminders, type ReminderTicket } from './reminders';

type Prompt =
  { kind: 'reminder'; ticket: ReminderTicket } | { kind: 'absence'; warning: AbsenceWarning };
interface Options {
  win: BrowserWindow;
  getState: () => DesktopState;
  settings: SettingsStore;
  log: Logger;
  toasts: CustomToasts;
  onAway: () => void;
  onChange: () => void;
  onOpen: () => void;
  onFinish: () => Promise<DesktopCommandResult>;
  onResult: (result: DesktopCommandResult) => void;
  beep: () => void;
}

export class TimerPrompts {
  private readonly absence = new TimerAbsence();
  private readonly reminders = new TimerReminders();
  private readonly policy = new WindowsNotificationPolicy();
  private readonly meta = new WeakMap<ToastSpec, Prompt>();
  private readonly active = new Map<string, ToastSpec>();
  private explicitLock = false;
  private uncertain = false;
  private shownWarning = 0;
  private warningAttempt = -Infinity;
  private returnPoll?: NodeJS.Immediate;
  private destroyed = false;
  private readonly lock = () => {
    this.explicitLock = true;
    this.absence.depart('lock', this.o.getState());
    this.hideWhileAway();
    this.o.onChange();
  };
  private readonly unlock = () => {
    this.explicitLock = false;
    this.absence.return('unlock', this.o.getState());
    this.pollAfterReturn();
  };
  private readonly suspend = () => {
    this.absence.depart('suspend', this.o.getState());
    this.hideWhileAway();
    this.o.onChange();
  };
  private readonly resume = () => {
    this.absence.return('resume', this.o.getState());
    this.pollAfterReturn();
  };

  constructor(private readonly o: Options) {
    // Listener сначала: не оставляем промежуток между снимком и подпиской.
    powerMonitor.on('lock-screen', this.lock);
    powerMonitor.on('unlock-screen', this.unlock);
    powerMonitor.on('suspend', this.suspend);
    powerMonitor.on('resume', this.resume);
    // На Windows powerMonitor.shutdown не доступен. Ничего не задерживаем при
    // завершении сессии и не считаем query-session-end окончательным завершением.
    o.win.on('session-end', this.suspend);
    this.refreshSystem();
  }

  get away(): boolean {
    return this.uncertain || this.absence.away;
  }
  owns(spec: ToastSpec): boolean {
    return this.meta.has(spec);
  }
  open(spec: ToastSpec): void {
    if (this.eligible(spec)) this.o.onOpen();
  }
  shown(spec: ToastSpec): void {
    const item = this.meta.get(spec);
    if (!item || !this.eligible(spec)) return;
    if (item.kind === 'reminder') this.reminders.shown(item.ticket);
    else this.shownWarning = item.warning.id;
    this.o.log.info('напоминание таймера показано', { kind: item.kind });
    if (this.o.settings.get().notifications.sound) this.o.beep();
  }
  closed(spec: ToastSpec): void {
    if (this.active.get(spec.id) === spec) this.active.delete(spec.id);
  }
  private clear(): void {
    for (const id of this.active.keys()) this.o.toasts.dismiss(id);
    this.active.clear();
  }
  get warning(): string {
    const warning = this.absence.warning;
    return warning?.owner === this.o.getState().user?.id ? S.timerUnconfirmed : '';
  }
  private refreshSystem(now = Date.now()): void {
    try {
      // API требует положительный аргумент; active/idle не различаем и по
      // бездействию таймер не меняем. locked также может означать заставку.
      const state = powerMonitor.getSystemIdleState(1);
      this.uncertain = state === 'unknown';
      if (state === 'locked') this.absence.depart('lock', this.o.getState(), now);
      else if (!this.uncertain && !this.explicitLock)
        this.absence.return('unlock', this.o.getState(), now);
    } catch {
      this.uncertain = true;
    }
    this.hideWhileAway();
  }
  private hideWhileAway(): void {
    if (!this.away) return;
    this.clear();
    this.o.onAway();
  }
  private pollAfterReturn(): void {
    clearImmediate(this.returnPoll);
    // Кэш Chromium может ещё содержать locked внутри нативного WTS callback.
    // Снимаем следующий снимок после завершения всей рассылки ОС-события.
    this.returnPoll = setImmediate(() => {
      this.returnPoll = undefined;
      if (this.destroyed) return;
      this.poll();
      this.o.onChange();
    });
  }
  poll(now = Date.now()): void {
    this.refreshSystem(now);
    const state = this.o.getState();
    this.absence.observe(state, now);
    for (const spec of [...this.active.values()]) {
      if (!this.eligible(spec, now)) this.o.toasts.dismiss(spec.id);
    }
    if (this.away || !state.ready || !state.user) return;
    const warning = this.absence.warning;
    if (
      warning &&
      this.o.settings.get().timer.askOnUnlock &&
      this.shownWarning !== warning.id &&
      (now < this.warningAttempt || now - this.warningAttempt >= 60000)
    ) {
      this.warningAttempt = now;
      this.show(
        { kind: 'absence', warning },
        `timer-absence:${warning.id}`,
        S.timerUnconfirmedTitle,
        S.timerUnconfirmed,
        [S.timerReview, S.timerDismiss],
      );
    }
    const ticket = this.reminders.due(state, this.o.settings.get().timer.reminderTime, now);
    if (!ticket) return;
    const task = state.timer.task;
    const since = state.timer.startedAt
      ? ` · ${S.desktopSince(new Date(state.timer.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))}`
      : '';
    this.show(
      { kind: 'reminder', ticket },
      ticket.id,
      S.timerReminderTitle,
      `${task?.mark ?? task?.title ?? ''} · ${hoursMinutes(elapsed(state, now))}${since}`,
      [S.timerFinish, S.timerStillWorking],
    );
  }
  private show(item: Prompt, id: string, title: string, body: string, buttons: string[]): void {
    const spec: ToastSpec = {
      id,
      key: id,
      groupId: id,
      title,
      body,
      buttons,
      hasReply: false,
      delayMs: 0,
    };
    this.meta.set(spec, item);
    this.active.set(id, spec);
    this.o.toasts.show(spec);
  }
  private eligible(spec: ToastSpec, now = Date.now()): boolean {
    const item = this.meta.get(spec);
    const state = this.o.getState();
    if (
      !item ||
      this.away ||
      !state.ready ||
      !state.user ||
      !this.o.settings.get().notifications.enabled ||
      focusOn(state, now)
    )
      return false;
    if (item.kind === 'reminder')
      return this.reminders.valid(
        item.ticket,
        state,
        this.o.settings.get().timer.reminderTime,
        now,
      );
    const warning = this.absence.warning;
    return warning?.owner === state.user.id && warning.id === item.warning.id;
  }
  async beforeShow(spec: ToastSpec): Promise<boolean> {
    this.refreshSystem();
    if (!this.eligible(spec) || !(await this.policy.allows())) return false;
    this.refreshSystem();
    return this.eligible(spec);
  }
  button(spec: ToastSpec, index: number): void {
    if (!this.eligible(spec)) {
      this.o.onResult({ ok: false, error: S.timerChanged });
      return;
    }
    const item = this.meta.get(spec);
    if (item?.kind === 'absence') {
      this.dismissWarning();
      if (index === 0) this.o.onOpen();
    } else if (item?.kind === 'reminder' && index === 0) {
      void this.o.onFinish().then((result) => this.o.onResult(result));
    }
  }
  dismissWarning(): void {
    this.absence.dismiss();
    this.poll();
    this.o.onChange();
  }
  settingsChanged(): void {
    this.reminders.reset();
    this.clear();
    this.poll();
  }
  reset(): void {
    clearImmediate(this.returnPoll);
    this.returnPoll = undefined;
    this.clear();
    this.reminders.reset();
    this.absence.reset();
    this.warningAttempt = -Infinity;
  }
  destroy(): void {
    this.destroyed = true;
    powerMonitor.removeListener('lock-screen', this.lock);
    powerMonitor.removeListener('unlock-screen', this.unlock);
    powerMonitor.removeListener('suspend', this.suspend);
    powerMonitor.removeListener('resume', this.resume);
    if (!this.o.win.isDestroyed()) this.o.win.removeListener('session-end', this.suspend);
    this.reset();
  }
}
