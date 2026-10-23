import type { DesktopEvents, DesktopTimer } from '../../bridge/protocol';
import { S } from '../strings';

export interface DesktopState {
  user: DesktopEvents['hello']['user'] | null;
  serverVersion: string;
  ready: boolean;
  online: boolean;
  chat: number;
  notifications: number;
  focusUntil: string | null;
  timer: DesktopTimer;
  timerReceivedAt: number;
}
export function initialState(): DesktopState {
  return {
    user: null,
    serverVersion: '',
    ready: false,
    online: false,
    chat: 0,
    notifications: 0,
    focusUntil: null,
    timer: { state: 'idle', task: null, startedAt: null, elapsedSec: 0, reason: null },
    timerReceivedAt: Date.now(),
  };
}
export function elapsed(state: DesktopState, now = Date.now()): number {
  return (
    state.timer.elapsedSec +
    (state.timer.state === 'run'
      ? Math.max(0, Math.floor((now - state.timerReceivedAt) / 1000))
      : 0)
  );
}
export function hoursMinutes(seconds: number): string {
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}`;
}
export function focusOn(state: DesktopState, now = Date.now()): boolean {
  return state.focusUntil !== null && Date.parse(state.focusUntil) > now;
}
export function tooltip(state: DesktopState): string {
  const lines = [state.user ? S.desktopUnread(state.chat + state.notifications) : S.desktopSignIn];
  if (state.timer.task)
    lines.push(
      `${state.timer.state === 'run' ? '▶' : 'Ⅱ'} ${state.timer.task.mark ?? state.timer.task.title} · ${hoursMinutes(elapsed(state))}`,
    );
  if (focusOn(state))
    lines.push(
      S.desktopFocusUntil(
        new Date(state.focusUntil ?? '').toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      ),
    );
  if (!state.ready || !state.online) lines.push(S.desktopNoConnection);
  return lines.join('\n');
}
