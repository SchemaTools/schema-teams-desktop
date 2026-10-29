import { describe, expect, it } from 'vitest';
import { TimerAbsence } from '../../src/main/timer/absence';
import { timerFixture } from '../fixtures/time';
const state = (owner = 1) => ({
  user: { id: owner, shortName: 'Тест', mustChangePassword: false },
  timer: timerFixture(),
});
describe('TimerAbsence: passive warnings, no timer commands', () => {
  it('keeps the first departure and waits until both lock and sleep ended', () => {
    const a = new TimerAbsence(),
      s = state();
    a.depart('lock', s, 1000);
    a.depart('suspend', s, 2000);
    a.return('unlock', s, 3000);
    expect(a.warning).toBeNull();
    a.return('resume', s, 4000);
    expect(a.warning).toEqual({ id: 1, owner: 1, from: 1000, to: 4000 });
  });
  it('retains unreviewed earlier absence and never changes input', () => {
    const a = new TimerAbsence(),
      s = state(),
      copy = structuredClone(s);
    a.depart('lock', s, 1000);
    a.return('unlock', s, 2000);
    a.depart('lock', s, 3000);
    a.return('unlock', s, 4000);
    expect(a.warning?.from).toBe(1000);
    expect(s).toEqual(copy);
  });
  it('does not carry another owner interval or warning', () => {
    const a = new TimerAbsence();
    a.depart('lock', state(1), 1000);
    a.return('unlock', state(2), 2000);
    expect(a.warning).toBeNull();
    a.depart('lock', state(2), 3000);
    a.return('unlock', state(2), 4000);
    a.observe({ user: null, timer: null });
    expect(a.warning).toBeNull();
  });
  it('reset clears owner data while preserving OS lock flags', () => {
    const a = new TimerAbsence();
    a.depart('lock', state(), 1000);
    a.reset();
    expect(a.away).toBe(true);
    a.observe(state(2), 2000);
    a.return('unlock', state(2), 3000);
    expect(a.warning).toMatchObject({ owner: 2, from: 2000, to: 3000 });
  });
  it('no warning for idle/pause; clock going backwards never gives negative range', () => {
    const a = new TimerAbsence();
    a.depart('lock', { ...state(), timer: null }, 1000);
    a.return('unlock', state(), 2000);
    expect(a.warning).toBeNull();
    a.depart('lock', { ...state(), timer: timerFixture('pause') }, 3000);
    a.return('unlock', state(), 4000);
    expect(a.warning).toBeNull();
    a.depart('lock', state(), 6000);
    a.return('unlock', state(), 5000);
    expect(a.warning).toMatchObject({ from: 6000, to: 6000 });
  });
  it('dismiss is explicit and cannot mutate a returned copy', () => {
    const a = new TimerAbsence();
    a.depart('lock', state(), 1000);
    a.return('unlock', state(), 2000);
    const copy = a.warning;
    if (copy) Object.assign(copy, { from: 0 });
    expect(a.warning?.from).toBe(1000);
    a.dismiss();
    expect(a.warning).toBeNull();
  });
});
