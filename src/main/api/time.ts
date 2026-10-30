import {
  isoDay,
  isoInstant,
  positiveId,
  timerRowsValid,
  type TimeOptions,
  type TimeTask,
  type WorkTimer,
  type TimerProposal,
  type TimerExpected,
  type TimerRowsCheck,
  expectedValid,
  utcInstant,
} from '../../shared/time';
import { InvalidData, object } from './parse';
const text = (v: unknown, max = 4000) => {
  if (typeof v !== 'string' || v.length > max) throw new InvalidData();
  return v;
};
const instant = (v: unknown) => {
  if (!isoInstant(v)) throw new InvalidData();
  return v;
};
const day = (v: unknown) => {
  if (!isoDay(v)) throw new InvalidData();
  return v;
};
const id = (v: unknown) => {
  if (!positiveId(v)) throw new InvalidData();
  return v;
};
const minute = (v: unknown) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1440) throw new InvalidData();
  return v;
};
export function timeTask(raw: unknown): TimeTask {
  const x = object(raw);
  if (!['album', 'subtask', 'personal'].includes(String(x.kind))) throw new InvalidData();
  return {
    id: id(x.id),
    kind: x.kind as TimeTask['kind'],
    albumId: id(x.albumId),
    mark: text(x.mark, 1000),
    title: text(x.title),
    place: text(x.place),
  };
}
export function timeOptions(raw: unknown): TimeOptions {
  const x = object(raw),
    w = object(x.workday);
  if (!Array.isArray(x.tasks) || x.tasks.length > 10000) throw new InvalidData();
  const tasks = x.tasks.map(timeTask);
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new InvalidData();
  const workday = {
    start: minute(w.start),
    end: minute(w.end),
    lunchStart: minute(w.lunchStart),
    lunchEnd: minute(w.lunchEnd),
  };
  if (workday.start >= workday.end || workday.lunchStart > workday.lunchEnd)
    throw new InvalidData();
  return { today: day(x.today), editableFrom: day(x.editableFrom), workday, tasks };
}
export function workTimer(raw: unknown): WorkTimer | null {
  const x = object(raw);
  if (x.timer === null) return null;
  const t = object(x.timer);
  if (
    !['run', 'pause'].includes(String(t.state)) ||
    ![null, 'lock', 'manual'].includes(t.pauseReason as string | null) ||
    !Array.isArray(t.segments) ||
    t.segments.length === 0 ||
    t.segments.length > 10000
  )
    throw new InvalidData();
  let previous = -Infinity;
  let open = 0;
  const sourceSegments = t.segments;
  const segments = sourceSegments.map((raw, i) => {
    const s = object(raw),
      from = instant(s.from),
      to = s.to === null ? null : instant(s.to);
    const start = Date.parse(from),
      end = to === null ? null : Date.parse(to);
    if (
      start < previous ||
      (end !== null && end < start) ||
      (to === null && i !== sourceSegments.length - 1)
    )
      throw new InvalidData();
    previous = end ?? start;
    if (to === null) open++;
    return { from, to };
  });
  if (open !== (t.state === 'run' ? 1 : 0)) throw new InvalidData();
  const startedAt = instant(t.startedAt);
  if (startedAt !== segments[0]?.from) throw new InvalidData();
  return {
    version: id(t.version),
    state: t.state as WorkTimer['state'],
    pauseReason: t.pauseReason as WorkTimer['pauseReason'],
    task: timeTask(t.task),
    segments,
    startedAt,
    updatedAt: instant(t.updatedAt),
    serverNow: instant(t.serverNow),
  };
}
/** Flat CAS fields must agree with the historical timer, not just be present. */
export function controlledTimer(raw: unknown): WorkTimer | null {
  const x = object(raw),
    timer = workTimer(raw);
  if (!utcInstant(x.serverNow)) throw new InvalidData();
  if (!timer) {
    if (
      x.state !== 'idle' ||
      x.timerId !== null ||
      x.revision !== null ||
      x.currentSegment !== null ||
      x.pausedAt !== null ||
      x.task !== null ||
      x.startedAt !== null ||
      x.elapsedSec !== 0 ||
      x.reason !== null
    )
      throw new InvalidData();
    return null;
  }
  const current = x.currentSegment === null ? null : instant(object(x.currentSegment).from);
  if (
    !positiveId(x.timerId) ||
    x.revision !== timer.version ||
    x.state !== timer.state ||
    x.startedAt !== timer.startedAt ||
    object(x.task).id !== timer.task.id ||
    x.reason !== timer.pauseReason ||
    !Number.isSafeInteger(x.elapsedSec) ||
    Number(x.elapsedSec) < 0 ||
    current !== (timer.state === 'run' ? timer.segments.at(-1)?.from : null) ||
    x.pausedAt !== (timer.state === 'pause' ? timer.segments.at(-1)?.to : null)
  )
    throw new InvalidData();
  return { ...timer, timerId: x.timerId, serverNow: instant(x.serverNow) };
}
const problems = (raw: unknown): TimerRowsCheck['problems'] => {
  if (!Array.isArray(raw) || raw.length > 100) throw new InvalidData();
  return raw.map((entry) => {
    const x = object(entry);
    if (
      !Number.isSafeInteger(x.row) ||
      Number(x.row) < 0 ||
      Number(x.row) >= 20 ||
      !['date', 'from', 'to', 'taskId'].includes(String(x.field))
    )
      throw new InvalidData();
    // Server messages may contain task details; use bounded local field text.
    return {
      row: Number(x.row),
      field: x.field as TimerRowsCheck['problems'][number]['field'],
      message: 'Проверьте дату, задачу и пересечения интервала.',
    };
  });
};
export function preparedTimer(raw: unknown, current: WorkTimer) {
  const x = object(raw);
  if (
    typeof x.requestId !== 'string' ||
    !/^[A-Za-z0-9._:-]{8,100}$/.test(x.requestId) ||
    !expectedValid(x.expected)
  )
    throw new InvalidData();
  return {
    current,
    proposal: timerProposal(raw),
    requestId: x.requestId,
    expected: x.expected as TimerExpected,
    cutoffAt: instant(x.cutoffAt),
    expiresAt: instant(x.expiresAt),
    serverNow: instant(x.serverNow),
    problems: problems(x.problems),
  };
}
export function rowsCheck(raw: unknown): TimerRowsCheck {
  const x = object(raw);
  if (
    typeof x.ok !== 'boolean' ||
    typeof x.hours !== 'number' ||
    !Number.isFinite(x.hours) ||
    x.hours < 0 ||
    x.hours > 480
  )
    throw new InvalidData();
  const errors = problems(x.problems);
  if (x.ok !== (errors.length === 0)) throw new InvalidData();
  return { ok: x.ok, hours: x.hours, problems: errors };
}
export function timerProposal(raw: unknown): TimerProposal {
  const x = object(raw);
  if (
    !Array.isArray(x.segments) ||
    x.segments.length === 0 ||
    x.segments.length > 10000 ||
    typeof x.elapsedSec !== 'number' ||
    !Number.isSafeInteger(x.elapsedSec) ||
    x.elapsedSec < 0 ||
    !Array.isArray(x.rows) ||
    x.rows.length > 20 ||
    (x.rows.length > 0 && !timerRowsValid(x.rows))
  )
    throw new InvalidData();
  const task = timeTask(x.task);
  const rows = x.rows as TimerProposal['rows'];
  if (rows.some((r) => r.taskId !== task.id)) throw new InvalidData();
  return {
    task,
    segments: x.segments.map((raw) => {
      const s = object(raw),
        from = instant(s.from),
        to = instant(s.to);
      if (Date.parse(to) < Date.parse(from)) throw new InvalidData();
      return { from, to };
    }),
    elapsedSec: x.elapsedSec,
    rows: rows.map((r) => ({ ...r })),
    today: day(x.today),
  };
}
