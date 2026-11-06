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
  customToastFailed: (error: string) => `Не отправлено: ${error}`,
  customToastTooLong: `сообщение длиннее 4000 знаков. Сократите текст или отправьте из окна чата.`,
  customToastUnavailable: 'не удалось связаться с сервером. Повторите отправку.',
  customToastMenu: 'Свои окна: Enter / Shift+Enter',
  nativeToastMenu: 'Родные уведомления Windows (сравнение)',
  bridgeOutdated: 'Приложение устарело — обновите. Сейчас доступно только окно Teams.',
  bridgeOffline: 'Нет связи с Teams. Попробуйте ещё раз после восстановления связи.',
  bridgeTimeout: 'Сервер не подтвердил действие. Попробуйте ещё раз.',
  bridgeCommandFailed: 'Не удалось выполнить действие.',
  desktopMenuTitle: 'Schema Teams — меню',
  desktopUnread: (n: number) => `Непрочитанных: ${n}`,
  desktopSignIn: 'Schema Teams — войдите',
  desktopLogin: 'Войти',
  desktopNoConnection: 'Нет связи',
  desktopOnline: 'В сети',
  desktopFocusUntil: (time: string) => `В фокусе до ${time}`,
  desktopChat: (n: number) => `Чат ${n}`,
  desktopNotifications: (n: number) => `Уведомления ${n}`,
  desktopFocus: 'Фокус',
  desktopFocus30: 'На 30 минут',
  desktopFocus60: 'На 1 час',
  desktopFocus1500: 'До 15:00',
  desktopFocusEnd: 'До конца дня',
  desktopFocusOff: 'Завершить фокус',
  desktopFocusPast: '15:00 уже прошло. Выберите другой срок.',
  desktopOpen: 'Открыть',
  desktopRead: 'Прочитано',
  desktopNewMessage: 'Новое сообщение',
  desktopStart: 'Начать работу…',
  desktopStartTask: 'Начать работу',
  desktopSince: (time: string) => `с ${time}`,
  desktopPause: 'Пауза',
  desktopResume: 'Продолжить',
  desktopStop: 'Закончить',
  desktopChange: 'Сменить',
  timerSettings: 'Настройки учёта времени…',
  timerUpgrade: 'Для автоматической паузы при блокировке требуется обновление сервера.',
  timerUnconfirmedTitle: 'Автоматическая пауза не подтверждена',
  timerUnconfirmed:
    'После блокировки или сна таймер мог продолжать идти. Проверьте таймер и трудозатраты в Teams.',
  timerReview: 'Проверить таймер',
  timerDismiss: 'Понятно',
  timerReminderTitle: 'Таймер ещё идёт',
  timerStillWorking: 'Ещё работаю',
  timerFinish: 'Закончить работу',
  timerChanged: 'Таймер изменился. Откройте его из меню ещё раз.',
  pathUnavailableTitle: 'Папка недоступна',
  pathUnavailableBody:
    'Компьютер не видит этот адрес. Возможно, нет доступа к этой папке, сервер выключен или вы не в офисной сети.',
  pathCopy: 'Скопировать путь',
  pathCopied: 'Скопировано',
  pathUnderstood: 'Понятно',
  // Путь к хосту не из списка серверов бюро (ТЗ, 7.2; решение 05.11.2026)
  pathForeignTitle: 'Сервер не из списка бюро',
  pathForeignMessage: (host: string) => `Это не сервер бюро: ${host}. Всё равно открыть?`,
  pathForeignDetail:
    'Windows передаст этому компьютеру данные вашей учётной записи для входа. Открывайте, только если доверяете отправителю.',
  pathForeignOpen: 'Открыть',
  pathForeignCancel: 'Отмена',
  // плагины Revit (ТЗ 8, 5.3)
  pluginInstallUnavailable: 'Установка недоступна: доверенный издатель не настроен.',
  pluginRollbackUnavailable: 'Предыдущая версия этого плагина не сохранилась — вернуть нечего.',
  pluginRequestFailed: 'Плагин недоступен в каталоге. Нажмите «Проверить» и повторите.',
  pluginWaitingTitle: 'Готовы обновления плагинов',
  pluginWaitingBody: (list: string, years: string) =>
    `${list} — установятся, когда вы закроете Revit${years ? ` ${years}` : ''}`,
  pluginCompleteTitle: 'Плагины обновлены — можно открывать Revit',
  pluginSetWaitingTitle: 'Готово обновление набора плагинов',
  pluginSetWaitingBody: (list: string, years: string) =>
    `${list} — установится, когда закроете Revit${years ? ` ${years}` : ''}`,
  pluginSelectionBusy:
    'Сейчас доводится установка плагинов — выбор применим после неё. Повторите позже.',
  pluginSelectionFailed: 'Не удалось применить выбор плагинов. Нажмите «Проверить» и повторите.',
  pluginNotesButton: 'Что нового',
  pluginOkButton: 'Хорошо',
  // свой клиент: ответы окну, уведомления, таймер (clientHost.ts)
  attachTitle: 'Прикрепить файлы (до 50 МБ каждый)',
  waitUpdateCheck: 'Дождитесь завершения проверки обновления.',
  loginChanged: 'Вход изменился.',
  serverUnavailable: 'Сервер временно недоступен.',
  serverTooOld: (version: string) => `Нужен Schema Teams ${version} или новее.`,
  morningSaveFailed:
    'Утренний обзор показан, но сохранить отметку не удалось. После перезапуска возможен повтор.',
  morningTitle: 'Доброе утро',
  morningDue: (n: number) => `Сроки сегодня: ${n}`,
  morningReview: (n: number) => `На проверке: ${n}`,
  morningRemarks: (n: number) => `Новых замечаний: ${n}`,
  pauseRecovered: 'Очередь паузы была повреждена и сброшена — проверьте время за сегодня.',
  pauseReturnTitle: 'Таймер на паузе',
  pauseReturnFrom: (unlock: boolean) => (unlock ? 'Не учтено: ' : 'Пауза с '),
  pauseReturnUntil: (kind: string | null) =>
    kind === 'unlock'
      ? ' — '
      : kind === 'wake'
        ? '. Система возобновила работу '
        : kind === 'screensaver'
          ? '. Заставка больше не обнаружена '
          : '. Снова подключились ',
  pauseReturnHidden: 'Пауза подтверждена сервером. Продолжите таймер или проверьте трудозатраты.',
  pauseReturnFinish: 'Закончить и проверить',
  absenceNoServerTime:
    'Нет свежего подтверждённого времени сервера для автопаузы. Время начала отсутствия не восстановлено. Проверьте время вручную.',
  absenceStorage:
    'Не удалось надёжно сохранить команду паузы или подтверждение её показа. Автопауза не считается завершённой. Проверьте время вручную; запись очереди не сбрасывается.',
  absenceQuery:
    'Завершение Windows не подтверждено. По этому запросу пауза автоматически не отправляется; проверьте время вручную.',
  absencePending:
    'Подтверждение паузы пока не получено. Сохраняется исходная команда; после восстановления связи возможен повтор. Если время проверено вручную, отмените дальнейший повтор ниже.',
  absenceRejected:
    'Пауза не подтверждена или исходный таймер изменился. Автоматический повтор остановлен. Проверьте интервалы вручную.',
  absenceScreensaver:
    'Состояние экранной заставки неизвестно. Автопауза по этому датчику не подтверждена; при необходимости поставьте таймер на паузу вручную.',
  absenceConfirmed:
    'Пауза после отсутствия подтверждена сервером. Продолжение выполняется только по вашей команде.',
  reminderSince: (clock: string, start: string) => `${clock} с ${start}`,
  reminderHidden: 'Таймер ещё идёт. Проверьте трудозатраты.',
  reminderFinish: '■ Закончить работу',
  timerReadFailed: 'Не удалось прочитать состояние таймера.',
  focusSummaryTitle: 'Пока вы были в фокусе',
  focusSummary: (messages: number, chats: number, mentions: number) =>
    `${messages} сообщений в ${chats} чатах · упоминаний: ${mentions}`,
  newAttachment: 'Новое вложение',
  newMessages: (n: number) => `${n} новых сообщений`,
  timerStoppedTitle: 'Вчерашний таймер остановлен в полночь',
  albumIssuedTitle: 'Альбом выдан',
  remarksClosedTitle: 'Все замечания закрыты',
  timerStoppedHidden: 'Запись трудозатрат требует проверки.',
  morningHidden: 'Откройте «Мою работу», чтобы посмотреть сводку.',
  checkEntry: 'Проверить запись',
  finishOffline: 'Нет связи. Подключитесь к серверу, чтобы закончить работу.',
  reportCaptureFailed: 'Не удалось сделать снимок. Выберите источник и повторите.',
  reportExportFailed: 'Не удалось сохранить архив. Проверьте папку и подготовьте файлы заново.',
  reportPrepareFailed: 'Не удалось подготовить диагностику. Проверьте выбранные файлы и повторите.',
  revitFoldersFailed: 'Не удалось проверить стандартные папки Revit. Повторите позже.',
  logsOpenFailed: 'Не удалось открыть папку журналов.',
  waitQuit: 'Дождитесь завершения выхода.',
  supportUnresolved: 'Результат прежней отправки пока неизвестен. Сначала проверьте отправку.',
  feedbackOpenFailed:
    'Не удалось открыть обратную связь. Архив сохранён; передайте его администратору вручную.',
  settingSaveFailed: 'Не удалось сохранить настройку. Повторите действие.',
  autostartSaveFailed:
    'Не удалось применить автозапуск или сохранить настройку. Проверьте автозапуск Windows.',
  settingsSaveFailed: 'Не удалось сохранить настройки. Повторите действие.',
} as const;
