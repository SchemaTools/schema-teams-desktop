// Опыт шага Д2 (ТЗ, 5.1): какие уведомления показать и как записать итог.
// Без Electron — проверяется модульными тестами. Данные вымышленные.

export interface ToastSpec {
  /** Ключ в итогах: какое уведомление сработало */
  key: string;
  /** Через сколько мс после выбора пункта показать */
  delayMs: number;
  /** Ид уведомления: одинаковый ид заменяет прежнее уведомление */
  id: string;
  groupId: string;
  /** Название группы в центре уведомлений (чат); без него — без группы */
  header?: string;
  title: string;
  body: string;
  hasReply: boolean;
  /** Подписи кнопок, по порядку */
  buttons: string[];
}

export interface Scenario {
  key: string;
  label: string;
  toasts: ToastSpec[];
}

export const REPLY_PLACEHOLDER = 'Ответить…';
const MESSAGE_BUTTONS = ['Открыть', 'Прочитано'];

const LONG =
  'Добрый день! По альбому АР3 «Разрезы» остались вопросы после проверки: на разрезе 2-2 ' +
  'отметка низа плиты перекрытия не совпадает с планом 3-го этажа, на разрезе 3-3 не показан ' +
  'утеплитель кровли и уклон, в узле 5 нет размера до оси Б. Ещё просьба: проверьте ' +
  'спецификацию окон — в ней 14 позиций, на планах 15. Если что-то уже исправлено в модели, ' +
  'напишите, пожалуйста, какой лист перевыпустить. Срок — до пятницы, в понедельник ' +
  'отдаём альбом заказчику на согласование вместе с КР и ОВ.';

const message = (
  key: string,
  delayMs: number,
  id: string,
  groupId: string,
  title: string,
  body: string,
): ToastSpec => ({
  key,
  delayMs,
  id,
  groupId,
  // группа — по чату: «Сидоров С.С. · 2 новых сообщения» ложится к «Сидоров С.С.»
  header: title.split(' · ')[0],
  title,
  body,
  hasReply: true,
  buttons: MESSAGE_BUTTONS,
});

/** Сценарии опыта; `n` — номер показа, чтобы повторный показ не заменял прежний. */
export function scenarios(n: number): Scenario[] {
  return [
    {
      key: 'reply',
      label: '1. Сообщение с полем ответа',
      toasts: [
        message(
          'reply',
          0,
          `chat1-${n}`,
          'chat1',
          'Иванова И.И.',
          'Добрый день! Посмотрите, пожалуйста, разрез 2-2 в альбоме АР3.',
        ),
      ],
    },
    {
      key: 'delayed',
      label: '2. Сообщение через 15 секунд (успеть спрятать окно)',
      toasts: [
        message(
          'delayed',
          15_000,
          `chat2-${n}`,
          'chat2',
          'Объект А — общий чат',
          'Петров П.П.: Планёрка переносится на 11:00.',
        ),
      ],
    },
    {
      key: 'task',
      label: '3. Назначена задача — кнопки',
      toasts: [
        {
          key: 'task',
          delayMs: 0,
          id: `task-${n}`,
          groupId: 'tasks',
          title: 'Вам назначен альбом АР3 «Разрезы»',
          body: 'Объект А · срок 24.10 · назначил Петров П.П.',
          hasReply: false,
          buttons: ['Открыть', '▶ Начать работу'],
        },
      ],
    },
    {
      key: 'replace',
      label: '4. Два сообщения одного чата — второе заменяет первое',
      toasts: [
        message('replace-1', 0, `chat3-${n}`, 'chat3', 'Сидоров С.С.', 'Первое сообщение.'),
        message(
          'replace-2',
          3000,
          `chat3-${n}`,
          'chat3',
          'Сидоров С.С. · 2 новых сообщения',
          'Второе сообщение — должно заменить первое, а не встать рядом.',
        ),
      ],
    },
    {
      key: 'long',
      label: '5. Длинный текст',
      toasts: [message('long', 0, `chat4-${n}`, 'chat4', 'Иванова И.И.', LONG)],
    },
    {
      key: 'burst',
      label: '6. Три сообщения подряд из разных чатов',
      toasts: [
        message('burst-1', 0, `chat5-${n}`, 'chat5', 'Иванова И.И.', 'Сообщение 1 из 3.'),
        message('burst-2', 1000, `chat6-${n}`, 'chat6', 'Петров П.П.', 'Сообщение 2 из 3.'),
        message('burst-3', 2000, `chat7-${n}`, 'chat7', 'Сидоров С.С.', 'Сообщение 3 из 3.'),
      ],
    },
  ];
}

export type ExperimentEvent =
  | 'start'
  | 'show'
  | 'failed'
  | 'click'
  | 'reply'
  | 'action'
  | 'close'
  | 'closedAtOnce'
  | 'activation';

export interface ExperimentRecord {
  at: string;
  event: ExperimentEvent;
  /** Ключ уведомления (ToastSpec.key), если известен */
  toast?: string;
  /** instance — событие объекта Notification, activation — общий обработчик Windows */
  source?: 'instance' | 'activation' | 'custom';
  /** Подпись нажатой кнопки */
  button?: string;
  /** Длина ответа (сам текст в итоги не пишется) */
  replyLength?: number;
  /** Ответ совпал с образцом «проверка» — Windows не испортил русский текст */
  replyMatches?: boolean;
  windowVisible?: boolean;
  /** Сколько секунд прошло с показа уведомления */
  sinceShowSec?: number;
  /** Сколько секунд прошло с запуска приложения — ответ из центра уведомлений после перезапуска */
  sinceStartSec?: number;
  activationType?: string;
  arguments?: string;
  /** Повтор того же нажатия — ответ второй раз не отправлялся */
  repeat?: boolean;
  /** Приложение запущено Windows из уведомления (`-Embedding`) */
  fromNotification?: boolean;
  error?: string;
  windows?: string;
  app?: string;
}

/** Образец ответа, который тестирующий вводит в поле ответа */
export const REPLY_SAMPLE = 'проверка';

export function replyFacts(reply: string): Pick<ExperimentRecord, 'replyLength' | 'replyMatches'> {
  return {
    replyLength: [...reply].length,
    replyMatches: reply.trim().toLowerCase() === REPLY_SAMPLE,
  };
}

export function toJsonLine(r: ExperimentRecord): string {
  return `${JSON.stringify(r)}\n`;
}

export function secondsBetween(from: number, to: number): number {
  return Math.round((to - from) / 100) / 10;
}

/** Закрытие быстрее этого — Windows не показала уведомление на экране («Не беспокоить» или отброс) */
export const CLOSED_AT_ONCE_SEC = 0.5;

export const SEND_LABEL = 'Отправить';

export interface ToastXmlOptions {
  /** Значок уведомления — путь к PNG */
  icon?: string;
  /** Значок кнопки отправки — путь к PNG; с ним Windows ставит кнопку рядом с полем */
  sendIcon?: string;
  /** Заголовок группы в центре уведомлений — сообщения одного чата собираются под ним */
  header?: string;
}

/**
 * Своё уведомление вместо собранного Electron: кнопка отправки «Отправить» вместо «Reply»,
 * группа чата в центре уведомлений. Аргументы — в том же виде, что у Electron
 * (`type=…&action=…&tag=…`), чтобы `Notification.handleActivation` разбирал их так же.
 */
export function toastXml(spec: ToastSpec, o: ToastXmlOptions = {}): string {
  const tag = encodeURIComponent(spec.id);
  const parts = ['<toast launch="', esc(`type=click&tag=${tag}`), '">'];
  if (o.header) {
    parts.push(
      `<header id="${esc(spec.groupId)}" title="${esc(o.header)}" arguments="${esc(`type=click&tag=${tag}`)}"/>`,
    );
  }
  parts.push('<visual><binding template="ToastGeneric">');
  parts.push(`<text>${esc(spec.title)}</text><text>${esc(spec.body)}</text>`);
  if (o.icon) {
    parts.push(`<image placement="appLogoOverride" hint-crop="none" src="${esc(o.icon)}"/>`);
  }
  parts.push('</binding></visual><actions>');
  if (spec.hasReply) {
    parts.push(`<input id="reply" type="text" placeHolderContent="${esc(REPLY_PLACEHOLDER)}"/>`);
    parts.push(
      `<action content="${esc(SEND_LABEL)}" activationType="foreground" hint-inputId="reply"` +
        (o.sendIcon ? ` imageUri="${esc(o.sendIcon)}"` : '') +
        ` arguments="${esc(`type=reply&tag=${tag}`)}"/>`,
    );
  }
  spec.buttons.forEach((text, i) => {
    parts.push(
      `<action content="${esc(text)}" activationType="foreground" arguments="${esc(`type=action&action=${i}&tag=${tag}`)}"/>`,
    );
  });
  parts.push('</actions></toast>');
  return parts.join('');
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Ид уведомления из аргументов активации (`tag=…`) */
export function tagOf(args: string): string | undefined {
  const m = /(?:^|&)tag=([^&]*)/.exec(args);
  return m?.[1] === undefined ? undefined : decodeURIComponent(m[1]);
}

/**
 * Windows присылает одно нажатие дважды с разницей ~15 мс (опыт Д2, Windows 10).
 * Второе такое же за `windowMs` — повтор: записать, но не отправлять ответ ещё раз.
 */
export class ActivationDedup {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs = 2000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isRepeat(type: string, args: string, reply?: string): boolean {
    const t = this.now();
    for (const [k, at] of this.seen) if (t - at > this.windowMs) this.seen.delete(k);
    const key = `${type}\n${args}\n${reply ?? ''}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, t);
    return false;
  }
}
