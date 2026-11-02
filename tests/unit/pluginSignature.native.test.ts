// Opt-in local oracle: skips when this isolated Windows evidence setup is absent.
// Unlike pluginSignature.test.ts, child_process and the OS verifier are REAL here.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
const { appRoot } = vi.hoisted(() => ({ appRoot: process.cwd() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => appRoot } }));
import {
  APPROVED_PLUGIN_PUBLISHER_DER_SHA256,
  evaluatePublisherTrust,
  verifyPluginSignature,
} from '../../src/main/plugins/signature';

const evidencePath = join(appRoot, 'private/plugin-signature-native-evidence.json');
type Case = {
  name: string;
  file: string;
  expectedSha256: string;
  output: {
    verdict: string;
    reason: string;
    signerDerSha256: string | null;
    winTrustCode: string | null;
  };
};
const cases: Case[] = existsSync(evidencePath)
  ? JSON.parse(readFileSync(evidencePath, 'utf8')).results
  : [];
const enabled =
  process.platform === 'win32' &&
  cases.length > 0 &&
  existsSync(join(appRoot, 'dist/native/plugin-signature.exe'));
describe.skipIf(!enabled)('real Windows helper through production TS wrapper', () => {
  it('real embedded positive remains blocked by empty/wrong publisher policy', async () => {
    const positive = cases[0];
    if (!positive) throw new Error('Missing native positive evidence');
    const verdict = await verifyPluginSignature(positive.file, positive.expectedSha256);
    expect(verdict.verdict).toBe('valid');
    expect(verdict.signerDerSha256).toBe(positive.output.signerDerSha256);
    expect(evaluatePublisherTrust(verdict, APPROVED_PLUGIN_PUBLISHER_DER_SHA256)).toBe(false);
    expect(evaluatePublisherTrust(verdict, ['0'.repeat(64)])).toBe(false);
    // Explicit in-test pin only. This does not change the production immutable empty policy.
    if (!verdict.signerDerSha256) throw new Error('Missing verified signer');
    expect(evaluatePublisherTrust(verdict, [verdict.signerDerSha256])).toBe(true);
  });
  it.each(cases.filter((item) => item.output.verdict === 'invalid'))(
    'native rejection: $name',
    async (item) => {
      const verdict = await verifyPluginSignature(item.file, item.expectedSha256);
      expect(verdict.verdict).toBe('invalid');
      expect(verdict.reason).toBe(item.output.reason);
      expect(verdict.signerDerSha256).toBeNull();
      expect(evaluatePublisherTrust(verdict, ['0'.repeat(64)])).toBe(false);
    },
  );
});
