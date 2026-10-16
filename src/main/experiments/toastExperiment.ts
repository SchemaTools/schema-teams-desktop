// Опыт шага Д2 (ТЗ, 5.1): родные уведомления Windows с полем ответа и кнопками.
// Есть только в пробной сборке (EXPERIMENT=toast). Итоги — %APPDATA%\Schema Teams\toast-experiment.jsonl.
import { app, Notification, shell, type MenuItemConstructorOptions } from 'electron';
import { appendFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { windowImage } from '../icons';
import type { Logger } from '../logger';
import {
  REPLY_PLACEHOLDER,
  replyFacts,
  scenarios,
  secondsBetween,
  toJsonLine,
  type ExperimentRecord,
  type ToastSpec,
} from './toastScenarios';

export interface ToastExperimentOptions {
  log: Logger;
  isWindowVisible: () => boolean;
  showWindow: () => void;
}

export class ToastExperiment {
  private readonly file = join(app.getPath('userData'), 'toast-experiment.jsonl');
  private readonly startedAt = Date.now();
  private shown = 0;
  /** Живые уведомления: без ссылки сборщик мусора забирает объект и события теряются */
  private readonly alive = new Map<string, { n: Notification; spec: ToastSpec; at: number }>();

  constructor(private readonly o: ToastExperimentOptions) {
    this.record({ event: 'start', windows: release(), app: app.getVersion() });
    // общий обработчик: ловит ответы и из центра уведомлений после перезапуска приложения
    Notification.handleActivation((d) => {
      this.record({
        event: 'activation',
        source: 'activation',
        activationType: d.type,
        arguments: d.arguments,
        ...(d.type === 'action' && { button: `#${d.actionIndex ?? '?'}` }),
        ...(d.reply !== undefined && replyFacts(d.reply)),
        sinceStartSec: secondsBetween(this.startedAt, Date.now()),
      });
      if (d.type === 'reply' && d.reply !== undefined) this.confirmSent('чат');
      if (d.type === 'click') this.o.showWindow();
    });
    // для проверки без мыши: SCHEMA_TEAMS_EXPERIMENT_RUN=reply,task — показать сценарии сразу
    for (const key of (process.env.SCHEMA_TEAMS_EXPERIMENT_RUN ?? '').split(',').filter(Boolean)) {
      setTimeout(() => this.run(key), 2000);
    }
  }

  /** Пункты меню значка для пробной сборки. */
  menu(): MenuItemConstructorOptions {
    return {
      label: 'Проверка уведомлений',
      submenu: [
        ...scenarios(0).map((s) => ({
          label: s.label,
          click: () => this.run(s.key),
        })),
        { type: 'separator' as const },
        { label: 'Открыть файл итогов', click: () => shell.showItemInFolder(this.file) },
      ],
    };
  }

  private run(key: string): void {
    const n = ++this.shown;
    const s = scenarios(n).find((x) => x.key === key);
    if (!s) return;
    if (!Notification.isSupported()) {
      this.record({ event: 'failed', toast: key, error: 'Notification.isSupported() = false' });
      return;
    }
    for (const spec of s.toasts) setTimeout(() => this.show(spec), spec.delayMs);
  }

  private show(spec: ToastSpec): void {
    const n = new Notification({
      id: spec.id,
      groupId: spec.groupId,
      title: spec.title,
      body: spec.body,
      icon: windowImage(),
      hasReply: spec.hasReply,
      replyPlaceholder: REPLY_PLACEHOLDER,
      actions: spec.buttons.map((text) => ({ type: 'button' as const, text })),
    });
    const at = Date.now();
    this.alive.set(spec.id, { n, spec, at });
    const base = () => ({
      toast: spec.key,
      source: 'instance' as const,
      windowVisible: this.o.isWindowVisible(),
      sinceShowSec: secondsBetween(at, Date.now()),
    });
    n.on('show', () => this.record({ event: 'show', ...base() }));
    n.on('failed', (_e, error) => this.record({ event: 'failed', ...base(), error }));
    n.on('click', () => {
      this.record({ event: 'click', ...base() });
      this.o.showWindow();
    });
    n.on('reply', (d) => {
      this.record({ event: 'reply', ...base(), ...replyFacts(d.reply) });
      this.confirmSent(spec.title);
    });
    n.on('action', (d) => {
      const button = spec.buttons[d.actionIndex] ?? `#${d.actionIndex}`;
      this.record({ event: 'action', ...base(), button });
      if (button === 'Открыть') this.o.showWindow();
    });
    n.on('close', () => {
      this.record({ event: 'close', ...base() });
      this.alive.delete(spec.id);
    });
    n.show();
  }

  /** Как в ТЗ, 5.4: после ответа — короткое «Отправлено в «чат»». */
  private confirmSent(chat: string): void {
    new Notification({ title: `Отправлено в «${chat}»`, silent: true, icon: windowImage() }).show();
  }

  private record(r: Omit<ExperimentRecord, 'at'>): void {
    const full: ExperimentRecord = { at: new Date().toISOString(), ...r };
    try {
      appendFileSync(this.file, toJsonLine(full), 'utf8');
    } catch (err) {
      this.o.log.warn('итог опыта не записан', { err });
    }
    this.o.log.info('опыт уведомлений', { ...full });
  }
}
