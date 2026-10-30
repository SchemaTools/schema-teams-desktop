import {
  closeSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { positiveId, utcInstant } from '../../shared/time';
import type {
  SupportFileManifest,
  SupportPayload,
  SupportReceipt,
  SupportAttemptView,
} from '../../shared/report';
import { supportPayloadValid } from '../../shared/report';

export interface SupportScope {
  serverHash: string;
  ownerId: number;
}
export interface SupportIntent extends SupportScope {
  schema: 1;
  id: string;
  previewId: string;
  chatId: number;
  payload: SupportPayload;
  key: string;
  files: SupportFileManifest[];
  firstAt: string;
  retryNotAfter: string;
  status: 'intent' | SupportAttemptView['status'];
  mayHaveCommitted: boolean;
  reason: 'none' | 'unknown' | 'expired' | 'clock' | 'chat-changed' | 'http';
  receipt?: SupportReceipt;
}
export interface SupportStorage {
  read(): string | null;
  replace(text: string): void;
}
export const SUPPORT_LEDGER_LIMIT = 512 * 1024;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const same = (a: SupportScope, b: SupportScope) =>
  a.serverHash === b.serverHash && a.ownerId === b.ownerId;
const name = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 200 &&
  !/[\\/:*?"<>|\p{Cc}\p{Cf}]/u.test(v) &&
  v !== '.' &&
  v !== '..';
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const checksum = (records: unknown) =>
  createHash('sha256').update(JSON.stringify(records)).digest('hex');
function valid(v: unknown): v is SupportIntent {
  if (
    !object(v) ||
    !keys(v, [
      'schema',
      'serverHash',
      'ownerId',
      'id',
      'previewId',
      'chatId',
      'payload',
      'key',
      'files',
      'firstAt',
      'retryNotAfter',
      'status',
      'mayHaveCommitted',
      'reason',
      'receipt',
    ]) ||
    v.schema !== 1 ||
    !hash(v.serverHash) ||
    !positiveId(v.ownerId) ||
    !uuid(v.id) ||
    !uuid(v.previewId) ||
    !uuid(v.key) ||
    !positiveId(v.chatId) ||
    !supportPayloadValid(v.payload) ||
    !utcInstant(v.firstAt) ||
    !utcInstant(v.retryNotAfter) ||
    Date.parse(v.retryNotAfter) <= Date.parse(v.firstAt) ||
    Date.parse(v.retryNotAfter) > Date.parse(v.firstAt) + 24 * 3600000 - 60000 ||
    typeof v.status !== 'string' ||
    !['intent', 'unresolved', 'review', 'confirmed', 'rejected', 'resolved'].includes(v.status) ||
    typeof v.mayHaveCommitted !== 'boolean' ||
    typeof v.reason !== 'string' ||
    !['none', 'unknown', 'expired', 'clock', 'chat-changed', 'http'].includes(v.reason) ||
    !Array.isArray(v.files) ||
    v.files.length > 3
  )
    return false;
  if (
    !v.files.every(
      (f) =>
        object(f) &&
        keys(f, ['name', 'size', 'sha256', 'fileId']) &&
        Object.keys(f).length === 4 &&
        name(f.name) &&
        positiveId(f.size) &&
        f.size <= 50 * 1024 * 1024 &&
        hash(f.sha256) &&
        positiveId(f.fileId),
    )
  )
    return false;
  if (
    new Set(v.files.map((f) => f.fileId)).size !== v.files.length ||
    new Set(v.files.map((f) => f.name)).size !== v.files.length ||
    JSON.stringify(v.files.map((f) => f.fileId)) !== JSON.stringify(v.payload.fileIds)
  )
    return false;
  if (
    v.receipt !== undefined &&
    (!object(v.receipt) ||
      !keys(v.receipt, ['chatId', 'messageId']) ||
      Object.keys(v.receipt).length !== 2 ||
      !positiveId(v.receipt.chatId) ||
      !positiveId(v.receipt.messageId) ||
      v.receipt.chatId !== v.chatId)
  )
    return false;
  return (
    (v.status === 'confirmed') === (v.receipt !== undefined) &&
    (!['unresolved', 'review', 'confirmed'].includes(v.status) || v.mayHaveCommitted) &&
    (!['intent', 'rejected'].includes(v.status) || !v.mayHaveCommitted)
  );
}
export function supportStorage(file: string): SupportStorage {
  return {
    read() {
      let fd: number;
      try {
        fd = openSync(file, 'r');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
      try {
        if (fstatSync(fd).size > SUPPORT_LEDGER_LIMIT) throw Error('support-size');
        const bytes = Buffer.alloc(SUPPORT_LEDGER_LIMIT + 1);
        let size = 0;
        while (size < bytes.length) {
          const n = readSync(fd, bytes, size, bytes.length - size, null);
          if (!n) break;
          size += n;
        }
        if (size > SUPPORT_LEDGER_LIMIT) throw Error('support-size');
        return bytes.subarray(0, size).toString('utf8');
      } finally {
        closeSync(fd);
      }
    },
    replace(text) {
      if (Buffer.byteLength(text) > SUPPORT_LEDGER_LIMIT) throw Error('support-size');
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(temp, 'wx', 0o600);
        writeFileSync(fd, text, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, file);
      } finally {
        if (fd !== undefined) closeSync(fd);
        try {
          unlinkSync(temp);
        } catch {
          /* Rename consumes the temporary file; keep the previous ledger on failure. */
        }
      }
    },
  };
}
/** No transport or auto-send. A failed/corrupt store blocks new independent requests. */
export class SupportLedger {
  private records: SupportIntent[] = [];
  private blocked = false;
  get healthy(): boolean {
    return !this.blocked;
  }
  constructor(private readonly storage: SupportStorage) {
    try {
      const text = storage.read();
      if (text === null) return;
      if (Buffer.byteLength(text) > SUPPORT_LEDGER_LIMIT) throw Error('support-size');
      const raw: unknown = JSON.parse(text);
      if (
        !object(raw) ||
        !keys(raw, ['schema', 'records', 'sha256']) ||
        !hash(raw.sha256) ||
        raw.sha256 !== checksum(raw.records) ||
        raw.schema !== 1 ||
        !Array.isArray(raw.records) ||
        raw.records.length > 16 ||
        !raw.records.every(valid) ||
        new Set(raw.records.map((r) => r.id)).size !== raw.records.length ||
        new Set(raw.records.map((r) => r.key)).size !== raw.records.length ||
        new Set(
          raw.records
            .filter((r) => ['intent', 'unresolved', 'review'].includes(r.status))
            .map((r) => `${r.serverHash}:${r.ownerId}`),
        ).size !==
          raw.records.filter((r) => ['intent', 'unresolved', 'review'].includes(r.status)).length
      )
        throw Error('support-data');
      this.records = raw.records;
      const changed = this.records.some((r) => r.status === 'intent');
      if (changed)
        this.save(
          this.records.map((r) =>
            r.status === 'intent'
              ? { ...r, status: 'unresolved', mayHaveCommitted: true, reason: 'unknown' }
              : r,
          ),
        );
    } catch {
      this.blocked = true;
    }
  }
  private save(records: SupportIntent[]): boolean {
    if (this.blocked || records.length > 16 || !records.every(valid)) return false;
    try {
      this.storage.replace(JSON.stringify({ schema: 1, records, sha256: checksum(records) }));
      this.records = structuredClone(records);
      return true;
    } catch {
      this.blocked = true;
      return false;
    }
  }
  current(scope: SupportScope): SupportIntent | null {
    const records = this.records.filter((r) => same(r, scope));
    return structuredClone(
      records.find((r) => ['intent', 'unresolved', 'review'].includes(r.status)) ??
        records.at(-1) ??
        null,
    );
  }
  locked(scope: SupportScope): boolean {
    const r = this.current(scope);
    return !this.healthy || (!!r && ['intent', 'unresolved', 'review'].includes(r.status));
  }
  preview(scope: SupportScope, previewId: string): SupportIntent | null {
    return structuredClone(
      this.records.filter((r) => same(r, scope) && r.previewId === previewId).at(-1) ?? null,
    );
  }
  begin(
    input: Omit<SupportIntent, 'schema' | 'id' | 'key' | 'status' | 'mayHaveCommitted' | 'reason'>,
  ): SupportIntent | null {
    if (this.locked(input)) return null;
    const record: SupportIntent = {
      ...structuredClone(input),
      schema: 1,
      id: randomUUID(),
      key: randomUUID(),
      status: 'intent',
      mayHaveCommitted: false,
      reason: 'none',
    };
    const records = [...this.records];
    if (records.length >= 16) {
      const terminal = records.findIndex((r) =>
        ['confirmed', 'rejected', 'resolved'].includes(r.status),
      );
      if (terminal < 0) return null;
      records.splice(terminal, 1);
    }
    return this.save([...records, record]) ? structuredClone(record) : null;
  }
  private replace(
    scope: SupportScope,
    id: string,
    change: (r: SupportIntent) => SupportIntent,
  ): boolean {
    const record = this.records.find((r) => same(r, scope) && r.id === id);
    if (!record) return false;
    if (!['intent', 'unresolved', 'review'].includes(record.status)) return false;
    return this.save(this.records.map((r) => (r === record ? change(structuredClone(r)) : r)));
  }
  retryAllowed(record: SupportIntent, serverNow: number): boolean {
    return (
      this.healthy &&
      ['intent', 'unresolved'].includes(record.status) &&
      Number.isFinite(serverNow) &&
      serverNow >= Date.parse(record.firstAt) &&
      serverNow < Date.parse(record.retryNotAfter)
    );
  }
  unknown(scope: SupportScope, id: string, reason: SupportIntent['reason'] = 'unknown'): boolean {
    return this.replace(scope, id, (r) => ({
      ...r,
      status: reason === 'unknown' ? 'unresolved' : 'review',
      mayHaveCommitted: true,
      reason,
    }));
  }
  reject(scope: SupportScope, id: string, priorUnknown: boolean): boolean {
    return this.replace(scope, id, (r) =>
      priorUnknown || r.mayHaveCommitted || ['unresolved', 'review'].includes(r.status)
        ? { ...r, status: 'review', mayHaveCommitted: true, reason: 'http' }
        : {
            ...r,
            status: 'rejected',
            mayHaveCommitted: false,
            reason: 'http',
          },
    );
  }
  confirm(scope: SupportScope, id: string, receipt: SupportReceipt): boolean {
    return this.replace(scope, id, (r) => ({
      ...r,
      status: 'confirmed',
      mayHaveCommitted: true,
      reason: 'none',
      receipt: structuredClone(receipt),
    }));
  }
  resolve(scope: SupportScope, id: string): boolean {
    return this.replace(scope, id, (r) => ({ ...r, status: 'resolved', reason: 'none' }));
  }
  view(scope: SupportScope, serverNow: number): SupportAttemptView | null {
    const r = this.current(scope);
    if (!r) return null;
    return {
      id: r.id,
      previewId: r.previewId,
      text: r.payload.text,
      files: r.files.map((f) => ({ name: f.name, size: f.size })),
      status: r.status === 'intent' ? 'unresolved' : r.status,
      retryAllowed: this.retryAllowed(r, serverNow),
      ...(r.receipt && { receipt: r.receipt }),
    };
  }
}
