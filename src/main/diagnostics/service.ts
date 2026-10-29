import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { rename, rm, writeFile } from 'node:fs/promises';
import { zip, type AsyncZippable } from 'fflate';
import type {
  ReportCapture,
  ReportExport,
  ReportOptions,
  ReportPreview,
  ReportScreen,
} from '../../shared/report';
import { reportOptionsValid } from '../../shared/report';
import type { LogSnapshot } from './logs';
export interface ReportBackend {
  metadata: () => { appVersion: string; serverVersion: string; connection: string };
  readApplication: () => Promise<LogSnapshot[]>;
  readRevit: (year: 2025 | 2026) => Promise<LogSnapshot | null>;
  screens: () => ReportScreen[];
  capture: (target: { type: 'window' } | { type: 'screen'; id: string }) => Promise<Uint8Array>;
  choose: (fileName: string) => Promise<string | null>;
  reveal: (path: string) => void;
  saved?: () => void;
}
interface File {
  name: string;
  bytes: Uint8Array;
  text?: string;
  image?: string;
}
interface Draft {
  id: string;
  generation: number;
  until: number;
  files: File[];
  notices: string[];
}
const encode = (value: string) => new TextEncoder().encode(value);
function archive(files: File[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let terminate = () => {};
    const timer = setTimeout(() => {
      terminate();
      reject(Error('zip_timeout'));
    }, 30000);
    const entries: AsyncZippable = {};
    for (const file of files) entries[file.name] = [file.bytes, { level: file.image ? 0 : 6 }];
    try {
      terminate = zip(entries, { level: 6 }, (error, bytes) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(bytes);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
/** Snapshot bytes stay in main. Export never rereads a log after its preview was approved. */
export class ReportService {
  private generation = 0;
  private screenshot?: File;
  private draft?: Draft;
  private exported?: { id: string; path: string };
  private exporting = false;
  private collecting = false;
  constructor(private readonly o: ReportBackend) {}
  private async collect<T>(read: () => Promise<T>): Promise<T> {
    if (this.collecting || this.exporting) throw Error('report_busy');
    this.collecting = true;
    // A timed-out OS read may still finish. Keep its slot occupied until it does.
    const task = Promise.resolve()
      .then(read)
      .finally(() => {
        this.collecting = false;
      });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('report_timeout')), 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  screens(): ReportScreen[] {
    return this.o.screens().slice(0, 16);
  }
  clear(): void {
    this.generation++;
    this.screenshot = undefined;
    this.draft = undefined;
    this.exported = undefined;
  }
  edit(): void {
    this.generation++;
    this.draft = undefined;
    this.exported = undefined;
  }
  async capture(
    target: { type: 'window' } | { type: 'screen'; id: string },
  ): Promise<ReportCapture> {
    if (this.collecting || this.exporting) throw Error('report_busy');
    this.draft = undefined;
    this.exported = undefined;
    this.screenshot = undefined;
    const generation = ++this.generation;
    if (target.type === 'screen' && !this.screens().some((screen) => screen.id === target.id))
      throw Error('invalid_screen');
    const bytes = await this.collect(() => this.o.capture(target)),
      buffer = Buffer.from(bytes);
    if (generation !== this.generation) throw Error('stale_report');
    if (
      bytes.length > 8 * 1024 * 1024 ||
      bytes.length < 24 ||
      !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      buffer.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw Error('invalid_image');
    const width = buffer.readUInt32BE(16),
      height = buffer.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096 || width * height > 8 * 1024 * 1024)
      throw Error('invalid_image');
    const image = `data:image/png;base64,${buffer.toString('base64')}`;
    this.screenshot = { name: 'screenshot.png', bytes: Uint8Array.from(bytes), image };
    return { image, width, height };
  }
  async prepare(options: ReportOptions): Promise<ReportPreview> {
    if (this.collecting || this.exporting) throw Error('report_busy');
    this.draft = undefined;
    this.exported = undefined;
    const generation = ++this.generation;
    if (!reportOptionsValid(options)) throw Error('invalid_report');
    const metadata = this.o.metadata(),
      description = options.description.trim();
    const text = `Schema Teams Desktop ${metadata.appVersion}\nВерсия сервера: ${metadata.serverVersion || 'не получена'}\nПодключение: ${metadata.connection}\nСоздано: ${new Date().toISOString()}\n\nЧто случилось:\n${description}\n`;
    const files: File[] = [{ name: 'report.txt', text, bytes: encode(text) }],
      notices: string[] = [];
    const [application, revit] = await this.collect(() =>
      Promise.all([
        options.applicationLogs ? this.o.readApplication() : [],
        options.revitYear ? this.o.readRevit(options.revitYear) : null,
      ]),
    );
    if (generation !== this.generation) throw Error('stale_report');
    if (options.applicationLogs && !application.length)
      notices.push('Журналы приложения не найдены или недоступны.');
    for (const log of application) {
      if (!/^application\/app(?:\.[1-4])?\.log$/.test(log.name)) throw Error('invalid_log');
      files.push({ name: log.name, text: log.text, bytes: encode(log.text) });
      if (log.truncated) notices.push(`${log.name}: приложена только последняя часть журнала.`);
    }
    if (options.revitYear) {
      if (!revit) notices.push(`Журнал Revit ${options.revitYear} не найден или недоступен.`);
      else {
        const name = `revit/revit-${options.revitYear}.txt`;
        files.push({ name, text: revit.text, bytes: encode(revit.text) });
        if (revit.truncated) notices.push(`${name}: приложена только последняя часть журнала.`);
      }
    }
    if (options.includeScreenshot) {
      if (!this.screenshot) throw Error('missing_screenshot');
      files.push({ ...this.screenshot, bytes: Uint8Array.from(this.screenshot.bytes) });
    }
    if (
      files.some((file) => file.bytes.length > 8 * 1024 * 1024) ||
      files.reduce((sum, file) => sum + file.bytes.length, 0) > 20 * 1024 * 1024
    )
      throw Error('report_too_large');
    const draft = {
      id: randomUUID(),
      generation,
      until: Date.now() + 30 * 60 * 1000,
      files,
      notices,
    };
    this.draft = draft;
    return {
      id: draft.id,
      files: files.map(({ name, bytes, text, image }) => ({
        name,
        size: bytes.length,
        ...(text !== undefined && { text }),
        ...(image && { image }),
      })),
      notices: [...notices],
    };
  }
  async export(id: string): Promise<ReportExport | null> {
    const draft = this.draft;
    if (this.collecting || this.exporting || !draft || draft.id !== id || Date.now() >= draft.until)
      throw Error('stale_report');
    const current = () =>
      this.draft === draft && this.generation === draft.generation && Date.now() < draft.until;
    this.exporting = true;
    let temporary: string | undefined;
    try {
      const target = await this.o.choose(
        `Schema Teams report ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`,
      );
      if (!current()) throw Error('stale_report');
      if (target === null) return null;
      if (!isAbsolute(target) || extname(target).toLowerCase() !== '.zip')
        throw Error('invalid_extension');
      const bytes = await archive(draft.files);
      if (!current()) throw Error('stale_report');
      temporary = join(dirname(target), `.schema-report-${randomUUID()}.tmp`);
      await writeFile(temporary, bytes, { flag: 'wx' });
      if (!current()) throw Error('stale_report');
      await rename(temporary, target);
      temporary = undefined;
      if (!current()) throw Error('stale_report');
      const receipt = { id: randomUUID(), path: target };
      this.exported = receipt;
      this.o.saved?.();
      return {
        id: receipt.id,
        fileName: basename(target)
          .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '�')
          .slice(0, 200),
      };
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      this.exporting = false;
    }
  }
  reveal(id: string): boolean {
    if (!this.exported || this.exported.id !== id) return false;
    this.o.reveal(this.exported.path);
    return true;
  }
}
