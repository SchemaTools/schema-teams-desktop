// Read-only DTO projections of Schema Teams 0.11.2-b time.ts / time-timer.ts.
export interface TimeTask {
  id: number;
  kind: 'album' | 'subtask' | 'personal';
  albumId: number;
  mark: string;
  title: string;
  place: string;
}
export interface WorkTimer {
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
  version: number;
  taskId: number;
  startedAt: string;
}
export interface TimeOptions {
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
export function expectedValid(raw: unknown): raw is TimerExpected {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const v = raw as Record<string, unknown>;
  return (
    Object.keys(v).length === 3 &&
    positiveId(v.version) &&
    positiveId(v.taskId) &&
    isoInstant(v.startedAt)
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
  version: timer.version,
  taskId: timer.task.id,
  startedAt: timer.startedAt,
});
export const matchesTimer = (timer: WorkTimer | null, expected: TimerExpected | null): boolean =>
  timer === null
    ? expected === null
    : expected !== null &&
      timer.version === expected.version &&
      timer.task.id === expected.taskId &&
      timer.startedAt === expected.startedAt;
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
