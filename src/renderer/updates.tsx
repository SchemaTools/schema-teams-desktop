import { useEffect, useRef, useState } from 'react';
import type { ClientSnapshot } from '../shared/desktop';
import type { ApiResult } from '../shared/client';
import type { DesktopUpdateView } from '../shared/desktopUpdate';
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
export interface UpdateActions {
  requestLaunch(jobId: string): Promise<ApiResult<DesktopUpdateView>>;
  acknowledge(
    challengeId: string,
    decision: 'cancel' | 'discard',
  ): Promise<ApiResult<DesktopUpdateView>>;
}
export function UpdatePreferences({
  snapshot,
  actions,
}: {
  snapshot: ClientSnapshot;
  actions?: UpdateActions;
}) {
  const [fallback, setFallback] = useState<UpdateState>(initialUpdateState()),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const alive = useRef(true),
    flight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const state = snapshot.updates ?? fallback;
  const update = snapshot.desktopUpdate;
  async function run(work: () => Promise<ApiResult<unknown>>) {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    setError('');
    try {
      const result = await work();
      if (!result.ok && alive.current) setError(result.error);
    } finally {
      flight.current = false;
      if (alive.current) setPending(false);
    }
  }
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
    <section className="update-info" aria-label="Обновление программы" data-update-controls>
      <h4>Обновление программы</h4>
      <p>
        Установлена на этом компьютере: <b>{snapshot.appVersion}</b>
      </p>
      {state.published && (
        <p>
          {state.status === 'error' || state.status === 'checking'
            ? 'Опубликована при последней успешной проверке'
            : 'Опубликована на сервере'}
          : <b>{state.published.version}</b>
        </p>
      )}
      <p role="status">{text}</p>
      {(state.error || error) && (
        <p className="preferences-error" role="alert">
          {error || state.error}
        </p>
      )}
      <button
        disabled={
          pending ||
          state.status === 'checking' ||
          state.status === 'unconfigured' ||
          ['preparing', 'confirming', 'validating', 'handing-off', 'handed-off'].includes(
            update?.phase ?? '',
          )
        }
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
          {!update?.installationAvailable && (
            <p className="preferences-hint">
              Установка из приложения станет доступна после подключения сертификата бюро. Для
              установки этой версии получите подписанный установщик у администратора.
            </p>
          )}
          {update?.installationAvailable && actions && ['idle', 'error'].includes(update.phase) && (
            <button
              disabled={pending || !update.offerId}
              onClick={() =>
                void run(() => request({ kind: 'updates.prepare', offerId: update.offerId ?? '' }))
              }
            >
              Загрузить и проверить установщик
            </button>
          )}
        </>
      )}
      {update?.phase === 'preparing' && (
        <p role="status">Загрузка и проверка установщика… {Math.floor(update.fraction * 100)}%</p>
      )}
      {update?.error && (
        <p role="alert" className="preferences-error">
          {{
            update_busy:
              'Завершите открытые формы и операции, закройте меню трея. Проверьте несохранённые ответы в трее.',
            update_drafts_changed: 'Черновики или окно изменились. Повторите подтверждение.',
            update_publisher_unconfigured: 'Доверенный сертификат бюро ещё не подключён.',
            update_environment: 'Обновление доступно в установленном приложении Windows.',
            update_signature_invalid: 'Подпись приложения или установщика не прошла проверку.',
            update_offer_changed:
              'Опубликованный установщик изменился. Проверьте обновления заново.',
            update_spawn_failed: 'Установщик не запущен. Приложение продолжает работать.',
          }[update.error] ?? 'Проверка обновления остановлена. Проверьте обновления заново.'}
        </p>
      )}
      {update?.phase === 'ready' && update.jobId && actions && (
        <>
          <p role="status">Установщик загружен и проверен. Установка ещё не началась.</p>
          <button
            disabled={pending}
            onClick={() => void run(() => actions.requestLaunch(update.jobId ?? ''))}
          >
            Установить и закрыть приложение
          </button>
        </>
      )}
      {update?.phase === 'confirming' && update.challenge && actions && (
        <div
          className="update-confirm"
          role="group"
          aria-label="Подтверждение выхода для обновления"
        >
          <p>
            Приложение закроется и запустит установщик. Несохранённые черновики будут потеряны:{' '}
            <b>{update.challenge.dirtyCount}</b>. Дождитесь завершения установки.
          </p>
          <button
            disabled={pending}
            onClick={() =>
              void run(() => actions.acknowledge(update.challenge?.id ?? '', 'cancel'))
            }
          >
            Вернуться
          </button>
          <button
            disabled={pending}
            onClick={() =>
              void run(() => actions.acknowledge(update.challenge?.id ?? '', 'discard'))
            }
          >
            Закрыть и установить
          </button>
        </div>
      )}
      {update?.phase === 'validating' && (
        <p role="status">Повторная проверка перед запуском. Приложение пока остаётся открытым.</p>
      )}
      {pending && update?.phase === 'idle' && <p role="status">Завершаем отменённую проверку…</p>}
      {['handing-off', 'handed-off'].includes(update?.phase ?? '') && (
        <p role="status">Запуск установщика… Это ещё не подтверждение установки.</p>
      )}
      {update?.jobId && ['preparing', 'ready', 'validating'].includes(update.phase) && (
        <button
          onClick={() => {
            void request({ kind: 'updates.cancel', jobId: update.jobId ?? '' });
          }}
        >
          Отменить обновление
        </button>
      )}
    </section>
  );
}
