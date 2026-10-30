import { useEffect, useRef, useState } from 'react';
import type { ClientSnapshot } from '../shared/desktop';
import { minuteClock } from '../shared/time';
import { request } from './bridge';

export function TimerSettings({
  snapshot,
  workdayEnd,
  expanded = false,
}: {
  snapshot: ClientSnapshot;
  workdayEnd?: number;
  expanded?: boolean;
}) {
  const saved = snapshot.timerReminderTime ?? '18:30';
  const [time, setTime] = useState(saved),
    [pauseOnLock, setPauseOnLock] = useState(snapshot.timerPauseOnLock !== false),
    [askOnUnlock, setAskOnUnlock] = useState(snapshot.timerAskOnUnlock !== false),
    [pending, setPending] = useState(false),
    [feedback, setFeedback] = useState('');
  const mounted = useRef(true),
    flight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setTime(saved);
  }, [saved]);
  useEffect(() => {
    setPauseOnLock(snapshot.timerPauseOnLock !== false);
  }, [snapshot.timerPauseOnLock]);
  useEffect(() => {
    setAskOnUnlock(snapshot.timerAskOnUnlock !== false);
  }, [snapshot.timerAskOnUnlock]);
  async function save(patch: { pauseOnLock?: boolean; askOnUnlock?: boolean } = {}) {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    setFeedback('');
    const result = await request({
      kind: 'timer.preferences',
      epoch: snapshot.epoch,
      reminderTime: time,
      ...patch,
    });
    if (!mounted.current) return;
    flight.current = false;
    setPending(false);
    if (!result.ok) {
      setPauseOnLock(snapshot.timerPauseOnLock !== false);
      setAskOnUnlock(snapshot.timerAskOnUnlock !== false);
    }
    setFeedback(
      result.ok
        ? patch.pauseOnLock !== undefined || patch.askOnUnlock !== undefined
          ? 'Настройки учёта времени сохранены на этом компьютере.'
          : 'Время напоминания сохранено на этом компьютере.'
        : result.error,
    );
  }
  return (
    <details className="timer-settings" open={expanded || undefined}>
      <summary>Настройки учёта времени</summary>
      <div>
        <label>
          Напомнить об идущем таймере
          <select
            aria-label="Время напоминания"
            value={time}
            disabled={pending}
            onChange={(e) => {
              setTime(e.target.value);
              setFeedback('');
            }}
          >
            {Array.from({ length: 48 }, (_, i) => minuteClock(i * 30)).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <p>
          Время этого компьютера. Напоминание появляется один раз в день, если таймер идёт. Фокус,
          тихие часы и системная блокировка уведомлений учитываются.
        </p>
        <button disabled={pending || time === saved} onClick={() => void save()}>
          {pending ? 'Сохранение…' : 'Сохранить время напоминания'}
        </button>
        {feedback && <p role="status">{feedback}</p>}
        <dl>
          <dt>Конец рабочего дня бюро</dt>
          <dd>
            {snapshot.bureau?.workEnd ??
              (workdayEnd === undefined
                ? 'Не удалось получить с сервера'
                : minuteClock(workdayEnd))}
          </dd>
        </dl>
        <label className="timer-unsupported">
          <input
            type="checkbox"
            checked={snapshot.timerControl === true && pauseOnLock}
            disabled={pending || !snapshot.timerControl}
            onChange={(event) => {
              setPauseOnLock(event.target.checked);
              void save({ pauseOnLock: event.target.checked });
            }}
          />
          Пауза при блокировке компьютера
        </label>
        <label className="timer-unsupported">
          <input
            type="checkbox"
            checked={snapshot.timerControl === true && askOnUnlock}
            disabled={pending || !snapshot.timerControl}
            onChange={(event) => {
              setAskOnUnlock(event.target.checked);
              void save({ askOnUnlock: event.target.checked });
            }}
          />
          Спросить «Продолжить?» после разблокировки
        </label>
        <p>
          {snapshot.timerControl
            ? 'Команда паузы сохраняется до отправки. После подтверждённой паузы и свежей проверки приложение предлагает продолжить или закончить работу. Автоматического продолжения нет.'
            : 'Без подтверждённого договора сервера приложение показывает предупреждение о времени отсутствия.'}
        </p>
      </div>
    </details>
  );
}
