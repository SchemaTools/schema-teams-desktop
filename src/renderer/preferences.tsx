import { useEffect, useRef, useState } from 'react';
import {
  ArrowSquareOut,
  Bell,
  ClockCountdown,
  FolderOpen,
  GearSix,
  Info,
  Stack,
  X,
} from '@phosphor-icons/react';
import type { ClientSnapshot } from '../shared/desktop';
import {
  preferenceTabs,
  type PreferencesTab,
  type LocalPreferences,
  type PreferencesPatch,
} from '../shared/preferences';
import { request } from './bridge';
import { TimerSettings } from './timerSettings';
import './preferences.css';
const tabs = {
  general: ['Общие', GearSix],
  notifications: ['Уведомления', Bell],
  plugins: ['Плагины Revit', Stack],
  time: ['Учёт времени', ClockCountdown],
  about: ['О программе', Info],
} as const;
export function PreferencesPanel({
  snapshot,
  initialTab,
  onClose,
}: {
  snapshot: ClientSnapshot;
  initialTab: PreferencesTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab),
    [loaded, setLoaded] = useState<LocalPreferences | null>(snapshot.preferences ?? null),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [feedback, setFeedback] = useState(''),
    [workdayEnd, setWorkdayEnd] = useState<number | undefined>();
  const mounted = useRef(true),
    flight = useRef(false),
    close = useRef<HTMLButtonElement>(null),
    tabButtons = useRef(new Map<PreferencesTab, HTMLButtonElement>());
  const prefs = snapshot.preferences ?? loaded,
    online = snapshot.connection === 'online',
    owner = `${snapshot.epoch}:${snapshot.user?.id ?? ''}`;
  useEffect(() => {
    mounted.current = true;
    close.current?.focus();
    void request({ kind: 'settings.read' }).then((result) => {
      if (!mounted.current) return;
      if (result.ok) setLoaded(result.data);
      else setError(result.error);
    });
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setWorkdayEnd(undefined);
    if (tab !== 'time' || !snapshot.user || !online) return;
    let active = true;
    void request({ kind: 'timer.options', epoch: snapshot.epoch }).then((result) => {
      if (active && result.ok) setWorkdayEnd(result.data.workday.end);
    });
    return () => {
      active = false;
    };
  }, [tab, owner, online]);
  async function save(patch: PreferencesPatch) {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    setError('');
    setFeedback('');
    const result = await request({ kind: 'settings.patch', patch });
    if (!mounted.current) return;
    flight.current = false;
    setPending(false);
    if (result.ok) {
      setLoaded(result.data);
      setFeedback('Настройки сохранены.');
    } else setError(result.error);
  }
  async function openLogs() {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    setError('');
    setFeedback('');
    const result = await request({ kind: 'logs.open' });
    if (!mounted.current) return;
    flight.current = false;
    setPending(false);
    if (result.ok) setFeedback('Папка журналов открыта.');
    else setError(result.error);
  }
  async function openNotificationSettings() {
    const result = await request({
      kind: 'open.site',
      epoch: snapshot.epoch,
      path: '/settings/notifications',
    });
    if (mounted.current && !result.ok) setError(result.error);
  }
  const connection = {
    online: 'В сети',
    offline: 'Нет связи',
    connecting: 'Подключение',
    signedOut: 'Вход не выполнен',
    passwordChange: 'Нужно сменить пароль',
    incompatible: 'Версия сервера не поддерживается',
    noServer: 'Сервер не настроен',
  }[snapshot.connection];
  return (
    <div
      className="preferences-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          event.stopPropagation();
          onClose();
        }
        if (event.key === 'Tab') {
          const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled):not([tabindex="-1"]),select:not(:disabled),input:not(:disabled),summary',
              ),
            ).filter((item) => item.getClientRects().length > 0),
            first = items[0],
            last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        className="preferences-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preferences-title"
      >
        <header>
          <GearSix size={23} weight="duotone" />
          <h2 id="preferences-title">Настройки</h2>
          <button
            className="icon-button"
            ref={close}
            disabled={pending}
            onClick={onClose}
            aria-label="Закрыть настройки"
          >
            <X size={21} />
          </button>
        </header>
        <div className="preferences-layout">
          <nav
            role="tablist"
            aria-label="Разделы настроек"
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                  event.key,
                ) ||
                pending
              )
                return;
              event.preventDefault();
              const current = preferenceTabs.indexOf(tab),
                next =
                  event.key === 'Home'
                    ? 'general'
                    : event.key === 'End'
                      ? 'about'
                      : preferenceTabs[
                          (current +
                            (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) +
                            preferenceTabs.length) %
                            preferenceTabs.length
                        ];
              if (next) {
                setTab(next);
                setError('');
                setFeedback('');
                tabButtons.current.get(next)?.focus();
              }
            }}
          >
            {preferenceTabs.map((key) => {
              const [label, Icon] = tabs[key];
              return (
                <button
                  key={key}
                  ref={(button) => {
                    if (button) tabButtons.current.set(key, button);
                    else tabButtons.current.delete(key);
                  }}
                  id={`pref-tab-${key}`}
                  role="tab"
                  aria-selected={tab === key}
                  aria-controls={`pref-panel-${key}`}
                  tabIndex={tab === key ? 0 : -1}
                  disabled={pending}
                  onClick={() => {
                    setTab(key);
                    setError('');
                    setFeedback('');
                  }}
                >
                  <Icon size={20} weight="duotone" />
                  {label}
                </button>
              );
            })}
          </nav>
          <div
            className="preferences-content"
            id={`pref-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`pref-tab-${tab}`}
          >
            {error && (
              <p className="preferences-error" role="alert">
                {error}
              </p>
            )}
            {feedback && (
              <p className="preferences-feedback" role="status">
                {feedback}
              </p>
            )}
            {tab === 'general' && (
              <>
                <h3>Общие</h3>
                {!prefs ? (
                  <p>Загрузка настроек…</p>
                ) : (
                  <>
                    <label className="preference-toggle">
                      <span>
                        <b>Запускать вместе с Windows</b>
                        <small>Приложение запускается в трее, окно остаётся скрытым.</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={prefs.autostart}
                        disabled={pending}
                        onChange={(e) => void save({ autostart: e.target.checked })}
                      />
                    </label>
                    {!prefs.autostartAvailable && (
                      <p className="preferences-hint">
                        Автозапуск применяется в установленной версии приложения.
                      </p>
                    )}
                    <label className="preference-select">
                      <span>
                        <b>Тема</b>
                        <small>Оформление чата, таймера и настроек.</small>
                      </span>
                      <select
                        aria-label="Тема оформления"
                        value={prefs.theme}
                        disabled={pending}
                        onChange={(e) =>
                          void save({ theme: e.target.value as LocalPreferences['theme'] })
                        }
                      >
                        <option value="system">Как в Windows</option>
                        <option value="light">Светлая</option>
                        <option value="dark">Тёмная</option>
                      </select>
                    </label>
                    <div className="preferences-note">
                      <b>Кнопка ✕</b>
                      <p>
                        Закрывает окно, приложение продолжает работать в трее. Для полного выхода
                        выберите «Выйти из приложения» в меню трея.
                      </p>
                    </div>
                    <div className="preferences-note">
                      <b>Подключение к серверу</b>
                      <p>
                        {snapshot.connection === 'noServer'
                          ? 'Адрес сервера не задан.'
                          : 'Используется адрес из конфигурации приложения.'}{' '}
                        Для изменения адреса обратитесь к администратору.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}
            {tab === 'notifications' && (
              <>
                <h3>Уведомления</h3>
                {prefs && (
                  <>
                    <label className="preference-toggle">
                      <span>
                        <b>Всплывающие уведомления</b>
                        <small>Сообщения и напоминания с учётом системных ограничений.</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={prefs.notifications.enabled}
                        disabled={pending}
                        onChange={(e) =>
                          void save({ notifications: { enabled: e.target.checked } })
                        }
                      />
                    </label>
                    <label className="preference-toggle">
                      <span>
                        <b>Звук уведомлений</b>
                        <small>Звук только при фактическом показе разрешённого уведомления.</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={prefs.notifications.sound}
                        disabled={pending}
                        onChange={(e) => void save({ notifications: { sound: e.target.checked } })}
                      />
                    </label>
                    <label className="preference-toggle">
                      <span>
                        <b>Показывать текст сообщения</b>
                        <small>Если выключено, содержимое скрыто во всплывающем уведомлении.</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={prefs.notifications.preview}
                        disabled={pending}
                        onChange={(e) =>
                          void save({ notifications: { preview: e.target.checked } })
                        }
                      />
                    </label>
                  </>
                )}
                <p className="preferences-hint">Какие события и тихие часы — в Teams.</p>
                <button
                  className="preferences-link"
                  disabled={!snapshot.user || pending}
                  onClick={() => void openNotificationSettings()}
                >
                  <ArrowSquareOut size={17} />
                  Настройки уведомлений Teams
                </button>
                <p className="preferences-hint">
                  Утренние итоги сервера доступны в служебном чате.
                </p>
              </>
            )}
            {tab === 'plugins' && (
              <>
                <h3>Плагины Revit</h3>
                <div className="preferences-note">
                  <Stack size={28} weight="duotone" />
                  <p>
                    Каталог плагинов пока недоступен. Установка и обновление плагинов появятся после
                    подключения каталога.
                  </p>
                </div>
              </>
            )}
            {tab === 'time' && (
              <>
                <h3>Учёт времени</h3>
                {snapshot.user ? (
                  <TimerSettings key={owner} snapshot={snapshot} workdayEnd={workdayEnd} expanded />
                ) : (
                  <p>
                    Войдите в Teams, чтобы открыть настройки таймера и получить конец рабочего дня
                    бюро.
                  </p>
                )}
              </>
            )}
            {tab === 'about' && (
              <>
                <h3>Schema Teams</h3>
                <p className="preferences-brand">Рабочие чаты и учёт времени</p>
                <dl>
                  <dt>Версия приложения</dt>
                  <dd>{snapshot.appVersion || 'Не определена'}</dd>
                  <dt>Версия сервера</dt>
                  <dd>{snapshot.serverVersion || 'Не получена'}</dd>
                  <dt>Подключение</dt>
                  <dd>{connection}</dd>
                </dl>
                <button disabled={pending} onClick={() => void openLogs()}>
                  <FolderOpen size={18} />
                  Открыть папку журналов
                </button>
                <p className="preferences-hint">
                  Папка открывается на этом компьютере. Журналы никуда не отправляются
                  автоматически.
                </p>
                <div className="preferences-note">
                  <b>Обновление программы</b>
                  <p>Обновления пока устанавливаются вручную.</p>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
