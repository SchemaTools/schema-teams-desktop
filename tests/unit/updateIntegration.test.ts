import { describe, expect, it } from 'vitest';
import { UpdateShutdown } from '../../src/main/desktop/updateShutdown';
import { requestValid } from '../../src/shared/requests';
import { updateDraftFacts } from '../../src/renderer/updateDrafts';
const uuid = '12345678-1234-4234-8234-123456789abc';
describe('Process-wide update shutdown ownership', () => {
  it('denies concurrent owners and replacement; an old release cannot release the next owner', () => {
    const gate = new UpdateShutdown(),
      first = gate.acquire(() => true);
    expect(first?.current()).toBe(true);
    expect(gate.locked).toBe(true);
    expect(gate.acquire(() => true)).toBeNull();
    expect(() => gate.assertMayReplace()).toThrow('update_in_progress');
    first?.release();
    const next = gate.acquire(() => true);
    first?.release();
    expect(first?.current()).toBe(false);
    expect(next?.current()).toBe(true);
    expect(gate.locked).toBe(true);
    next?.release();
    expect(() => gate.assertMayReplace()).not.toThrow();
  });
  it('late readiness failure invalidates a lease but still prevents replacement until its owner releases', async () => {
    const gate = new UpdateShutdown();
    let ready = true;
    const lease = gate.acquire(() => ready);
    await Promise.resolve();
    ready = false;
    expect(lease?.current()).toBe(false);
    expect(() => gate.assertMayReplace()).toThrow();
    lease?.release();
    expect(gate.locked).toBe(false);
  });
  it('busy and throwing readiness checks do not acquire', () => {
    const gate = new UpdateShutdown();
    expect(gate.acquire(() => false)).toBeNull();
    expect(
      gate.acquire(() => {
        throw Error('injected');
      }),
    ).toBeNull();
    expect(gate.locked).toBe(false);
  });
});
describe('Updater strict public IPC contains intents and summaries only', () => {
  it.each([
    { kind: 'updates.prepare', offerId: uuid },
    { kind: 'updates.cancel', jobId: uuid },
    { kind: 'updates.requestLaunch', jobId: uuid },
    { kind: 'updates.acknowledge', challengeId: uuid, decision: 'discard' },
    { kind: 'updates.acknowledge', challengeId: uuid, decision: 'cancel' },
    {
      kind: 'updates.drafts',
      contextId: uuid,
      revision: 0,
      dirtyCount: 2,
      editorsOpen: 1,
      busy: false,
    },
    { kind: 'updates.trayDrafts', contextId: uuid, revision: 1, dirtyCount: 0, busy: true },
  ])('accepts a minimal intent %j', (raw) => expect(requestValid(raw)).toBe(true));
  it.each([
    { kind: 'updates.prepare', offerId: uuid, path: 'foreign.exe' },
    { kind: 'updates.prepare', offerId: uuid, sha256: 'a'.repeat(64) },
    { kind: 'updates.prepare', offerId: uuid, epoch: 1 },
    { kind: 'updates.prepare', offerId: 'forged' },
    { kind: 'updates.cancel', jobId: uuid, args: [] },
    { kind: 'updates.requestLaunch', jobId: uuid, publisherPins: [] },
    { kind: 'updates.acknowledge', challengeId: uuid, decision: ['discard'] },
    { kind: 'updates.acknowledge', challengeId: uuid, decision: true },
    {
      kind: 'updates.drafts',
      contextId: uuid,
      revision: NaN,
      dirtyCount: 0,
      editorsOpen: 0,
      busy: false,
    },
    {
      kind: 'updates.drafts',
      contextId: uuid,
      revision: 0,
      dirtyCount: -1,
      editorsOpen: 0,
      busy: false,
    },
    {
      kind: 'updates.drafts',
      contextId: uuid,
      revision: 0,
      dirtyCount: 0,
      editorsOpen: 0,
      busy: 0,
    },
    {
      kind: 'updates.trayDrafts',
      contextId: uuid,
      revision: 0,
      dirtyCount: 0,
      busy: false,
      text: 'private',
    },
  ])('rejects expanded or invalid intent %j', (raw) => expect(requestValid(raw)).toBe(false));
});
describe('All local chat drafts, not only visible selection', () => {
  const empty = () => ({
    value: '',
    files: [],
    uploading: false,
    pending: false,
    uncertain: false,
  });
  it('counts text, whitespace, files-only and reply-only without exposing contents', () => {
    const facts = updateDraftFacts(
      {
        1: { ...empty(), value: 'private' },
        2: { ...empty(), files: ['private'] },
        3: { ...empty(), reply: { text: 'private' } },
        4: { ...empty(), value: ' ' },
        5: empty(),
      },
      2,
    );
    expect(facts).toEqual({ dirtyCount: 4, editorsOpen: 2, busy: false });
    expect(JSON.stringify(facts)).not.toContain('private');
  });
  it.each(['uploading', 'pending', 'uncertain', 'intent'])(
    '%s blocks discard even if composer is empty',
    (key) => {
      expect(updateDraftFacts({ 99: { ...empty(), [key]: true } }, 0).busy).toBe(true);
    },
  );
});
