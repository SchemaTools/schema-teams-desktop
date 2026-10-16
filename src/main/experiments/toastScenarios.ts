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
  'start' | 'show' | 'failed' | 'click' | 'reply' | 'action' | 'close' | 'activation';

export interface ExperimentRecord {
  at: string;
  event: ExperimentEvent;
  /** Ключ уведомления (ToastSpec.key), если известен */
  toast?: string;
  /** instance — событие объекта Notification, activation — общий обработчик Windows */
  source?: 'instance' | 'activation';
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
