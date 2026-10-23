// Опыт шага Д2 (ТЗ, 5.1): родные уведомления Windows с полем ответа и кнопками.
// Есть только в пробной сборке (EXPERIMENT=toast). Итоги — %APPDATA%\Schema Teams\toast-experiment.jsonl.
// Вторая версия по итогам Windows 10: своё уведомление (toastXml) с «Отправить» и группой чата,
// действия — только из общего обработчика с отбросом повторов.
import { app, Notification, shell, type MenuItemConstructorOptions } from 'electron';
import { appendFileSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { windowImage } from '../icons';
import type { Logger } from '../logger';
import { ELECTRIC, type Bitmap } from '../mark';
import { encodePng } from '../png';
import { S } from '../strings';
import { CustomToasts } from '../notifications/toasts';
import {
  ActivationDedup,
  CLOSED_AT_ONCE_SEC,
  replyFacts,
  scenarios,
  secondsBetween,
  tagOf,
  toJsonLine,
  toastXml,
  type ExperimentRecord,
  type ToastSpec,
} from './toastScenarios';

export interface ToastExperimentOptions {
  log: Logger;
  isWindowVisible: () => boolean;
  showWindow: () => void;
  /** Приложение запущено Windows из уведомления */
  fromNotification: boolean;
}

export class ToastExperiment {
  private readonly file = join(app.getPath('userData'), 'toast-experiment.jsonl');
  private readonly startedAt = Date.now();
  private readonly dedup = new ActivationDedup();
  private readonly icon = join(app.getPath('userData'), 'toast-icon.png');
  private readonly sendIcon = join(app.getPath('userData'), 'toast-send.png');
  private shown = 0;
  private readonly custom: CustomToasts;
  /** Живые уведомления: без ссылки сборщик мусора забирает объект и события теряются */
  private readonly alive = new Map<string, { n: Notification; spec: ToastSpec; at: number }>();

  constructor(private readonly o: ToastExperimentOptions) {
    this.custom = new CustomToasts({
      onReply: (spec, text) => {
        this.record({ event: 'reply', source: 'custom', toast: spec.key, ...replyFacts(text) });
        return { ok: true };
      },
      onButton: (spec, index) => {
        this.record({
          event: 'action',
          source: 'custom',
          toast: spec.key,
          button: spec.buttons[index],
        });
        if (index === 0) o.showWindow();
      },
      onShow: (spec) => {
        this.record({
          event: 'show',
          source: 'custom',
          toast: spec.key,
          windowVisible: o.isWindowVisible(),
        });
      },
      onClose: (spec) => this.record({ event: 'close', source: 'custom', toast: spec.key }),
    });
    app.once('before-quit', () => this.custom.destroy());
    try {
      writeFileSync(this.icon, windowImage().toPNG());
      writeFileSync(this.sendIcon, encodePng(drawSendArrow(32)));
    } catch (err) {
      o.log.warn('значки уведомлений не записаны', { err });
    }
    this.record({
      event: 'start',
      windows: release(),
      app: app.getVersion(),
      fromNotification: o.fromNotification,
    });
    // единственное место, где нажатие что-то делает: ловит и живые уведомления,
    // и центр уведомлений после перезапуска приложения
    Notification.handleActivation((d) => {
      const repeat = this.dedup.isRepeat(d.type, d.arguments, d.reply);
      const tag = tagOf(d.arguments);
      this.record({
        event: 'activation',
        source: 'activation',
        activationType: d.type,
        arguments: d.arguments,
        ...(d.type === 'action' && { button: `#${d.actionIndex ?? '?'}` }),
        ...(d.reply !== undefined && replyFacts(d.reply)),
        ...(repeat && { repeat }),
        sinceStartSec: secondsBetween(this.startedAt, Date.now()),
      });
      if (repeat) return;
      const spec = tag === undefined ? undefined : this.alive.get(tag)?.spec;
      if (d.type === 'reply' && d.reply !== undefined) this.confirmSent(spec?.title ?? 'чат');
      // «Открыть» — первая кнопка у всех сценариев; щелчок по уведомлению — как «Открыть» (ТЗ, 5.3)
      if (d.type === 'click' || (d.type === 'action' && d.actionIndex === 0)) this.o.showWindow();
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
        {
          label: S.customToastMenu,
          submenu: scenarios(0).map((s) => ({
            label: s.label,
            click: () => this.run(`custom:${s.key}`),
          })),
        },
        {
          label: S.nativeToastMenu,
          submenu: scenarios(0).map((s) => ({ label: s.label, click: () => this.run(s.key) })),
        },
        { type: 'separator' as const },
        { label: 'Открыть файл итогов', click: () => shell.showItemInFolder(this.file) },
      ],
    };
  }

  private run(key: string): void {
    const custom = key.startsWith('custom:');
    if (custom) key = key.slice('custom:'.length);
    const n = ++this.shown;
    const s = scenarios(n).find((x) => x.key === key);
    if (!s) return;
    if (!custom && !Notification.isSupported()) {
      this.record({ event: 'failed', toast: key, error: 'Notification.isSupported() = false' });
      return;
    }
    for (const spec of s.toasts) {
      setTimeout(() => (custom ? this.custom.show(spec) : this.show(spec)), spec.delayMs);
    }
  }

  private show(spec: ToastSpec): void {
    const n = new Notification({
      id: spec.id,
      groupId: spec.groupId,
      title: spec.title,
      body: spec.body,
      toastXml: toastXml(spec, {
        icon: this.icon,
        sendIcon: this.sendIcon,
        header: spec.header,
      }),
    });
    const at = Date.now();
    this.alive.set(spec.id, { n, spec, at });
    const base = () => ({
      toast: spec.key,
      source: 'instance' as const,
      windowVisible: this.o.isWindowVisible(),
      sinceShowSec: secondsBetween(at, Date.now()),
    });
    // события объекта только записываются: действия — в handleActivation, иначе ответ уйдёт дважды
    n.on('show', () => this.record({ event: 'show', ...base() }));
    n.on('failed', (_e, error) => this.record({ event: 'failed', ...base(), error }));
    n.on('click', () => this.record({ event: 'click', ...base() }));
    n.on('reply', (d) => this.record({ event: 'reply', ...base(), ...replyFacts(d.reply) }));
    n.on('action', (d) => {
      const button = spec.buttons[d.actionIndex] ?? `#${d.actionIndex}`;
      this.record({ event: 'action', ...base(), button });
    });
    n.on('close', () => {
      const b = base();
      this.record({ event: 'close', ...b });
      // Windows не показала уведомление: «Не беспокоить» (оно в центре уведомлений) или отбросила
      if (b.sinceShowSec < CLOSED_AT_ONCE_SEC) this.record({ event: 'closedAtOnce', ...b });
      // ид остаётся до замены: по нему «Отправлено в «чат»» берёт название из центра уведомлений
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

/** Значок кнопки отправки: треугольник «➤» цвета электрик, виден и на светлом, и на тёмном фоне. */
function drawSendArrow(size: number): Bitmap {
  const data = Buffer.alloc(size * size * 4);
  const left = size * 0.2;
  const right = size * 0.85;
  const mid = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const half = ((right - cx) / (right - left)) * size * 0.35;
      if (cx >= left && cx <= right && Math.abs(y + 0.5 - mid) <= half) {
        data.set(ELECTRIC, (y * size + x) * 4);
      }
    }
  }
  return { width: size, height: size, data };
}
