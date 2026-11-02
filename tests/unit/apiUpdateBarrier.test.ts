import { describe, expect, it, vi } from 'vitest';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = () => ({
  user: { id: 1, shortName: 'Тест', mustChangePassword: false },
  csrfToken: 'fixture-csrf',
});
async function fixture() {
  const f = {
    allowed: true,
    throws: false,
    fetch: vi.fn<TeamsApiOptions['fetch']>(),
    api: undefined as unknown as TeamsApi,
  };
  f.fetch.mockResolvedValueOnce(json(session()));
  f.api = new TeamsApi({
    fetch: f.fetch,
    allowMutation: () => {
      if (f.throws) throw Error('private');
      return f.allowed;
    },
  });
  await f.api.authenticate();
  return f;
}
describe('Main API update barrier: mocked transport only', () => {
  it('denies message/read/delete/upload/support writes before network, without uncertain result', async () => {
    const f = await fixture();
    f.allowed = false;
    const results = await Promise.all([
      f.api.send(4, 'text', 'request-1234'),
      f.api.read(4, 10),
      f.api.delete(4, 10),
      f.api.upload(4, new Uint8Array([1, 2]), 'file.txt', 'text/plain'),
      f.api.supportSend({ text: 'Support', fileIds: [] }, 'support-1234'),
    ]);
    for (const r of results) {
      expect(r).toMatchObject({ ok: false, code: 'update_in_progress', retryable: false });
      expect(r).not.toHaveProperty('uncertain');
    }
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.api.mutationState).toEqual({ active: 0, revision: 0 });
  });
  it('a throwing barrier fails closed without raw error details', async () => {
    const f = await fixture();
    f.throws = true;
    const result = await f.api.read(4, 10);
    expect(result).toMatchObject({ code: 'update_in_progress' });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('public latest GET remains available while writes are gated and never counts as a mutation', async () => {
    const f = await fixture();
    f.allowed = false;
    f.fetch.mockResolvedValueOnce(json({ error: { code: 'no_release' } }, 404));
    expect(await f.api.latestRelease()).toEqual({ ok: true, data: null });
    expect(f.api.mutationState).toEqual({ active: 0, revision: 0 });
    expect(f.fetch.mock.calls.at(-1)?.[1]?.method).toBe('GET');
  });
  it('counts the complete pending response, increments revision on start/end and preserves snapshots', async () => {
    const f = await fixture();
    let finish!: (r: Response) => void;
    f.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const previous = f.api.mutationState,
      flight = f.api.read(4, 10),
      pending = f.api.mutationState;
    expect(previous).toEqual({ active: 0, revision: 0 });
    expect(pending).toEqual({ active: 1, revision: 1 });
    expect(Object.isFrozen(pending)).toBe(true);
    f.allowed = false;
    finish(json({ ok: true }));
    expect(await flight).toEqual({ ok: true, data: null });
    expect(f.api.mutationState).toEqual({ active: 0, revision: 2 });
    expect(pending).toEqual({ active: 1, revision: 1 });
    expect(await f.api.read(4, 10)).toMatchObject({ code: 'update_in_progress' });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.allowed = true;
    f.fetch.mockResolvedValueOnce(json({ ok: true }));
    expect(await f.api.read(4, 11)).toEqual({ ok: true, data: null });
    expect(f.api.mutationState).toEqual({ active: 0, revision: 4 });
  });
  it('transport failure releases the active mutation count and preserves existing uncertainty semantics', async () => {
    const f = await fixture();
    f.fetch.mockRejectedValueOnce(Error('injected'));
    expect(await f.api.read(4, 10)).toMatchObject({ code: 'network', uncertain: true });
    expect(f.api.mutationState).toEqual({ active: 0, revision: 2 });
  });
  it('checks the barrier again before a CSRF retry, not just at the first intent', async () => {
    const f = await fixture();
    f.fetch.mockResolvedValueOnce(json({ error: { code: 'csrf' } }, 403));
    f.fetch.mockImplementationOnce(async () => {
      f.allowed = false;
      return json(session());
    });
    expect(await f.api.read(4, 10)).toMatchObject({ code: 'update_in_progress' });
    expect(f.fetch.mock.calls.map((c) => c[1]?.method)).toEqual(['GET', 'POST', 'GET']);
    expect(f.api.mutationState).toEqual({ active: 0, revision: 2 });
  });
});
