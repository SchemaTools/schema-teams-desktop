import { ExternalLink, FolderOpen, Info, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ObjectInfo } from '../shared/client';
import { request } from './bridge';
import './objectInfo.css';

const statuses = { active: 'В работе', paused: 'Приостановлен', archive: 'В архиве' };
const day = (value: string) => {
  const [y, m, d] = value.split('-');
  return `${d}.${m}.${y}`;
};

export function ObjectInfoPanel({
  epoch,
  chatId,
  online,
  onClose,
}: {
  epoch: number;
  chatId: number;
  online: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<ObjectInfo | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0),
    [feedback, setFeedback] = useState('');
  const close = useRef<HTMLButtonElement>(null),
    mounted = useRef(true),
    action = useRef(false);
  useEffect(() => {
    mounted.current = true;
    close.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    setFeedback('');
    if (!online) {
      setLoading(false);
      setError('Нет связи. Сведения об объекте появятся после подключения.');
      return;
    }
    setLoading(true);
    void request({ kind: 'chat.objectInfo', epoch, chatId }).then((result) => {
      if (!active) return;
      setLoading(false);
      if (result.ok) setData(result.data);
      else setError(result.error);
    });
    return () => {
      active = false;
    };
  }, [epoch, chatId, online, retry]);
  async function openPath(path: string) {
    if (action.current) return;
    action.current = true;
    setFeedback('Проверка пути…');
    const result = await request({ kind: 'open.path', epoch, path, reveal: true });
    if (!mounted.current) return;
    action.current = false;
    setFeedback(
      !result.ok
        ? result.error
        : result.data === 'ok'
          ? 'Путь показан в Проводнике.'
          : result.data === 'blocked'
            ? 'Этот путь нельзя показать из приложения.'
            : 'Путь недоступен. Проверьте подключение к хранилищу.',
    );
  }
  const current = data?.stages.find((s) => s.id === data.currentStageId);
  return (
    <aside
      className="object-info-panel"
      id="object-info-panel"
      role="region"
      aria-label="Сведения об объекте"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <Info size={20} />
        <h2>Об объекте</h2>
        <button
          type="button"
          ref={close}
          className="icon-button"
          aria-label="Закрыть сведения об объекте"
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      <div className="object-info-body">
        {loading && <p role="status">Загрузка сведений…</p>}
        {error && (
          <div role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="secondary-button"
              disabled={!online || loading}
              onClick={() => setRetry((value) => value + 1)}
            >
              Повторить загрузку сведений
            </button>
          </div>
        )}
        {data && (
          <>
            <span className={`object-state object-state-${data.status}`}>
              {statuses[data.status]}
            </span>
            <h3>
              {data.code} · {data.name}
            </h3>
            {data.fullName && <p className="object-full-name">{data.fullName}</p>}
            <dl>
              <dt>Заказчик</dt>
              <dd>{data.client || 'Не указан'}</dd>
              <dt>Адрес</dt>
              <dd>{data.address || 'Не указан'}</dd>
              <dt>ГИП</dt>
              <dd>{data.gip?.shortName ?? 'Не назначен'}</dd>
              <dt>ГАП</dt>
              <dd>{data.gap?.shortName ?? 'Не назначен'}</dd>
              <dt>Руководитель проекта</dt>
              <dd>{data.pm?.shortName ?? 'Не назначен'}</dd>
              <dt>Текущая стадия</dt>
              <dd>{current ? `${current.code} · ${current.name}` : 'Не выбрана'}</dd>
              {data.statusNote && (
                <>
                  <dt>Примечание к статусу</dt>
                  <dd>{data.statusNote}</dd>
                </>
              )}
            </dl>
            {data.stages.length > 0 && (
              <section aria-label="Стадии объекта">
                <h4>Стадии</h4>
                <ol className="object-stages">
                  {data.stages.map((stage) => (
                    <li
                      key={stage.id}
                      className={stage.id === data.currentStageId ? 'current-stage' : ''}
                    >
                      <strong>
                        {stage.code} · {stage.name}
                      </strong>
                      <span>
                        {day(stage.startDate)} — {day(stage.endDate)}
                      </span>
                      <small>
                        {stage.closed
                          ? 'Закрыта'
                          : stage.id === data.currentStageId
                            ? 'Текущая'
                            : 'Открыта'}
                      </small>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {[
              ['Папка объекта', data.folderRoot],
              ['Модель', data.modelPath],
            ].map(
              ([label, path]) =>
                path && (
                  <section key={label} className="object-path">
                    <h4>{label}</h4>
                    <code>{path}</code>
                    {path.startsWith('\\\\') && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void openPath(path)}
                      >
                        <FolderOpen size={16} />
                        Показать в папке
                      </button>
                    )}
                  </section>
                ),
            )}
            <button
              type="button"
              className="secondary-button object-site"
              onClick={() => {
                void request({ kind: 'open.site', epoch, path: `/objects/${data.id}` }).then(
                  (result) => {
                    if (mounted.current && !result.ok) setFeedback(result.error);
                  },
                );
              }}
            >
              <ExternalLink size={17} />
              Открыть на сайте
            </button>
            {feedback && (
              <p className="object-feedback" role="status">
                {feedback}
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
