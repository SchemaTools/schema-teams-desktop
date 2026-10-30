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
import {
  optionsFixture,
  timerFixture,
  proposalFixture,
  timeTasks,
  timerPushFixture,
  configFixture,
} from '../fixtures/time';
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
async function setup(onTimerAudit?: TeamsApiOptions['onTimerAudit']) {
  const fetch = vi.fn<TeamsApiOptions['fetch']>().mockResolvedValueOnce(json(me()));
  const api = new TeamsApi({ fetch, onTimerAudit });
  await api.authenticate();
  fetch.mockResolvedValueOnce(json(configFixture()));
  await api.readDesktopConfig();
  fetch.mockClear();
  return { api, fetch };
}
describe('Native timer: server DTOs and display', () => {
  it('projects only timer fields and accepts idle', () => {
    expect(workTimer({ timer: null })).toBeNull();
    expect(workTimer({ timer: { ...timerFixture(), secret: 'discard' } })).toEqual(
      expect.objectContaining({ version: 1, state: 'run' }),
    );
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
      preparedRequestId: 'prepared-test',
    };
    expect(requestValid(request)).toBe(true);
    for (const patch of [
      { url: 'https://example.test' },
      { expected: { ...expected, revision: 0 } },
      { rows: [] },
      { note: 'x'.repeat(501) },
      { epoch: -1 },
      { preparedRequestId: undefined },
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

describe('TeamsApi 0.12.1 CAS and operation envelopes', () => {
  it('sends expected and idempotency key atomically without a racy preflight', async () => {
    const audit = vi.fn(),
      h = await setup(audit),
      expected = timerExpected(timerFixture());
    h.fetch.mockResolvedValueOnce(json(timerPushFixture(timerFixture('pause'))));
    expect((await h.api.timerPause(expected)).ok).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [path, init] = required(h.fetch.mock.calls[0]);
    expect(path).toBe('/api/time/timer/pause');
    expect(JSON.parse(String(init?.body))).toEqual({ expected, reason: 'manual' });
    expect(new Headers(init?.headers).get('idempotency-key')).toMatch(/^[a-f0-9-]{36}$/);
    expect(audit.mock.calls.map((c) => c[0].phase)).toEqual(['requested', 'result']);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/taskId|timerId|csrf|rows|note/);
  });
  it('retries unknown transport outcome with identical method/key/body, never a new operation', async () => {
    const h = await setup();
    h.fetch
      .mockRejectedValueOnce(Error('private socket'))
      .mockResolvedValueOnce(json(timerPushFixture(timerFixture('pause'))));
    expect((await h.api.timerPause(timerExpected(timerFixture()))).ok).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    const [first, second] = h.fetch.mock.calls;
    expect([
      required(first)[0],
      required(first)[1]?.method,
      required(first)[1]?.body,
      new Headers(required(first)[1]?.headers).get('idempotency-key'),
    ]).toEqual([
      required(second)[0],
      required(second)[1]?.method,
      required(second)[1]?.body,
      new Headers(required(second)[1]?.headers).get('idempotency-key'),
    ]);
  });
  it.each([
    [409, 'stale_timer'],
    [409, 'idempotency_conflict'],
    [428, 'precondition_required'],
    [400, 'invalid_event_time'],
    [403, 'csrf'],
    [403, 'forbidden'],
    [500, 'server_error'],
  ])('does not automatically retry %s %s', async (status, code) => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json({ error: { code } }, Number(status)));
    expect(await h.api.timerPause(timerExpected(timerFixture()))).toMatchObject({
      ok: false,
      code,
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it('an old pause for A remains bound to A after B exists on the server', async () => {
    const h = await setup(),
      expected = timerExpected(timerFixture());
    h.fetch.mockResolvedValueOnce(json({ error: { code: 'stale_timer' } }, 409));
    expect(
      await h.api.timerPause(expected, '2026-10-29T04:30:00.000Z', 'absence-operation-1'),
    ).toMatchObject({ code: 'stale_timer' });
    expect(JSON.parse(String(required(h.fetch.mock.calls[0])[1]?.body))).toEqual({
      expected,
      reason: 'lock',
      at: '2026-10-29T04:30:00.000Z',
    });
    expect(new Headers(required(h.fetch.mock.calls[0])[1]?.headers).get('idempotency-key')).toBe(
      'absence-operation-1',
    );
  });
  it('serializes parallel mutations and rejects late responses after logout', async () => {
    const h = await setup(),
      pending = deferred<Response>();
    h.fetch.mockReturnValueOnce(pending.promise);
    const first = h.api.timerPause(timerExpected(timerFixture()));
    expect(await h.api.timerReset(timerExpected(timerFixture()))).toMatchObject({
      code: 'timer_busy',
    });
    h.api.clear();
    pending.resolve(json(timerPushFixture(timerFixture('pause'))));
    expect(await first).toMatchObject({ code: 'stale_session' });
    expect(h.api.timerControl).toBe(false);
  });
  it('malformed CAS snapshots cannot enable writes', async () => {
    const h = await setup();
    h.fetch.mockResolvedValueOnce(json({ timer: timerFixture() }));
    expect(await h.api.timer()).toMatchObject({ code: 'invalid_data' });
    h.fetch.mockResolvedValueOnce(json({ ...timerPushFixture(timerFixture()), revision: 99 }));
    expect(await h.api.timer()).toMatchObject({ code: 'invalid_data' });
  });
  it('prepares without pause, validates exact rows and finishes with a new operation key', async () => {
    const h = await setup(),
      timer = timerFixture(),
      expected = timerExpected(timer);
    h.fetch
      .mockResolvedValueOnce(json(timerPushFixture(timer)))
      .mockImplementationOnce(async (_path, init) =>
        json({
          ...proposalFixture(),
          requestId: new Headers(init?.headers).get('idempotency-key'),
          expected,
          cutoffAt: timer.serverNow,
          expiresAt: '2026-10-29T05:00:00.000Z',
          serverNow: timer.serverNow,
          problems: [],
        }),
      );
    const preparation = await h.api.timerProposal(expected);
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) throw Error('preparation failed');
    const preparedId = preparation.data.requestId;
    const rows = proposalFixture().rows;
    expect(await h.api.timerFinish(expected, rows, '', preparedId)).toMatchObject({
      code: 'validation',
    });
    h.fetch.mockResolvedValueOnce(json({ ok: true, problems: [], hours: 0.5 }));
    expect(await h.api.timerValidateRows(preparedId, rows)).toMatchObject({
      ok: true,
      data: { ok: true },
    });
    expect(
      await h.api.timerFinish(expected, [{ ...required(rows[0]), to: 600 }], '', preparedId),
    ).toMatchObject({ code: 'validation' });
    h.fetch.mockResolvedValueOnce(json(timerPushFixture(null)));
    expect((await h.api.timerFinish(expected, rows, 'note', preparedId)).ok).toBe(true);
    expect(h.fetch.mock.calls.map((c) => c[0])).toEqual([
      '/api/time/timer',
      '/api/time/timer/prepare-finish',
      '/api/time/timer/validate-rows',
      '/api/time/timer/finish',
    ]);
    const keys = h.fetch.mock.calls
      .slice(1)
      .map((c) => new Headers(c[1]?.headers).get('idempotency-key'));
    expect(new Set(keys).size).toBe(3);
    expect(JSON.parse(String(required(h.fetch.mock.calls.at(-1))[1]?.body))).toMatchObject({
      expected,
      preparedRequestId: preparedId,
      rows,
    });
  });
  it('failed row validation and prepared expiry remain explicit and cannot write', async () => {
    const h = await setup(),
      timer = timerFixture(),
      expected = timerExpected(timer);
    h.fetch
      .mockResolvedValueOnce(json(timerPushFixture(timer)))
      .mockImplementationOnce(async (_path, init) =>
        json({
          ...proposalFixture(),
          requestId: new Headers(init?.headers).get('idempotency-key'),
          expected,
          cutoffAt: timer.serverNow,
          expiresAt: '2026-10-29T05:00:00.000Z',
          serverNow: timer.serverNow,
          problems: [],
        }),
      );
    const preparation = await h.api.timerProposal(expected);
    if (!preparation.ok) throw Error('preparation failed');
    const preparedId = preparation.data.requestId;
    h.fetch.mockResolvedValueOnce(
      json({ ok: false, problems: [{ row: 0, field: 'from', message: 'private' }], hours: 0.5 }),
    );
    const check = await h.api.timerValidateRows(preparedId, proposalFixture().rows);
    expect(check).toMatchObject({
      ok: true,
      data: { ok: false, problems: [{ row: 0, field: 'from' }] },
    });
    expect(JSON.stringify(check)).not.toContain('private');
    expect(await h.api.timerFinish(expected, proposalFixture().rows, '', preparedId)).toMatchObject(
      { code: 'validation' },
    );
    h.fetch.mockResolvedValueOnce(json({ error: { code: 'prepared_expired' } }, 409));
    expect(await h.api.timerValidateRows(preparedId, proposalFixture().rows)).toMatchObject({
      code: 'prepared_expired',
    });
  });
});

describe('prepare recovery', () => {
  it.each([false, true])('recovers the same preparation via GET, expired=%s', async (expired) => {
    const h = await setup(),
      timer = timerFixture(),
      expected = timerExpected(timer);
    h.fetch
      .mockResolvedValueOnce(json(timerPushFixture(timer)))
      .mockRejectedValueOnce(Error('lost'))
      .mockRejectedValueOnce(Error('lost'))
      .mockImplementationOnce(async (path) =>
        expired
          ? json({ error: { code: 'prepared_expired' } }, 404)
          : json({
              ...proposalFixture(),
              requestId: path.split('/').at(-1),
              expected,
              cutoffAt: timer.serverNow,
              expiresAt: '2026-10-29T05:00:00.000Z',
              serverNow: timer.serverNow,
              problems: [],
            }),
      );
    const result = await h.api.timerProposal(expected);
    expect(result).toMatchObject(expired ? { code: 'prepared_expired' } : { ok: true });
    const prepare = required(h.fetch.mock.calls[1]),
      retry = required(h.fetch.mock.calls[2]),
      recovery = required(h.fetch.mock.calls[3]);
    const key = new Headers(prepare[1]?.headers).get('idempotency-key');
    expect(new Headers(retry[1]?.headers).get('idempotency-key')).toBe(key);
    expect(recovery[0]).toBe('/api/time/timer/prepared/' + key);
    expect(recovery[1]?.method).toBe('GET');
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error('Missing fixture value');
  return value;
}

describe('extend uses CAS and preserves pause', () => {
  it('retries the same +15 operation and never turns a pause into an automatic resume', async () => {
    const h = await setup(),
      timer = timerFixture('pause');
    const extended = {
      ...timer,
      version: 3,
      startedAt: '2026-10-29T03:45:00.000Z',
      segments: [{ from: '2026-10-29T03:45:00.000Z', to: timer.segments[0]?.to ?? null }],
    };
    h.fetch
      .mockRejectedValueOnce(Error('lost'))
      .mockResolvedValueOnce(json(timerPushFixture(extended)));
    expect(await h.api.timerExtend(timerExpected(timer))).toMatchObject({
      ok: true,
      data: { state: 'pause', version: 3 },
    });
    const first = required(h.fetch.mock.calls[0]),
      second = required(h.fetch.mock.calls[1]);
    expect(first[0]).toBe('/api/time/timer/extend');
    expect(first[1]?.body).toBe(second[1]?.body);
    expect(new Headers(first[1]?.headers).get('idempotency-key')).toBe(
      new Headers(second[1]?.headers).get('idempotency-key'),
    );
    h.fetch.mockResolvedValueOnce(json({ error: { code: 'stale_timer' } }, 409));
    expect(await h.api.timerExtend(timerExpected(timer))).toMatchObject({ code: 'stale_timer' });
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
});
