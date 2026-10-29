import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configuredServer,
  serverPartitionValid,
  supportedServerVersion,
} from '../../src/shared/serverConfiguration';
import { ServerConfigurationService } from '../../src/main/desktop/serverConfiguration';
import { switchServer } from '../../src/main/desktop/switchServer';
import { SettingsStore, normalizeSettings } from '../../src/main/settings';
import { requestValid } from '../../src/shared/requests';
const health = {
  ok: true as const,
  data: { status: 'ok' as const, db: 'ok' as const, version: '0.11.2-b' },
};
const next = 'http://next.example.test:8081';
function setup() {
  const readHealth = vi.fn().mockResolvedValue(health),
    activate = vi.fn().mockResolvedValue(undefined);
  const options = {
    current: new URL('https://old.example.test'),
    locked: false,
    readHealth,
    activate,
  };
  return { readHealth, activate, options, service: new ServerConfigurationService(options) };
}
afterEach(() => vi.useRealTimers());
describe('Server address and isolated storage', () => {
  it.each([
    'ftp://example.test',
    'https://u:p@example.org',
    'https://example.test/api',
    'https://example.test/?x=1',
    'https://example.test/#fragment',
    'https://example.test/\\x',
    'https://example.test\n',
    'javascript:alert(1)',
    '',
    'x'.repeat(2049),
  ])('rejects an ambiguous or unsafe address %s', (value) =>
    expect(configuredServer(value)).toBeNull(),
  );
  it('canonicalizes a root origin and compares the actual native API minimum', () => {
    expect(configuredServer(' https://EXAMPLE.test:443/ ')?.origin).toBe('https://example.test');
    for (const version of ['0.11.0', '0.11.2-b', '0.12.0', '1.0.0'])
      expect(supportedServerVersion(version)).toBe(true);
    for (const version of ['0.10.99', '0.9.0', 'oops', '0.11'])
      expect(supportedServerVersion(version)).toBe(false);
  });
  it('validates RPC and accepts only internally generated partition names in settings', () => {
    expect(requestValid({ kind: 'server.check', url: next })).toBe(true);
    expect(requestValid({ kind: 'server.apply', url: next, token: 'a'.repeat(36) })).toBe(true);
    for (const raw of [
      { kind: 'server.read', partition: 'persist:other' },
      { kind: 'server.check', url: next, headers: { cookie: 'secret' } },
      { kind: 'server.apply', url: next, token: 'oops' },
      { kind: 'settings.patch', patch: { serverUrl: next } },
    ])
      expect(requestValid(raw)).toBe(false);
    expect(normalizeSettings({ serverPartition: 'persist:other' }).serverPartition).toBeUndefined();
    expect(serverPartitionValid('persist:teams-12345678-1234-1234-1234-123456789abc')).toBe(true);
  });
  it('requires a fresh proof bound to the exact checked origin and consumes it once', async () => {
    const h = setup(),
      checked = await h.service.check(next);
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw Error();
    expect(h.readHealth.mock.calls[0]?.[0].origin).toBe(next);
    expect((await h.service.apply('https://other.example.test', checked.data.token)).ok).toBe(
      false,
    );
    expect((await h.service.apply(next, checked.data.token)).ok).toBe(true);
    expect((await h.service.apply(next, checked.data.token)).ok).toBe(false);
    expect(h.activate).toHaveBeenCalledTimes(1);
    expect(h.service.read()).toEqual({
      url: 'https://old.example.test',
      locked: false,
      minimumVersion: '0.11.0',
      notice: null,
    });
  });
  it('does not accept expired, old or destroyed proofs', async () => {
    vi.useFakeTimers();
    const h = setup(),
      first = await h.service.check(next);
    if (!first.ok) throw Error();
    await vi.advanceTimersByTimeAsync(300000);
    expect((await h.service.apply(next, first.data.token)).ok).toBe(false);
    const second = await h.service.check(next);
    if (!second.ok) throw Error();
    await h.service.check('bad');
    expect((await h.service.apply(next, second.data.token)).ok).toBe(false);
    const third = await h.service.check(next);
    if (!third.ok) throw Error();
    h.service.destroy();
    expect((await h.service.apply(next, third.data.token)).ok).toBe(false);
    expect(h.activate).not.toHaveBeenCalled();
  });
  it('ignores a late check superseded by another check or destroyed host', async () => {
    const h = setup();
    let resolve!: (value: typeof health) => void;
    h.readHealth.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const late = h.service.check(next);
    const current = await h.service.check('https://current.example.test');
    resolve(health);
    expect((await late).ok).toBe(false);
    if (!current.ok) throw Error();
    expect((await h.service.apply(current.data.url, current.data.token)).ok).toBe(true);
  });
  it('does not change address or reveal private transport errors on failure', async () => {
    const h = setup();
    h.readHealth.mockRejectedValueOnce(Error('private address and cookie'));
    expect(JSON.stringify(await h.service.check(next))).not.toContain('private');
    h.readHealth.mockResolvedValueOnce({ ...health, data: { ...health.data, version: '0.10.0' } });
    expect(await h.service.check(next)).toMatchObject({ ok: false, code: 'incompatible' });
    h.readHealth.mockResolvedValueOnce({ ...health, data: { ...health.data, db: 'down' } });
    expect((await h.service.check(next)).ok).toBe(false);
    expect(h.activate).not.toHaveBeenCalled();
  });
  it('environment override is read only, even after a successful health read', async () => {
    const h = setup(),
      service = new ServerConfigurationService({ ...h.options, locked: true });
    expect((await service.check(next)).ok).toBe(false);
    const check = await service.check('https://old.example.test');
    if (!check.ok) throw Error();
    expect((await service.apply(check.data.url, check.data.token)).ok).toBe(false);
    expect(h.activate).not.toHaveBeenCalled();
  });
  it('concurrent activation is serialized and failure requires a new health check', async () => {
    const h = setup();
    let reject!: (value: Error) => void;
    h.activate.mockImplementationOnce(
      () =>
        new Promise((_r, j) => {
          reject = j;
        }),
    );
    const check = await h.service.check(next);
    if (!check.ok) throw Error();
    const pending = h.service.apply(next, check.data.token);
    expect((await h.service.apply(next, check.data.token)).ok).toBe(false);
    reject(Error('private'));
    expect(await pending).toMatchObject({ ok: false, code: 'configuration_failed' });
    expect((await h.service.apply(next, check.data.token)).ok).toBe(false);
    expect(h.activate).toHaveBeenCalledTimes(1);
  });
});
describe('Server switch transaction', () => {
  it('stops before clearing and atomically saves a new partition while preserving general preferences', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'server-switch-'));
    try {
      const settings = new SettingsStore(join(dir, 'settings.json'));
      settings.update({
        serverUrl: 'https://old.example.test',
        theme: 'dark',
        autostart: false,
        recentTimeTaskIds: { '1': [3] },
        timerReminderSeen: { '1': '2026-10-29' },
      });
      const events: string[] = [];
      await switchServer(new URL(next), {
        settings,
        stop: () => events.push('stop'),
        clear: async () => {
          events.push('clear');
          expect(settings.get().serverUrl).toBe('https://old.example.test');
        },
        mount: () => {
          events.push('mount');
          expect(settings.get().serverUrl).toBe(next);
        },
      });
      expect(events).toEqual(['stop', 'clear', 'mount']);
      expect(serverPartitionValid(settings.get().serverPartition)).toBe(true);
      expect(settings.get()).toMatchObject({
        theme: 'dark',
        autostart: false,
        recentTimeTaskIds: {},
        timerReminderSeen: {},
      });
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).serverPartition).toBe(
        settings.get().serverPartition,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each(['clear', 'save'])(
    'recovers the old configured server after %s fails without mounting the target',
    async (point) => {
      const state = { serverUrl: 'https://old.example.test' },
        mount = vi.fn(),
        update = vi.fn(() => {
          if (point === 'save') throw Error('private');
        });
      await expect(
        switchServer(new URL(next), {
          settings: { get: () => state, update } as unknown as SettingsStore,
          stop: vi.fn(),
          clear: async () => {
            if (point === 'clear') throw Error('private');
          },
          mount,
        }),
      ).rejects.toThrow('configuration_failed');
      expect(state.serverUrl).toBe('https://old.example.test');
      expect(mount).toHaveBeenCalledTimes(1);
      expect(mount.mock.calls[0]?.[0]).toContain('Адрес не изменён');
      expect(JSON.stringify(mount.mock.calls)).not.toContain('private');
    },
  );
});
