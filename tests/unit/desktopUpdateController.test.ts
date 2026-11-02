import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm, readdir, readFile, utimes, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
import {
  DesktopUpdateController,
  type DesktopUpdateContext,
  type DesktopDraftSummary,
  type DesktopUpdateControllerOptions,
} from '../../src/main/desktop/updateController';
import type { DesktopRelease } from '../../src/shared/updates';
import { APPROVED_DESKTOP_PUBLISHER_DER_SHA256 } from '../../src/main/desktop/updateTrust';

const base = resolve(__dirname, '../../private'),
  roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + sep) || !root.includes('updater-controller-'))
      throw Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'updater-controller-'));
  roots.push(root);
  const executable = join(root, 'Installed.exe'),
    body = Buffer.from('INERT INSTALLER');
  await writeFile(executable, 'INERT BASELINE');
  const context: DesktopUpdateContext = {
    stamp: 'owner-A',
    document: 'document-A',
    serverOrigin: 'http://localhost:43210',
    currentVersion: '0.12.0',
    executable,
    windows: true,
    packaged: true,
  };
  const release: DesktopRelease = {
    version: '0.13.0',
    file: 'Setup.exe',
    url: '/api/desktop/files/Setup.exe',
    notes: 'Update',
    size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
  const f = {
    root,
    executable,
    body,
    context,
    release,
    pins: ['a'.repeat(64)] as readonly string[],
    latest: release as unknown | null,
    readHook: undefined as (() => Promise<void>) | undefined,
    verifyHook: undefined as ((path: string) => Promise<void>) | undefined,
    signer: (() => 'a'.repeat(64)) as (path: string) => string,
    busy: false,
    leaseCurrent: true,
    monotonic: 0,
    read: vi.fn(async () => {
      await f.readHook?.();
      return f.latest;
    }),
    verify: vi.fn(async (path: string, hash: string) => {
      await f.verifyHook?.(path);
      return {
        v: 1 as const,
        verdict: 'valid' as const,
        reason: 'verified' as const,
        fileSha256: hash,
        signerDerSha256: f.signer(path),
        winTrustCode: '00000000',
      };
    }),
    fetch: vi.fn(
      async () =>
        new Response(new Uint8Array(body), {
          status: 200,
          headers: { 'content-length': String(body.length) },
        }),
    ),
    handoff: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
    quit: vi.fn(),
    releaseLease: vi.fn(),
    changed: vi.fn(),
    options: undefined as unknown as DesktopUpdateControllerOptions,
    controller: undefined as unknown as DesktopUpdateController,
    offer: '',
  };
  f.options = {
    context: () => ({ ...f.context }),
    now: () => f.monotonic,
    publisherPins: () => f.pins,
    stagingRoot: join(root, 'downloads'),
    readLatest: f.read,
    acquireQuiescence: () =>
      f.busy ? null : { current: () => f.leaseCurrent, release: f.releaseLease },
    handoff: f.handoff,
    quit: f.quit,
    onChange: f.changed,
    fetch: f.fetch as typeof fetch,
    pathAllowed: async () => true,
    verify: f.verify,
  };
  f.controller = new DesktopUpdateController(f.options);
  f.offer = f.controller.setOffer(release, 'owner-A') ?? '';
  f.controller.reportDrafts('document-A', 'owner-A', {
    revision: 0,
    dirtyCount: 1,
    editorsOpen: 0,
    busy: false,
  });
  return f;
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.controller.prepare(f.offer);
  expect(state.phase).toBe('ready');
  if (!state.jobId) throw Error('missing job');
  return state.jobId;
}
function confirm(f: Awaited<ReturnType<typeof fixture>>, job: string) {
  const state = f.controller.requestLaunch(job);
  expect(state.phase).toBe('confirming');
  if (!state.challenge) throw Error('missing challenge');
  return state.challenge.id;
}
async function stagedFile(f: Awaited<ReturnType<typeof fixture>>) {
  const root = join(f.root, 'downloads'),
    names = await readdir(root);
  expect(names).toHaveLength(1);
  return join(root, names[0] ?? '', 'installer.exe');
}
function changeContext(
  f: Awaited<ReturnType<typeof fixture>>,
  patch: Partial<DesktopUpdateContext>,
) {
  Object.assign(f.context, patch);
}

describe('Desktop updater orchestration: inert temp files, injected signer, runner spy only', () => {
  it('coalesces prepare, verifies twice, sends exact owned path once then quits only after spawn', async () => {
    const f = await fixture(),
      a = f.controller.prepare(f.offer),
      b = f.controller.prepare(f.offer);
    expect(a).toBe(b);
    const state = await a,
      job = state.jobId ?? '';
    expect(state.phase).toBe('ready');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.handoff).not.toHaveBeenCalled();
    const setup = await stagedFile(f),
      challenge = confirm(f, job);
    const wait = deferred();
    f.handoff.mockImplementation(async (path) => {
      expect(path).toBe(setup);
      await wait.promise;
    });
    const ack = f.controller.acknowledge(challenge, 'discard');
    await vi.waitFor(() => expect(f.handoff).toHaveBeenCalledTimes(1));
    expect(f.controller.state.phase).toBe('handing-off');
    expect(f.quit).not.toHaveBeenCalled();
    expect(await f.controller.cancel(job)).toBe(false);
    expect(f.controller.setOffer({ ...f.release, notes: 'new' }, 'owner-A')).toBeNull();
    await f.controller.acknowledge(challenge, 'discard');
    wait.resolve();
    expect((await ack).phase).toBe('handed-off');
    expect(f.quit).toHaveBeenCalledTimes(1);
    expect(f.releaseLease).toHaveBeenCalledTimes(1);
    expect(f.verify).toHaveBeenCalledTimes(4);
    expect(f.read).toHaveBeenCalledTimes(3);
    expect(await readFile(setup)).toEqual(f.body);
    await f.controller.acknowledge(challenge, 'discard');
    expect(f.handoff).toHaveBeenCalledTimes(1);
    const projection = JSON.stringify(f.changed.mock.calls);
    expect(projection).not.toContain(f.root);
    expect(projection).not.toContain(f.release.sha256);
    expect(projection).not.toContain(f.pins[0]);
  });
  it.each(['windows', 'packaged'] as const)(
    'denies %s=false before helper/network/staging',
    async (key) => {
      const f = await fixture();
      changeContext(f, { [key]: false });
      f.offer = f.controller.setOffer(f.release, 'owner-A') ?? '';
      expect((await f.controller.prepare(f.offer)).error).toBe('update_environment');
      expect(f.verify).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
      await expect(readdir(join(f.root, 'downloads'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('empty production publisher policy denies before helper/network/staging', async () => {
    const f = await fixture();
    f.pins = APPROVED_DESKTOP_PUBLISHER_DER_SHA256;
    f.offer = f.controller.setOffer(f.release, 'owner-A') ?? '';
    expect((await f.controller.prepare(f.offer)).error).toBe('update_publisher_unconfigured');
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(readdir(join(f.root, 'downloads'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('a signed candidate cannot bootstrap an unapproved installed baseline', async () => {
    const f = await fixture();
    f.signer = () => 'b'.repeat(64);
    expect((await f.controller.prepare(f.offer)).error).toBe('update_signature_invalid');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it('different approved candidate and baseline DER deny and clean up owned bytes', async () => {
    const f = await fixture();
    f.pins = ['a'.repeat(64), 'b'.repeat(64)];
    f.signer = (path) => (path === f.executable ? 'a' : 'b').repeat(64);
    f.offer = f.controller.setOffer(f.release, 'owner-A') ?? '';
    expect((await f.controller.prepare(f.offer)).error).toBe('update_publisher_changed');
    expect(await readdir(join(f.root, 'downloads'))).toEqual([]);
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it.each(['sha256', 'file', 'url', 'size', 'notes', 'version'] as const)(
    'same offer cannot authorize changed latest.%s',
    async (field) => {
      const f = await fixture(),
        job = await ready(f);
      f.latest = {
        ...f.release,
        [field]:
          field === 'size'
            ? f.release.size + 1
            : field === 'sha256'
              ? 'b'.repeat(64)
              : field === 'version'
                ? '0.13.1'
                : 'changed',
      };
      const result = await f.controller.acknowledge(confirm(f, job), 'discard');
      expect(result.phase).toBe('error');
      expect(f.handoff).not.toHaveBeenCalled();
      expect(f.quit).not.toHaveBeenCalled();
      expect(f.releaseLease).toHaveBeenCalledTimes(1);
    },
  );
  it('freezes full offer and constructor callbacks before awaits', async () => {
    const f = await fixture(),
      original = { ...f.release };
    f.release.notes = 'mutated caller';
    f.latest = original;
    f.options.handoff = async () => {
      throw Error('mutated constructor callback');
    };
    const job = await ready(f);
    expect((await f.controller.acknowledge(confirm(f, job), 'discard')).phase).toBe('handed-off');
    expect(f.handoff).toHaveBeenCalledTimes(1);
  });
  it('late former-owner offer cannot replace a current offer; no_release removes it', async () => {
    const f = await fixture();
    changeContext(f, { stamp: 'owner-B' });
    expect(f.controller.setOffer(f.release, 'owner-A')).toBeNull();
    expect(f.controller.state.offerId).toBe(f.offer);
    expect((await f.controller.prepare(f.offer)).error).toBe('stale_update');
    const newOffer = f.controller.setOffer(f.release, 'owner-B');
    expect(newOffer).not.toBe(f.offer);
    expect(f.controller.setOffer(null, 'owner-B')).toBeNull();
    expect(f.controller.state.offerId).toBeNull();
  });
  it.each(['0.12.0', '0.11.0', 'invalid'])(
    'equal/older/invalid %s never grants an offer',
    async (version) => {
      const f = await fixture();
      expect(f.controller.setOffer({ ...f.release, version }, 'owner-A')).toBeNull();
      expect(f.controller.state.offerId).toBeNull();
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['stamp', 'document', 'serverOrigin', 'currentVersion', 'executable'] as const)(
    'changed context %s blocks old job',
    async (key) => {
      const f = await fixture(),
        job = await ready(f);
      changeContext(f, { [key]: key === 'currentVersion' ? '0.12.1' : 'changed' });
      expect(f.controller.requestLaunch(job).error).toBe('stale_update');
      expect(f.handoff).not.toHaveBeenCalled();
      expect(f.quit).not.toHaveBeenCalled();
      await f.controller.cancel(job);
    },
  );
  it('revoked publisher pins invalidate a ready job', async () => {
    const f = await fixture(),
      job = await ready(f);
    f.pins = [];
    expect(f.controller.requestLaunch(job).error).toBe('stale_update');
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it('cancellation during candidate helper finishes its lease before deleting only own artifact', async () => {
    const f = await fixture(),
      wait = deferred(),
      entered = deferred();
    f.verifyHook = async (path) => {
      if (path !== f.executable) {
        entered.resolve();
        await wait.promise;
      }
    };
    const flight = f.controller.prepare(f.offer);
    await entered.promise;
    const job = f.controller.state.jobId ?? '',
      setup = await stagedFile(f);
    expect(await f.controller.cancel(job)).toBe(true);
    expect(await readFile(setup)).toEqual(f.body); // Helper still owns its lease.
    wait.resolve();
    await flight;
    await expect(readFile(setup)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.controller.state.phase).toBe('idle');
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it('a late cancelled prepare cannot overwrite a successor offer', async () => {
    const f = await fixture(),
      wait = deferred(),
      entered = deferred();
    f.readHook = async () => {
      entered.resolve();
      await wait.promise;
    };
    const flight = f.controller.prepare(f.offer);
    await entered.promise;
    const next = f.controller.setOffer({ ...f.release, notes: 'replacement' }, 'owner-A');
    wait.resolve();
    await flight;
    expect(f.controller.state.offerId).toBe(next);
    expect(f.controller.state.phase).toBe('idle');
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('missing renderer summary, busy work and open editors cannot be discarded', async () => {
    const f = await fixture(),
      job = await ready(f);
    const summary: DesktopDraftSummary = { revision: 1, dirtyCount: 0, editorsOpen: 0, busy: true };
    expect(f.controller.reportDrafts('wrong-document', 'owner-A', summary)).toBe(false);
    expect(f.controller.reportDrafts('document-A', 'owner-A', summary)).toBe(true);
    expect(f.controller.requestLaunch(job).error).toBe('update_busy');
    f.controller.reportDrafts('document-A', 'owner-A', {
      ...summary,
      revision: 2,
      busy: false,
      editorsOpen: 1,
    });
    expect(f.controller.requestLaunch(job).error).toBe('update_busy');
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it('a new controller without any renderer summary cannot request a launch', async () => {
    const f = await fixture();
    f.controller = new DesktopUpdateController(f.options);
    f.offer = f.controller.setOffer(f.release, 'owner-A') ?? '';
    const job = await ready(f);
    expect(f.controller.requestLaunch(job).error).toBe('update_drafts_changed');
    await f.controller.acknowledge(f.offer, 'discard');
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it('ready alone is not permission; random or old challenge IDs cannot launch', async () => {
    const f = await fixture();
    const job = await ready(f);
    await f.controller.acknowledge(job, 'discard');
    expect(f.controller.state.phase).toBe('ready');
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it.each(['unpublished', 'read-failure'])(
    'final latest %s denies without quitting',
    async (mode) => {
      const f = await fixture(),
        job = await ready(f);
      if (mode === 'unpublished') f.latest = null;
      else
        f.readHook = async () => {
          throw Error(f.executable);
        };
      const result = await f.controller.acknowledge(confirm(f, job), 'discard');
      expect(result.phase).toBe('error');
      expect(f.handoff).not.toHaveBeenCalled();
      expect(f.quit).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(f.root);
      expect(f.releaseLease).toHaveBeenCalledTimes(1);
    },
  );
  it('republication at the same version creates a different offer and cancels the old artifact', async () => {
    const f = await fixture(),
      job = await ready(f),
      setup = await stagedFile(f);
    const next = f.controller.setOffer({ ...f.release, sha256: 'b'.repeat(64) }, 'owner-A');
    expect(next).not.toBe(f.offer);
    expect(f.controller.requestLaunch(job).phase).toBe('idle');
    expect(f.handoff).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      await expect(readFile(setup)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
  it('explicit cancellation of a ready job deletes its exact owned artifact', async () => {
    const f = await fixture(),
      job = await ready(f),
      setup = await stagedFile(f);
    expect(await f.controller.cancel(job)).toBe(true);
    await expect(readFile(setup)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.controller.cancel(job)).toBe(false);
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it('hidden drafts are counted; stale/equal-revision changes rejected; new revision cancels challenge', async () => {
    const f = await fixture(),
      job = await ready(f);
    f.controller.reportDrafts('document-A', 'owner-A', {
      revision: 3,
      dirtyCount: 5,
      editorsOpen: 0,
      busy: false,
    });
    const challenge = confirm(f, job);
    expect(f.controller.state.challenge?.dirtyCount).toBe(5);
    expect(
      f.controller.reportDrafts('document-A', 'owner-A', {
        revision: 2,
        dirtyCount: 0,
        editorsOpen: 0,
        busy: false,
      }),
    ).toBe(false);
    expect(
      f.controller.reportDrafts('document-A', 'owner-A', {
        revision: 3,
        dirtyCount: 0,
        editorsOpen: 0,
        busy: false,
      }),
    ).toBe(false);
    f.controller.reportDrafts('document-A', 'owner-A', {
      revision: 4,
      dirtyCount: 6,
      editorsOpen: 0,
      busy: false,
    });
    expect(f.controller.state.phase).toBe('ready');
    await f.controller.acknowledge(challenge, 'discard');
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it('explicit decline consumes challenge without deleting the prepared job', async () => {
    const f = await fixture(),
      job = await ready(f),
      setup = await stagedFile(f),
      challenge = confirm(f, job);
    expect((await f.controller.acknowledge(challenge, 'cancel')).phase).toBe('ready');
    await f.controller.acknowledge(challenge, 'discard');
    expect(f.handoff).not.toHaveBeenCalled();
    expect(await readFile(setup)).toEqual(f.body);
    expect(confirm(f, job)).not.toBe(challenge);
  });
  it('main quiescence denial blocks a direct ACK even with a clean renderer', async () => {
    const f = await fixture(),
      job = await ready(f),
      challenge = confirm(f, job);
    f.busy = true;
    expect((await f.controller.acknowledge(challenge, 'discard')).error).toBe('update_busy');
    expect(f.handoff).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled();
  });
  it('a new draft during final latest read aborts, releases main gate and preserves the app', async () => {
    const f = await fixture(),
      job = await ready(f),
      challenge = confirm(f, job),
      wait = deferred(),
      entered = deferred();
    f.readHook = async () => {
      entered.resolve();
      await wait.promise;
    };
    const ack = f.controller.acknowledge(challenge, 'discard');
    await entered.promise;
    f.controller.reportDrafts('document-A', 'owner-A', {
      revision: 1,
      dirtyCount: 2,
      editorsOpen: 0,
      busy: false,
    });
    wait.resolve();
    await ack;
    expect(f.handoff).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled();
    expect(f.releaseLease).toHaveBeenCalledTimes(1);
    expect(await readdir(join(f.root, 'downloads'))).toEqual([]);
  });
  it.each(['baseline', 'candidate'] as const)(
    'final %s same-size mutation cannot launch',
    async (which) => {
      const f = await fixture(),
        job = await ready(f),
        setup = await stagedFile(f);
      const target = which === 'baseline' ? f.executable : setup;
      let installerChecks = 0;
      f.verifyHook = async (path) => {
        if (path !== f.executable && ++installerChecks === 1) {
          const original = await readFile(target);
          await writeFile(target, Buffer.alloc(original.length, 88));
          const time = new Date(Date.now() + 2000);
          await utimes(target, time, time);
        }
      };
      expect((await f.controller.acknowledge(confirm(f, job), 'discard')).phase).toBe('error');
      expect(f.handoff).not.toHaveBeenCalled();
      expect(f.quit).not.toHaveBeenCalled();
      if (which === 'candidate') expect((await readFile(setup))[0]).toBe(88); // Uncertain bytes retained.
    },
  );
  it('equal bytes at a replacement candidate identity are preserved and never handed off', async () => {
    const f = await fixture(),
      job = await ready(f),
      setup = await stagedFile(f);
    const replacement = join(f.root, 'Replacement.exe');
    await writeFile(replacement, f.body);
    await rename(replacement, setup);
    expect((await f.controller.acknowledge(confirm(f, job), 'discard')).error).toBe(
      'update_file_changed',
    );
    expect(f.handoff).not.toHaveBeenCalled();
    expect(await readFile(setup)).toEqual(f.body);
  });
  it('losing quiescence during native await denies handoff', async () => {
    const f = await fixture(),
      job = await ready(f);
    f.verifyHook = async () => {
      f.leaseCurrent = false;
    };
    expect((await f.controller.acknowledge(confirm(f, job), 'discard')).error).toBe('update_busy');
    expect(f.handoff).not.toHaveBeenCalled();
    expect(f.releaseLease).toHaveBeenCalledTimes(1);
  });
  it('expired confirmation denies handoff and consumes permission', async () => {
    const f = await fixture(),
      job = await ready(f),
      challenge = confirm(f, job);
    f.monotonic += 6 * 60 * 1000;
    expect((await f.controller.acknowledge(challenge, 'discard')).error).toBe(
      'update_drafts_changed',
    );
    expect(f.handoff).not.toHaveBeenCalled();
  });
  it('wall-clock rollback cannot extend a confirmation during a final await', async () => {
    const f = await fixture(),
      job = await ready(f),
      challenge = confirm(f, job),
      wait = deferred(),
      entered = deferred();
    f.readHook = async () => {
      entered.resolve();
      await wait.promise;
    };
    const ack = f.controller.acknowledge(challenge, 'discard');
    await entered.promise;
    vi.spyOn(Date, 'now').mockReturnValue(0);
    f.monotonic = 6 * 60 * 1000;
    wait.resolve();
    expect((await ack).error).toBe('update_drafts_changed');
    expect(f.handoff).not.toHaveBeenCalled();
    expect(f.releaseLease).toHaveBeenCalledTimes(1);
  });
  it.each([-1, NaN, Infinity])('invalid/backward monotonic %s fails closed', async (now) => {
    const f = await fixture(),
      job = await ready(f),
      challenge = confirm(f, job);
    f.monotonic = now;
    expect((await f.controller.acknowledge(challenge, 'discard')).error).toBe(
      'update_drafts_changed',
    );
    expect(f.handoff).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled();
  });
  it('same-document new owner cannot reuse the previous owner draft summary or delayed report', async () => {
    const f = await fixture();
    changeContext(f, { stamp: 'owner-B' });
    f.offer = f.controller.setOffer(f.release, 'owner-B') ?? '';
    const job = await ready(f);
    expect(f.controller.requestLaunch(job).error).toBe('update_drafts_changed');
    expect(
      f.controller.reportDrafts('document-A', 'owner-A', {
        revision: 50,
        dirtyCount: 0,
        editorsOpen: 0,
        busy: false,
      }),
    ).toBe(false);
    expect(f.controller.requestLaunch(job).error).toBe('update_drafts_changed');
    expect(f.handoff).not.toHaveBeenCalled();
    expect(
      f.controller.reportDrafts('document-A', 'owner-B', {
        revision: 0,
        dirtyCount: 2,
        editorsOpen: 0,
        busy: false,
      }),
    ).toBe(true);
    expect(f.controller.requestLaunch(job).challenge?.dirtyCount).toBe(2);
  });
  it.each(['sync', 'async'])(
    'runner %s failure does not quit or retain launch permission',
    async (kind) => {
      const f = await fixture(),
        job = await ready(f),
        setup = await stagedFile(f),
        challenge = confirm(f, job);
      f.handoff.mockImplementation(() => {
        if (kind === 'sync') throw Error(setup);
        return Promise.reject(Error(setup));
      });
      const result = await f.controller.acknowledge(challenge, 'discard');
      expect(result.error).toBe('update_spawn_failed');
      expect(f.quit).not.toHaveBeenCalled();
      expect(f.releaseLease).toHaveBeenCalledTimes(1);
      await expect(readFile(setup)).rejects.toMatchObject({ code: 'ENOENT' });
      await f.controller.acknowledge(challenge, 'discard');
      expect(f.handoff).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain(setup);
    },
  );
  it('destroy during final await cancels permission and cleans only exact owned bytes', async () => {
    const f = await fixture(),
      job = await ready(f),
      wait = deferred(),
      entered = deferred();
    f.readHook = async () => {
      entered.resolve();
      await wait.promise;
    };
    const ack = f.controller.acknowledge(confirm(f, job), 'discard');
    await entered.promise;
    f.controller.destroy();
    wait.resolve();
    await ack;
    expect(f.handoff).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled();
    expect(f.releaseLease).toHaveBeenCalledTimes(1);
    expect(f.controller.setOffer(f.release, 'owner-A')).toBeNull();
  });
});
