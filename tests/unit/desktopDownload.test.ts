import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat, symlink } from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  downloadDesktopRelease,
  discardDesktopDownload,
  claimDesktopDownload,
  DESKTOP_MAX_BYTES,
  type DesktopDownloadOptions,
  type DesktopDownloadProgress,
} from '../../src/main/desktop/downloadDesktop';

const fault = vi.hoisted(() => ({
  mode: '',
  current: true,
  substituted: false,
  renameCalls: 0,
  bigintReads: 0,
  numberReads: 0,
}));
vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof import('node:fs/promises')>();
  function highIdentity<T extends object>(stat: T, id: bigint, bigint: boolean): T {
    return new Proxy(stat, {
      get(target, key) {
        if (key === 'ino') return bigint ? id : Number(id);
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  const recordStat = (bigint: boolean) => {
    if (fault.mode === 'high-id') {
      if (bigint) fault.bigintReads++;
      else fault.numberReads++;
    }
  };
  return {
    ...fs,
    lstat: async (path: Parameters<typeof fs.lstat>[0], options?: { bigint?: boolean }) => {
      const bigint = options?.bigint === true;
      recordStat(bigint);
      const stat = bigint ? await fs.lstat(path, { bigint: true }) : await fs.lstat(path);
      return fault.mode === 'high-id' && String(path).endsWith('installer.part')
        ? highIdentity(stat, fault.substituted ? 9007199254740993n : 9007199254740992n, bigint)
        : stat;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      return new Proxy(file, {
        get(target, key) {
          if (key === 'stat')
            return async (options?: { bigint?: boolean }) => {
              const bigint = options?.bigint === true;
              recordStat(bigint);
              const stat = bigint ? await target.stat({ bigint: true }) : await target.stat();
              return fault.mode === 'high-id'
                ? highIdentity(stat, 9007199254740992n, bigint)
                : stat;
            };
          if (key === 'write')
            return async (buffer: Uint8Array, offset: number, length: number) => {
              if (fault.mode === 'write-fail') throw Error('injected-write-failure');
              if (fault.mode === 'zero-write') return { bytesWritten: 0, buffer };
              return target.write(
                buffer,
                offset,
                fault.mode === 'short-write' ? Math.min(length, 2) : length,
              );
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    rename: async (from: string, to: string) => {
      fault.renameCalls++;
      if (fault.mode === 'real-rename-fail') {
        await fs.mkdir(to);
        await fs.writeFile(join(to, 'foreign.bin'), 'preserve');
      }
      await fs.rename(from, to);
      if (fault.mode === 'stale-after-rename') fault.current = false;
    },
  };
});

const base = resolve(__dirname, '../../private');
const roots: string[] = [];
const servers: Server[] = [];
const data = Buffer.from('Synthetic bounded desktop installer fixture, never executed.');
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const release = (bytes: Uint8Array = data) => ({
  version: '0.12.0',
  notes: 'Local fixture',
  file: 'Schema Teams 0.12.0.exe',
  url: '/api/desktop/files/Schema%20Teams%200.12.0.exe',
  size: bytes.byteLength,
  sha256: digest(bytes),
});
async function root() {
  await mkdir(base, { recursive: true });
  const value = await mkdtemp(join(base, 'desktop-download-test-'));
  roots.push(value);
  return value;
}
async function fixture(mode = 'good', payload = data) {
  const requests: { url: string; cookie?: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({
      url: req.url ?? '',
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
    });
    if (mode === 'timeout') return;
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/foreign' });
      res.end();
      return;
    }
    if (mode === 'missing-length') {
      res.writeHead(200);
      res.write(payload);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-length': mode === 'oversized-header' ? DESKTOP_MAX_BYTES + 1 : payload.length,
    });
    if (mode === 'truncated') {
      res.write(payload.subarray(0, 3));
      res.destroy();
      return;
    }
    res.end(payload);
  });
  servers.push(server);
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture address');
  return { origin: `http://127.0.0.1:${address.port}`, requests };
}
const options = (
  directory: string,
  serverOrigin = 'http://127.0.0.1:1',
): DesktopDownloadOptions => ({
  root: directory,
  serverOrigin,
  current: () => fault.current,
});
const response = (bytes = data, length: string | null = String(bytes.length)) =>
  new Response(bytes, { headers: length === null ? {} : { 'content-length': length } });
async function completedFixture() {
  const directory = await root(),
    receipt = await downloadDesktopRelease(release(), {
      ...options(directory),
      fetch: async () => response(),
    });
  return { directory, receipt };
}
afterEach(async () => {
  fault.mode = '';
  fault.current = true;
  fault.substituted = false;
  fault.renameCalls = 0;
  fault.bigintReads = 0;
  fault.numberReads = 0;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((yes) => server.close(() => yes()));
  }
  for (const value of roots.splice(0)) {
    const rel = relative(base, value);
    if (!rel || rel.startsWith('..')) throw Error('unsafe test cleanup');
    await rm(value, { recursive: true, force: true });
  }
});

describe('successful download ownership and handoff lease, no installer execution', () => {
  it('cleans only an original receipt and consumes its cleanup authority', async () => {
    const { directory, receipt } = await completedFixture();
    expect(await discardDesktopDownload({ ...receipt })).toBe(false);
    expect(claimDesktopDownload({ ...receipt })).toBeNull();
    expect(await discardDesktopDownload(receipt)).toBe(true);
    expect(await readdir(directory)).toEqual([]);
    expect(await discardDesktopDownload(receipt)).toBe(false);
  });
  it('keeps bytes during a lease and rejects stale lease release', async () => {
    const { receipt } = await completedFixture(),
      lease = claimDesktopDownload(receipt);
    if (!lease) throw Error('Lease');
    expect(claimDesktopDownload(receipt)).toBeNull();
    expect(await discardDesktopDownload(receipt)).toBe(false);
    expect(lease.finish(false)).toBe(true);
    const next = claimDesktopDownload(receipt);
    if (!next) throw Error('Next lease');
    expect(lease.finish(false)).toBe(false);
    expect(await discardDesktopDownload(receipt)).toBe(false);
    expect(next.finish(false)).toBe(true);
    expect(await discardDesktopDownload(receipt)).toBe(true);
  });
  it('never removes bytes handed off to a runner', async () => {
    const { receipt } = await completedFixture(),
      lease = claimDesktopDownload(receipt);
    if (!lease) throw Error('Lease');
    expect(lease.finish(true)).toBe(true);
    expect(await discardDesktopDownload(receipt)).toBe(false);
    expect(await readFile(receipt.file)).toEqual(data);
  });
  it('preserves a replacement file even when its bytes match', async () => {
    const { directory, receipt } = await completedFixture(),
      replacement = join(directory, 'replacement.exe');
    await writeFile(replacement, data);
    await (await import('node:fs/promises')).rename(replacement, receipt.file);
    expect(await discardDesktopDownload(receipt)).toBe(false);
    expect(await readFile(receipt.file)).toEqual(data);
  });
  it('preserves changed bytes at the original inode', async () => {
    const { receipt } = await completedFixture();
    await writeFile(receipt.file, 'changed');
    expect(await discardDesktopDownload(receipt)).toBe(false);
    expect(await readFile(receipt.file, 'utf8')).toBe('changed');
  });
  it('removes its file but preserves foreign entries in the job directory', async () => {
    const { receipt } = await completedFixture(),
      foreign = join(dirname(receipt.file), 'foreign.txt');
    await writeFile(foreign, 'preserve');
    expect(await discardDesktopDownload(receipt)).toBe(true);
    expect(await readFile(foreign, 'utf8')).toBe('preserve');
  });
  it('serializes concurrent cleanup requests', async () => {
    const { receipt } = await completedFixture();
    expect(
      (
        await Promise.all([discardDesktopDownload(receipt), discardDesktopDownload(receipt)])
      ).sort(),
    ).toEqual([false, true]);
  });
});

describe('Desktop public download — real local HTTP and temp filesystem', () => {
  it('streams bounded bytes to exclusive file, exact SHA/size, immutable receipt and monotonic progress', async () => {
    const f = await fixture('good', Buffer.alloc(256 * 1024, 7));
    const directory = await root();
    const bytes = Buffer.alloc(256 * 1024, 7);
    const progress: Readonly<DesktopDownloadProgress>[] = [];
    const receipt = await downloadDesktopRelease(release(bytes), {
      ...options(directory, f.origin),
      onProgress: (p) => progress.push(p),
    });
    expect(await readFile(receipt.file)).toEqual(bytes);
    expect(receipt.bytes).toBe(bytes.length);
    expect(receipt.sha256).toBe(digest(bytes));
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.release)).toBe(true);
    expect(() => JSON.stringify(receipt)).not.toThrow();
    expect(await readdir(receipt.file.slice(0, receipt.file.lastIndexOf('installer.exe')))).toEqual(
      ['installer.exe'],
    );
    expect(f.requests).toEqual([
      { url: release().url, cookie: undefined, authorization: undefined },
    ]);
    expect(progress.length).toBeGreaterThan(1);
    for (let i = 0; i < progress.length; i++) {
      const p = progress[i];
      if (!p) throw Error('missing progress');
      expect(Object.isFrozen(p)).toBe(true);
      expect(p.fraction).toBeGreaterThanOrEqual(progress[i - 1]?.fraction ?? 0);
      expect(p.fraction).toBeLessThanOrEqual(1);
      expect(p.verified).toBe(i === progress.length - 1);
      if (!p.verified) expect(p.fraction).toBeLessThan(1);
    }
  });
  it.each(['redirect', 'missing-length', 'oversized-header', 'truncated', 'timeout'])(
    'rejects real HTTP %s with no staged receipt/files and preserves sibling sentinel',
    async (mode) => {
      const directory = await root();
      await writeFile(join(directory, 'foreign.bin'), 'preserve');
      const f = await fixture(mode);
      await expect(
        downloadDesktopRelease(release(), { ...options(directory, f.origin), timeoutMs: 80 }),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual(['foreign.bin']);
      expect(await readFile(join(directory, 'foreign.bin'), 'utf8')).toBe('preserve');
    },
  );
  it('rejects hash mismatch after actual HTTP/disk write without false verified progress', async () => {
    const directory = await root();
    const f = await fixture();
    const events: boolean[] = [];
    await expect(
      downloadDesktopRelease(
        { ...release(), sha256: '0'.repeat(64) },
        { ...options(directory, f.origin), onProgress: (p) => events.push(p.verified) },
      ),
    ).rejects.toThrow('download_hash');
    expect(events).not.toContain(true);
    expect(await readdir(directory)).toEqual([]);
  });
  it('primitive deliberately does not coalesce double clicks; future controller must do so', async () => {
    const directory = await root();
    const f = await fixture();
    const result = await Promise.all([
      downloadDesktopRelease(release(), options(directory, f.origin)),
      downloadDesktopRelease(release(), options(directory, f.origin)),
    ]);
    expect(f.requests).toHaveLength(2);
    expect(result[0]?.file).not.toBe(result[1]?.file);
  });
});

describe('Synthetic transport/fault boundaries with real staged filesystem', () => {
  it.each([null, '0', '-1', '1.5', 'NaN', '9007199254740992', String(data.length + 1)])(
    'rejects length %s before creating owned directory',
    async (length) => {
      const directory = await root();
      await expect(
        downloadDesktopRelease(release(), {
          ...options(directory),
          fetch: async () => response(data, length),
        }),
      ).rejects.toThrow('download_size');
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it.each(['overflow', 'short'])(
    'checks real stream bytes for %s independently of header',
    async (mode) => {
      const directory = await root();
      const bytes = mode === 'overflow' ? Buffer.concat([data, data]) : data.subarray(0, 2);
      await expect(
        downloadDesktopRelease(release(), {
          ...options(directory),
          fetch: async () => response(bytes, String(data.length)),
        }),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it.each([
    'http://other.invalid/file.exe',
    'https://user:pass@example.com',
    'https://example.test/path',
    'https://example.test?secret=1',
    'https://example.test/#x',
  ])('denies foreign metadata/origin %s before network', async (bad) => {
    const directory = await root();
    const fetcher = vi.fn();
    const raw = bad.endsWith('file.exe') ? { ...release(), url: bad } : release();
    await expect(
      downloadDesktopRelease(raw, {
        ...options(directory, bad.endsWith('file.exe') ? 'http://127.0.0.1:1' : bad),
        fetch: fetcher,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects foreign final response URL even on injected 200', async () => {
    const directory = await root();
    const res = response();
    Object.defineProperty(res, 'url', { value: 'http://other.invalid/file' });
    await expect(
      downloadDesktopRelease(release(), { ...options(directory), fetch: async () => res }),
    ).rejects.toThrow('download_http');
  });
  it('512MiB metadata boundary is independent of plugin200; no huge buffer allocated', async () => {
    const directory = await root();
    const fetcher = vi.fn(async () => {
      throw Error('fetch-boundary');
    });
    await expect(
      downloadDesktopRelease(
        { ...release(), size: DESKTOP_MAX_BYTES },
        { ...options(directory), fetch: fetcher },
      ),
    ).rejects.toThrow('fetch-boundary');
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockClear();
    await expect(
      downloadDesktopRelease(
        { ...release(), size: DESKTOP_MAX_BYTES + 1 },
        { ...options(directory), fetch: fetcher },
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('freezes offer/options/root/current/progress/fetch refs before await', async () => {
    const directory = await root();
    const foreign = await root();
    let deliver!: (value: Response) => void;
    const firstFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual', method: 'GET' });
      expect(init?.headers).toBeUndefined();
      return new Promise<Response>((yes) => {
        deliver = yes;
      });
    });
    const raw = release();
    const current = vi.fn(() => true);
    const progress = vi.fn();
    const o: DesktopDownloadOptions = {
      ...options(directory),
      current,
      onProgress: progress,
      fetch: firstFetch,
    };
    const pending = downloadDesktopRelease(raw, o);
    raw.size = 1;
    raw.url = '/wrong';
    raw.sha256 = '0'.repeat(64);
    raw.version = '9.9.9';
    o.root = foreign;
    o.current = () => false;
    o.onProgress = () => {
      throw Error('wrong callback');
    };
    o.fetch = vi.fn();
    o.serverOrigin = 'http://other.invalid';
    deliver(response());
    const receipt = await pending;
    expect(receipt.release).toEqual(release());
    expect(current).toHaveBeenCalled();
    expect(progress).toHaveBeenCalled();
    expect(await readFile(receipt.file)).toEqual(data);
    expect(await readdir(foreign)).toEqual([]);
  });
  it('aborted late fetch body is cancelled without touching staging', async () => {
    const directory = await root();
    const signal = new AbortController();
    let deliver!: (value: Response) => void;
    const cancelled = vi.fn();
    const pending = downloadDesktopRelease(release(), {
      ...options(directory),
      signal: signal.signal,
      fetch: () =>
        new Promise<Response>((yes) => {
          deliver = yes;
        }),
    });
    signal.abort();
    await expect(pending).rejects.toThrow('download_aborted');
    deliver(
      new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { 'content-length': String(data.length) },
      }),
    );
    await new Promise((yes) => setTimeout(yes, 0));
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(['stale', 'throw'])(
    'changed offer/server/destroyed current guard %s rejects late response',
    async (mode) => {
      const directory = await root();
      let live = true;
      let deliver!: (value: Response) => void;
      const pending = downloadDesktopRelease(release(), {
        ...options(directory),
        current: () => {
          if (!live && mode === 'throw') throw Error('destroyed');
          return live;
        },
        fetch: () =>
          new Promise<Response>((yes) => {
            deliver = yes;
          }),
      });
      live = false;
      deliver(response());
      await expect(pending).rejects.toThrow('download_stale');
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it.each(['write-fail', 'zero-write', 'stale-after-rename'])(
    'fault %s cleans only owned part/final file',
    async (mode) => {
      const directory = await root();
      fault.mode = mode;
      await writeFile(join(directory, 'foreign.bin'), 'preserve');
      await expect(
        downloadDesktopRelease(release(), { ...options(directory), fetch: async () => response() }),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual(['foreign.bin']);
    },
  );
  it('scope invalidation after actual chunk write cleans part without verified success', async () => {
    const directory = await root();
    const events: boolean[] = [];
    await expect(
      downloadDesktopRelease(release(), {
        ...options(directory),
        fetch: async () => response(),
        onProgress: (p) => {
          events.push(p.verified);
          fault.current = false;
        },
      }),
    ).rejects.toThrow('download_stale');
    expect(events).toEqual([false]);
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(['actual-id', 'high-id'])(
    'never renames/deletes a foreign part substitution (%s)',
    async (mode) => {
      const directory = await root();
      if (mode === 'high-id') {
        fault.mode = mode;
        expect(9007199254740992n).not.toBe(9007199254740993n);
        expect(Number(9007199254740992n)).toBe(Number(9007199254740993n));
      }
      let finish!: () => void;
      let written!: () => void;
      const writtenPromise = new Promise<void>((yes) => {
        written = yes;
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          finish = () => controller.close();
        },
      });
      const pending = downloadDesktopRelease(release(), {
        ...options(directory),
        fetch: async () =>
          new Response(stream, { headers: { 'content-length': String(data.length) } }),
        onProgress: () => written(),
      });
      await writtenPromise;
      const [child] = await readdir(directory);
      if (!child) throw Error('missing owned child');
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await fs.rename(
        join(directory, child, 'installer.part'),
        join(directory, child, 'moved-by-fixture'),
      );
      await writeFile(join(directory, child, 'installer.part'), 'foreign-substitution');
      fault.substituted = true;
      finish();
      await expect(pending).rejects.toThrow('download_part');
      expect(fault.renameCalls).toBe(0);
      if (mode === 'high-id') {
        expect(fault.bigintReads).toBeGreaterThan(5);
        expect(fault.numberReads).toBe(0);
      }
      expect(await readFile(join(directory, child, 'installer.part'), 'utf8')).toBe(
        'foreign-substitution',
      );
      expect(await readFile(join(directory, child, 'moved-by-fixture'))).toEqual(data);
    },
  );
  it('handles injected short writes by writing all actual bytes', async () => {
    const directory = await root();
    fault.mode = 'short-write';
    const receipt = await downloadDesktopRelease(release(), {
      ...options(directory),
      fetch: async () => response(),
    });
    expect(await readFile(receipt.file)).toEqual(data);
  });
  it('actual rename over nonempty directory preserves foreign sentinel and removes own part', async () => {
    const directory = await root();
    fault.mode = 'real-rename-fail';
    await expect(
      downloadDesktopRelease(release(), { ...options(directory), fetch: async () => response() }),
    ).rejects.toThrow();
    const [child] = await readdir(directory);
    if (!child) throw Error('sentinel directory lost');
    expect(await readdir(join(directory, child))).toEqual(['installer.exe']);
    expect(await readFile(join(directory, child, 'installer.exe', 'foreign.bin'), 'utf8')).toBe(
      'preserve',
    );
  });
  it('rejects junction root without writing/deleting foreign destination', async () => {
    const directory = await root();
    const foreign = await root();
    const link = join(directory, 'redirect');
    await writeFile(join(foreign, 'sentinel'), 'preserve');
    await symlink(foreign, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      downloadDesktopRelease(release(), { ...options(link), fetch: async () => response() }),
    ).rejects.toThrow('download_root');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readdir(foreign)).toEqual(['sentinel']);
    expect(await readFile(join(foreign, 'sentinel'), 'utf8')).toBe('preserve');
  });
  it('progress listener failure does not turn integrity success into failed download', async () => {
    const directory = await root();
    const receipt = await downloadDesktopRelease(release(), {
      ...options(directory),
      fetch: async () => response(),
      onProgress: () => {
        throw Error('UI observer');
      },
    });
    expect(await readFile(receipt.file)).toEqual(data);
  });
});
