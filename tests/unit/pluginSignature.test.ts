import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const { runner, appMock, osMock } = vi.hoisted(() => ({
  runner: vi.fn(),
  appMock: { isPackaged: false, getAppPath: () => 'C:/controlled-app' },
  osMock: { platform: (): string => 'win32' },
}));
vi.mock('node:child_process', () => ({ execFile: runner }));
vi.mock('electron', () => ({ app: appMock }));
vi.mock('node:os', () => osMock);
import {
  APPROVED_PLUGIN_PUBLISHER_DER_SHA256,
  evaluatePublisherTrust,
  verifyPluginSignature,
  verifyDesktopSignature,
} from '../../src/main/plugins/signature';

const hash = 'a'.repeat(64),
  pin = 'b'.repeat(64);
const valid = {
  v: 1,
  verdict: 'valid',
  reason: 'verified',
  fileSha256: hash,
  signerDerSha256: pin,
  winTrustCode: '00000000',
};
function answer(value: unknown) {
  runner.mockImplementation((_path, _args, _options, done) => done(null, JSON.stringify(value)));
}
beforeEach(() => {
  runner.mockReset();
  appMock.isPackaged = false;
  osMock.platform = () => 'win32';
});

describe('signature wrapper, mocked process runner (not WinTrust evidence)', () => {
  it('Desktop uses an explicit fixed purpose; plugins keep the original two arguments', async () => {
    answer(valid);
    expect((await verifyDesktopSignature('C:/stage/Setup.exe', hash)).verdict).toBe('valid');
    expect(runner.mock.calls[0]?.[1]).toEqual(['C:/stage/Setup.exe', hash, 'desktop']);
    await verifyPluginSignature('C:/stage/Plugin.dll', hash);
    expect(runner.mock.calls[1]?.[1]).toEqual(['C:/stage/Plugin.dll', hash]);
  });
  it('passes only controlled helper path and explicit bounded execFile options', async () => {
    answer(valid);
    expect((await verifyPluginSignature('C:/stage/plugin.dll', hash)).verdict).toBe('valid');
    expect(runner).toHaveBeenCalledWith(
      join('C:/controlled-app', 'dist/native/plugin-signature.exe'),
      ['C:/stage/plugin.dll', hash],
      { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 1024, encoding: 'utf8' },
      expect.any(Function),
    );
  });
  it('uses unpacked packaged helper', async () => {
    answer(valid);
    appMock.isPackaged = true;
    await verifyPluginSignature('C:/stage/plugin.dll', hash);
    expect(runner.mock.calls[0]?.[0]).toBe(
      join('C:/controlled-app.unpacked', 'dist/native/plugin-signature.exe'),
    );
  });
  it.each([
    'malformed',
    JSON.stringify({ ...valid, v: 2 }),
    JSON.stringify({ ...valid, extra: true }),
    JSON.stringify({ ...valid, fileSha256: pin }),
    JSON.stringify({ ...valid, winTrustCode: '800b010e' }),
    JSON.stringify({ ...valid, signerDerSha256: null }),
    JSON.stringify({ ...valid, verdict: 'unknown' }),
    '{"v":1,"v":1}',
    'x'.repeat(1025),
  ])('rejects invalid protocol %s', async (stdout) => {
    runner.mockImplementation((_path, _args, _options, done) => done(null, stdout));
    expect((await verifyPluginSignature('C:/stage/plugin.dll', hash)).verdict).toBe('unknown');
  });
  it.each(
    (['verdict', 'reason', 'fileSha256', 'signerDerSha256', 'winTrustCode'] as const).flatMap(
      (field) => [
        { field, value: [valid[field]], shape: 'array' },
        { field, value: { value: valid[field] }, shape: 'object' },
        { field, value: null, shape: 'null' },
      ],
    ),
  )('rejects $shape instead of primitive $field in a positive result', async ({ field, value }) => {
    answer({ ...valid, [field]: value });
    const verdict = await verifyPluginSignature('C:/stage/plugin.dll', hash);
    expect(verdict.verdict).toBe('unknown');
    expect(evaluatePublisherTrust(verdict, [pin])).toBe(false);
  });
  it.each(
    (['verdict', 'reason'] as const).flatMap((field) => [
      { field, value: [field === 'verdict' ? 'invalid' : 'input'], shape: 'array' },
      { field, value: { value: field === 'verdict' ? 'invalid' : 'input' }, shape: 'object' },
      { field, value: null, shape: 'null' },
    ]),
  )('rejects $shape instead of primitive $field in a negative result', async ({ field, value }) => {
    answer({
      v: 1,
      verdict: 'invalid',
      reason: 'input',
      fileSha256: null,
      signerDerSha256: null,
      winTrustCode: null,
      [field]: value,
    });
    const verdict = await verifyPluginSignature('C:/stage/plugin.dll', hash);
    expect(verdict.verdict).toBe('unknown');
    expect(evaluatePublisherTrust(verdict, [pin])).toBe(false);
  });
  it.each([{ value: [pin] }, { value: { pin } }, { value: null }])(
    'rejects a nonprimitive approved pin $value',
    async ({ value }) => {
      answer(valid);
      const verdict = await verifyPluginSignature('C:/stage/plugin.dll', hash);
      expect(evaluatePublisherTrust(verdict, [value] as unknown as string[])).toBe(false);
    },
  );
  it.each(['ETIMEDOUT', 'ENOENT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])(
    'process failure %s rejects valid-looking stdout',
    async (code) => {
      runner.mockImplementation((_path, _args, _options, done) =>
        done(Object.assign(new Error('fixture'), { code }), JSON.stringify(valid)),
      );
      expect((await verifyPluginSignature('C:/stage/plugin.dll', hash)).verdict).toBe('unknown');
    },
  );
  it('synchronous spawn failure is unknown', async () => {
    runner.mockImplementation(() => {
      throw new Error('fixture');
    });
    expect((await verifyPluginSignature('C:/stage/plugin.dll', hash)).verdict).toBe('unknown');
  });
  it('unsupported platform never spawns', async () => {
    osMock.platform = () => 'linux';
    expect((await verifyPluginSignature('C:/stage/plugin.dll', hash)).verdict).toBe('unsupported');
    expect(runner).not.toHaveBeenCalled();
  });
  it.each([
    ['relative.dll', hash],
    ['C:/stage/plugin.dll', ''],
    ['C:/stage/plugin.dll', 'A'.repeat(64)],
  ])('bad inputs never spawn', async (path, expected) => {
    expect((await verifyPluginSignature(path, expected)).verdict).toBe('invalid');
    expect(runner).not.toHaveBeenCalled();
  });
  it('publisher admission requires actual valid result AND explicit nonempty matching pins', async () => {
    answer(valid);
    const verdict = await verifyPluginSignature('C:/stage/plugin.dll', hash);
    expect(APPROVED_PLUGIN_PUBLISHER_DER_SHA256).toEqual([]);
    expect(evaluatePublisherTrust(verdict, APPROVED_PLUGIN_PUBLISHER_DER_SHA256)).toBe(false);
    expect(evaluatePublisherTrust(verdict, ['c'.repeat(64)])).toBe(false);
    expect(evaluatePublisherTrust(verdict, [pin])).toBe(true);
    expect(evaluatePublisherTrust({ ...verdict, verdict: 'unknown' }, [pin])).toBe(false);
    expect(evaluatePublisherTrust(verdict, [pin, 'bad'])).toBe(false);
  });
});
