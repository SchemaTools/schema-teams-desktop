import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { ApiResult, ChatFile } from '../../shared/client';
import { TeamsApi, FILE_LIMIT, failure } from '../api/client';
import { pathNeedsReveal } from '../paths/validate';

export interface FileTarget {
  epoch: number;
  chatId: number;
  messageId: number;
  fileId: number;
}
interface Options {
  api: TeamsApi;
  downloads: () => string;
  openPath: (path: string) => Promise<string>;
  reveal: (path: string) => void;
}
interface Loaded {
  file: ChatFile;
  bytes: Uint8Array;
  mime: string;
}
interface Preview {
  epoch: number;
  bytes: Uint8Array;
  mime: string;
  key: string;
}
type FileAction = 'saved' | 'opened' | 'revealed' | 'blocked';
const OPEN_EXTENSIONS = new Set([
  'PDF',
  'PNG',
  'JPG',
  'JPEG',
  'GIF',
  'WEBP',
  'TXT',
  'CSV',
  'MD',
  'RVT',
  'RFA',
  'RTE',
  'DWG',
  'DXF',
  'IFC',
  'NWC',
  'NWD',
  'ZIP',
  '7Z',
  'DOCX',
  'XLSX',
  'PPTX',
]);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const keyOf = (t: FileTarget) => `${t.epoch}:${t.chatId}:${t.messageId}:${t.fileId}`;
export function attachmentName(name: string): string | null {
  if (
    !name ||
    name.length > 240 ||
    name.trim() !== name ||
    name.endsWith('.') ||
    /[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}]/u.test(name) ||
    name === '.' ||
    name === '..' ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/iu.test(
      (name.split('.')[0] ?? '').trimEnd(),
    )
  )
    return null;
  return name;
}
export function rasterMime(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length >= 24 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    b.toString('ascii', 12, 16) === 'IHDR'
  )
    return 'image/png';
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 10 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)))
    return 'image/gif';
  if (
    b.length >= 16 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  return null;
}
export function attachmentCanOpen(name: string, bytes: Uint8Array): boolean {
  if (!attachmentName(name) || pathNeedsReveal(`\\\\server\\share\\${name}`)) return false;
  const ext = extname(name).slice(1).toUpperCase();
  if (!OPEN_EXTENSIONS.has(ext)) return false;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lead = b.subarray(0, 512).toString('utf8').trimStart();
  if (
    (b[0] === 77 && b[1] === 90) ||
    (b[0] === 127 && b.toString('ascii', 1, 4) === 'ELF') ||
    /^(?:#!|<\??(?:!doctype|html|script|svg)|<\?xml)/i.test(lead)
  )
    return false;
  if (['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP'].includes(ext)) return rasterMime(bytes) !== null;
  if (ext === 'PDF') return b.subarray(0, 5).toString('ascii') === '%PDF-';
  return true;
}

/** Binary data stays in main. Each action rechecks message membership and server access. */
export class AttachmentService {
  private readonly busy = new Set<string>();
  private readonly previews = new Map<string, Preview>();
  private readonly saved = new Map<string, { path: string; digest: string }>();
  private active = 0;
  private readonly waiters: {
    target: FileTarget;
    key: string;
    resolve: (allowed: boolean) => void;
  }[] = [];
  private stopped = false;
  constructor(private readonly o: Options) {}
  private current(t: FileTarget): boolean {
    return !this.stopped && t.epoch === this.o.api.epoch && this.o.api.owner !== null;
  }
  reset(): void {
    this.previews.clear();
    this.saved.clear();
    for (const w of this.waiters.splice(0)) {
      this.busy.delete(w.key);
      w.resolve(false);
    }
  }
  destroy(): void {
    this.stopped = true;
    this.reset();
  }
  private async enter(t: FileTarget, priority = false): Promise<boolean> {
    const key = keyOf(t);
    if (!this.current(t) || this.busy.has(key) || this.waiters.length >= 6) return false;
    this.busy.add(key);
    if (this.active < 2) {
      this.active++;
      return true;
    }
    return new Promise((resolve) => {
      const waiter = { target: t, key, resolve };
      if (priority) this.waiters.unshift(waiter);
      else this.waiters.push(waiter);
    });
  }
  private leave(key: string): void {
    this.busy.delete(key);
    this.active--;
    for (const w of this.waiters.splice(0)) {
      if (!this.current(w.target)) {
        this.busy.delete(w.key);
        w.resolve(false);
        continue;
      }
      if (this.active < 2) {
        this.active++;
        w.resolve(true);
      } else this.waiters.push(w);
    }
  }
  private async load(t: FileTarget): Promise<ApiResult<Loaded>> {
    if (!this.current(t)) return failure('stale_session');
    const page = await this.o.api.messages(t.chatId, { around: t.messageId });
    if (!this.current(t)) return failure('stale_session');
    if (!page.ok) return page;
    const message = page.data.items.find(
      (m) => m.id === t.messageId && m.chatId === t.chatId && !m.deleted,
    );
    const file = message?.files.find((f) => f.fileId === t.fileId);
    if (!file) return failure('not_found');
    if (!attachmentName(file.fileName) || file.size > FILE_LIMIT) return failure('invalid_file');
    const data = await this.o.api.download(file.fileId, file.size);
    if (!this.current(t)) return failure('stale_session');
    return data.ok ? { ok: true, data: { file, ...data.data } } : data;
  }
  async preview(t: FileTarget): Promise<ApiResult<{ url: string }>> {
    const key = keyOf(t);
    if (!(await this.enter(t))) return failure(this.current(t) ? 'busy' : 'stale_session');
    try {
      const data = await this.load(t);
      if (!data.ok) return data;
      const mime = rasterMime(data.data.bytes);
      if (!mime || !data.data.file.isImage) return failure('invalid_file');
      const token = randomUUID();
      // Bound memory even when a long conversation contains many photographs.
      for (const [id, p] of this.previews)
        if (p.epoch !== t.epoch || p.key === key) this.previews.delete(id);
      let used = [...this.previews.values()].reduce((sum, p) => sum + p.bytes.length, 0);
      for (const [id, p] of this.previews) {
        if (this.previews.size < 12 && used + data.data.bytes.length <= FILE_LIMIT) break;
        this.previews.delete(id);
        used -= p.bytes.length;
      }
      this.previews.set(token, { epoch: t.epoch, bytes: data.data.bytes, mime, key });
      return { ok: true, data: { url: `schema-attachment://preview/${token}` } };
    } finally {
      this.leave(key);
    }
  }
  response(request: Request): Response {
    if (
      !['GET', 'HEAD'].includes(request.method) ||
      !/^schema-attachment:\/\/preview\/[a-f0-9-]{36}$/.test(request.url)
    )
      return new Response(null, { status: 404 });
    const token = request.url.slice(request.url.lastIndexOf('/') + 1),
      p = this.previews.get(token);
    if (!p || this.stopped || p.epoch !== this.o.api.epoch || !this.o.api.owner)
      return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(p.bytes).buffer, {
      headers: {
        'content-type': p.mime,
        'content-length': String(p.bytes.length),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  }
  async action(t: FileTarget, action: 'save' | 'open' | 'reveal'): Promise<ApiResult<FileAction>> {
    const key = keyOf(t);
    if (!(await this.enter(t, true))) return failure(this.current(t) ? 'busy' : 'stale_session');
    let created: string | undefined;
    let complete = false;
    try {
      const loaded = await this.load(t);
      if (!loaded.ok) return loaded;
      const { file, bytes } = loaded.data,
        checksum = digest(bytes);
      let path: string | undefined;
      const cached = this.saved.get(key);
      if (cached && cached.digest === checksum) {
        try {
          const info = await stat(cached.path);
          if (
            info.isFile() &&
            info.size === bytes.length &&
            digest(await readFile(cached.path)) === checksum
          )
            path = cached.path;
        } catch {
          /* The user may have moved/deleted the download. Save another copy. */
        }
      }
      if (!this.current(t)) return failure('stale_session');
      if (!path) {
        const name = file.fileName,
          ext = extname(name),
          base = name.slice(0, name.length - ext.length);
        for (let i = 0; i < 1000; i++) {
          if (!this.current(t)) return failure('stale_session');
          const candidate = join(this.o.downloads(), i ? `${base} (${i})${ext}` : name);
          let handle;
          try {
            handle = await open(candidate, 'wx', 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw error;
          }
          created = candidate;
          try {
            await handle.writeFile(bytes);
          } finally {
            await handle.close();
          }
          if (process.platform === 'win32') {
            // Preserve Windows' downloaded-file warning without recording a server URL.
            await writeFile(`${candidate}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(
              () => {},
            );
          }
          complete = true;
          if (!this.current(t)) return failure('stale_session');
          path = candidate;
          break;
        }
        if (!path) return failure('file_error');
        this.saved.set(key, { path, digest: checksum });
      }
      if (!this.current(t)) return failure('stale_session');
      if (action === 'save') return { ok: true, data: 'saved' };
      if (action === 'reveal' || !attachmentCanOpen(file.fileName, bytes)) {
        this.o.reveal(path);
        return { ok: true, data: action === 'reveal' ? 'revealed' : 'blocked' };
      }
      const error = await this.o.openPath(path);
      if (!this.current(t)) return failure('stale_session');
      return error ? failure('file_error') : { ok: true, data: 'opened' };
    } catch {
      return this.current(t) ? failure('file_error') : failure('stale_session');
    } finally {
      this.leave(key);
      if (created && (!complete || !this.current(t))) await unlink(created).catch(() => {});
    }
  }
}
