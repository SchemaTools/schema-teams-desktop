// Repeatable Windows baseline on a local fixture; never opens the real user profile.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { _electron: electron, expect } = require('@playwright/test');
const { buildSync } = require('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index],
    value = args[index + 1];
  if (!['--executable', '--output', '--seconds'].includes(key) || !value || options.has(key))
    throw Error(
      'Usage: node scripts/measure-memory.mjs [--executable path] [--output path] [--seconds 120..600]',
    );
  options.set(key, value);
}
if (process.platform !== 'win32') throw Error('This baseline requires Windows and a packaged EXE.');
const seconds = Number(options.get('--seconds') ?? 120);
if (!Number.isInteger(seconds) || seconds < 120 || seconds > 600 || seconds % 10)
  throw Error('Seconds must be a multiple of 10, from 120 through 600.');
const executable = resolve(
  root,
  options.get('--executable') ?? 'release/win-unpacked/Schema Teams.exe',
);
const output = resolve(root, options.get('--output') ?? 'private/memory-baseline.json');
if (!existsSync(executable)) throw Error('Packaged EXE not found. Run npm run dist first.');
if (existsSync(output)) throw Error('Output already exists; choose a new --output path.');
mkdirSync(join(root, 'private'), { recursive: true });
mkdirSync(dirname(output), { recursive: true });
const profile = mkdtempSync(join(root, 'private', 'memory-profile-'));
const bundle = join(profile, 'fixture.cjs');
buildSync({
  entryPoints: [join(root, 'tests/e2e/clientStub.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
});
const { startClientStub } = require(bundle);
const stub = await startClientStub();
writeFileSync(
  join(profile, 'settings.json'),
  JSON.stringify({
    serverUrl: stub.url,
    onboardingComplete: true,
    autostart: false,
    notifications: { enabled: false, sound: false, preview: false },
  }),
);
let app;
const samples = [];
const report = {
  complete: false,
  fixture: true,
  withRevit: false,
  manualAcceptance: false,
  inspectorAttached: true,
  windows: release(),
  units: 'Electron KB divided by 1024 = MiB',
  note: 'privateBytes and workingSetSize are separate metrics. Summed working sets may count shared pages more than once. No forced GC.',
  samples,
};
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
async function sample(stage) {
  const value = await app.evaluate(({ app, BrowserWindow }) => ({
    at: Date.now(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    arch: process.arch,
    collectorDisabled: app.commandLine.hasSwitch('disable-gpu-process-for-dx12-info-collection'),
    renderingDisabled: app.commandLine.hasSwitch('disable-gpu'),
    windows: BrowserWindow.getAllWindows().map((w) => ({
      visible: w.isVisible(),
      kind: w.webContents.getURL().split(':')[0],
    })),
    processes: app.getAppMetrics().map((p) => ({
      pid: p.pid,
      created: p.creationTime,
      type: p.type,
      sandboxed: p.sandboxed,
      memory: p.memory,
      cpu: p.cpu.percentCPUUsage,
    })),
  }));
  if (stage !== 'chat_open' && value.windows.some((w) => w.visible))
    throw Error('A hidden-stage window is visible; the measurement is invalid.');
  const row = {
    stage,
    ...value,
    privateMiB: value.processes.every((p) => typeof p.memory.privateBytes === 'number')
      ? value.processes.reduce((sum, p) => sum + p.memory.privateBytes, 0) / 1024
      : null,
    workingSetMiB: value.processes.reduce((sum, p) => sum + p.memory.workingSetSize, 0) / 1024,
    cpuPercent: value.processes.reduce((sum, p) => sum + p.cpu, 0),
  };
  samples.push(row);
  save();
  console.log(
    JSON.stringify({
      stage,
      privateMiB: row.privateMiB,
      workingSetMiB: row.workingSetMiB,
      processes: row.processes.length,
    }),
  );
}
try {
  app = await electron.launch({
    executablePath: executable,
    args: ['--hidden'],
    env: { ...process.env, SCHEMA_TEAMS_USER_DATA: profile, SCHEMA_TEAMS_SERVER_URL: '' },
  });
  const page = await app.firstWindow();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'signedOut');
  await delay(10000);
  await sample('signed_out_hidden_10s');
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith('file:'),
    );
    win?.show();
    win?.focus();
  });
  const login = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await (await login).locator('#sign-in').click();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-connection', 'online');
  await page.locator('.chat-row[data-chat-id="4"]').click();
  await expect(page.locator('.message-row')).toHaveCount(2);
  await sample('chat_open');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()));
  for (let elapsed = 10; elapsed <= seconds; elapsed += 10) {
    await delay(10000);
    await sample(`online_hidden_${elapsed}s`);
  }
  const extraWrites = stub.state.calls.filter(
    (c) => c.method !== 'GET' && c.path !== '/api/auth/login' && c.path !== '/api/chats/4/read',
  );
  if (extraWrites.length) throw Error('Unexpected business mutation on fixture.');
  report.complete = true;
  save();
} finally {
  await app?.close().catch(() => undefined);
  await stub.close();
}
