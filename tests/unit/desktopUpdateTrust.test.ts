import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm, readFile, rename, link, utimes } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
import {
  inspectSignedDesktopFile,
  inspectDownloadedDesktopFile,
  revalidateDesktopPair,
  APPROVED_DESKTOP_PUBLISHER_DER_SHA256,
  type DesktopTrustOptions,
} from '../../src/main/desktop/updateTrust';
import {
  downloadDesktopRelease,
  discardDesktopDownload,
} from '../../src/main/desktop/downloadDesktop';
const base = resolve(__dirname, '../../private'),
  roots: string[] = [],
  hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + sep) || !root.includes('desktop-trust-'))
      throw Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'desktop-trust-'));
  roots.push(root);
  const app = join(root, 'Installed.exe'),
    setup = join(root, 'Setup.exe');
  await writeFile(app, 'INERT BASELINE');
  await writeFile(setup, 'INERT INSTALLER');
  const state = { current: true },
    options: DesktopTrustOptions = {
      publisherPins: ['a'.repeat(64)],
      current: () => state.current,
      pathAllowed: async () => true,
      verify: async (_p, h) => ({
        v: 1,
        verdict: 'valid',
        reason: 'verified',
        fileSha256: h,
        signerDerSha256: 'a'.repeat(64),
        winTrustCode: '00000000',
      }),
    };
  return { root, app, setup, state, options };
}
describe('Desktop trust: actual temp bytes with injected publisher oracle, never executable fixtures', () => {
  it('separate empty production policy denies before filesystem/helper IO', async () => {
    const f = await fixture(),
      pathAllowed = vi.fn(f.options.pathAllowed),
      verify = vi.fn(f.options.verify);
    await expect(
      inspectSignedDesktopFile(f.app, {
        ...f.options,
        publisherPins: APPROVED_DESKTOP_PUBLISHER_DER_SHA256,
        pathAllowed,
        verify,
      }),
    ).rejects.toThrow('update_publisher_unconfigured');
    expect(pathAllowed).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
  it('binds signed facts to exact bytes and rechecks the same approved identity', async () => {
    const f = await fixture(),
      baseline = await inspectSignedDesktopFile(f.app, f.options),
      installer = await inspectSignedDesktopFile(f.setup, f.options, {
        size: 15,
        sha256: hash(await readFile(f.setup)),
      });
    expect(Object.isFrozen(installer)).toBe(true);
    await expect(revalidateDesktopPair(baseline, installer, f.options)).resolves.toBeUndefined();
  });
  it.each(['app', 'setup'] as const)(
    'rejects changed %s bytes before launch authorization',
    async (which) => {
      const f = await fixture(),
        baseline = await inspectSignedDesktopFile(f.app, f.options),
        installer = await inspectSignedDesktopFile(f.setup, f.options);
      await writeFile(f[which], 'Changed');
      await expect(revalidateDesktopPair(baseline, installer, f.options)).rejects.toThrow(
        'update_file_changed',
      );
    },
  );
  it('rejects different signers even when both are currently approved', async () => {
    const f = await fixture();
    f.options.publisherPins = ['a'.repeat(64), 'b'.repeat(64)];
    f.options.verify = async (p, h) => ({
      v: 1,
      verdict: 'valid',
      reason: 'verified',
      fileSha256: h,
      signerDerSha256: (p === f.app ? 'a' : 'b').repeat(64),
      winTrustCode: '00000000',
    });
    const baseline = await inspectSignedDesktopFile(f.app, f.options),
      installer = await inspectSignedDesktopFile(f.setup, f.options);
    await expect(revalidateDesktopPair(baseline, installer, f.options)).rejects.toThrow(
      'update_publisher_changed',
    );
  });
  it('rejects revoked certificate and context cancellation at native boundary', async () => {
    const f = await fixture();
    f.options.verify = async (_p, h) => {
      f.state.current = false;
      return {
        v: 1,
        verdict: 'valid',
        reason: 'verified',
        fileSha256: h,
        signerDerSha256: 'a'.repeat(64),
        winTrustCode: '00000000',
      };
    };
    await expect(inspectSignedDesktopFile(f.app, f.options)).rejects.toThrow('stale_update');
    const g = await fixture(),
      baseline = await inspectSignedDesktopFile(g.app, g.options),
      installer = await inspectSignedDesktopFile(g.setup, g.options);
    g.options.publisherPins = ['c'.repeat(64)];
    await expect(revalidateDesktopPair(baseline, installer, g.options)).rejects.toThrow(
      'update_signature_invalid',
    );
  });
  it('rejects equal-byte file replacement during signature await using bigint identity', async () => {
    const f = await fixture(),
      original = f.options.verify;
    f.options.verify = async (p, h) => {
      const replacement = join(f.root, 'replacement.exe');
      await writeFile(replacement, await readFile(p));
      await rename(replacement, p);
      if (!original) throw Error('Fixture');
      return original(p, h);
    };
    await expect(inspectSignedDesktopFile(f.app, f.options)).rejects.toThrow('update_file_changed');
  });
  it('does not admit a hardlinked staged executable', async () => {
    const f = await fixture();
    await link(f.setup, join(f.root, 'another.exe'));
    await expect(inspectSignedDesktopFile(f.setup, f.options)).rejects.toThrow(
      'update_file_invalid',
    );
  });
  it('rejects same-size in-place bytes changed after signature verification', async () => {
    const f = await fixture(),
      original = f.options.verify;
    f.options.verify = async (p, h) => {
      if (!original) throw Error('Fixture');
      const signed = await original(p, h),
        bytes = await readFile(p);
      await writeFile(p, Buffer.alloc(bytes.length, 120));
      const time = Date.now() / 1000 + 2;
      await utimes(p, time, time);
      return signed;
    };
    await expect(inspectSignedDesktopFile(f.app, f.options)).rejects.toThrow('update_file_changed');
  });
  it('rechecks the baseline after the installer verification await', async () => {
    const f = await fixture(),
      baseline = await inspectSignedDesktopFile(f.app, f.options),
      installer = await inspectSignedDesktopFile(f.setup, f.options),
      original = f.options.verify;
    f.options.verify = async (p, h) => {
      if (!original) throw Error('Fixture');
      const signed = await original(p, h);
      if (p === f.setup) {
        const bytes = await readFile(f.app);
        await writeFile(f.app, Buffer.alloc(bytes.length, 120));
        const time = Date.now() / 1000 + 2;
        await utimes(f.app, time, time);
      }
      return signed;
    };
    await expect(revalidateDesktopPair(baseline, installer, f.options)).rejects.toThrow(
      'update_file_changed',
    );
  });
  it('binds installer admission to original download identity and preserves an equal-byte replacement', async () => {
    const f = await fixture(),
      bytes = Buffer.from('INERT UPDATE, NOT EXECUTABLE'),
      receipt = await downloadDesktopRelease(
        {
          version: '0.12.0',
          file: 'Schema Teams 0.12.0.exe',
          url: '/api/desktop/files/Schema%20Teams%200.12.0.exe',
          notes: '',
          sha256: hash(bytes),
          size: bytes.length,
        },
        {
          root: join(f.root, 'stage'),
          serverOrigin: 'https://example.test',
          current: () => true,
          fetch: async () =>
            new Response(bytes, { headers: { 'content-length': String(bytes.length) } }),
        },
      );
    expect((await inspectDownloadedDesktopFile(receipt, f.options)).sha256).toBe(hash(bytes));
    const replacement = join(f.root, 'replacement.exe');
    await writeFile(replacement, bytes);
    await rename(replacement, receipt.file);
    await expect(inspectDownloadedDesktopFile(receipt, f.options)).rejects.toThrow(
      'update_file_changed',
    );
    expect(await discardDesktopDownload(receipt)).toBe(false);
    expect(await readFile(receipt.file)).toEqual(bytes);
  });
});
