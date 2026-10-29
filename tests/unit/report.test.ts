import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applicationLog,
  applicationLogs,
  latestRevitLog,
  revitLog,
} from '../../src/main/diagnostics/logs';
import { ReportService, type ReportBackend } from '../../src/main/diagnostics/service';
import { encodePng } from '../../src/main/png';
import { requestValid } from '../../src/shared/requests';
const dir = () => mkdtempSync(join(tmpdir(), 'stdesk-report-'));
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw Error('Missing test value');
  return value;
}
const options = {
  description: 'Не открылась карточка',
  applicationLogs: false,
  revitYear: null,
  includeScreenshot: false,
} as const;
const png = () => encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const root = dir(),
    target = join(root, 'report.zip');
  const backend: ReportBackend = {
    metadata: () => ({ appVersion: '0.6.4', serverVersion: '0.11.2-b', connection: 'online' }),
    readApplication: vi.fn(async () => []),
    readRevit: vi.fn(async () => null),
    screens: () => [{ id: '1', label: 'Экран 1' }],
    capture: vi.fn(async () => png()),
    choose: vi.fn(async () => target),
    reveal: vi.fn(),
    saved: vi.fn(),
  };
  return { root, target, backend, service: new ReportService(backend) };
}
afterEach(() => vi.useRealTimers());
describe('Диагностические журналы', () => {
  it('projects only known events and safe fields; unknown text and exception details cannot leak', () => {
    const output = applicationLog(
      '2026-10-29T19:00:00.000Z INFO запуск {"app":"0.6.4","packaged":true,"server":"http://private.example.org","error":"hidden","windows":"10.0.19045"}\n2026-10-29T19:01:00.000Z ERROR необработанная ошибка {"error":"password hidden C:/private"}\n2026-10-29T19:02:00.000Z INFO unknown private\nraw secret\n2026-10-29T19:03:00.000Z INFO событие клиента {"event":"chat:message","message":"hidden"}',
    );
    expect(output).toContain('"app":"0.6.4"');
    expect(output).toContain('"event":"chat:message"');
    expect(output).not.toMatch(/private|hidden|password|server|unknown|raw secret/);
  });
  it('redacts quoted model values, paths, addresses and credential lines from Revit text', () => {
    const output = revitLog(
      'Operation "my model"\nC:\\private\\model.rvt\n\\\\server\\share\\file.rvt\nhttps://example.org/path\nUser user@example.org\nAuthorization: Bearer dummy\npassword=hidden\nNormal operation\u0000',
    );
    expect(output).toContain('Normal operation');
    expect(output).not.toMatch(/my model|private|server|example.org|dummy|hidden/);
    expect(output).not.toContain(String.fromCharCode(0));
  });
  it('reads only five fixed application names and bounds each tail', async () => {
    const root = dir();
    writeFileSync(join(root, 'app.log'), 'secret'.repeat(200000));
    writeFileSync(join(root, 'app.1.log'), '2026-10-29T19:00:00.000Z INFO выход');
    writeFileSync(join(root, 'other.log'), 'not read');
    const result = await applicationLogs(root);
    expect(result.map((x) => x.name)).toEqual(['application/app.log', 'application/app.1.log']);
    expect(result[0]?.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('selects the highest journal number, decodes UTF16 and ignores other files and years', async () => {
    const root = dir(),
      folder = join(root, 'Autodesk', 'Revit', 'Autodesk Revit 2025', 'Journals');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'journal.9998.txt'), 'old');
    writeFileSync(
      join(folder, 'journal.10000.txt'),
      Buffer.from('\uFEFFNewest "private model"\r\nCommand complete', 'utf16le'),
    );
    writeFileSync(join(folder, 'other.99999.txt'), 'ignore');
    mkdirSync(join(folder, 'journal.99999.txt'));
    const result = await latestRevitLog(root, 2025);
    expect(result?.text).toContain('Newest');
    expect(result?.text).not.toMatch(/private model|old|ignore/);
    expect(result?.name).toBe('revit/revit-2025.txt');
    expect(await latestRevitLog(root, 2026)).toBeNull();
    expect(await latestRevitLog('', 2025)).toBeNull();
  });
  it('bounds large UTF16 journals and aligns the tail', async () => {
    const root = dir(),
      folder = join(root, 'Autodesk', 'Revit', 'Autodesk Revit 2026', 'Journals');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'journal.0001.txt'),
      Buffer.from('\uFEFF' + 'Ж'.repeat(600000) + 'Конец', 'utf16le'),
    );
    const result = await latestRevitLog(root, 2026);
    expect(result?.truncated).toBe(true);
    expect(result?.text.endsWith('Конец')).toBe(true);
    expect(result?.text).not.toContain('�');
  });
});
describe('Report snapshot and ZIP', () => {
  it('does not read attachments or capture without an explicit selection', async () => {
    const { service, backend } = fixture(),
      preview = await service.prepare(options);
    expect(preview.files.map((x) => x.name)).toEqual(['report.txt']);
    expect(backend.readApplication).not.toHaveBeenCalled();
    expect(backend.readRevit).not.toHaveBeenCalled();
    expect(backend.capture).not.toHaveBeenCalled();
    expect(JSON.stringify(preview)).not.toMatch(/serverUrl|password|cookie|C:\\/);
  });
  it('exports the exact reviewed bytes even when source files and returned preview are changed', async () => {
    const { service, backend, target } = fixture();
    let text = 'Reviewed diagnostic '.repeat(10000);
    backend.readApplication = vi.fn(async () => [
      { name: 'application/app.log', text, truncated: true },
    ]);
    await service.capture({ type: 'window' });
    const preview = await service.prepare({
        ...options,
        applicationLogs: true,
        includeScreenshot: true,
      }),
      expected = preview.files.map((x) => ({ ...x }));
    text = 'Changed after review';
    required(preview.files[0]).text = 'tampered preview';
    preview.files.push({ name: '../injected', size: 1, text: 'bad' });
    const receipt = await service.export(preview.id);
    expect(receipt?.fileName).toBe('report.zip');
    const archive = unzipSync(readFileSync(target));
    expect(Object.keys(archive)).toEqual(expected.map((x) => x.name));
    for (const file of expected) {
      if (file.text !== undefined) expect(strFromU8(required(archive[file.name]))).toBe(file.text);
      else
        expect(Buffer.from(required(archive[file.name])).toString('base64')).toBe(
          required(file.image).split(',')[1],
        );
    }
    expect(backend.readApplication).toHaveBeenCalledTimes(1);
    expect(service.reveal(required(receipt).id)).toBe(true);
    expect(backend.reveal).toHaveBeenCalledWith(target);
    service.clear();
    expect(service.reveal(required(receipt).id)).toBe(false);
  });
  it('reports unavailable selected logs and retains only a selected Revit year', async () => {
    const { service, backend } = fixture();
    let preview = await service.prepare({ ...options, applicationLogs: true, revitYear: 2026 });
    expect(preview.notices).toHaveLength(2);
    backend.readRevit = vi.fn(async () => ({
      name: 'untrusted',
      text: 'safe snapshot',
      truncated: false,
    }));
    preview = await service.prepare({ ...options, revitYear: 2025 });
    expect(preview.files.map((x) => x.name)).toEqual(['report.txt', 'revit/revit-2025.txt']);
    expect(backend.readRevit).toHaveBeenCalledWith(2025);
  });
  it('cancellation preserves the review and duplicate exports do not open another native dialog', async () => {
    const { service, backend } = fixture(),
      preview = await service.prepare(options),
      choice = deferred<string | null>();
    backend.choose = vi.fn(() => choice.promise);
    const first = service.export(preview.id);
    await expect(service.export(preview.id)).rejects.toThrow('stale_report');
    choice.resolve(null);
    expect(await first).toBeNull();
    expect(backend.choose).toHaveBeenCalledTimes(1);
    backend.choose = vi.fn(async () => null);
    expect(await service.export(preview.id)).toBeNull();
  });
  it('clear while the native chooser is open prevents a later write', async () => {
    const { service, backend, target, root } = fixture(),
      preview = await service.prepare(options),
      choice = deferred<string | null>();
    backend.choose = () => choice.promise;
    const save = service.export(preview.id);
    service.clear();
    choice.resolve(target);
    await expect(save).rejects.toThrow('stale_report');
    expect(readdirSync(root)).toEqual([]);
  });
  it('late log reads and captures cannot restore discarded private data; collection is single flight', async () => {
    const { service, backend } = fixture(),
      read = deferred<[]>();
    backend.readApplication = () => read.promise;
    const preparing = service.prepare({ ...options, applicationLogs: true });
    await expect(service.prepare(options)).rejects.toThrow('report_busy');
    service.clear();
    read.resolve([]);
    await expect(preparing).rejects.toThrow('stale_report');
    const capture = deferred<Uint8Array>();
    backend.capture = () => capture.promise;
    const shot = service.capture({ type: 'window' });
    service.clear();
    capture.resolve(png());
    await expect(shot).rejects.toThrow('stale_report');
    await expect(service.prepare({ ...options, includeScreenshot: true })).rejects.toThrow(
      'missing_screenshot',
    );
  });
  it('times out a hanging collection and prevents accumulating additional OS reads', async () => {
    vi.useFakeTimers();
    const { service, backend } = fixture(),
      read = deferred<[]>();
    backend.readApplication = vi.fn(() => read.promise);
    const preparing = service.prepare({ ...options, applicationLogs: true });
    const rejected = expect(preparing).rejects.toThrow('report_timeout');
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    await expect(service.prepare(options)).rejects.toThrow('report_busy');
    read.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    expect((await service.prepare(options)).files).toHaveLength(1);
    expect(backend.readApplication).toHaveBeenCalledTimes(1);
  });
  it('edits invalidate the old proof while retaining the explicitly captured image', async () => {
    const { service } = fixture();
    await service.capture({ type: 'window' });
    const old = await service.prepare({ ...options, includeScreenshot: true });
    service.edit();
    await expect(service.export(old.id)).rejects.toThrow('stale_report');
    expect(
      (await service.prepare({ ...options, includeScreenshot: true })).files.some(
        (x) => x.name === 'screenshot.png',
      ),
    ).toBe(true);
  });
  it('expires reviews after thirty minutes', async () => {
    const { service } = fixture(),
      preview = await service.prepare(options);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    await expect(service.export(preview.id)).rejects.toThrow('stale_report');
  });
  it('rejects unknown screens, malformed/oversized PNGs and unsafe backend file names', async () => {
    const { service, backend } = fixture();
    await expect(service.capture({ type: 'screen', id: '2' })).rejects.toThrow('invalid_screen');
    expect(backend.capture).not.toHaveBeenCalled();
    backend.capture = async () => new Uint8Array(30);
    await expect(service.capture({ type: 'window' })).rejects.toThrow('invalid_image');
    const invalid = png();
    invalid.writeUInt32BE(5000, 16);
    backend.capture = async () => invalid;
    await expect(service.capture({ type: 'screen', id: '1' })).rejects.toThrow('invalid_image');
    backend.readApplication = async () => [
      { name: '../secrets', text: 'ignored', truncated: false },
    ];
    await expect(service.prepare({ ...options, applicationLogs: true })).rejects.toThrow(
      'invalid_log',
    );
  });
  it('rejects invalid destinations, oversized logs and cleans only its own temp file on failure', async () => {
    const { service, backend, root } = fixture(),
      preview = await service.prepare(options);
    backend.choose = async () => 'relative.zip';
    await expect(service.export(preview.id)).rejects.toThrow('invalid_extension');
    backend.choose = async () => join(root, 'bad.exe');
    await expect(service.export(preview.id)).rejects.toThrow('invalid_extension');
    const folder = join(root, 'folder.zip');
    mkdirSync(folder);
    backend.choose = async () => folder;
    await expect(service.export(preview.id)).rejects.toThrow();
    expect(readdirSync(root)).toEqual(['folder.zip']);
    backend.readApplication = async () => [
      { name: 'application/app.log', text: 'x'.repeat(8 * 1024 * 1024 + 1), truncated: false },
    ];
    await expect(service.prepare({ ...options, applicationLogs: true })).rejects.toThrow(
      'report_too_large',
    );
  });
});
describe('Report IPC schema', () => {
  it('accepts fixed local commands and excludes file paths, arbitrary bytes, URLs and sending', () => {
    for (const command of [
      { kind: 'report.open' },
      { kind: 'report.clear' },
      { kind: 'report.edit' },
      { kind: 'report.screens' },
      { kind: 'report.prepare', options },
      { kind: 'report.capture', target: { type: 'window' } },
      { kind: 'report.capture', target: { type: 'screen', id: '-123' } },
      { kind: 'report.export', id: '12345678-1234-1234-1234-123456789012' },
    ])
      expect(requestValid(command)).toBe(true);
    for (const command of [
      { kind: 'report.send' },
      { kind: 'report.prepare', options: { ...options, path: 'secret' } },
      { kind: 'report.prepare', options: { ...options, description: '' } },
      { kind: 'report.prepare', options: { ...options, description: 'x'.repeat(4001) } },
      { kind: 'report.prepare', options: { ...options, revitYear: 2024 } },
      { kind: 'report.capture', target: { type: 'window', path: 'secret' } },
      { kind: 'report.capture', target: { type: 'screen', id: 'file:///secret' } },
      { kind: 'report.export', id: '123', path: 'secret' },
      { kind: 'report.screens', url: 'https://example.org' },
    ])
      expect(requestValid(command)).toBe(false);
  });
});
