import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import type { PluginBuild } from '../../src/shared/plugins';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (id = 1) => ({
  user: { id, shortName: 'Тест', mustChangePassword: false },
  csrfToken: 'csrf-fixture',
});
const bytes = new Uint8Array([80, 75, 3, 4]);
const b: PluginBuild = {
  id: 7,
  version: '1.0',
  verified: true,
  revit: [2025],
  notes: '',
  size: 4,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  url: '/api/desktop/plugins/files/7',
  publishedAt: '2026-10-31T04:00:00.000Z',
  requires: [],
};
const roots: string[] = [];
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
});
async function setup() {
  const fetch = vi.fn<TeamsApiOptions['fetch']>(),
    lost = vi.fn(),
    audit = vi.fn(),
    api = new TeamsApi({ fetch, onAuthLost: lost, onPluginAudit: audit });
  fetch.mockResolvedValueOnce(json(me()));
  await api.authenticate();
  const root = await mkdtemp(join(tmpdir(), 'api-plugins-'));
  roots.push(root);
  return { api, fetch, lost, root, audit };
}
describe('Plugin cookie/epoch API', () => {
  it('catalog uses protected cookie GET, rejects malformed DTO without accepting fake installed data', async () => {
    const f = await setup();
    f.fetch.mockResolvedValueOnce(json({ tester: false, plugins: [] }));
    expect(await f.api.plugins()).toEqual({ ok: true, data: { tester: false, plugins: [] } });
    expect(f.fetch.mock.calls[1]).toEqual([
      '/api/desktop/plugins',
      expect.objectContaining({ method: 'GET', credentials: 'include', redirect: 'manual' }),
    ]);
    f.fetch.mockResolvedValueOnce(
      json({
        tester: false,
        plugins: [{ code: 'floor-plans', stable: { ...b, url: 'https://other.invalid/file' } }],
      }),
    );
    expect(await f.api.plugins()).toMatchObject({ ok: false, code: 'invalid_data' });
    expect(f.audit.mock.calls.map((c) => c[0])).toEqual([
      { operation: 'catalog', phase: 'requested' },
      { operation: 'catalog', phase: 'result', outcome: 'ok' },
      { operation: 'catalog', phase: 'requested' },
      { operation: 'catalog', phase: 'result', outcome: 'rejected', reason: 'invalid_data' },
    ]);
    f.audit.mockImplementation(() => {
      throw Error('log storage unavailable');
    });
    f.fetch.mockResolvedValueOnce(json({ tester: false, plugins: [] }));
    expect(await f.api.plugins()).toEqual({ ok: true, data: { tester: false, plugins: [] } });
  });
  it('catalog permission failure or expired session is never an empty successful catalog', async () => {
    const f = await setup();
    f.fetch.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    expect(await f.api.plugins()).toMatchObject({ ok: false, code: 'forbidden' });
    f.fetch.mockResolvedValueOnce(new Response('HTML', { status: 401 }));
    expect(await f.api.plugins()).toMatchObject({ ok: false, code: 'unauthenticated' });
    expect(f.lost).toHaveBeenCalledTimes(1);
  });
  it('stream is cookie-authenticated and returns only main path after exact checks', async () => {
    const f = await setup();
    f.fetch.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-length': '4' } }));
    const result = await f.api.downloadPlugin(b, f.root);
    expect(result.ok).toBe(true);
    expect(f.fetch.mock.calls[1]).toEqual([
      b.url,
      expect.objectContaining({ credentials: 'include', redirect: 'manual', method: 'GET' }),
    ]);
    expect(f.audit.mock.calls.map((c) => c[0])).toEqual([
      { operation: 'download', phase: 'requested', version: '1.0', buildId: 7 },
      { operation: 'download', phase: 'result', outcome: 'ok', version: '1.0', buildId: 7 },
    ]);
  });
  it('clear aborts pending stream, destroys old session result and removes partial data', async () => {
    const f = await setup();
    let chunks = 0;
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    f.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(c) {
            if (chunks++ === 0) c.enqueue(bytes.subarray(0, 2));
            else started();
          },
        }),
        { headers: { 'content-length': '4' } },
      ),
    );
    const work = f.api.downloadPlugin(b, f.root);
    await ready;
    expect(await readdir(f.root)).toHaveLength(1);
    f.api.clear();
    expect(await work).toMatchObject({ ok: false, code: 'stale_session' });
    expect(await readdir(f.root)).toEqual([]);
  });
  it('late catalog of previous login cannot publish after clear, even already fulfilled response', async () => {
    const f = await setup();
    let resolve!: (v: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const work = f.api.plugins();
    resolve(json({ tester: true, plugins: [] }));
    f.api.clear();
    expect(await work).toMatchObject({ ok: false, code: 'stale_session' });
  });
  it('stream 401 revokes session and leaves no file; no-auth never opens connection', async () => {
    const f = await setup();
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await f.api.downloadPlugin(b, f.root)).toMatchObject({
      ok: false,
      code: 'stale_session',
    });
    expect(f.lost).toHaveBeenCalledTimes(1);
    const count = f.fetch.mock.calls.length;
    await f.api.downloadPlugin(b, f.root);
    expect(f.fetch).toHaveBeenCalledTimes(count);
    expect(await readdir(f.root)).toEqual([]);
  });
});
