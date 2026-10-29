import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Camera, ChatCircleDots, X } from '@phosphor-icons/react';
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
    [pending, setPending] = useState<'capture' | 'prepare' | 'export' | null>(null),
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
  const file = preview?.files.find((item) => item.name === selected);
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
          <ChatCircleDots size={24} weight="duotone" />
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
            Чат поддержки ещё не настроен. Сейчас можно сохранить ZIP и передать администратору
            вручную. Приложение ничего не отправляет автоматически.
          </p>
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
              {pending === 'export' ? 'Сохранение…' : 'Сохранить ZIP'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
