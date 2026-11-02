import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import { desktopRelease } from '../../src/main/api/updates';
import { UpdateChecker, UPDATE_INTERVAL } from '../../src/main/desktop/updateChecker';
import { compareVersions, type DesktopRelease } from '../../src/shared/updates';
import type { ApiResult } from '../../src/shared/client';
import { requestValid } from '../../src/shared/requests';
import { releaseFixture } from '../fixtures/updates';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wait = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());
describe('Release manifest and version comparison', () => {
  it('compares numeric components, never lexicographic', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '2.0.0')).toBe(-1);
    for (const version of ['01.2.3', '1.2', '1.2.3-beta', '1.2.3\n', '999999999999999999999.0.0'])
      expect(compareVersions(version, '1.0.0')).toBeNull();
  });
  it('projects metadata and canonicalizes checksum, never extra secret fields', () => {
    expect(
      desktopRelease({
        ...releaseFixture(),
        sha256: 'A'.repeat(64),
        token: 'private-token',
        internal: { path: 'private-path' },
      }),
    ).toEqual(releaseFixture());
  });
  it.each([
    { version: '1.2.3-beta' },
    { version: '01.2.3' },
    { notes: 'x'.repeat(10001) },
    { file: '../evil.exe' },
    { file: 'CON.exe' },
    { file: 'payload.cmd' },
    { file: 'foo.exe\n' },
    { url: 'https://other.example.test/setup.exe' },
    { url: '/api/desktop/files/wrong.exe' },
    { sha256: 'oops' },
    { size: 0 },
    { size: 512 * 1024 * 1024 + 1 },
  ])('rejects unsafe/ambiguous manifest %j', (patch) =>
    expect(() => desktopRelease({ ...releaseFixture(), ...patch })).toThrow(),
  );
  it('IPC accepts checks and version-bound later, no URL or file operations', () => {
    expect(requestValid({ kind: 'updates.check' })).toBe(true);
    expect(requestValid({ kind: 'updates.later', version: '1.1.0' })).toBe(true);
    for (const raw of [
      { kind: 'updates.check', url: 'https://other.example.test' },
      { kind: 'updates.later', version: '1.1.0', epoch: 1 },
      { kind: 'updates.later', version: '01.1.0' },
      { kind: 'updates.install', path: 'setup.exe' },
    ])
      expect(requestValid(raw)).toBe(false);
  });
});
describe('TeamsApi public latest endpoint', () => {
  it('reads without login and validates the server-provided canonical path', async () => {
    const fetch = vi.fn<TeamsApiOptions['fetch']>().mockResolvedValue(json(releaseFixture())),
      api = new TeamsApi({ fetch });
    expect(await api.latestRelease()).toEqual({ ok: true, data: releaseFixture() });
    expect(fetch.mock.calls.map((c) => [c[0], c[1]?.method])).toEqual([
      ['/api/desktop/latest', 'GET'],
    ]);
    expect(api.owner).toBeNull();
  });
  it('only explicit 404 no_release means unpublished, not generic 404 or 200 error', async () => {
    const fetch = vi.fn<TeamsApiOptions['fetch']>(),
      api = new TeamsApi({ fetch });
    fetch.mockResolvedValueOnce(json({ error: { code: 'no_release' } }, 404));
    expect(await api.latestRelease()).toEqual({ ok: true, data: null });
    fetch.mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404));
    expect(await api.latestRelease()).toMatchObject({ ok: false });
    fetch.mockResolvedValueOnce(json({ error: { code: 'no_release' } }, 200));
    expect(await api.latestRelease()).toMatchObject({ ok: false, code: 'invalid_data' });
  });
  it('public endpoint 401 does not sign out an existing owner', async () => {
    const fetch = vi
        .fn<TeamsApiOptions['fetch']>()
        .mockResolvedValueOnce(
          json({
            user: { id: 1, shortName: 'Тест', mustChangePassword: false },
            csrfToken: 'fixture-csrf',
          }),
        )
        .mockResolvedValueOnce(json({ error: { code: 'unauthenticated' } }, 401)),
      onAuthLost = vi.fn(),
      api = new TeamsApi({ fetch, onAuthLost });
    await api.authenticate();
    expect(await api.latestRelease()).toMatchObject({ ok: false });
    expect(api.owner).toBe(1);
    expect(onAuthLost).not.toHaveBeenCalled();
  });
  it('no redirect and no arbitrary server error detail reaches the UI', async () => {
    const fetch = vi
        .fn<TeamsApiOptions['fetch']>()
        .mockResolvedValueOnce(json(releaseFixture(), 302))
        .mockResolvedValueOnce(
          json({ error: { code: 'internal', message: 'private-error' } }, 500),
        ),
      api = new TeamsApi({ fetch });
    expect(await api.latestRelease()).toMatchObject({ code: 'invalid_data' });
    const result = await api.latestRelease();
    expect(JSON.stringify(result)).not.toContain('private-error');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });
});
describe('UpdateChecker: startup, six hours, coalescing and version-bound dismissal', () => {
  const setup = (
    read = vi
      .fn<() => Promise<ApiResult<DesktopRelease | null>>>()
      .mockResolvedValue({ ok: true, data: releaseFixture() }),
    enabled = true,
  ) => {
    const changes = vi.fn(),
      checker = new UpdateChecker({ enabled, currentVersion: '0.6.1', read, onChange: changes });
    return { checker, read, changes };
  };
  it('checks at startup and every six hours, destroys all timers', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.checker.start();
    h.checker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.checker.state.status).toBe('available');
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL - 1);
    expect(h.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.read).toHaveBeenCalledTimes(2);
    h.checker.destroy();
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL);
    expect(h.read).toHaveBeenCalledTimes(2);
  });
  it('coalesces concurrent checks and makes a safe public snapshot', async () => {
    const pending = wait<ApiResult<DesktopRelease | null>>(),
      read = vi
        .fn<() => Promise<ApiResult<DesktopRelease | null>>>()
        .mockReturnValue(pending.promise),
      h = setup(read);
    const first = h.checker.check(),
      second = h.checker.check();
    expect(first).toBe(second);
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: true, data: releaseFixture() });
    const state = await first;
    expect(state.available).toEqual({
      version: '1.1.0',
      notes: releaseFixture().notes,
      size: 112000000,
    });
    expect(JSON.stringify(state)).not.toMatch(/sha256|\/api\/desktop\/files|Setup/);
    h.checker.destroy();
  });
  it('later hides exactly this version until restart or a different version', async () => {
    const h = setup();
    await h.checker.check();
    expect(h.checker.later('0.1.0')).toBe(false);
    expect(h.checker.later('1.1.0')).toBe(true);
    await h.checker.check();
    expect(h.checker.state.dismissedVersion).toBe('1.1.0');
    h.read.mockResolvedValueOnce({ ok: true, data: releaseFixture('1.2.0') });
    await h.checker.check();
    expect(h.checker.state.available?.version).toBe('1.2.0');
    expect(h.checker.state.available?.version).not.toBe(h.checker.state.dismissedVersion);
    h.checker.destroy();
    const next = setup();
    await next.checker.check();
    expect(next.checker.state.dismissedVersion).toBeNull();
    next.checker.destroy();
  });
  it('distinguishes current, unpublished and failed checks without hiding the last verified release', async () => {
    const h = setup();
    await h.checker.check();
    const checkedAt = h.checker.state.checkedAt;
    h.read.mockResolvedValueOnce({
      ok: false,
      code: 'network',
      error: 'private raw error',
      retryable: true,
    });
    await h.checker.check();
    expect(h.checker.state).toMatchObject({
      status: 'error',
      checkedAt,
      available: { version: '1.1.0' },
    });
    expect(JSON.stringify(h.checker.state)).not.toContain('private raw error');
    h.read.mockResolvedValueOnce({ ok: true, data: null });
    await h.checker.check();
    expect(h.checker.state).toMatchObject({ status: 'unpublished', available: null });
    h.read.mockResolvedValueOnce({ ok: true, data: releaseFixture('0.6.1') });
    await h.checker.check();
    expect(h.checker.state.status).toBe('current');
    h.checker.destroy();
  });
  it('retries an epoch-cancelled public read once without user data', async () => {
    const h = setup();
    h.read.mockResolvedValueOnce({
      ok: false,
      code: 'stale_session',
      error: 'old session',
      retryable: false,
    });
    expect((await h.checker.check()).status).toBe('available');
    expect(h.read).toHaveBeenCalledTimes(2);
    h.checker.destroy();
  });
  it('does not publish late results after destroy and makes no requests without a server', async () => {
    const pending = wait<ApiResult<DesktopRelease | null>>(),
      h = setup(
        vi.fn<() => Promise<ApiResult<DesktopRelease | null>>>().mockReturnValue(pending.promise),
      );
    const p = h.checker.check();
    h.checker.destroy();
    pending.resolve({ ok: true, data: releaseFixture() });
    await p;
    expect(h.changes).toHaveBeenCalledTimes(1);
    const disabled = setup(undefined, false);
    disabled.checker.start();
    expect((await disabled.checker.check()).status).toBe('unconfigured');
    expect(disabled.read).not.toHaveBeenCalled();
    disabled.checker.destroy();
  });
});

describe('Published release survives numeric comparison', () => {
  it.each(['0.6.1', '0.1.0'])(
    'retains verified published %s alongside installed version',
    async (version) => {
      const read = vi
        .fn<() => Promise<ApiResult<DesktopRelease | null>>>()
        .mockResolvedValueOnce({ ok: true, data: releaseFixture(version) })
        .mockResolvedValueOnce({ ok: false, code: 'network', error: 'private', retryable: true });
      const checker = new UpdateChecker({
        enabled: true,
        currentVersion: '0.6.1',
        read,
        onChange: () => {},
      });
      await checker.check();
      expect(checker.state).toMatchObject({
        status: 'current',
        available: null,
        published: { version },
      });
      await checker.check();
      expect(checker.state).toMatchObject({ status: 'error', published: { version } });
      checker.destroy();
    },
  );
});

describe('Main-only update offers follow the captured lifetime', () => {
  it('preserves public unpublished/error status across owner reset while clearing executable permission', async () => {
    const onOffer = vi.fn(),
      read = vi
        .fn<() => Promise<ApiResult<DesktopRelease | null>>>()
        .mockResolvedValueOnce({ ok: true, data: null })
        .mockResolvedValueOnce({
          ok: false,
          code: 'invalid_data',
          error: 'private',
          retryable: false,
        });
    const checker = new UpdateChecker({
      enabled: true,
      currentVersion: '0.6.1',
      read,
      onChange: () => {},
      onOffer,
    });
    await checker.check();
    checker.reset(true);
    expect(checker.state.status).toBe('unpublished');
    await checker.check();
    const error = checker.state.error;
    checker.reset(true);
    expect(checker.state).toMatchObject({ status: 'error', error });
    expect(onOffer.mock.calls.every(([release]) => release === null)).toBe(true);
    checker.destroy();
  });
  it('delivers frozen full metadata only to main; errors clear permission but retain display metadata', async () => {
    const release = releaseFixture(),
      onOffer = vi.fn(),
      read = vi
        .fn<() => Promise<ApiResult<DesktopRelease | null>>>()
        .mockResolvedValueOnce({ ok: true, data: release })
        .mockResolvedValueOnce({ ok: false, code: 'network', error: 'private', retryable: true });
    const checker = new UpdateChecker({
      enabled: true,
      currentVersion: '0.6.1',
      read,
      onChange: () => {},
      lifetime: () => 'A',
      onOffer,
    });
    await checker.check();
    const full = onOffer.mock.calls[1]?.[0] as Readonly<DesktopRelease>;
    expect(full).toEqual(releaseFixture());
    expect(Object.isFrozen(full)).toBe(true);
    release.notes = 'caller mutation';
    expect(full.notes).not.toBe(release.notes);
    expect(JSON.stringify(checker.state)).not.toMatch(/sha256|\/api\/desktop\/files/);
    await checker.check();
    expect(onOffer.mock.calls.at(-1)).toEqual([null, 'A']);
    expect(checker.state.available?.version).toBe('1.1.0');
    checker.destroy();
  });
  it('old owner success cannot become the new owner offer or overwrite its state', async () => {
    let lifetime = 'A';
    const old = wait<ApiResult<DesktopRelease | null>>(),
      onOffer = vi.fn(),
      read = vi
        .fn<() => Promise<ApiResult<DesktopRelease | null>>>()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce({ ok: true, data: releaseFixture('1.2.0') });
    const checker = new UpdateChecker({
      enabled: true,
      currentVersion: '0.6.1',
      read,
      onChange: () => {},
      lifetime: () => lifetime,
      onOffer,
    });
    const oldFlight = checker.check();
    lifetime = 'B';
    checker.reset();
    const currentFlight = checker.check();
    expect(currentFlight).not.toBe(oldFlight);
    await currentFlight;
    old.resolve({ ok: true, data: releaseFixture('1.1.0') });
    await oldFlight;
    expect(checker.state.available?.version).toBe('1.2.0');
    expect(onOffer.mock.calls.filter(([release]) => release !== null)).toEqual([
      [releaseFixture('1.2.0'), 'B'],
    ]);
    checker.destroy();
  });
  it('former-owner stale_session does not retry using a new owner', async () => {
    let lifetime = 'A';
    const old = wait<ApiResult<DesktopRelease | null>>(),
      onOffer = vi.fn(),
      read = vi.fn<() => Promise<ApiResult<DesktopRelease | null>>>().mockReturnValue(old.promise);
    const checker = new UpdateChecker({
      enabled: true,
      currentVersion: '0.6.1',
      read,
      onChange: () => {},
      lifetime: () => lifetime,
      onOffer,
    });
    const flight = checker.check();
    lifetime = 'B';
    checker.reset();
    old.resolve({ ok: false, code: 'stale_session', error: 'old', retryable: false });
    await flight;
    expect(read).toHaveBeenCalledTimes(1);
    expect(checker.state.status).toBe('idle');
    expect(onOffer.mock.calls.every(([release]) => release === null)).toBe(true);
    checker.destroy();
  });
  it('same-version republish passes the new complete tuple, not an old cached file', async () => {
    const first = releaseFixture(),
      second = { ...first, notes: 'replacement', sha256: 'b'.repeat(64) },
      onOffer = vi.fn(),
      read = vi
        .fn<() => Promise<ApiResult<DesktopRelease | null>>>()
        .mockResolvedValueOnce({ ok: true, data: first })
        .mockResolvedValueOnce({ ok: true, data: second });
    const checker = new UpdateChecker({
      enabled: true,
      currentVersion: '0.6.1',
      read,
      onChange: () => {},
      onOffer,
    });
    await checker.check();
    await checker.check();
    expect(onOffer.mock.calls).toEqual([
      [null, ''],
      [first, ''],
      [null, ''],
      [second, ''],
    ]);
    checker.destroy();
  });
  it.each(['unpublished', 'older', 'invalid'])(
    '%s cannot supply an executable offer',
    async (kind) => {
      const data =
          kind === 'unpublished'
            ? null
            : {
                ...releaseFixture(kind === 'older' ? '0.1.0' : '1.1.0'),
                ...(kind === 'invalid' ? { sha256: 'invalid' } : {}),
              },
        onOffer = vi.fn();
      const checker = new UpdateChecker({
        enabled: true,
        currentVersion: '0.6.1',
        read: async () => ({ ok: true, data }),
        onChange: () => {},
        onOffer,
      });
      await checker.check();
      expect(onOffer.mock.calls).toEqual([[null, '']]);
      checker.destroy();
    },
  );
});
