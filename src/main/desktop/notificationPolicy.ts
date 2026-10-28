// Версионированный ответ собственного helper. Неизвестный результат запрещает показ.
export interface NotificationState {
  v: 1;
  shell: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  focus: 0 | 1 | 2;
}

export function parseNotificationState(stdout: string): NotificationState | null {
  if (stdout.length > 256) return null;
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.v !== 1 ||
    ![1, 2, 3, 4, 5, 6, 7].includes(record.shell as number) ||
    ![0, 1, 2].includes(record.focus as number)
  )
    return null;
  return {
    v: 1,
    shell: record.shell as NotificationState['shell'],
    focus: record.focus as NotificationState['focus'],
  };
}

export function notificationStateAllowed(state: NotificationState | null): boolean {
  return state !== null && state.v === 1 && state.shell === 5 && state.focus === 0;
}
