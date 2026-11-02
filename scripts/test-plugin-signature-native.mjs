// Read-only real Windows WinTrust evidence. Fixture writes stay in a new private directory.
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'private'), { recursive: true });
const fixtures = await mkdtemp(join(root, 'private/native-signature-oracle-'));
const helper = join(root, 'dist/native/plugin-signature.exe');
const positive = JSON.parse(
  await readFile(join(root, 'private/plugin-signature-embedded-candidate-20261031.json'), 'utf8'),
);
const catalog = JSON.parse(
  await readFile(join(root, 'private/plugin-signature-oracle-candidate-20261031.json'), 'utf8'),
);
async function hash(path) {
  const sha = createHash('sha256');
  for await (const chunk of createReadStream(path)) sha.update(chunk);
  return sha.digest('hex');
}
function verify(path, expected) {
  return JSON.parse(
    execFileSync(helper, [path, expected], {
      shell: false,
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024,
      encoding: 'utf8',
    }),
  );
}
const results = [];
async function check(name, file, verdict, reason, expected = undefined) {
  const measured = await hash(file);
  const output = verify(file, expected ?? measured);
  assert.equal(output.verdict, verdict, name);
  if (reason) assert.equal(output.reason, reason, name);
  if (output.verdict !== 'valid') assert.equal(output.signerDerSha256, null, name);
  results.push({
    name,
    file,
    expectedSha256: expected ?? measured,
    measuredSha256: measured,
    output,
  });
}
await check('embedded runtime positive', positive.file, 'valid', 'verified');
assert.equal(results[0].measuredSha256, positive.fileSha256);
await check('wrong expected SHA256', positive.file, 'invalid', 'hash-mismatch', '0'.repeat(64));
// The build output is replaced on every compile (PE timestamp changes). Keep
// the evidence case immutable so a later build does not invalidate its hash.
const unsignedFixture = join(fixtures, 'unsigned-own-helper.exe');
await copyFile(helper, unsignedFixture);
await check('unsigned own helper', unsignedFixture, 'invalid', 'no-embedded-signature');
await check(
  'catalog-only is not embedded positive',
  catalog.file,
  'invalid',
  'no-embedded-signature',
);

const tampered = join(fixtures, 'tampered-section.exe');
await copyFile(positive.file, tampered);
const f = await open(tampered, 'r+');
const header = Buffer.alloc(4096);
await f.read(header, 0, header.length, 0);
const pe = header.readUInt32LE(0x3c),
  optional = pe + 24;
const sections = optional + header.readUInt16LE(pe + 20);
const rawSize = header.readUInt32LE(sections + 16),
  rawOffset = header.readUInt32LE(sections + 20);
assert(rawSize > 128 && rawOffset >= sections + 40);
const offset = rawOffset + 64,
  byte = Buffer.alloc(1);
await f.read(byte, 0, 1, offset);
const before = byte[0];
byte[0] ^= 1;
await f.write(byte, 0, 1, offset);
await f.close();
await check(
  'signed section byte changed with recomputed expected file hash',
  tampered,
  'invalid',
  'wintrust',
);
assert.equal(results.at(-1).output.winTrustCode, '80096010');

const malformed = join(fixtures, 'malformed.exe');
await writeFile(malformed, Buffer.alloc(64));
await check('malformed PE', malformed, 'invalid', 'malformed-pe');
const badSecurity = join(fixtures, 'security-directory-out-of-bounds.exe');
await copyFile(positive.file, badSecurity);
const b = await open(badSecurity, 'r+');
const directories = header.readUInt16LE(optional) === 0x20b ? 112 : 96;
const invalidOffset = Buffer.alloc(4);
invalidOffset.writeUInt32LE(0xfffffff8);
await b.write(invalidOffset, 0, 4, optional + directories + 32);
await b.close();
await check('out-of-bounds security directory', badSecurity, 'invalid', 'malformed-pe');

const locked = await open(tampered, 'r+');
try {
  await check('existing writer prevents helper read lock', tampered, 'unknown', 'unavailable');
} finally {
  await locked.close();
}

const evidence = {
  testedAt: new Date().toISOString(),
  scope:
    'Real native helper / Windows trust store, no trust-store changes; runtime is a test sample, not approved bureau trust',
  policy:
    'WTD_CHOICE_FILE, UI_NONE, standard Windows timestamp, CHAIN_EXCLUDE_ROOT revocation, CACHE_ONLY_URL_RETRIEVAL, DISABLE_MD2_MD4; exec timeout 10000ms',
  signedSectionMutation: { rawOffset, rawSize, offset, before, after: before ^ 1 },
  helperSha256: await hash(helper),
  fixtures,
  results,
};
await writeFile(
  join(root, 'private/plugin-signature-native-evidence.json'),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
