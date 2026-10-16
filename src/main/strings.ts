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
} as const;
