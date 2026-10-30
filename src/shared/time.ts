// Read-only DTO projections of Schema Teams 0.12.1-b time.ts / time-timer.ts.
export interface TimeTask {
  id: number;
  kind: 'album' | 'subtask' | 'personal';
  albumId: number;
  mark: string;
  title: string;
  place: string;
}
export interface WorkTimer {
  timerId?: number;
  version: number;
  state: 'run' | 'pause';
  pauseReason: 'lock' | 'manual' | null;
  task: TimeTask;
  segments: { from: string; to: string | null }[];
  startedAt: string;
  updatedAt: string;
  serverNow: string;
}
export interface TimerExpected {
  timerId: number;
  revision: number;
  currentSegmentFrom: string | null;
}
export interface TimeOptions {
  recentTaskIds?: number[];
  today: string;
  editableFrom: string;
  workday: { start: number; end: number; lunchStart: number; lunchEnd: number };
  tasks: TimeTask[];
}
export interface TimerRow {
  taskId: number;
  date: string;
  from: number;
  to: number;
}
export interface TimerProposal {
  task: TimeTask;
  segments: { from: string; to: string }[];
  elapsedSec: number;
  rows: TimerRow[];
  today: string;
}
export interface TimerPrepared {
  current: WorkTimer;
  proposal: TimerProposal;
  requestId: string;
  expected: TimerExpected;
  cutoffAt: string;
  expiresAt: string;
  serverNow: string;
  problems: TimerRowProblem[];
}
export interface TimerRowProblem {
  row: number;
  field: 'date' | 'from' | 'to' | 'taskId';
  message: string;
}
export interface TimerRowsCheck {
  ok: boolean;
  problems: TimerRowProblem[];
  hours: number;
}
export const positiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export const isoDay = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export const isoInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 64 &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));
export const utcInstant = (value: unknown): value is string =>
  isoInstant(value) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  new Date(value).toISOString() === value;
export function expectedValid(raw: unknown): raw is TimerExpected {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const v = raw as Record<string, unknown>;
  return (
    Object.keys(v).length === 3 &&
    positiveId(v.timerId) &&
    positiveId(v.revision) &&
    (v.currentSegmentFrom === null || isoInstant(v.currentSegmentFrom))
  );
}
export function timerRowsValid(raw: unknown): raw is TimerRow[] {
  return (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.length <= 20 &&
    raw.every((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      const v = value as Record<string, unknown>;
      return (
        Object.keys(v).length === 4 &&
        positiveId(v.taskId) &&
        isoDay(v.date) &&
        typeof v.from === 'number' &&
        typeof v.to === 'number' &&
        Number.isSafeInteger(v.from) &&
        Number.isSafeInteger(v.to) &&
        v.from >= 0 &&
        v.to <= 1440 &&
        v.from < v.to &&
        v.from % 30 === 0 &&
        v.to % 30 === 0
      );
    })
  );
}
export const timerExpected = (timer: WorkTimer): TimerExpected => ({
  timerId: timer.timerId ?? 0,
  revision: timer.version,
  currentSegmentFrom: timer.state === 'run' ? (timer.segments.at(-1)?.from ?? null) : null,
});
export const matchesTimer = (timer: WorkTimer | null, expected: TimerExpected | null): boolean =>
  timer === null
    ? expected === null
    : expected !== null &&
      timer.timerId === expected.timerId &&
      timer.version === expected.revision &&
      (timer.state === 'run' ? (timer.segments.at(-1)?.from ?? null) : null) ===
        expected.currentSegmentFrom;
export function elapsedAt(timer: WorkTimer, observedAt: number, now = Date.now()): number {
  const serverNow = Date.parse(timer.serverNow) + Math.max(0, now - observedAt);
  let ms = 0;
  for (const segment of timer.segments)
    ms += Math.max(
      0,
      (segment.to === null ? serverNow : Date.parse(segment.to)) - Date.parse(segment.from),
    );
  return Math.floor(ms / 1000);
}
export const timerClock = (seconds: number) => {
  const m = Math.max(0, Math.floor(seconds / 60));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
export const minuteClock = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
