import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Camera, MessageCircleMore, X } from 'lucide-react';
import type { ClientSnapshot } from '../shared/desktop';
import type { ReportCapture, ReportExport, ReportPreview, ReportScreen } from '../shared/report';
import { request } from './bridge';
import './report.css';
export function ReportPanel({
  snapshot,
  onClose,
}: {
  snapshot: ClientSnapshot;
  onClose: () => void;
}) {
  const [description, setDescription] = useState(''),
    [appLogs, setAppLogs] = useState(false),
    [revitLogs, setRevitLogs] = useState(false),
    [year, setYear] = useState<2025 | 2026>(2025),
    [screen, setScreen] = useState('window'),
    [screens, setScreens] = useState<ReportScreen[]>([]),
    [shot, setShot] = useState<ReportCapture | null>(null),
    [includeShot, setIncludeShot] = useState(false),
    [preview, setPreview] = useState<ReportPreview | null>(null),
    [selected, setSelected] = useState('report.txt'),
    [exported, setExported] = useState<ReportExport | null>(null),
    [pending, setPending] = useState<
      'capture' | 'prepare' | 'export' | 'send' | 'retry' | 'resolve' | 'fallback' | null
    >(null),
    [reviewed, setReviewed] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true),
    flight = useRef(false),
    generation = useRef(0),
    close = useRef<HTMLButtonElement>(null),
    owner = useRef(`${snapshot.epoch}:${snapshot.user?.id ?? ''}`);
  useEffect(() => {
    alive.current = true;
    close.current?.focus();
    void request({ kind: 'report.screens' }).then((result) => {
      if (alive.current && result.ok) setScreens(result.data);
    });
    return () => {
      alive.current = false;
      generation.current++;
      void request({ kind: 'report.clear' });
    };
  }, []);
  useEffect(() => {
    const current = `${snapshot.epoch}:${snapshot.user?.id ?? ''}`;
    if (owner.current !== current) {
      generation.current++;
      flight.current = false;
      setPending(null);
      setShot(null);
      setIncludeShot(false);
      setPreview(null);
      setExported(null);
      setDescription('');
      setReviewed(false);
      setError('Вход изменился. Диагностика очищена.');
      void request({ kind: 'report.clear' });
    }
    owner.current = current;
  }, [snapshot.epoch, snapshot.user?.id]);
  useLayoutEffect(() => {
    if (pending !== 'capture') return;
    const ticket = ++generation.current;
    void (async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (!alive.current || ticket !== generation.current) return;
      const result = await request({
        kind: 'report.capture',
        target: screen === 'window' ? { type: 'window' } : { type: 'screen', id: screen },
      });
      if (!alive.current || ticket !== generation.current) return;
      flight.current = false;
      setPending(null);
      if (result.ok) {
        setShot(result.data);
        setIncludeShot(true);
      } else setError(result.error);
    })();
  }, [pending, screen]);
  async function prepare() {
    if (flight.current) return;
    flight.current = true;
    setPending('prepare');
    setError('');
    const ticket = ++generation.current;
    const result = await request({
      kind: 'report.prepare',
      options: {
        description,
        applicationLogs: appLogs,
        revitYear: revitLogs ? year : null,
        includeScreenshot: includeShot,
      },
    });
    if (!alive.current || ticket !== generation.current) return;
    flight.current = false;
    setPending(null);
    if (result.ok) {
      setPreview(result.data);
      setSelected('report.txt');
      setExported(null);
    } else setError(result.error);
  }
  async function save() {
    if (flight.current || !preview) return;
    flight.current = true;
    setPending('export');
    setError('');
    const ticket = ++generation.current;
    const result = await request({ kind: 'report.export', id: preview.id });
    if (!alive.current || ticket !== generation.current) return;
    flight.current = false;
    setPending(null);
    if (result.ok) {
      if (result.data) setExported(result.data);
    } else setError(result.error);
  }
  async function supportAction(kind: 'send' | 'retry' | 'resolve') {
    const attempt = snapshot.reportSupport?.attempt;
    if (
      flight.current ||
      (kind === 'send' && !preview) ||
      (kind !== 'send' && !attempt) ||
      (kind === 'resolve' && !reviewed)
    )
      return;
    flight.current = true;
    setPending(kind);
    setError('');
    const ticket = ++generation.current,
      epoch = snapshot.epoch;
    const result =
      kind === 'send' && preview
        ? await request({ kind: 'report.send', epoch, id: preview.id })
        : kind === 'retry' && attempt
          ? await request({ kind: 'report.retry', epoch, id: attempt.id })
          : attempt
            ? await request({ kind: 'report.resolve', epoch, id: attempt.id, confirmed: true })
            : null;
    if (!alive.current || ticket !== generation.current) return;
    flight.current = false;
    setPending(null);
    setReviewed(false);
    if (result && !result.ok) setError(result.error);
  }
  const support = snapshot.reportSupport,
    attempt = support?.attempt;
  const unresolved = !!attempt && ['unresolved', 'review'].includes(attempt.status);
  const consumed =
    !!attempt &&
    attempt.previewId === preview?.id &&
    ['confirmed', 'resolved'].includes(attempt.status);
  useEffect(() => setReviewed(false), [attempt?.id]);
  const file = preview?.files.find((item) => item.name === selected);
  async function fallback() {
    if (flight.current || !exported) return;
    flight.current = true;
    setPending('fallback');
    setError('');
    const ticket = ++generation.current;
    const result = await request({
      kind: 'report.fallback',
      epoch: snapshot.epoch,
      id: exported.id,
    });
    if (!alive.current || ticket !== generation.current) return;
    flight.current = false;
    setPending(null);
    if (!result.ok) setError(result.error);
  }
  return (
    <div
      className="report-backdrop"
      data-capturing={pending === 'capture'}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          event.stopPropagation();
          onClose();
        }
        if (event.key === 'Tab') {
          const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled),textarea:not(:disabled),select:not(:disabled),input:not(:disabled)',
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
        className="report-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
      >
        <header>
          <MessageCircleMore size={24} />
          <h2 id="report-title">Сообщить о проблеме</h2>
          <button
            className="icon-button"
            ref={close}
            disabled={Boolean(pending)}
            onClick={onClose}
            aria-label="Закрыть сообщение о проблеме"
          >
            <X size={21} />
          </button>
        </header>
        <div className="report-content">
          <p className="report-note">
            {support?.error
              ? 'Результат прежней отправки может быть неизвестен. Сохраните архив локально и сначала проверьте состояние обращения.'
              : unresolved
                ? 'Сначала проверьте результат предыдущей отправки. Архив можно сохранить локально.'
                : consumed
                  ? 'Для нового обращения измените описание и подготовьте новый предпросмотр.'
                  : support?.available
                    ? 'После просмотра можно отправить обращение в поддержку. Ответ придёт в личные.'
                    : 'Отправка в поддержку сейчас недоступна. Сохраните архив и передайте администратору вручную.'}{' '}
            Приложение ничего не отправляет автоматически.
          </p>
          {support?.error && (
            <p role="alert" className="preferences-error">
              {support.error}
            </p>
          )}
          {attempt && (
            <section className="report-note" aria-label="Состояние обращения">
              <p role="status">
                {attempt.status === 'confirmed'
                  ? `${attempt.previewId === preview?.id ? 'Обращение' : 'Предыдущее обращение'} отправлено. Ответ придёт в личные.`
                  : unresolved
                    ? 'Результат отправки пока неизвестен.'
                    : attempt.status === 'resolved'
                      ? 'Результат проверен вручную. Для нового обращения подготовьте новый предпросмотр.'
                      : 'Сервер не принял обращение.'}
              </p>
              {unresolved && (
                <>
                  <p>{attempt.text}</p>
                  <ul>
                    {attempt.files.map((f) => (
                      <li key={f.name}>
                        {f.name} · {new Intl.NumberFormat('ru-RU').format(f.size)} Б
                      </li>
                    ))}
                  </ul>
                  <p>
                    Сохранены описание и список вложений. Повтор использует прежнее обращение; файлы
                    заново не собираются.
                  </p>
                  <button
                    disabled={Boolean(pending) || !attempt.retryAllowed}
                    onClick={() => void supportAction('retry')}
                  >
                    {pending === 'retry' ? 'Проверка…' : 'Проверить отправку'}
                  </button>
                  {!attempt.retryAllowed && (
                    <p>Безопасный повтор сейчас недоступен. Проверьте результат с поддержкой.</p>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewed}
                      disabled={Boolean(pending)}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />
                    Я проверил результат с поддержкой
                  </label>
                  <button
                    disabled={Boolean(pending) || !reviewed}
                    onClick={() => void supportAction('resolve')}
                  >
                    Результат проверен вручную
                  </button>
                </>
              )}
            </section>
          )}
          {error && (
            <p role="alert" className="preferences-error">
              {error}
            </p>
          )}
          {!preview ? (
            <>
              <label className="report-description">
                Что случилось
                <textarea
                  rows={4}
                  value={description}
                  maxLength={4000}
                  disabled={Boolean(pending)}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Что делали, что произошло и что ожидали увидеть"
                />
              </label>
              <fieldset disabled={Boolean(pending)}>
                <legend>Какие файлы приложить</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={appLogs}
                    onChange={(event) => setAppLogs(event.target.checked)}
                  />
                  Журналы приложения — без адресов, путей и подробностей ошибок
                </label>
                <label>
                  <input type="checkbox" disabled />
                  Журналы плагинов — путь не настроен
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={revitLogs}
                    onChange={(event) => setRevitLogs(event.target.checked)}
                  />
                  Последний журнал Revit
                </label>
                {revitLogs && (
                  <>
                    <select
                      aria-label="Версия Revit для журнала"
                      value={year}
                      onChange={(event) => setYear(Number(event.target.value) as 2025 | 2026)}
                    >
                      <option value="2025">Revit 2025</option>
                      <option value="2026">Revit 2026</option>
                    </select>
                    <p className="preferences-hint">
                      Значения в кавычках, известные данные доступа и пути скрываются. Проверьте
                      оставшийся текст: он может содержать сведения о моделях.
                    </p>
                  </>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={includeShot}
                    disabled={!shot}
                    onChange={(event) => setIncludeShot(event.target.checked)}
                  />
                  Снимок экрана
                </label>
              </fieldset>
              <section className="report-capture" aria-label="Снимок для диагностики">
                <h3>Снимок</h3>
                <select
                  aria-label="Источник снимка"
                  value={screen}
                  disabled={Boolean(pending)}
                  onChange={(event) => setScreen(event.target.value)}
                >
                  <option value="window">Окно Schema Teams</option>
                  {screens.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <button
                  disabled={Boolean(pending)}
                  onClick={() => {
                    if (flight.current) return;
                    flight.current = true;
                    setError('');
                    setPending('capture');
                  }}
                >
                  <Camera size={18} />
                  {pending === 'capture' ? 'Снимок…' : 'Сделать снимок'}
                </button>
                {shot && (
                  <>
                    <img className="report-image" src={shot.image} alt="Снимок для диагностики" />
                    <button
                      disabled={Boolean(pending)}
                      onClick={() => {
                        void request({ kind: 'report.clear' });
                        setShot(null);
                        setIncludeShot(false);
                      }}
                    >
                      Удалить снимок
                    </button>
                  </>
                )}
              </section>
            </>
          ) : (
            <section className="report-preview" aria-label="Что войдёт в архив">
              <h3>Что войдёт в архив</h3>
              <p>Сохранятся именно эти версии файлов. Проверьте описание, журналы и снимок.</p>
              <ul>
                {preview.files.map((item) => (
                  <li key={item.name}>
                    {item.name} · {new Intl.NumberFormat('ru-RU').format(item.size)} Б
                  </li>
                ))}
              </ul>
              {preview.notices.map((notice) => (
                <p key={notice} className="preferences-hint">
                  {notice}
                </p>
              ))}
              <label>
                Просмотр файла
                <select
                  aria-label="Просмотр файла диагностики"
                  value={selected}
                  disabled={Boolean(pending)}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {preview.files.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {file?.text !== undefined && (
                <textarea
                  className="report-log"
                  aria-label="Содержимое файла диагностики"
                  readOnly
                  value={file.text}
                  rows={12}
                />
              )}{' '}
              {file?.image && (
                <img className="report-image" src={file.image} alt="Снимок в архиве" />
              )}
              {exported && (
                <p role="status" className="preferences-feedback">
                  Архив сохранён: {exported.fileName}
                </p>
              )}
              {exported && !support?.available && (
                <>
                  <p>
                    В обратной связи сайта выберите «Написать». Архив передайте администратору
                    вручную. Кнопка также покажет сохранённый архив в папке.
                  </p>
                  <button
                    disabled={
                      Boolean(pending) ||
                      unresolved ||
                      consumed ||
                      !!support?.error ||
                      !snapshot.user
                    }
                    onClick={() => void fallback()}
                  >
                    {pending === 'fallback' ? 'Открываем…' : 'Открыть обратную связь на сайте'}
                  </button>
                </>
              )}
            </section>
          )}
        </div>
        <footer>
          {preview && (
            <button
              disabled={Boolean(pending)}
              onClick={() => {
                void request({ kind: 'report.edit' });
                setPreview(null);
                setExported(null);
                setError('');
              }}
            >
              Изменить описание и вложения
            </button>
          )}
          <span />
          {preview && (
            <button
              className="primary-button"
              disabled={Boolean(pending) || !support?.available || unresolved || consumed}
              onClick={() => void supportAction('send')}
            >
              {pending === 'send' ? 'Отправка…' : 'Отправить в поддержку'}
            </button>
          )}
          {!preview ? (
            <button
              className="primary-button"
              disabled={Boolean(pending) || !description.trim()}
              onClick={() => void prepare()}
            >
              {pending === 'prepare' ? 'Подготовка…' : 'Подготовить и просмотреть'}
            </button>
          ) : exported ? (
            <button onClick={() => void request({ kind: 'report.reveal', id: exported.id })}>
              Показать сохранённый архив
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={Boolean(pending)}
              onClick={() => void save()}
            >
              {pending === 'export' ? 'Сохранение…' : 'Сохранить архив'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
