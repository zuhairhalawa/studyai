import { Inflate } from 'fflate';
import { PptxError } from './errors';
import type { ExtractionLimits } from './limits';

/**
 * Minimal, defensive ZIP reader for untrusted .pptx files.
 *
 * Why not just call a library's unzip? Libraries trust the sizes declared in
 * the archive headers. A hostile archive can declare a small size and expand
 * to gigabytes, or contain overlapping entries that all point at the same
 * compressed bytes. This reader:
 *   - parses the central directory itself and rejects ZIP64 / encryption /
 *     unknown compression methods,
 *   - rejects duplicate names, path traversal and overlapping entries,
 *   - decompresses incrementally and aborts as soon as the *actual* output
 *     exceeds the declared size (so a lying header cannot cause a big
 *     allocation),
 *   - keeps a cumulative decompression budget for the whole deck,
 *   - verifies CRC-32 of every entry it returns.
 * Entries are only decompressed when `read()` is called.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const MiB = 1024 * 1024;
const INFLATE_SLICE = 16 * 1024;

interface Entry {
  name: string;
  method: number;
  crc: number;
  compSize: number;
  size: number;
  dataStart: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

export function isXmlPartName(name: string): boolean {
  return /\.(xml|rels|vml)$/i.test(name);
}

function validateName(raw: string): void {
  if (
    raw.length === 0 ||
    raw.includes('\0') ||
    raw.includes('\\') ||
    raw.startsWith('/') ||
    /^[a-zA-Z]:/.test(raw) ||
    raw.split('/').some((seg) => seg === '..')
  ) {
    throw new PptxError('ZIP_BAD_ENTRY', `Unsafe entry name in archive: ${JSON.stringify(raw.slice(0, 80))}`);
  }
}

export class ZipArchive {
  private readonly entries = new Map<string, Entry>();
  private readonly lowerIndex = new Map<string, string>();
  private budgetUsed = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly limits: ExtractionLimits,
  ) {
    if (data.length > limits.maxFileBytes) {
      throw new PptxError('FILE_TOO_LARGE', `File is ${(data.length / MiB).toFixed(1)} MiB; limit is ${(limits.maxFileBytes / MiB).toFixed(0)} MiB.`);
    }
    this.parse();
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  /** Declared (header) uncompressed size, or undefined if the entry does not exist. */
  declaredSize(name: string): number | undefined {
    const key = this.resolve(name);
    return key ? this.entries.get(key)!.size : undefined;
  }

  /** Total bytes decompressed so far (for tests and diagnostics). */
  get decompressedBytes(): number {
    return this.budgetUsed;
  }

  /** Read and verify one entry. Throws PptxError when limits or integrity checks fail. */
  read(name: string): Uint8Array {
    const key = this.resolve(name);
    if (!key) throw new PptxError('ZIP_BAD_ENTRY', `Entry not found: ${name}`);
    const e = this.entries.get(key)!;
    const xml = isXmlPartName(e.name);
    const cap = xml ? this.limits.maxXmlBytes : this.limits.maxEntryBytes;
    if (e.size > cap) {
      throw new PptxError(xml ? 'XML_TOO_LARGE' : 'ZIP_ENTRY_TOO_LARGE', `Entry ${e.name} declares ${(e.size / MiB).toFixed(1)} MiB; limit is ${(cap / MiB).toFixed(0)} MiB.`);
    }
    if (e.size > MiB && e.size / Math.max(e.compSize, 1) > this.limits.maxCompressionRatio) {
      throw new PptxError('ZIP_RATIO_SUSPICIOUS', `Entry ${e.name} has a suspicious compression ratio (${Math.round(e.size / Math.max(e.compSize, 1))}:1).`);
    }
    if (this.budgetUsed + e.size > this.limits.maxTotalBytes) {
      throw new PptxError('ZIP_TOTAL_TOO_LARGE', 'Decompressed content exceeds the total size budget for one presentation.');
    }
    this.budgetUsed += e.size;

    const compressed = this.data.subarray(e.dataStart, e.dataStart + e.compSize);
    let out: Uint8Array;
    if (e.method === 0) {
      if (compressed.length !== e.size) throw new PptxError('ZIP_SIZE_MISMATCH', `Stored entry ${e.name} has inconsistent sizes.`);
      out = compressed.slice();
    } else {
      out = this.inflateExact(e, compressed);
    }
    if (crc32(out) !== e.crc) {
      throw new PptxError('ZIP_CRC_MISMATCH', `Entry ${e.name} is corrupt (CRC mismatch).`);
    }
    return out;
  }

  private inflateExact(e: Entry, compressed: Uint8Array): Uint8Array {
    const out = new Uint8Array(e.size);
    let written = 0;
    let failure: PptxError | undefined;
    const inflater = new Inflate((chunk) => {
      if (failure) return;
      if (written + chunk.length > e.size) {
        failure = new PptxError('ZIP_SIZE_MISMATCH', `Entry ${e.name} expands beyond its declared size (possible decompression bomb).`);
        return;
      }
      out.set(chunk, written);
      written += chunk.length;
    });
    try {
      if (compressed.length === 0) inflater.push(new Uint8Array(0), true);
      for (let i = 0; i < compressed.length && !failure; i += INFLATE_SLICE) {
        const end = Math.min(i + INFLATE_SLICE, compressed.length);
        inflater.push(compressed.subarray(i, end), end === compressed.length);
      }
    } catch (err) {
      if (failure) throw failure;
      throw new PptxError('ZIP_BAD_ENTRY', `Entry ${e.name} could not be decompressed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    if (failure) throw failure;
    if (written !== e.size) {
      throw new PptxError('ZIP_SIZE_MISMATCH', `Entry ${e.name} expanded to ${written} bytes but declares ${e.size}.`);
    }
    return out;
  }

  private resolve(name: string): string | undefined {
    if (this.entries.has(name)) return name;
    return this.lowerIndex.get(name.toLowerCase());
  }

  private parse(): void {
    const d = this.data;
    if (d.length < 22) throw new PptxError('NOT_A_ZIP', 'File is too small to be a ZIP archive.');
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);

    // OLE2 compound file (legacy .ppt, or an encrypted OOXML package).
    if (view.getUint32(0, true) === 0xe011cfd0 && view.getUint32(4, true) === 0xe11ab1a1) {
      const probe = new TextDecoder('utf-16le').decode(d.subarray(0, Math.min(d.length, 1 << 20)));
      throw new PptxError(probe.includes('EncryptedPackage') ? 'ENCRYPTED' : 'LEGACY_PPT', 'OLE2 container, not an OOXML package.');
    }

    // Locate the end-of-central-directory record.
    let eocd = -1;
    const minStart = Math.max(0, d.length - 22 - 0xffff);
    for (let i = d.length - 22; i >= minStart; i--) {
      if (view.getUint32(i, true) === SIG_EOCD && i + 22 + view.getUint16(i + 20, true) === d.length) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new PptxError('NOT_A_ZIP', 'ZIP end-of-central-directory record not found.');
    if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) {
      throw new PptxError('ZIP_UNSUPPORTED', 'ZIP64 archives are not supported.');
    }
    const total = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new PptxError('ZIP_UNSUPPORTED', 'ZIP64 archives are not supported.');
    }
    if (total > this.limits.maxEntries) {
      throw new PptxError('ZIP_TOO_MANY_ENTRIES', `Archive has ${total} entries; limit is ${this.limits.maxEntries}.`);
    }
    if (cdOffset + cdSize > eocd) throw new PptxError('NOT_A_ZIP', 'Central directory is out of bounds.');

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const ranges: [number, number][] = [];
    let p = cdOffset;
    for (let n = 0; n < total; n++) {
      if (p + 46 > cdOffset + cdSize || view.getUint32(p, true) !== SIG_CENTRAL) {
        throw new PptxError('NOT_A_ZIP', 'Corrupt central directory.');
      }
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const compSize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      if (p + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) {
        throw new PptxError('NOT_A_ZIP', 'Corrupt central directory entry.');
      }
      const name = decoder.decode(d.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      if (name.endsWith('/')) continue; // directory entry
      validateName(name);
      if (flags & 1) throw new PptxError('ENCRYPTED', `Entry ${name} is encrypted.`);
      if (method !== 0 && method !== 8) {
        throw new PptxError('ZIP_UNSUPPORTED', `Entry ${name} uses unsupported compression method ${method}.`);
      }
      if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
        throw new PptxError('ZIP_UNSUPPORTED', `Entry ${name} requires ZIP64.`);
      }
      const lower = name.toLowerCase();
      if (this.entries.has(name) || this.lowerIndex.has(lower)) {
        throw new PptxError('ZIP_DUPLICATE_ENTRY', `Duplicate entry name: ${name}`);
      }

      // Validate the local header and locate the compressed bytes.
      if (localOffset + 30 > d.length || view.getUint32(localOffset, true) !== SIG_LOCAL) {
        throw new PptxError('ZIP_BAD_ENTRY', `Entry ${name} has an invalid local header.`);
      }
      const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      if (dataStart + compSize > cdOffset) {
        throw new PptxError('ZIP_BAD_ENTRY', `Entry ${name} extends outside the archive body.`);
      }
      ranges.push([localOffset, dataStart + compSize]);
      this.entries.set(name, { name, method, crc, compSize, size, dataStart });
      this.lowerIndex.set(lower, name);
    }

    // Overlapping entries are the signature of "quine"/overlap zip bombs.
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i]![0] < ranges[i - 1]![1]) {
        throw new PptxError('ZIP_OVERLAP', 'Archive contains overlapping entries.');
      }
    }
  }
}
