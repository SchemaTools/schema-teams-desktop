import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Timer, Search, Pause, Play, Trash, X } from 'lucide-react';
import type { ApiResult } from '../shared/client';
import type { ClientSnapshot } from '../shared/desktop';
import {
  elapsedAt,
  matchesTimer,
  minuteClock,
  timerClock,
  timerExpected,
  timerRowsValid,
  type TimeOptions,
  type TimeTask,
  type TimerPrepared,
  type TimerRow,
  type TimerRowsCheck,
  type TimerExpected,
  type WorkTimer,
} from '../shared/time';
import { request } from './bridge';
import './timer.css';
import { TimerSettings } from './timerSettings';

export function TimerElapsed({
  timer,
  observedAt,
  confirmed = true,
}: {
  timer: WorkTimer;
  observedAt: number;
  confirmed?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return (
    <span className="timer-clock">
      {timerClock(elapsedAt(timer, observedAt, confirmed ? now : observedAt))}
    </span>
  );
}
export function TimerCard({
  snapshot,
  onOpen,
}: {
  snapshot: ClientSnapshot;
  onOpen: (mode: 'pick' | 'finish') => void;
}) {
  const timer = snapshot.timer;
  return (
    <section className="timer-card" aria-label="Таймер работы">
      <div className="timer-card-top">
        <Timer size={20} />
        <b>Учёт времени</b>
        {timer && (
          <TimerElapsed
            timer={timer}
            observedAt={snapshot.timerObservedAt ?? Date.now()}
            confirmed={snapshot.timerReady && snapshot.connection === 'online'}
          />
        )}
      </div>
      {timer ? (
        <>
          <p>
            <b>{timer.task.mark}</b> {timer.task.title}
          </p>
          <small>
            {timer.task.place} ·{' '}
            {snapshot.timerReady && snapshot.connection === 'online'
              ? timer.state === 'run'
                ? 'Идёт работа'
                : 'На паузе'
              : 'Состояние не подтверждено'}
          </small>
        </>
      ) : (
        <p>{snapshot.timerReady ? 'Таймер не запущен' : 'Состояние таймера не получено'}</p>
      )}
      {snapshot.timerError && (
        <p className="timer-error" role="status">
          {snapshot.timerError}
        </p>
      )}
      {snapshot.timerAbsence && (
        <p className="timer-warning">
          {snapshot.timerAbsence.message ??
            'После блокировки или сна проверьте время: автоматическая пауза не подтверждена.'}
        </p>
      )}
      <div className="timer-actions">
        <button onClick={() => onOpen(timer ? 'finish' : 'pick')}>
          {timer ? 'Открыть таймер' : 'Начать работу'}
        </button>
        {timer && <button onClick={() => onOpen('pick')}>Сменить задачу</button>}
      </div>
    </section>
  );
}

export function TimerPanel({
  snapshot,
  mode,
  taskId,
  prepareExpected,
  onClose,
}: {
  snapshot: ClientSnapshot;
  mode: 'pick' | 'finish';
  taskId?: number;
  prepareExpected?: TimerExpected;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<TimeOptions | null>(null),
    [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [prepared, setPrepared] = useState<TimerPrepared | null>(null),
    [rows, setRows] = useState<TimerRow[]>([]),
    [note, setNote] = useState(''),
    [resetConfirm, setResetConfirm] = useState(false),
    [extendConfirm, setExtendConfirm] = useState(false),
    [nextTask, setNextTask] = useState<TimeTask | null>(null),
    [feedback, setFeedback] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [reviewRequired, setReviewRequired] = useState(false),
    [showPicker, setShowPicker] = useState(mode === 'pick'),
    [rowError, setRowError] = useState<number | null>(null);
  const [rowCheck, setRowCheck] = useState<{ signature: string; value: TimerRowsCheck } | null>(
    null,
  );
  const validationGeneration = useRef(0);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [validationError, setValidationError] = useState('');
  const latest = useRef(snapshot),
    alive = useRef(true),
    busy = useRef(false),
    close = useRef<HTMLButtonElement>(null);
  latest.current = snapshot;
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const epoch = snapshot.epoch,
    online = snapshot.connection === 'online',
    timer = snapshot.timer ?? null;
  const valid =
    online && snapshot.timerReady && snapshot.timerControl === true && !pending && !uncertain;
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const preparedAt = useRef(0);
  const expired =
    prepared !== null &&
    Date.parse(prepared.serverNow) + Math.max(0, clock - preparedAt.current) >=
      Date.parse(prepared.expiresAt);
  const stale =
    expired ||
    reviewRequired ||
    (prepared !== null && !matchesTimer(timer, timerExpected(prepared.current)));
  const rowsSignature = JSON.stringify(rows);
  const rowsValidated = rowCheck?.signature === rowsSignature && rowCheck.value.ok;
  useEffect(() => {
    const generation = ++validationGeneration.current;
    setRowCheck(null);
    setValidationError('');
    if (!prepared || stale || !online || !timerRowsValid(rows)) return;
    const requestId = prepared.requestId;
    const checkedRows = structuredClone(rows);
    const validation = setTimeout(() => {
      void request({
        kind: 'timer.validateRows',
        epoch,
        preparedRequestId: requestId,
        rows: checkedRows,
      }).then((result) => {
        if (
          !alive.current ||
          latest.current.epoch !== epoch ||
          generation !== validationGeneration.current
        )
          return;
        if (result.ok) {
          setRowCheck({ signature: rowsSignature, value: result.data });
          setRowError(result.data.problems[0]?.row ?? null);
        } else setValidationError(result.error);
      });
    }, 300);
    return () => {
      clearTimeout(validation);
      validationGeneration.current++;
    };
  }, [prepared, rowsSignature, epoch, stale, online, validationAttempt]);
  useEffect(() => {
    const search = setTimeout(() => {
      void request({ kind: 'timer.options', epoch, q: query }).then((result) => {
        if (
          alive.current &&
          latest.current.epoch === epoch &&
          latestQuery.current === query &&
          result.ok
        )
          setOptions(result.data);
      });
    }, 250);
    return () => clearTimeout(search);
  }, [query, epoch]);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => {
      alive.current = false;
      previous?.focus();
    };
  }, []);
  async function run<T>(work: () => Promise<ApiResult<T>>): Promise<ApiResult<T> | null> {
    if (busy.current || latest.current.epoch !== epoch) return null;
    busy.current = true;
    setPending(true);
    setError('');
    setRowError(null);
    setFeedback('');
    const result = await work();
    if (!alive.current || latest.current.epoch !== epoch) return null;
    busy.current = false;
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      setUncertain(Boolean(result.uncertain));
      if (result.uncertain) setReviewRequired(true);
      setRowError(result.row ?? null);
    }
    return result;
  }
  async function refresh() {
    await run(async () => {
      const [state, list] = await Promise.all([
        request({ kind: 'timer.read', epoch }),
        request({ kind: 'timer.options', epoch }),
      ]);
      if (alive.current && latest.current.epoch === epoch && list.ok) setOptions(list.data);
      if (!state.ok) return state;
      if (!list.ok) return list;
      setUncertain(false);
      setValidationAttempt((value) => value + 1);
      return { ok: true, data: null };
    });
  }
  useEffect(() => {
    void refresh();
  }, []); // One mount is bound to one owner/navigation request.
  const preparedOnOpen = useRef(false);
  useEffect(() => {
    if (!prepareExpected || preparedOnOpen.current || !valid || busy.current) return;
    preparedOnOpen.current = true;
    if (!matchesTimer(timer, prepareExpected))
      setError('Таймер изменился после возвращения. Обновите состояние и проверьте задачу.');
    else void prepare();
  }, [prepareExpected, valid]);
  async function prepare(next: TimeTask | null = null) {
    const current = latest.current.timer;
    if (!current || !latest.current.timerReady || latest.current.connection !== 'online') return;
    const result = await run(() =>
      request({ kind: 'timer.proposal', epoch, expected: timerExpected(current) }),
    );
    if (result?.ok) {
      preparedAt.current = Date.now();
      setPrepared(result.data);
      setReviewRequired(false);
      setRows(result.data.proposal.rows);
      setNote('');
      setNextTask(next);
      setResetConfirm(false);
    }
  }
  const tasks = useMemo(() => {
    const list = options?.tasks ?? [],
      q = query.trim().toLocaleLowerCase('ru');
    const recent = options?.recentTaskIds ?? snapshot.recentTimeTaskIds ?? [];
    const filtered = list.filter((t) =>
      [t.mark, t.title, t.place].join(' ').toLocaleLowerCase('ru').includes(q),
    );
    return [...filtered].sort((a, b) => {
      const ai = recent.indexOf(a.id),
        bi = recent.indexOf(b.id);
      return (
        (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) ||
        a.place.localeCompare(b.place, 'ru') ||
        a.mark.localeCompare(b.mark, 'ru') ||
        a.title.localeCompare(b.title, 'ru')
      );
    });
  }, [options, query, snapshot.recentTimeTaskIds]);
  async function start(task: TimeTask) {
    if (!valid) return;
    if (timer && timer.task.id !== task.id) {
      await prepare(task);
      return;
    }
    const result = await run(() =>
      request({
        kind: 'timer.start',
        epoch,
        taskId: task.id,
        expected: timer ? timerExpected(timer) : null,
      }),
    );
    if (result?.ok) {
      setFeedback('Работа начата.');
      setPrepared(null);
      setNextTask(null);
    }
  }
  async function control(kind: 'timer.pause' | 'timer.resume' | 'timer.reset' | 'timer.extend') {
    if (!timer || !valid) return;
    const result = await run(() => request({ kind, epoch, expected: timerExpected(timer) }));
    if (result?.ok) {
      setPrepared(null);
      setResetConfirm(false);
      setExtendConfirm(false);
      setFeedback(
        kind === 'timer.reset'
          ? 'Таймер сброшен без записи.'
          : kind === 'timer.pause'
            ? 'Таймер на паузе.'
            : kind === 'timer.extend'
              ? 'К началу работы добавлено 15 минут.'
              : 'Работа продолжена.',
      );
    }
  }
  async function finish() {
    if (!prepared || !valid || stale || !timerRowsValid(rows) || !rowsValidated) return;
    const saved = await run(async () => {
      const checked = await request({
        kind: 'timer.validateRows',
        epoch,
        preparedRequestId: prepared.requestId,
        rows,
      });
      if (!checked.ok) return checked;
      if (!checked.data.ok)
        return {
          ok: false,
          code: 'validation',
          error: 'Проверьте строки и пересечения интервалов.',
          row: checked.data.problems[0]?.row,
          retryable: false,
        } as const;
      return request({
        kind: 'timer.finish',
        epoch,
        expected: prepared.expected,
        preparedRequestId: prepared.requestId,
        rows,
        note,
      });
    });
    if (!saved?.ok) return;
    setPrepared(null);
    setRows([]);
    setNote('');
    setResetConfirm(false);
    const target = nextTask;
    setNextTask(null);
    setFeedback('Трудозатраты записаны.');
    if (target) {
      const begun = await run(() =>
        request({ kind: 'timer.start', epoch, taskId: target.id, expected: null }),
      );
      if (begun?.ok) setFeedback('Трудозатраты записаны. Новая задача начата.');
      else if (begun)
        setFeedback(
          'Трудозатраты записаны. Запуск новой задачи не подтверждён — обновите состояние.',
        );
    }
  }
  function changeRow(index: number, change: Partial<TimerRow>) {
    setRows((old) => old.map((row, i) => (i === index ? { ...row, ...change } : row)));
    setRowError(null);
  }
  const clockOptions = (end: boolean) =>
    Array.from({ length: end ? 49 : 48 }, (_, i) => i * 30)
      .filter((m) => !end || m > 0)
      .map((m) => (
        <option key={m} value={m}>
          {minuteClock(m)}
        </option>
      ));
  return (
    <div
      className="timer-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          event.stopPropagation();
          onClose();
        }
        if (event.key === 'Tab') {
          const nodes = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)',
              ),
            ).filter((n) => n.getClientRects().length > 0),
            first = nodes[0],
            last = nodes.at(-1);
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
        className="timer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="timer-title"
      >
        <header>
          <Timer size={24} />
          <div>
            <h2 id="timer-title">Учёт времени</h2>
            <small>Один таймер на всех ваших устройствах</small>
          </div>
          <button
            ref={close}
            className="icon-button"
            disabled={pending}
            aria-label="Закрыть таймер"
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </header>
        <div className="timer-body">
          {snapshot.timerAbsence && (
            <div className="timer-warning" role="status">
              <b>Проверьте время после возвращения</b>
              <p>
                {snapshot.timerAbsence.message ?? (
                  <>
                    Компьютер был заблокирован или спал:{' '}
                    {new Date(snapshot.timerAbsence.from).toLocaleString('ru-RU')} —{' '}
                    {new Date(snapshot.timerAbsence.to).toLocaleString('ru-RU')}. Автоматическая
                    пауза не подтверждена. При записи исключите время отсутствия вручную.
                  </>
                )}
              </p>
              <button
                disabled={pending}
                onClick={() =>
                  void request({
                    kind: 'timer.absenceDismiss',
                    epoch,
                    id: snapshot.timerAbsence?.id ?? 0,
                  })
                }
              >
                {snapshot.timerAbsence.durable
                  ? 'Проверено, отменить повтор'
                  : 'Предупреждение прочитано'}
              </button>
            </div>
          )}
          {timer && (
            <div className="timer-current">
              <span className={`timer-state ${timer.state}`}>
                {snapshot.timerReady && online
                  ? timer.state === 'run'
                    ? 'Идёт работа'
                    : 'На паузе'
                  : 'Состояние не подтверждено'}
              </span>
              <TimerElapsed
                timer={timer}
                observedAt={snapshot.timerObservedAt ?? Date.now()}
                confirmed={snapshot.timerReady && online}
              />
              <h3>
                {timer.task.mark} · {timer.task.title}
              </h3>
              <p>{timer.task.place}</p>
              <div className="timer-actions">
                <button
                  disabled={!valid || Boolean(prepared)}
                  onClick={() =>
                    void control(timer.state === 'run' ? 'timer.pause' : 'timer.resume')
                  }
                >
                  {timer.state === 'run' ? <Pause size={17} /> : <Play size={17} />}{' '}
                  {timer.state === 'run' ? 'Пауза' : 'Продолжить'}
                </button>
                <button
                  className="timer-primary"
                  disabled={!valid || Boolean(prepared)}
                  onClick={() => void prepare()}
                >
                  Закончить и проверить
                </button>
                <button disabled={!valid} onClick={() => setResetConfirm(true)}>
                  <Trash size={17} />
                  Сбросить
                </button>
                <button
                  disabled={!valid || Boolean(prepared)}
                  onClick={() => setExtendConfirm(true)}
                >
                  Добавить 15 минут
                </button>
                <button disabled={pending} onClick={() => setShowPicker((value) => !value)}>
                  Выбрать другую задачу
                </button>
              </div>
            </div>
          )}
          {snapshot.timerControl !== true && (
            <p className="timer-warning">Сервер не подтвердил безопасное управление таймером.</p>
          )}
          {!snapshot.timerReady && (
            <p className="timer-error" role="status">
              {snapshot.timerError || 'Состояние таймера ещё не подтверждено.'}
            </p>
          )}
          {!online && (
            <p className="timer-warning" role="status">
              Нет связи. Изменение таймера и запись недоступны. Последнее состояние показано для
              справки.
            </p>
          )}
          {(error || uncertain) && (
            <div className="timer-error" role="alert">
              <p>{error}</p>
              {uncertain && (
                <p>
                  Результат действия неизвестен. Повтор автоматически не отправляется. Обновите
                  состояние, затем заново проверьте интервалы.
                </p>
              )}
              {rowError !== null && (
                <p>
                  Проверьте строку {rowError + 1}: дату, интервалы и пересечения с уже записанным
                  временем.
                </p>
              )}
            </div>
          )}
          {feedback && (
            <p className="timer-success" role="status">
              {feedback}
            </p>
          )}
          <button disabled={!online || pending} onClick={() => void refresh()}>
            Обновить состояние
          </button>
          {resetConfirm && (
            <div className="timer-warning" role="alert">
              <b>Сбросить таймер без записи трудозатрат?</b>
              <p>Накопленные интервалы будут удалены.</p>
              <div className="timer-actions">
                <button disabled={!valid} onClick={() => void control('timer.reset')}>
                  Да, сбросить
                </button>
                <button disabled={pending} onClick={() => setResetConfirm(false)}>
                  Отмена
                </button>
              </div>
            </div>
          )}
          {extendConfirm && (
            <div className="timer-warning" role="alert">
              <b>Добавить 15 минут перед началом работы?</b>
              <p>
                Начало первого интервала сдвинется на 15 минут назад, отработанное время увеличится
                на 15 минут. Это не перенос напоминания или конца рабочего дня.
              </p>
              <div className="timer-actions">
                <button disabled={!valid} onClick={() => void control('timer.extend')}>
                  Да, добавить 15 минут
                </button>
                <button disabled={pending} onClick={() => setExtendConfirm(false)}>
                  Отмена добавления
                </button>
              </div>
            </div>
          )}
          {prepared ? (
            <section className="timer-finish" aria-label="Запись трудозатрат">
              <h3>Записать в трудозатраты</h3>
              <p>
                {prepared.proposal.task.mark} · {prepared.proposal.task.title}
              </p>
              <p>
                Фактически: {timerClock(prepared.proposal.elapsedSec)} · округление предложено
                сервером до получаса.
              </p>
              <p>
                Окончание работы зафиксировано:{' '}
                {new Date(prepared.cutoffAt).toLocaleString(
                  'ru-RU',
                  snapshot.bureau ? { timeZone: snapshot.bureau.timeZone } : undefined,
                )}
                {snapshot.bureau ? ` (${snapshot.bureau.timeZone})` : ''}. Подготовка не меняет
                состояние таймера.
              </p>
              {prepared.problems.length > 0 && (
                <div className="timer-warning" role="status">
                  Предупреждения предложения сервера:{' '}
                  {prepared.problems
                    .map((problem) => `Строка ${problem.row + 1}: ${problem.message}`)
                    .join(' ')}
                </div>
              )}
              {!stale && timerRowsValid(rows) && !rowCheck && !validationError && (
                <p role="status">Проверяем изменённые строки на сервере…</p>
              )}
              {validationError && (
                <div className="timer-error" role="alert">
                  <p>{validationError}</p>
                  <button
                    disabled={!online || pending || stale}
                    onClick={() => setValidationAttempt((value) => value + 1)}
                  >
                    Повторить проверку строк
                  </button>
                </div>
              )}
              {rowCheck?.signature === rowsSignature &&
                rowCheck.value.problems.map((problem, index) => (
                  <p key={index} className="timer-error" role="alert">
                    Строка {problem.row + 1}: {problem.message}
                  </p>
                ))}
              <details>
                <summary>Фактические интервалы (часовой пояс компьютера)</summary>
                <ul>
                  {prepared.proposal.segments.map((s, i) => (
                    <li key={i}>
                      {new Date(s.from).toLocaleString('ru-RU')} —{' '}
                      {new Date(s.to).toLocaleString('ru-RU')}
                    </li>
                  ))}
                </ul>
              </details>
              {expired && (
                <p className="timer-warning" role="alert">
                  Срок проверки истёк. Закройте проверку и подготовьте её заново.
                </p>
              )}
              {stale && !expired && (
                <p className="timer-warning" role="alert">
                  Таймер изменился. Эти интервалы больше нельзя отправить. Закройте проверку и
                  откройте её заново.
                </p>
              )}
              {rows.length === 0 && (
                <p className="timer-warning">
                  После округления нет интервалов для записи. Продолжите работу или сбросьте таймер.
                </p>
              )}
              <div className="timer-rows">
                {rows.map((row, index) => (
                  <div className={`timer-row${rowError === index ? ' invalid' : ''}`} key={index}>
                    <label>
                      Дата {index + 1}
                      <input
                        aria-label={`Дата ${index + 1}`}
                        type="date"
                        min={options?.editableFrom}
                        max={prepared.proposal.today}
                        value={row.date}
                        disabled={pending || uncertain}
                        onChange={(e) => changeRow(index, { date: e.target.value })}
                      />
                    </label>
                    <label>
                      С
                      <select
                        aria-label={`С ${index + 1}`}
                        value={row.from}
                        disabled={pending || uncertain}
                        onChange={(e) => changeRow(index, { from: Number(e.target.value) })}
                      >
                        {clockOptions(false)}
                      </select>
                    </label>
                    <label>
                      До
                      <select
                        aria-label={`До ${index + 1}`}
                        value={row.to}
                        disabled={pending || uncertain}
                        onChange={(e) => changeRow(index, { to: Number(e.target.value) })}
                      >
                        {clockOptions(true)}
                      </select>
                    </label>
                    <button
                      aria-label={`Удалить строку ${index + 1}`}
                      disabled={pending || uncertain}
                      onClick={() => setRows((old) => old.filter((_, i) => i !== index))}
                    >
                      <Trash size={18} />
                    </button>
                  </div>
                ))}
              </div>
              <label className="timer-note">
                Примечание
                <textarea
                  aria-label="Примечание"
                  maxLength={500}
                  value={note}
                  disabled={pending || uncertain}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                />
                <small>{note.length}/500</small>
              </label>
              {nextTask && (
                <p>
                  После подтверждённой записи начнётся:{' '}
                  <b>
                    {nextTask.mark} · {nextTask.title}
                  </b>
                </p>
              )}
              <div className="timer-actions">
                <button
                  className="timer-primary"
                  disabled={!valid || stale || !timerRowsValid(rows) || !rowsValidated}
                  onClick={() => void finish()}
                >
                  {nextTask ? 'Записать и начать новую' : 'Записать'}
                </button>
                <button
                  disabled={pending}
                  onClick={() => {
                    setPrepared(null);
                    setNextTask(null);
                    setUncertain(false);
                  }}
                >
                  Закрыть проверку
                </button>
              </div>
            </section>
          ) : showPicker || !timer ? (
            <section className="timer-picker" aria-label="Выбор задачи">
              <h3>{timer ? 'Выбрать задачу' : 'Начать работу'}</h3>
              <label className="timer-search">
                <Search size={18} />
                <input
                  aria-label="Поиск задачи для таймера"
                  placeholder="Марка, задача или объект"
                  maxLength={200}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              {!options ? (
                <p>Загрузите список доступных задач кнопкой «Обновить состояние».</p>
              ) : tasks.length === 0 ? (
                <p>Подходящих доступных задач нет.</p>
              ) : (
                <div className="timer-task-list">
                  {tasks.map((task, index) => {
                    const recent = (
                        options?.recentTaskIds ??
                        snapshot.recentTimeTaskIds ??
                        []
                      ).includes(task.id),
                      previous = tasks[index - 1],
                      group = recent ? 'Недавние' : task.place || 'Личные задачи',
                      previousGroup = previous
                        ? (options?.recentTaskIds ?? snapshot.recentTimeTaskIds ?? []).includes(
                            previous.id,
                          )
                          ? 'Недавние'
                          : previous.place || 'Личные задачи'
                        : null;
                    return (
                      <div key={task.id}>
                        {group !== previousGroup && <h4>{group}</h4>}
                        <button
                          className={`timer-task${task.id === taskId ? ' suggested' : ''}`}
                          disabled={!valid}
                          onClick={() => void start(task)}
                        >
                          <span>
                            <b>{task.mark || 'Задача'}</b>
                            <strong>{task.title}</strong>
                            <small>{task.place || 'Личная задача'}</small>
                          </span>
                          <Play size={19} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}
          <TimerSettings snapshot={snapshot} workdayEnd={options?.workday.end} />
          <p className="timer-footnote">
            Управление подтверждается сервером. Проверка интервалов не ставит таймер на паузу;
            запись завершает работу на момент подготовки.
          </p>
          <button
            className="timer-site"
            disabled={!online || pending}
            onClick={() => void request({ kind: 'open.site', epoch, path: '/time' })}
          >
            <ExternalLink size={17} /> Все трудозатраты на сайте
          </button>
        </div>
      </section>
    </div>
  );
}
