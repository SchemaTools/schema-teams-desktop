import { describe, expect, it, vi } from 'vitest';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import { timeOptions, workTimer, timerProposal } from '../../src/main/api/time';
import {
  elapsedAt,
  minuteClock,
  timerClock,
  timerExpected,
  timerRowsValid,
} from '../../src/shared/time';
import { requestValid } from '../../src/shared/requests';
import { normalizeSettings } from '../../src/main/settings';
import { optionsFixture, timerFixture, proposalFixture, timeTasks } from '../fixtures/time';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (id = 1) => ({
  user: { id, shortName: 'Тест', mustChangePassword: false },
  csrfToken: 'fixture-csrf',
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function setup() {
  const fetch = vi.fn<TeamsApiOptions['fetch']>().mockResolvedValueOnce(json(me()));
  const api = new TeamsApi({ fetch });
  await api.authenticate();
  return { api, fetch };
}
describe('Native timer: server DTOs and display', () => {
  it('projects only timer fields and accepts idle', () => {
    expect(workTimer({ timer: null })).toBeNull();
    expect(workTimer({ timer: { ...timerFixture(), secret: 'discard' } })).toEqual(timerFixture());
    expect(timeOptions({ ...optionsFixture(), token: 'discard' })).toEqual(optionsFixture());
    expect(timerProposal(proposalFixture())).toEqual(proposalFixture());
  });
  it.each([
    { state: 'other' },
    { version: 0 },
    { startedAt: '2026-10-29T03:00:00Z' },
    { segments: [] },
    { segments: [{ from: '2026-10-29T04:00:00.000Z', to: '2026-10-29T03:00:00Z' }] },
    { state: 'pause' },
    {
      segments: [
        { from: '2026-10-29T04:00:00.000Z', to: null },
        { from: '2026-10-29T05:00:00Z', to: null },
      ],
    },
  ])('rejects malformed timer %j', (patch) =>
    expect(() => workTimer({ timer: { ...timerFixture(), ...patch } })).toThrow(),
  );
  it('rejects duplicate tasks, invalid days and rows of another task', () => {
    const options = optionsFixture();
    options.tasks.push(timeTasks[0]);
    expect(() => timeOptions(options)).toThrow();
    expect(() => timeOptions({ ...optionsFixture(), today: '2026-02-30' })).toThrow();
    expect(() =>
      timerProposal({ ...proposalFixture(), rows: [{ ...proposalFixture().rows[0], taskId: 22 }] }),
    ).toThrow();
    expect(timerProposal({ ...proposalFixture(), rows: [] })).toHaveProperty('rows', []);
  });
  it('uses server elapsed time and freezes pauses, handles 24:00', () => {
    expect(elapsedAt(timerFixture(), 1000, 61000)).toBe(2460);
    expect(elapsedAt(timerFixture('pause'), 1000, 999999)).toBe(2400);
    expect(elapsedAt(timerFixture(), 1000, 0)).toBe(2400);
    expect(timerClock(2400)).toBe('0:40');
    expect(minuteClock(1440)).toBe('24:00');
  });
  it('validates strict IPC, half-hours, row bounds and task binding', () => {
    const expected = timerExpected(timerFixture());
    const request = {
      kind: 'timer.finish',
      epoch: 1,
      expected,
      rows: proposalFixture().rows,
      note: 'Комментарий',
    };
    expect(requestValid(request)).toBe(true);
    for (const patch of [
      { url: 'https://example.test' },
      { expected: { ...expected, revision: 1 } },
      { rows: [] },
      { note: 'x'.repeat(501) },
      { epoch: -1 },
      { rows: [{ taskId: 22, date: '2026-10-29', from: 540, to: 570 }] },
    ])
      expect(requestValid({ ...request, ...patch })).toBe(false);
    expect(timerRowsValid([{ taskId: 21, date: '2026-10-29', from: 1410, to: 1440 }])).toBe(true);
    expect(timerRowsValid([{ taskId: 21, date: '2026-10-29', from: 540, to: 541 }])).toBe(false);
  });
  it('keeps only three recent IDs per owner, no labels, normalizes on reload', () => {
    const s = normalizeSettings({
      recentTimeTaskIds: { '1': [21, 21, 22, 23, 24, -1], '2': [7], bad: [1], '3': 'bad' },
    });
    expect(s.recentTimeTaskIds).toEqual({ '1': [21, 22, 23], '2': [7] });
    expect(normalizeSettings(s).recentTimeTaskIds).toEqual(s.recentTimeTaskIds);
  });
});
describe('TeamsApi: timer operations only with a fresh owner-bound preflight', () => {
  it('reads timer/options without mutation', async () => {
    const h = await setup();
    h.fetch
      .mockResolvedValueOnce(json({ timer: timerFixture() }))
      .mockResolvedValueOnce(json(optionsFixture()));
    expect(await h.api.timer()).toEqual({ ok: true, data: timerFixture() });
    expect(await h.api.timeOptions()).toEqual({ ok: true, data: optionsFixture() });
  });
  it('starts once after idle preflight, exact CSRF/body and result task', async () => {
    const h = await setup();
    h.fetch
      .mockResolvedValueOnce(json({ timer: null }))
      .mockResolvedValueOnce(json({ timer: timerFixture() }));
    expect(await h.api.timerStart(21, null)).toEqual({ ok: true, data: timerFixture() });
    expect(h.fetch.mock.calls.slice(1).map((c) => [c[0], c[1]?.method])).toEqual([
      ['/api/time/timer', 'GET'],
      ['/api/time/timer/start', 'POST'],
    ]);
    expect(h.fetch.mock.calls[2]?.[1]).toMatchObject({
      body: JSON.stringify({ taskId: 21 }),
      headers: { 'x-csrf-token': 'fixture-csrf' },
    });
  });
  it.each(['timerPause', 'timerResume', 'timerReset'] as const)(
    'rejects changed timer before %s mutation',
    async (method) => {
      const h = await setup();
      h.fetch.mockResolvedValueOnce(json({ timer: { ...timerFixture(), version: 9 } }));
      expect(await h.api[method](timerExpected(timerFixture()))).toMatchObject({
        ok: false,
        code: 'timer_changed',
      });
      expect(h.fetch).toHaveBeenCalledTimes(2);
    },
  );
  it('does not start another task over an active timer', async () => {
    const h = await setup();
    expect(await h.api.timerStart(22, timerExpected(timerFixture()))).toMatchObject({
      code: 'timer_running',
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it('serializes commands, rejects a duplicate while preflight is pending', async () => {
    const h = await setup(),
      wait = deferred<Response>();
    h.fetch
      .mockReturnValueOnce(wait.promise)
      .mockResolvedValueOnce(json({ timer: timerFixture('pause') }));
    const first = h.api.timerPause(timerExpected(timerFixture()));
    expect(await h.api.timerPause(timerExpected(timerFixture()))).toMatchObject({
      code: 'timer_busy',
    });
    wait.resolve(json({ timer: timerFixture() }));
    expect(await first).toMatchObject({ ok: true });
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it('does not mutate for an old owner after preflight', async () => {
    const h = await setup(),
      wait = deferred<Response>();
    h.fetch.mockReturnValueOnce(wait.promise);
    const first = h.api.timerPause(timerExpected(timerFixture()));
    h.api.clear();
    wait.resolve(json({ timer: timerFixture() }));
    expect(await first).toMatchObject({ code: 'stale_session' });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it('old command completion does not release the new owner mutex', async () => {
    const h = await setup(),
      old = deferred<Response>(),
      fresh = deferred<Response>();
    h.fetch.mockReturnValueOnce(old.promise);
    const first = h.api.timerStart(21, null);
    h.api.clear();
    h.fetch.mockResolvedValueOnce(json(me(2)));
    await h.api.authenticate();
    h.fetch
      .mockReturnValueOnce(fresh.promise)
      .mockResolvedValueOnce(json({ timer: timerFixture() }));
    const second = h.api.timerStart(21, null);
    old.resolve(json({ timer: null }));
    await first;
    expect(await h.api.timerStart(21, null)).toMatchObject({ code: 'timer_busy' });
    fresh.resolve(json({ timer: null }));
    expect(await second).toMatchObject({ ok: true });
  });
  it('prepares server proposal only if state is unchanged before and after GET', async () => {
    const h = await setup(),
      timer = timerFixture('pause');
    h.fetch
      .mockResolvedValueOnce(json({ timer }))
      .mockResolvedValueOnce(json(proposalFixture()))
      .mockResolvedValueOnce(json({ timer }));
    expect(await h.api.timerProposal(timerExpected(timer))).toEqual({
      ok: true,
      data: { current: timer, proposal: proposalFixture() },
    });
    h.fetch
      .mockResolvedValueOnce(json({ timer }))
      .mockResolvedValueOnce(json(proposalFixture()))
      .mockResolvedValueOnce(json({ timer: null }));
    expect(await h.api.timerProposal(timerExpected(timer))).toMatchObject({
      code: 'timer_changed',
    });
  });
  it('finishes with exact rows/note, no unsupported expected fields sent to legacy server', async () => {
    const h = await setup(),
      timer = timerFixture('pause');
    h.fetch.mockResolvedValueOnce(json({ timer })).mockResolvedValueOnce(json({ timer: null }));
    expect(
      await h.api.timerFinish(timerExpected(timer), proposalFixture().rows, '  запись  '),
    ).toEqual({ ok: true, data: null });
    expect(JSON.parse(String(h.fetch.mock.calls[2]?.[1]?.body))).toEqual({
      rows: proposalFixture().rows,
      note: 'запись',
    });
  });
  it('exposes safe row validation only on finish, never server message', async () => {
    const h = await setup(),
      timer = timerFixture('pause');
    h.fetch.mockResolvedValueOnce(json({ timer })).mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'validation',
            message: 'secret',
            row: 0,
            field: 'from',
            internal: 'secret',
          },
        },
        400,
      ),
    );
    const result = await h.api.timerFinish(timerExpected(timer), proposalFixture().rows, '');
    expect(result).toMatchObject({ ok: false, code: 'validation', row: 0, field: 'from' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('unconfirmed finish is uncertain and never retried', async () => {
    const h = await setup(),
      timer = timerFixture('pause');
    h.fetch
      .mockResolvedValueOnce(json({ timer }))
      .mockResolvedValueOnce(json({ error: { code: 'internal' } }, 500));
    expect(await h.api.timerFinish(timerExpected(timer), proposalFixture().rows, '')).toMatchObject(
      { ok: false, uncertain: true },
    );
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it('rejects impossible mutation responses as uncertain', async () => {
    const h = await setup();
    h.fetch
      .mockResolvedValueOnce(json({ timer: timerFixture() }))
      .mockResolvedValueOnce(json({ timer: timerFixture() }));
    expect(await h.api.timerPause(timerExpected(timerFixture()))).toMatchObject({
      code: 'invalid_data',
      uncertain: true,
    });
  });
});
