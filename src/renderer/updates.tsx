import { useEffect, useRef, useState } from 'react';
import type { ClientSnapshot } from '../shared/desktop';
import { initialUpdateState, type UpdateState } from '../shared/updates';
import { request } from './bridge';
import './updates.css';
export function UpdateBanner({ snapshot }: { snapshot: ClientSnapshot }) {
  const state = snapshot.updates,
    version = state?.available?.version;
  if (!version || state.dismissedVersion === version) return null;
  return (
    <section className="update-banner" aria-label="Новая версия приложения">
      <span>
        Доступна новая версия приложения <b>{version}</b>
      </span>
      <button onClick={() => void request({ kind: 'settings.open', tab: 'about' })}>
        Что нового
      </button>
      <button onClick={() => void request({ kind: 'updates.later', version })}>Позже</button>
    </section>
  );
}
export function UpdatePreferences({ snapshot }: { snapshot: ClientSnapshot }) {
  const [fallback, setFallback] = useState<UpdateState>(initialUpdateState()),
    [error, setError] = useState('');
  const alive = useRef(true),
    flight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const state = snapshot.updates ?? fallback;
  async function check() {
    if (flight.current) return;
    flight.current = true;
    setError('');
    const result = await request({ kind: 'updates.check' });
    if (!alive.current) return;
    flight.current = false;
    if (result.ok) setFallback(result.data);
    else setError(result.error);
  }
  const text = {
    idle: 'Обновления ещё не проверялись.',
    checking: 'Проверка обновлений…',
    available: 'На сервере опубликована новая версия приложения.',
    current: 'Новых опубликованных версий нет.',
    unpublished: 'Администратор ещё не опубликовал сборку приложения.',
    error: 'Проверку обновлений завершить не удалось.',
    unconfigured: 'Для проверки обновлений нужен настроенный сервер.',
  }[state.status];
  return (
    <section className="update-info" aria-label="Обновление программы">
      <h4>Обновление программы</h4>
      <p role="status">{text}</p>
      {(state.error || error) && (
        <p className="preferences-error" role="alert">
          {error || state.error}
        </p>
      )}
      <button
        disabled={state.status === 'checking' || state.status === 'unconfigured'}
        onClick={() => void check()}
      >
        Проверить обновления
      </button>
      {state.checkedAt !== null && (
        <p className="preferences-hint">
          Последняя успешная проверка: {new Date(state.checkedAt).toLocaleString('ru-RU')}
        </p>
      )}
      {state.available && (
        <>
          <p>
            <b>Версия {state.available.version}</b>
          </p>
          <section className="update-notes" aria-label="Что нового">
            <h5>Что нового</h5>
            <p>{state.available.notes || 'Описание изменений не опубликовано.'}</p>
          </section>
          <p className="preferences-hint">
            Установка из приложения станет доступна после подключения сертификата бюро. Для
            установки этой версии получите подписанный установщик у администратора.
          </p>
        </>
      )}
    </section>
  );
}
