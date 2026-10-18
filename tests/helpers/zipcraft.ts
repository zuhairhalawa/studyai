import { deflateSync } from 'fflate';
import { crc32 } from '../../src/core/pptx/zip';

/** Hand-assembles ZIP bytes with full control over header fields (for hostile-archive tests). */
export interface RawEntry {
  name: string;
  /** Bytes as stored in the archive (already compressed when method = 8). */
  stored: Uint8Array;
  method: 0 | 8;
  crc: number;
  /** Declared uncompressed size (may lie). */
  size: number;
  flags?: number;
}

export function deflatedEntry(name: string, data: Uint8Array, lie?: { size?: number; crc?: number }): RawEntry {
  return {
    name,
    stored: deflateSync(data),
    method: 8,
    crc: lie?.crc ?? crc32(data),
    size: lie?.size ?? data.length,
  };
}

export function storedEntry(name: string, data: Uint8Array): RawEntry {
  return { name, stored: data, method: 0, crc: crc32(data), size: data.length };
}

export function craftZip(entries: RawEntry[], opts: { overlapSecondOnFirst?: boolean } = {}): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let firstOffset = 0;
  entries.forEach((e, idx) => {
    const name = enc.encode(e.name);
    const localOffset = opts.overlapSecondOnFirst && idx === 1 ? firstOffset : offset;
    if (!(opts.overlapSecondOnFirst && idx === 1)) {
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, e.flags ?? 0, true);
      lh.setUint16(8, e.method, true);
      lh.setUint32(14, e.crc, true);
      lh.setUint32(18, e.stored.length, true);
      lh.setUint32(22, e.size, true);
      lh.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(lh.buffer), name, e.stored);
      if (idx === 0) firstOffset = offset;
      offset += 30 + name.length + e.stored.length;
    }
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, e.flags ?? 0, true);
    ch.setUint16(10, e.method, true);
    ch.setUint32(16, e.crc, true);
    ch.setUint32(20, e.stored.length, true);
    ch.setUint32(24, e.size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, localOffset, true);
    central.push(new Uint8Array(ch.buffer), name);
  });
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
