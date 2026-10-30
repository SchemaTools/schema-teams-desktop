import type { TimeOptions, TimeTask, TimerProposal, WorkTimer } from '../../src/shared/time';
export const timeTasks: [TimeTask, TimeTask, TimeTask] = [
  {
    id: 21,
    kind: 'album',
    albumId: 21,
    mark: 'АР',
    title: 'План первого этажа',
    place: 'Объект А · Р',
  },
  { id: 22, kind: 'subtask', albumId: 21, mark: 'АР', title: 'Узлы фасада', place: 'Объект А · Р' },
  { id: 23, kind: 'personal', albumId: 23, mark: '', title: 'Обучение', place: '' },
];
export const optionsFixture = (): TimeOptions => ({
  today: '2026-10-29',
  editableFrom: '2026-09-29',
  workday: { start: 480, end: 1080, lunchStart: 720, lunchEnd: 780 },
  tasks: structuredClone(timeTasks),
});
export const timerFixture = (state: 'run' | 'pause' = 'run', taskId = 21): WorkTimer => ({
  timerId: 71,
  version: state === 'run' ? 1 : 2,
  state,
  pauseReason: state === 'run' ? null : 'manual',
  task: structuredClone(timeTasks.find((t) => t.id === taskId) ?? timeTasks[0]),
  segments: [
    { from: '2026-10-29T04:00:00.000Z', to: state === 'run' ? null : '2026-10-29T04:40:00.000Z' },
  ],
  startedAt: '2026-10-29T04:00:00.000Z',
  updatedAt: '2026-10-29T04:40:00.000Z',
  serverNow: '2026-10-29T04:40:00.000Z',
});
export const proposalFixture = (taskId = 21): TimerProposal => ({
  task: structuredClone(timeTasks.find((t) => t.id === taskId) ?? timeTasks[0]),
  segments: [{ from: '2026-10-29T04:00:00.000Z', to: '2026-10-29T04:40:00.000Z' }],
  elapsedSec: 2400,
  rows: [{ taskId, date: '2026-10-29', from: 540, to: 570 }],
  today: '2026-10-29',
});

export const timerPushFixture = (
  timer: WorkTimer | null,
  now = timer?.serverNow ?? '2026-10-29T04:40:00.000Z',
) => ({
  timer,
  state: timer?.state ?? 'idle',
  task: timer
    ? { id: timer.task.id, mark: timer.task.mark || null, title: timer.task.title }
    : null,
  startedAt: timer?.startedAt ?? null,
  elapsedSec: timer
    ? timer.segments.reduce(
        (sum, segment) =>
          sum + Math.floor((Date.parse(segment.to ?? now) - Date.parse(segment.from)) / 1000),
        0,
      )
    : 0,
  reason: timer?.pauseReason ?? null,
  timerId: timer?.timerId ?? (timer ? 71 : null),
  revision: timer?.version ?? null,
  currentSegment: timer?.state === 'run' ? { from: required(timer.segments.at(-1)).from } : null,
  pausedAt: timer?.state === 'pause' ? required(timer.segments.at(-1)).to : null,
  serverNow: now,
});
export const configFixture = () => ({
  bureau: { timeZone: 'Asia/Yekaterinburg', workEnd: '18:00' },
  serverNow: '2026-10-29T04:40:00.000Z',
  supportChatId: null,
  capabilities: { timerControl: 2 },
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error('Missing fixture value');
  return value;
}
