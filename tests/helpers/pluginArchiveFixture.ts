import { deflateRawSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

export type FixtureEntry = {
  name: string;
  bytes: Buffer;
  method?: number;
  flags?: number;
  attributes?: number;
  extra?: Buffer;
  compressed?: Buffer;
  size?: number;
  crc?: number;
  descriptorSignature?: boolean;
};
export function makePluginZip(entries: readonly FixtureEntry[]) {
  const local: Buffer[] = [],
    central: Buffer[] = [],
    locals: number[] = [],
    centers: number[] = [],
    payloads: number[] = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name),
      extra = item.extra ?? Buffer.alloc(0),
      method = item.method ?? 0,
      flags = item.flags ?? 0x800;
    const compressed = item.compressed ?? (method === 8 ? deflateRawSync(item.bytes) : item.bytes),
      size = item.size ?? item.bytes.length,
      crc = item.crc ?? crc32(item.bytes);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(flags, 6);
    l.writeUInt16LE(method, 8);
    if (!(flags & 8)) {
      l.writeUInt32LE(crc, 14);
      l.writeUInt32LE(compressed.length, 18);
      l.writeUInt32LE(size, 22);
    }
    l.writeUInt16LE(name.length, 26);
    l.writeUInt16LE(extra.length, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(item.attributes ?? 0, 38);
    c.writeUInt32LE(offset, 42);
    const descriptor =
      flags & 8 ? Buffer.alloc(item.descriptorSignature === false ? 12 : 16) : Buffer.alloc(0);
    if (descriptor.length) {
      const start = descriptor.length === 16 ? 4 : 0;
      if (start) descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, start);
      descriptor.writeUInt32LE(compressed.length, start + 4);
      descriptor.writeUInt32LE(size, start + 8);
    }
    locals.push(offset);
    payloads.push(offset + l.length + name.length + extra.length);
    local.push(l, name, extra, compressed, descriptor);
    central.push(c, name, extra);
    offset += l.length + name.length + extra.length + compressed.length + descriptor.length;
  }
  const centralAt = offset;
  for (let i = 0; i < central.length; i += 3) {
    centers.push(offset);
    offset +=
      (central[i]?.length ?? 0) + (central[i + 1]?.length ?? 0) + (central[i + 2]?.length ?? 0);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralAt, 12);
  end.writeUInt32LE(centralAt, 16);
  return {
    buffer: Buffer.concat([...local, ...central, end]),
    centralAt,
    centers,
    locals,
    payloads,
    eocd: offset,
  };
}
export const fileHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const fixtureGuid = '8ba69c10-0f12-4bc0-8ced-a167b8947149';
export function fixtureXml(assembly = 'managed/gen-v1/Plugin.dll', id = fixtureGuid): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><RevitAddIns><AddIn Type="Application"><Name>Synthetic fixture</Name><Assembly>${assembly}</Assembly><AddInId>${id}</AddInId><FullClassName>Fixture.Plugin</FullClassName><VendorId>TEST</VendorId></AddIn></RevitAddIns>`,
  );
}
/**
 * Пакет набора формата 2 из записей формата 1: одинаковые файлы в 2025/ и 2026/ (кроме
 * .addin) — один раз в `_shared/<sha256>.<ext>`, в schema-plugins.json — `format: 2` и `links`.
 */
export function toFormat2(entries: readonly FixtureEntry[]): {
  entries: FixtureEntry[];
  links: Record<string, string>;
} {
  const groups = new Map<string, FixtureEntry[]>();
  for (const e of entries)
    if (/^20(25|26)\//.test(e.name) && !/\.addin$/i.test(e.name)) {
      const hash = fileHash(e.bytes);
      groups.set(hash, [...(groups.get(hash) ?? []), e]);
    }
  const links: Record<string, string> = {},
    shared: FixtureEntry[] = [],
    linked = new Set<string>();
  for (const [hash, group] of groups) {
    if (group.length < 2) continue;
    const ext = /\.([a-z0-9]+)$/i.exec(group[0]?.name ?? '')?.[1]?.toLowerCase() ?? 'bin';
    if (group.some((e) => !e.name.toLowerCase().endsWith(`.${ext}`))) continue;
    const blob = `_shared/${hash}.${ext}`;
    shared.push({ name: blob, bytes: group[0]?.bytes ?? Buffer.alloc(0) });
    for (const e of group) {
      links[e.name] = blob;
      linked.add(e.name);
    }
  }
  const result = entries
    .filter((e) => !linked.has(e.name))
    .map((e) => {
      if (e.name !== 'schema-plugins.json') return e;
      const manifest = JSON.parse(e.bytes.toString('utf8')) as Record<string, unknown>;
      return {
        ...e,
        bytes: Buffer.from(JSON.stringify({ ...manifest, format: 2, links })),
      };
    });
  return { entries: [...result, ...shared], links };
}
