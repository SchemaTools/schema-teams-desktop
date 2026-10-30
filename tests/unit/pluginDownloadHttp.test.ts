import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadPlugin } from '../../src/main/plugins/download';
import type { PluginBuild } from '../../src/shared/plugins';
describe('Plugin HTTP stream fixture', () => {
  it('real chunked writes preserve exact bytes, 404 and redirect never follow and leave no part', async () => {
    const bytes = Buffer.from('synthetic package integrity bytes'),
      seen: string[] = [],
      server = createServer((req, res) => {
        seen.push(req.url ?? '');
        if (req.url?.endsWith('/2')) {
          res.writeHead(302, { location: '/external' });
          res.end();
        } else if (req.url?.endsWith('/3')) {
          res.writeHead(404);
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.length });
          res.write(bytes.subarray(0, 5));
          res.end(bytes.subarray(5));
        }
      });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      root = await mkdtemp(join(tmpdir(), 'plugin-http-'));
    const b = (id: number): PluginBuild => ({
      id,
      version: '1.0',
      verified: true,
      revit: [2025],
      notes: '',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: `/api/desktop/plugins/files/${id}`,
      publishedAt: '2026-10-31T04:00:00.000Z',
      requires: [],
    });
    try {
      const file = await downloadPlugin(b(1), {
        root,
        fetch: (p, init) => fetch(new URL(p, origin), init),
        current: () => true,
      });
      expect(await readFile(file)).toEqual(bytes);
      const before = await readdir(root);
      for (const id of [2, 3])
        await expect(
          downloadPlugin(b(id), {
            root,
            fetch: (p, init) => fetch(new URL(p, origin), init),
            current: () => true,
          }),
        ).rejects.toThrow();
      expect(await readdir(root)).toEqual(before);
      expect(seen).toEqual([
        '/api/desktop/plugins/files/1',
        '/api/desktop/plugins/files/2',
        '/api/desktop/plugins/files/3',
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
