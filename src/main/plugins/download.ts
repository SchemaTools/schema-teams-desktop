import { mkdir, mkdtemp, open, unlink, rmdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PLUGIN_MAX_BYTES, type PluginBuild } from '../../shared/plugins';
import { auditPlugin, type PluginAuditListener } from './audit';
export interface PluginDownloadOptions {
  audit?: PluginAuditListener;
  fetch: (path: string, init: RequestInit) => Promise<Response>;
  root: string;
  signal?: AbortSignal;
  current: () => boolean;
  onUnauthorized?: () => void;
  timeoutMs?: number;
}
/** Main-only bounded reader. Never exposes binary bytes or arbitrary URLs through IPC. */
export async function downloadPlugin(
  build: PluginBuild,
  o: PluginDownloadOptions,
): Promise<string> {
  // Own the primitive metadata before the first await; a refreshed catalog cannot change this read.
  build = { ...build };
  auditPlugin(o.audit, {
    operation: 'download',
    phase: 'requested',
    version: build.version,
    buildId: build.id,
  });
  if (
    !Number.isSafeInteger(build.id) ||
    build.id <= 0 ||
    build.url !== `/api/desktop/plugins/files/${build.id}` ||
    !Number.isSafeInteger(build.size) ||
    build.size <= 0 ||
    build.size > PLUGIN_MAX_BYTES ||
    typeof build.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(build.sha256)
  ) {
    auditPlugin(o.audit, {
      operation: 'download',
      phase: 'result',
      outcome: 'rejected',
      reason: 'invalid_plugin',
      version: build.version,
      buildId: build.id,
    });
    throw Error('invalid_plugin');
  }
  const controller = new AbortController(),
    abort = () => controller.abort();
  o.signal?.addEventListener('abort', abort, { once: true });
  if (o.signal?.aborted) abort();
  const timer = setTimeout(abort, o.timeoutMs ?? 120000);
  let directory: string | undefined,
    part: string | undefined,
    target: string | undefined,
    response: Response | undefined,
    completed = false,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const check = () => {
    if (controller.signal.aborted) throw Error('download_aborted');
    if (!o.current()) throw Error('stale_session');
  };
  const wait = async <T>(work: Promise<T>): Promise<T> => {
    let listener: () => void = () => {};
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          listener = () => reject(Error('download_aborted'));
          controller.signal.addEventListener('abort', listener, { once: true });
          if (controller.signal.aborted) listener();
        }),
      ]);
    } finally {
      controller.signal.removeEventListener('abort', listener);
    }
  };
  try {
    check();
    response = await wait(
      o.fetch(build.url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'manual',
        signal: controller.signal,
      }),
    );
    check();
    if (response.status === 401) o.onUnauthorized?.();
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel();
      throw Error(response.status === 404 ? 'plugin_unavailable' : 'download_http');
    }
    const length = response.headers.get('content-length');
    if (
      !length ||
      !/^\d+$/.test(length) ||
      !Number.isSafeInteger(Number(length)) ||
      Number(length) !== build.size ||
      Number(length) > PLUGIN_MAX_BYTES
    ) {
      await response.body?.cancel();
      throw Error('download_size');
    }
    if (!response.body) throw Error('download_empty');
    reader = response.body.getReader();
    await mkdir(o.root, { recursive: true });
    check();
    directory = await mkdtemp(join(o.root, 'plugin-'));
    part = join(directory, 'archive.part');
    const file = await open(part, 'wx', 0o600),
      hash = createHash('sha256');
    let received = 0;
    try {
      while (true) {
        const chunk = await wait(reader.read());
        check();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > PLUGIN_MAX_BYTES || received > build.size) throw Error('download_overflow');
        hash.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          check();
          const written = await file.write(chunk.value, offset, chunk.value.byteLength - offset);
          if (written.bytesWritten <= 0) throw Error('download_write');
          offset += written.bytesWritten;
        }
      }
      if (received !== build.size) throw Error('download_size');
      if (hash.digest('hex') !== build.sha256.toLowerCase()) throw Error('download_hash');
      await file.sync();
      check();
    } finally {
      await file.close();
    }
    target = join(directory, 'archive.zip');
    await rename(part, target);
    part = undefined;
    check();
    completed = true;
    auditPlugin(o.audit, {
      operation: 'download',
      phase: 'result',
      outcome: 'ok',
      version: build.version,
      buildId: build.id,
    });
    return target;
  } catch (error) {
    auditPlugin(o.audit, {
      operation: 'download',
      phase: 'result',
      outcome: 'rejected',
      reason: error instanceof Error ? error.message : 'error',
      version: build.version,
      buildId: build.id,
    });
    throw error;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', abort);
    await reader?.cancel().catch(() => {});
    if (!reader) await response?.body?.cancel().catch(() => {});
    if (part) await unlink(part).catch(() => {});
    if (target && !completed) await unlink(target).catch(() => {});
    if (directory && !completed) await rmdir(directory).catch(() => {});
  }
}
