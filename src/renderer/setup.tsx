import { useEffect, useRef, useState } from 'react';
import { CheckCircle, GearSix, X } from '@phosphor-icons/react';
import type { ClientSnapshot } from '../shared/desktop';
import type { RevitInventory } from '../shared/setup';
import { request } from './bridge';
import { ServerConfigurationPanel } from './serverConfiguration';
import './setup.css';
const stages = ['Подключение', 'Вход', 'Плагины Revit', 'Готово'];
export function SetupPanel({
  snapshot,
  onClose,
}: {
  snapshot: ClientSnapshot;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0),
    [checked, setChecked] = useState(false),
    [inventory, setInventory] = useState<RevitInventory | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [autostart, setAutostart] = useState(snapshot.preferences?.autostart ?? true);
  const alive = useRef(true),
    flight = useRef(false),
    heading = useRef<HTMLHeadingElement>(null),
    owner = useRef(`${snapshot.epoch}:${snapshot.user?.id ?? ''}`);
  const online = snapshot.connection === 'online' && Boolean(snapshot.user);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
    setError('');
  }, [step]);
  useEffect(() => {
    const current = `${snapshot.epoch}:${snapshot.user?.id ?? ''}`;
    if (owner.current !== current && step > 1) setStep(1);
    owner.current = current;
  }, [snapshot.epoch, snapshot.user?.id, step]);
  async function inspect(refresh = false) {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    setError('');
    const result = await request({ kind: 'setup.inventory', refresh });
    flight.current = false;
    if (!alive.current) return;
    setPending(false);
    if (result.ok) setInventory(result.data);
    else setError(result.error);
  }
  useEffect(() => {
    if (step === 2) void inspect();
  }, [step]);
  async function finish() {
    if (flight.current || !online) return;
    flight.current = true;
    setPending(true);
    setError('');
    const result = await request({ kind: 'setup.finish', epoch: snapshot.epoch, autostart });
    flight.current = false;
    if (!alive.current) return;
    setPending(false);
    if (result.ok) onClose();
    else setError(result.error);
  }
  const next = () => {
    setError('');
    setStep((value) => value + 1);
  };
  return (
    <div
      className="setup-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (!snapshot.setupRequired && !pending) onClose();
        }
        if (event.key === 'Tab') {
          const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),select:not(:disabled)',
              ),
            ).filter((item) => item.getClientRects().length > 0),
            first = items[0],
            last = items.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === heading.current)
          ) {
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
        className="setup-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-title"
      >
        <header>
          <GearSix size={24} weight="duotone" />
          <h2 id="setup-title">Настройка Schema Teams</h2>
          {!snapshot.setupRequired && (
            <button
              className="icon-button"
              disabled={pending}
              onClick={onClose}
              aria-label="Закрыть настройку"
            >
              <X size={21} />
            </button>
          )}
        </header>
        <ol className="setup-steps" aria-label="Шаги настройки">
          {stages.map((stage, index) => (
            <li
              key={stage}
              aria-current={index === step ? 'step' : undefined}
              className={index < step ? 'complete' : ''}
            >
              <span>{index < step ? <CheckCircle size={19} /> : index + 1}</span>
              {stage}
            </li>
          ))}
        </ol>
        <div className="setup-content">
          <h3 ref={heading} tabIndex={-1}>
            {stages[step]}
          </h3>
          {error && (
            <p role="alert" className="preferences-error">
              {error}
            </p>
          )}
          {step === 0 && (
            <>
              <p>
                Проверьте связь с сервером перед входом. Для собственного клиента нужен Schema Teams
                0.11.0 или новее.
              </p>
              <ServerConfigurationPanel onChecked={setChecked} />
            </>
          )}
          {step === 1 && (
            <>
              <p>Войдите в отдельном окне Teams. Пароль вводится на странице сервера.</p>
              {online ? (
                <p role="status" className="preferences-feedback">
                  Вход выполнен: {snapshot.user?.shortName}
                </p>
              ) : (
                <>
                  <p role="status">
                    {snapshot.connection === 'passwordChange'
                      ? 'Смените временный пароль в окне Teams.'
                      : snapshot.connection === 'offline'
                        ? 'Нет связи. Восстановите подключение и повторите вход.'
                        : 'Вход ещё не выполнен.'}
                  </p>
                  <button onClick={() => void request({ kind: 'login' })}>Войти в Teams</button>
                  <button onClick={() => void request({ kind: 'retry' })}>
                    Повторить подключение
                  </button>
                </>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <p>
                Проверяем стандартные папки Revit 2025 и 2026 и списки файлов .addin. Другие папки
                установки не проверяются.
              </p>
              <button disabled={pending} onClick={() => void inspect(true)}>
                {pending ? 'Проверка папок…' : 'Проверить папки ещё раз'}
              </button>
              {inventory && (
                <div className="setup-revit">
                  {inventory.years.map((year) => (
                    <section key={year.year}>
                      <h4>Revit {year.year}</h4>
                      <p>
                        {year.executable === 'found'
                          ? 'Файл Revit.exe найден.'
                          : year.executable === 'notFound'
                            ? 'Revit.exe в стандартной папке не найден.'
                            : 'Стандартная папка установки недоступна.'}
                      </p>
                      {year.addins.map((addins) => (
                        <div key={addins.scope}>
                          <b>
                            {addins.scope === 'user' ? 'Профиль пользователя' : 'Все пользователи'}
                          </b>
                          <p>
                            {addins.status === 'missing'
                              ? 'Папка Addins не найдена.'
                              : addins.status === 'unavailable'
                                ? 'Список файлов недоступен.'
                                : addins.names.length
                                  ? `Файлы .addin: ${addins.names.join(', ')}`
                                  : 'Файлы .addin не найдены.'}
                            {addins.truncated ? ' Список неполный.' : ''}
                          </p>
                        </div>
                      ))}
                    </section>
                  ))}
                </div>
              )}
              <p className="setup-note">
                Каталог плагинов бюро пока недоступен. Версии, подписи и загрузка в Revit не
                проверены; установка и автообновление не выполняются.
              </p>
              <label className="setup-disabled">
                <input type="checkbox" disabled />
                Обновлять плагины автоматически — недоступно до подключения каталога
              </label>
            </>
          )}
          {step === 3 && (
            <>
              <p>
                Приложение готово к работе с чатами и ручным учётом времени. Плагины можно будет
                настроить после подключения каталога бюро.
              </p>
              <label className="setup-auto">
                <input
                  type="checkbox"
                  checked={autostart}
                  disabled={pending}
                  onChange={(event) => setAutostart(event.target.checked)}
                />
                Запускать вместе с Windows
              </label>
              {snapshot.preferences?.autostartAvailable === false && (
                <p className="preferences-hint">
                  В этом тестовом профиле регистрация автозапуска Windows отключена.
                </p>
              )}
              <div className="setup-note">
                <b>Приложение остаётся в трее</b>
                <p>
                  Кнопка ✕ скрывает окно. Значок Schema Teams ищите у часов, при необходимости под
                  стрелкой скрытых значков. В параметрах панели задач Windows можно включить его
                  постоянный показ.
                </p>
                <p>Для полного выхода выберите «Выйти из приложения» в меню трея.</p>
              </div>
              {!online && (
                <p role="alert" className="preferences-error">
                  Для завершения настройки восстановите связь и вход.
                </p>
              )}
            </>
          )}
        </div>
        <footer>
          {step > 0 && (
            <button
              disabled={pending}
              onClick={() => {
                if (step === 1) setChecked(false);
                setStep((value) => value - 1);
              }}
            >
              Назад
            </button>
          )}
          <span />
          {step < 3 ? (
            <button
              className="primary-button"
              disabled={pending || (step === 0 && !checked) || (step === 1 && !online)}
              onClick={next}
            >
              {step === 2 && error ? 'Продолжить без проверки Revit' : 'Далее'}
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={pending || !online}
              onClick={() => void finish()}
            >
              {pending ? 'Сохранение…' : 'Завершить настройку'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
