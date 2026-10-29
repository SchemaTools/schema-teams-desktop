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
  async function save() {
    if (flight.current) return;
    flight.current = true;
    setPending(true);
    setFeedback('');
    const result = await request({
      kind: 'timer.preferences',
      epoch: snapshot.epoch,
      reminderTime: time,
    });
    if (!mounted.current) return;
    flight.current = false;
    setPending(false);
    setFeedback(result.ok ? 'Время напоминания сохранено на этом компьютере.' : result.error);
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
            {workdayEnd === undefined ? 'Не удалось получить с сервера' : minuteClock(workdayEnd)}
          </dd>
        </dl>
        <label className="timer-unsupported">
          <input type="checkbox" checked={false} disabled readOnly />
          Пауза при блокировке компьютера
        </label>
        <label className="timer-unsupported">
          <input type="checkbox" checked={false} disabled readOnly />
          Спросить «Продолжить?» после разблокировки
        </label>
        <p>
          Эти два действия станут доступны после обновления сервера. Сейчас приложение показывает
          предупреждение о времени отсутствия.
        </p>
      </div>
    </details>
  );
}
