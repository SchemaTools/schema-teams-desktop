import { elapsedAt, timerClock, type WorkTimer } from '../../shared/time';

/** Предел подсказки значка трея Windows (NOTIFYICONDATA.szTip — 128 символов с нулём). */
export const TRAY_TOOLTIP_LIMIT = 127;

export interface TrayTooltipState {
  online: boolean;
  signedIn: boolean;
  unread: number;
  timer: WorkTimer | null;
  timerObservedAt?: number;
  focusUntil: string | null;
  now?: number;
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

/**
 * Подсказка значка по ТЗ 4.1: 2–4 строки — непрочитанное (или «Нет связи»), таймер
 * «▶ АР1 · 1:12», «Фокус до 15:00». Не длиннее 127 символов: укорачивается название задачи.
 */
export function trayTooltip(state: TrayTooltipState): string {
  const now = state.now ?? Date.now();
  const head = 'Schema Teams';
  if (!state.online) return `${head}\nНет связи`;
  if (!state.signedIn) return `${head}\nВойдите в Schema Teams`;
  const lines = [head, state.unread > 0 ? `Непрочитанных: ${state.unread}` : 'Нет непрочитанных'];
  const focus = state.focusUntil ? Date.parse(state.focusUntil) : NaN;
  const focusLine =
    Number.isFinite(focus) && focus > now
      ? `Фокус до ${new Date(focus).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
      : null;
  let timerLine: { prefix: string; label: string; suffix: string } | null = null;
  if (state.timer) {
    const seconds =
      state.timerObservedAt !== undefined ? elapsedAt(state.timer, state.timerObservedAt, now) : 0;
    const task = state.timer.task;
    timerLine = {
      prefix: state.timer.state === 'run' ? '▶ ' : '⏸ ',
      // Как в ТЗ: «▶ АР1 · 1:12» — марка, без марки — название задачи.
      label: (task.mark.trim() || task.title).replace(/\s+/g, ' ').trim(),
      suffix: ` · ${timerClock(seconds)}`,
    };
  }
  const fixed =
    lines.join('\n').length +
    (focusLine ? focusLine.length + 1 : 0) +
    (timerLine ? timerLine.prefix.length + timerLine.suffix.length + 1 : 0);
  if (timerLine)
    lines.push(
      `${timerLine.prefix}${clip(timerLine.label, Math.max(1, TRAY_TOOLTIP_LIMIT - fixed))}${timerLine.suffix}`,
    );
  if (focusLine) lines.push(focusLine);
  return clip(lines.join('\n'), TRAY_TOOLTIP_LIMIT);
}
