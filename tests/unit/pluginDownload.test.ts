import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadPlugin } from '../../src/main/plugins/download';
import { PLUGIN_MAX_BYTES, type PluginBuild } from '../../src/shared/plugins';
const roots: string[] = [];
const bytes = new Uint8Array([80, 75, 3, 4]);
function build(
  size = bytes.length,
  sha256 = createHash('sha256').update(bytes).digest('hex'),
): PluginBuild {
  return {
    id: 1,
    version: '1.0',
    verified: true,
    revit: [2025],
    notes: '',
    size,
    sha256,
    url: '/api/desktop/plugins/files/1',
    publishedAt: '2026-10-31T00:00:00.000Z',
    requires: [],
  };
}
async function root() {
  const p = await mkdtemp(join(tmpdir(), 'plugin-download-'));
  roots.push(p);
  return p;
}
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
});
describe('main-only streaming plugin download', () => {
  it('a caller/catalog mutation during fetch cannot replace the approved size/hash', async () => {
    const p = await root(),
      expected = build(),
      changed = new Uint8Array(8).fill(9);
    await expect(
      downloadPlugin(expected, {
        root: p,
        current: () => true,
        fetch: async () => {
          expected.size = changed.length;
          expected.sha256 = createHash('sha256').update(changed).digest('hex');
          return new Response(changed, { headers: { 'content-length': '8' } });
        },
      }),
    ).rejects.toThrow('download_size');
    expect(await readdir(p)).toEqual([]);
  });
  it('writes exclusive part then exact verified ZIP; requests only same-server route/cookies/no redirects', async () => {
    const p = await root(),
      fetch = vi.fn(async () => new Response(bytes, { headers: { 'content-length': '4' } }));
    const file = await downloadPlugin(build(), { root: p, fetch, current: () => true });
    expect(await readFile(file)).toEqual(Buffer.from(bytes));
    expect(fetch).toHaveBeenCalledWith(
      '/api/desktop/plugins/files/1',
      expect.objectContaining({ method: 'GET', credentials: 'include', redirect: 'manual' }),
    );
    expect(file.endsWith('archive.zip')).toBe(true);
    expect(await readdir(file.slice(0, -11))).toEqual(['archive.zip']);
  });
  it('accepts exact 200MiB via incremental chunks, rejects metadata above limit before fetch', async () => {
    const p = await root(),
      chunk = new Uint8Array(1024 * 1024).fill(7),
      hash = createHash('sha256');
    for (let i = 0; i < 200; i++) hash.update(chunk);
    let count = 0;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              if (count++ < 200) c.enqueue(chunk);
              else c.close();
            },
          }),
          { headers: { 'content-length': String(PLUGIN_MAX_BYTES) } },
        ),
    );
    const file = await downloadPlugin(build(PLUGIN_MAX_BYTES, hash.digest('hex')), {
      root: p,
      fetch,
      current: () => true,
    });
    expect(file.endsWith('.zip')).toBe(true);
    expect(count).toBe(201);
    await expect(
      downloadPlugin(build(PLUGIN_MAX_BYTES + 1), { root: p, fetch, current: () => true }),
    ).rejects.toThrow('invalid_plugin');
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 15000);
  it('missing/invalid/lying length, overflow, truncation and bad hash leave no own part directories', async () => {
    for (const [length, data, sha] of [
      [null, bytes, undefined],
      ['x', bytes, undefined],
      ['5', bytes, undefined],
      ['4', new Uint8Array(5), undefined],
      ['4', new Uint8Array(3), undefined],
      ['4', bytes, 'b'.repeat(64)],
    ] as const) {
      const p = await root();
      await expect(
        downloadPlugin(build(4, sha), {
          root: p,
          fetch: async () =>
            new Response(data, { headers: length ? { 'content-length': length } : {} }),
          current: () => true,
        }),
      ).rejects.toThrow();
      expect(await readdir(p)).toEqual([]);
    }
  });
  it('redirect/401/404 refuse and cancel without writing; unauthorized callback is specific', async () => {
    for (const status of [302, 401, 404]) {
      const p = await root(),
        unauthorized = vi.fn();
      await expect(
        downloadPlugin(build(), {
          root: p,
          current: () => true,
          onUnauthorized: unauthorized,
          fetch: async () =>
            new Response(null, { status, headers: { location: 'https://evil.invalid' } }),
        }),
      ).rejects.toThrow();
      expect(await readdir(p)).toEqual([]);
      expect(unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    }
  });
  it('abort/timeout unblock stalled read and remove part; preserve unrelated sentinel', async () => {
    for (const timeout of [false, true]) {
      const p = await root();
      await mkdir(join(p, 'unrelated'));
      const control = new AbortController();
      let chunks = 0;
      let start!: () => void;
      const started = new Promise<void>((r) => {
        start = r;
      });
      const work = downloadPlugin(build(), {
        root: p,
        current: () => true,
        signal: control.signal,
        timeoutMs: timeout ? 25 : 1000,
        fetch: async () =>
          new Response(
            new ReadableStream({
              pull(c) {
                if (chunks++ === 0) c.enqueue(bytes.subarray(0, 2));
                else start();
              },
            }),
            { headers: { 'content-length': '4' } },
          ),
      });
      await started;
      if (!timeout) expect((await readdir(p)).filter((n) => n !== 'unrelated')).toHaveLength(1);
      if (!timeout) control.abort();
      await expect(work).rejects.toThrow('download_aborted');
      expect(await readdir(p)).toEqual(['unrelated']);
    }
  });
  it('owner/epoch change during read discards all bytes and cleans own staging', async () => {
    const p = await root();
    let current = true,
      chunks = 0;
    await expect(
      downloadPlugin(build(), {
        root: p,
        current: () => current,
        fetch: async () =>
          new Response(
            new ReadableStream({
              pull(c) {
                if (chunks++ === 0) c.enqueue(bytes.subarray(0, 2));
                else {
                  current = false;
                  c.enqueue(bytes.subarray(2));
                  c.close();
                }
              },
            }),
            { headers: { 'content-length': '4' } },
          ),
      }),
    ).rejects.toThrow('stale_session');
    expect(await readdir(p)).toEqual([]);
  });
});
