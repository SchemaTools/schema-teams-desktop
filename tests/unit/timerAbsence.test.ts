import { describe, expect, it } from 'vitest';
import { initialState, type DesktopState } from '../../src/main/desktop/state';
import { TimerAbsence } from '../../src/main/timer/absence';

function running(owner = 1): DesktopState {
  return {
    ...initialState(),
    user: { id: owner, shortName: 'Тест' },
    ready: true,
    online: true,
    timer: {
      state: 'run',
      task: { id: 4, mark: 'АР1', title: 'Задача А' },
      startedAt: '2026-10-28T04:00:00Z',
      elapsedSec: 120,
      reason: null,
    },
  };
}

describe('TimerAbsence', () => {
  it('изначально не считает компьютер отсутствующим и не создаёт предупреждения', () => {
    const absence = new TimerAbsence();
    absence.observe(running(), 1000);
    expect(absence.away).toBe(false);
    expect(absence.warning).toBeNull();
  });

  it('сохраняет время первой блокировки и предупреждает только после возвращения', () => {
    const absence = new TimerAbsence();
    const state = running();
    absence.depart('lock', state, 1000);
    absence.depart('lock', state, 2000);
    expect(absence.away).toBe(true);
    expect(absence.warning).toBeNull();
    absence.return('unlock', state, 3000);
    expect(absence.away).toBe(false);
    expect(absence.warning).toEqual({ id: 1, owner: 1, from: 1000, to: 3000 });
    absence.return('unlock', state, 4000);
    expect(absence.warning?.id).toBe(1);
  });

  it.each([
    ['unlock', 'resume'],
    ['resume', 'unlock'],
  ] as const)('объединяет lock/suspend и ждёт оба события %s, %s', (first, second) => {
    const absence = new TimerAbsence();
    const state = running();
    absence.depart('lock', state, 1000);
    absence.depart('suspend', state, 2000);
    absence.return(first, state, 3000);
    expect(absence.away).toBe(true);
    expect(absence.warning).toBeNull();
    absence.return(second, state, 4000);
    expect(absence.away).toBe(false);
    expect(absence.warning).toEqual({ id: 1, owner: 1, from: 1000, to: 4000 });
  });

  it('resume не снимает отдельную блокировку, unlock не снимает сон', () => {
    const absence = new TimerAbsence();
    const state = running();
    absence.depart('lock', state, 1000);
    absence.return('resume', state, 2000);
    expect(absence.away).toBe(true);
    absence.return('unlock', state, 3000);
    absence.dismiss();
    absence.depart('suspend', state, 4000);
    absence.return('unlock', state, 5000);
    expect(absence.away).toBe(true);
    absence.return('resume', state, 6000);
    expect(absence.warning).toEqual({ id: 2, owner: 1, from: 4000, to: 6000 });
  });

  it('учитывает известный run без связи, не меняя входное состояние таймера', () => {
    const absence = new TimerAbsence();
    const state = running();
    state.online = false;
    const before = structuredClone(state);
    absence.depart('lock', state, 1000);
    absence.return('unlock', state, 3000);
    expect(absence.warning).toEqual({ id: 1, owner: 1, from: 1000, to: 3000 });
    expect(state).toEqual(before);
  });

  it.each(['pause', 'idle'] as const)('не захватывает период при исходном %s', (mode) => {
    const absence = new TimerAbsence();
    const state = running();
    state.timer.state = mode;
    absence.depart('lock', state, 1000);
    state.timer.state = 'run';
    absence.return('unlock', state, 3000);
    expect(absence.warning).toBeNull();
  });

  it('обнаруженный во время отсутствия run отсчитывает только с observe', () => {
    const absence = new TimerAbsence();
    const state = running();
    state.timer.state = 'pause';
    absence.depart('lock', state, 1000);
    state.timer.state = 'run';
    absence.observe(state, 2000);
    absence.return('unlock', state, 3000);
    expect(absence.warning?.from).toBe(2000);
  });

  it('не переносит время до входа на появившегося позже пользователя', () => {
    const absence = new TimerAbsence();
    absence.depart('lock', initialState(), 1000);
    absence.observe(running(), 2000);
    absence.return('unlock', running(), 3000);
    expect(absence.warning).toEqual({ id: 1, owner: 1, from: 2000, to: 3000 });
  });

  it('смена владельца во время отсутствия начинает новый период временем обнаружения', () => {
    const absence = new TimerAbsence();
    absence.depart('lock', running(1), 1000);
    absence.observe(running(2), 2000);
    absence.return('unlock', running(2), 3000);
    expect(absence.warning).toEqual({ id: 1, owner: 2, from: 2000, to: 3000 });
  });

  it('выход/неподтверждённый вход удаляет прежние периоды и предупреждения', () => {
    const absence = new TimerAbsence();
    absence.depart('lock', running(), 1000);
    absence.return('unlock', running(), 2000);
    absence.observe(initialState(), 3000);
    expect(absence.warning).toBeNull();
    absence.depart('lock', running(), 4000);
    const unready = running();
    unready.ready = false;
    absence.observe(unready, 5000);
    absence.return('unlock', running(), 6000);
    expect(absence.warning).toBeNull();
  });

  it('смена владельца при возвращении не создаёт предупреждение от прежнего входа', () => {
    const absence = new TimerAbsence();
    absence.depart('lock', running(1), 1000);
    absence.return('unlock', running(2), 3000);
    expect(absence.warning).toBeNull();
  });

  it('reset не снимает ОС-флаги и новое наблюдение не использует старое время', () => {
    const absence = new TimerAbsence();
    const state = running();
    absence.depart('lock', state, 1000);
    absence.depart('suspend', state, 1500);
    absence.reset();
    expect(absence.away).toBe(true);
    absence.observe(state, 2000);
    absence.return('resume', state, 3000);
    expect(absence.away).toBe(true);
    absence.return('unlock', state, 4000);
    expect(absence.warning).toEqual({ id: 1, owner: 1, from: 2000, to: 4000 });
  });

  it('уже созданное предупреждение сохраняется после pause/idle и нового run', () => {
    const absence = new TimerAbsence();
    const state = running();
    absence.depart('lock', state, 1000);
    absence.return('unlock', state, 2000);
    for (const mode of ['pause', 'idle', 'run'] as const) {
      state.timer.state = mode;
      absence.observe(state, 3000);
      expect(absence.warning).toEqual({ id: 1, owner: 1, from: 1000, to: 2000 });
    }
  });

  it('новое отсутствие не теряет начало непроверенного периода', () => {
    const absence = new TimerAbsence();
    const state = running();
    absence.depart('lock', state, 1000);
    absence.return('unlock', state, 2000);
    absence.depart('suspend', state, 3000);
    expect(absence.warning).toEqual({ id: 1, owner: 1, from: 1000, to: 2000 });
    absence.return('resume', state, 4000);
    expect(absence.warning).toEqual({ id: 2, owner: 1, from: 1000, to: 4000 });
  });

  it('dismiss/reset очищают предупреждение, но не переиспользуют его id', () => {
    const absence = new TimerAbsence();
    const state = running();
    absence.depart('lock', state, 1000);
    absence.return('unlock', state, 2000);
    absence.dismiss();
    expect(absence.warning).toBeNull();
    absence.depart('lock', state, 3000);
    absence.return('unlock', state, 4000);
    expect(absence.warning).toEqual({ id: 2, owner: 1, from: 3000, to: 4000 });
    absence.reset();
    expect(absence.warning).toBeNull();
    absence.depart('lock', state, 5000);
    absence.return('unlock', state, 6000);
    expect(absence.warning?.id).toBe(3);
  });

  it('перевод часов назад не создаёт отрицательный интервал', () => {
    const absence = new TimerAbsence();
    const state = running();
    absence.depart('lock', state, 3000);
    absence.return('unlock', state, 1000);
    expect(absence.warning).toEqual({ id: 1, owner: 1, from: 3000, to: 3000 });
  });

  it('изменение копии warning не меняет внутреннее предупреждение', () => {
    const absence = new TimerAbsence();
    const state = running();
    absence.depart('lock', state, 1000);
    absence.return('unlock', state, 2000);
    const copy = absence.warning;
    if (copy) Object.assign(copy, { owner: 9, from: 0 });
    expect(absence.warning).toEqual({ id: 1, owner: 1, from: 1000, to: 2000 });
  });
});
