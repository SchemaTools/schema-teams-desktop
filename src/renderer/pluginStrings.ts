// Тексты экрана «Плагины Revit» — по ТЗ 8.4 и макету v4, экран 3.
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10,
    h = n % 100;
  return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};
const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export const P = {
  title: 'Плагины Revit',
  check: 'Проверить',
  upToDate: (n: number, m: number) => `актуально ${n}/${m}`,
  heroChecking: 'Проверяем и устанавливаем обновления…',
  heroWaiting: (n: number) =>
    `Ещё ${n} ${plural(n, 'обновление поставим', 'обновления поставим', 'обновлений поставим')} сами, как только вы закроете Revit.`,
  heroErrors: 'Часть плагинов не установилась — причина в группе «Ошибки».',
  heroFresh: 'Все плагины актуальны.',
  heroManual: 'Автообновление выключено — ставьте плагины кнопкой «Установить».',
  heroRecovering: 'Доводим прерванную установку — как только вы закроете Revit.',
  trustBlocked: 'Установка недоступна: доверенный издатель не настроен.',
  trustBlockedHint:
    'Подпись DLL сертификатом бюро пока не настроена. Загрузка и установка отключены; «Вернуть» и уже установленное работают.',
  signIn: 'Войдите и подключитесь к серверу, чтобы прочитать каталог.',
  unavailable: 'Этот сервер не предоставляет каталог плагинов Desktop.',
  loading: 'Читаем каталог…',
  empty: 'В каталоге пока нет плагинов. Это не означает, что всё установлено.',
  groupWaiting: 'Ждут закрытия Revit',
  groupInstalled: 'Установлено',
  groupErrors: 'Ошибки',
  groupAvailable: 'Доступно',
  noBuild: 'Нет доступной сборки.',
  revit: (years: readonly number[]) => (years.length ? `Revit ${years.join(', ')}` : ''),
  chipFresh: '✓ свежий',
  chipTrial: '◐ проба',
  chipMissing: '⚠ не установлен',
  chipDisabled: '⚠ отключён',
  chipDamaged: '⚠ повреждён',
  chipWaiting: '◷ ждёт Revit',
  disabled: 'Плагин отключён: файл .addin убран или изменён. Revit его не загрузит.',
  damaged: 'Плагин повреждён: файлы версии пропали или изменены (например, антивирусом).',
  held: (version: string) =>
    `Автообновление версии ${version} остановлено после «Вернуть». Поставить её снова — кнопкой «Установить».`,
  notes: 'Что нового',
  noNotes: 'Описание изменений отсутствует.',
  requires: (list: string) => `Нужны: ${list}`,
  published: (iso: string, verified: boolean) =>
    `${verified ? 'Подпись проверена · ' : ''}сборка выложена ${date.format(new Date(iso))}`,
  install: 'Установить',
  installOnClose: 'Установить при закрытии',
  reinstall: 'Переустановить',
  rollback: (version: string) => `Вернуть ${version}`,
  retry: 'Повторить',
  // набор плагинов одним пакетом (решение 06.11)
  components: (selected: number, total: number) => `Состав набора: ${selected} из ${total}`,
  componentFixed: 'Входит в набор всегда',
  componentsHint:
    'Снятые плагины Revit не загрузит. Изменение — без загрузки; Revit подхватит после перезапуска.',
  componentsAfterInstall:
    'По умолчанию ставятся все плагины набора. Состав можно выбрать галочками после установки.',
  selectionApplied: 'Состав изменён. Revit подхватит его после перезапуска.',
  selectionSaved: 'Выбор сохранён — применится при установке набора.',
  certificatePrompt: 'Windows спросит подтверждение сертификата бюро — нажмите «Да».',
  notice: (reason: string): string => {
    switch (reason) {
      case 'legacy_path':
        return 'Прежняя установка плагинов не удалена: путь её удалителя вне папки SchemaRevitPlugins. Её файлы .addin отключены, плагины работают из Schema Teams. Удалить её можно в «Приложениях» Windows.';
      case 'legacy_uninstall':
        return 'Прежняя установка плагинов не удалилась (удалитель вернул ошибку). Её файлы .addin отключены, плагины работают из Schema Teams. Удалить её можно в «Приложениях» Windows.';
      case 'legacy_timeout':
        return 'Удаление прежней установки плагинов не завершилось вовремя. Её файлы .addin отключены, плагины работают из Schema Teams.';
      case 'bureau_settings_failed':
        return 'Не удалось записать настройки бюро для плагинов (bureau.txt). Сообщите BIM-менеджеру.';
      default:
        return 'Прежнюю установку плагинов не удалось проверить. Её файлы .addin отключены, плагины работают из Schema Teams.';
    }
  },
  progress: (name: string) => `${name}: идёт установка`,
  phase: {
    waiting: 'Установится, когда вы закроете Revit.',
    rollbackWaiting: 'Вернём, когда вы закроете Revit.',
    downloading: 'Загружаем и проверяем сборку…',
    installing: 'Устанавливаем…',
    complete: 'Готово — можно открывать Revit.',
  },
  reason: (reason: string | undefined, detail: string | undefined): string => {
    const file = detail ? ` (${detail})` : '';
    switch (reason) {
      case 'download':
        return 'Не удалось загрузить сборку. Проверьте связь и нажмите «Проверить».';
      case 'signature':
        return `Подпись DLL не прошла проверку сертификатом бюро${file}. Сборка не установлена.`;
      case 'package_invalid':
        return 'Архив сборки не прошёл проверку (размер, sha256 или состав). Сборка не установлена.';
      case 'package_addin':
        return `Файл .addin в архиве сборки не прошёл проверку${file}. Сообщите BIM-менеджеру.`;
      case 'package_year_missing':
        return `В архиве нет сборки для Revit ${detail ?? ''}. Сообщите BIM-менеджеру.`;
      case 'addin_conflict':
        return `В папке Revit уже есть${file} с тем же плагином, и его сборка не подписана сертификатом бюро. Удалите этот файл .addin или обратитесь к BIM-менеджеру.`;
      case 'addin_conflict_machine':
        return `Этот плагин уже установлен для всех пользователей компьютера${file}. Удалить такую установку может только администратор.`;
      case 'plugin_dependency_unavailable':
        return 'Нужная версия общей библиотеки (Schema.Tools) недоступна — несовместимое сочетание не ставим.';
      case 'plugin_trust_unconfigured':
        return 'Установка недоступна: доверенный издатель не настроен.';
      case 'plugin_unavailable':
        return 'Сборки больше нет в каталоге. Нажмите «Проверить».';
      case 'revit_not_found':
        return 'Не найден Revit той версии, для которой эта сборка.';
      case 'package_manifest':
        return 'Описание набора (schema-plugins.json) в архиве не прошло проверку. Сообщите BIM-менеджеру.';
      case 'certificate_required':
        return 'Нужно подтвердить сертификат бюро. Нажмите «Повторить» — Windows спросит подтверждение, ответьте «Да».';
      case 'certificate_declined':
        return 'Сертификат бюро не подтверждён — без него подпись плагинов не проверить, набор не установлен. Нажмите «Повторить» и ответьте «Да».';
      case 'certificate_failed':
        return 'Не удалось добавить сертификат бюро в доверенные. Набор не установлен. Подробности — в журнале приложения.';
      case 'rollback_unavailable':
        return 'Предыдущая версия не сохранилась — вернуть нечего.';
      default:
        return 'Операция не выполнена. Подробности — в журнале приложения.';
    }
  },
  autoUpdate: 'Обновлять автоматически',
  autoUpdateHint: 'Только проверенные сборки; поставим, когда вы закроете Revit.',
  notify: 'Сообщать об установке',
  notifyHint: 'Уведомление «Плагины обновлены — можно открывать Revit».',
  beta: 'Пробные сборки',
  betaHint: 'Вы назначены испытателем.',
} as const;
