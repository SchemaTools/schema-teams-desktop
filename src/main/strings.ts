// Тексты интерфейса — формулировки как в ТЗ и макете.

export const S = {
  appName: 'Schema Teams',
  trayTooltip: 'Schema Teams',
  menuOpen: 'Открыть Schema Teams',
  menuQuit: 'Выход',
  menuVersion: (v: string) => `Версия ${v}`,
  // ТЗ, 4.3 (Д-О-3)
  trayHintTitle: 'Schema Teams работает в трее',
  trayHintBody: 'Уведомления будут приходить. Выйти совсем — правой кнопкой по значку → «Выход».',
  // страница, пока сервер не открылся
  offlineTitle: 'Нет связи с сервером',
  offlineBody: 'Сервер Schema Teams не отвечает. Приложение повторит попытку само.',
  noServerTitle: 'Не задан адрес сервера',
  noServerBody: 'В сборке нет адреса сервера Schema Teams. Обратитесь к администратору бюро.',
  // пробная сборка шага Д2
  experimentTitle: 'Пробная сборка: проверка уведомлений',
  experimentBody:
    'Правой кнопкой по значку Schema Teams у часов → «Проверка уведомлений» → «Свои окна: Enter / Shift+Enter». Порядок проверок — в памятке.',
  customToastTitle: 'Schema Teams — уведомление',
  customToastReply: 'Ответить…',
  customToastSend: 'Отправить',
  customToastClose: 'Закрыть уведомление',
  customToastKeys: 'Enter — отправить · Shift+Enter — новая строка',
  customToastSent: (chat: string) => `Отправлено в «${chat}»`,
  customToastMenu: 'Свои окна: Enter / Shift+Enter',
  nativeToastMenu: 'Родные уведомления Windows (сравнение)',
} as const;
