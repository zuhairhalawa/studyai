import { describe, expect, it } from 'vitest';
import { ZipArchive } from '../src/core/pptx/zip';
import { PptxError, type PptxErrorCode } from '../src/core/pptx/errors';
import { DEFAULT_LIMITS, withLimits } from '../src/core/pptx/limits';
import { craftZip, deflatedEntry, storedEntry } from './helpers/zipcraft';

const enc = (s: string) => new TextEncoder().encode(s);

function codeOf(fn: () => unknown): PptxErrorCode | 'no-error' {
  try {
    fn();
    return 'no-error';
  } catch (e) {
    if (e instanceof PptxError) return e.code;
    throw e;
  }
}

describe('ZipArchive', () => {
  it('reads stored and deflated entries and verifies them', () => {
    const zip = craftZip([storedEntry('a.txt', enc('hello')), deflatedEntry('dir/b.xml', enc('<x>' + 'y'.repeat(5000) + '</x>'))]);
    const a = new ZipArchive(zip, DEFAULT_LIMITS);
    expect(a.names()).toEqual(['a.txt', 'dir/b.xml']);
    expect(new TextDecoder().decode(a.read('a.txt'))).toBe('hello');
    expect(new TextDecoder().decode(a.read('dir/b.xml')).length).toBe(5007);
    expect(a.has('DIR/B.XML')).toBe(true); // OPC part names are case-insensitive
  });

  it('rejects data that is not a zip', () => {
    expect(codeOf(() => new ZipArchive(enc('this is definitely not a zip file at all'), DEFAULT_LIMITS))).toBe('NOT_A_ZIP');
  });

  it('recognises legacy .ppt (OLE2) files', () => {
    const ole = new Uint8Array(2048);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(codeOf(() => new ZipArchive(ole, DEFAULT_LIMITS))).toBe('LEGACY_PPT');
  });

  it('recognises password-protected OOXML (OLE2 + EncryptedPackage)', () => {
    const ole = new Uint8Array(4096);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const name = new TextEncoder().encode('E\0n\0c\0r\0y\0p\0t\0e\0d\0P\0a\0c\0k\0a\0g\0e\0');
    ole.set(name, 1024);
    expect(codeOf(() => new ZipArchive(ole, DEFAULT_LIMITS))).toBe('ENCRYPTED');
  });

  it('rejects path traversal and absolute names', () => {
    for (const bad of ['../evil.xml', 'a/../../evil.xml', '/etc/passwd', 'C:/x.xml', 'a\\b.xml']) {
      expect(codeOf(() => new ZipArchive(craftZip([storedEntry(bad, enc('x'))]), DEFAULT_LIMITS))).toBe('ZIP_BAD_ENTRY');
    }
  });

  it('rejects duplicate entry names (case-insensitively)', () => {
    const zip = craftZip([storedEntry('ppt/a.xml', enc('1')), storedEntry('PPT/A.xml', enc('2'))]);
    expect(codeOf(() => new ZipArchive(zip, DEFAULT_LIMITS))).toBe('ZIP_DUPLICATE_ENTRY');
  });

  it('rejects encrypted entries', () => {
    const e = storedEntry('a.xml', enc('x'));
    e.flags = 1;
    expect(codeOf(() => new ZipArchive(craftZip([e]), DEFAULT_LIMITS))).toBe('ENCRYPTED');
  });

  it('rejects unsupported compression methods', () => {
    const e = storedEntry('a.xml', enc('x'));
    (e as { method: number }).method = 12; // bzip2
    expect(codeOf(() => new ZipArchive(craftZip([e]), DEFAULT_LIMITS))).toBe('ZIP_UNSUPPORTED');
  });

  it('aborts when an entry expands beyond its declared size (lying header)', () => {
    // Declares 10 bytes, actually expands to 4 MiB.
    const real = new Uint8Array(4 * 1024 * 1024).fill(65);
    const zip = craftZip([deflatedEntry('ppt/slides/slide1.xml', real, { size: 10 })]);
    const a = new ZipArchive(zip, DEFAULT_LIMITS);
    expect(codeOf(() => a.read('ppt/slides/slide1.xml'))).toBe('ZIP_SIZE_MISMATCH');
  });

  it('rejects an entry that expands to less than declared', () => {
    const zip = craftZip([deflatedEntry('a.bin', enc('short'), { size: 500 })]);
    const a = new ZipArchive(zip, DEFAULT_LIMITS);
    expect(codeOf(() => a.read('a.bin'))).toBe('ZIP_SIZE_MISMATCH');
  });

  it('flags suspicious compression ratios (zip bomb)', () => {
    const zeros = new Uint8Array(30 * 1024 * 1024); // deflates to ~30 KiB => ratio ~1000
    const zip = craftZip([deflatedEntry('ppt/media/bomb.bin', zeros)]);
    const a = new ZipArchive(zip, DEFAULT_LIMITS);
    expect(codeOf(() => a.read('ppt/media/bomb.bin'))).toBe('ZIP_RATIO_SUSPICIOUS');
    expect(a.decompressedBytes).toBe(0); // nothing was inflated
  });

  it('enforces the per-XML-part size limit before decompressing', () => {
    const zip = craftZip([deflatedEntry('ppt/slides/slide1.xml', enc('<a>' + 'x'.repeat(5000) + '</a>'))]);
    const a = new ZipArchive(zip, withLimits({ maxXmlBytes: 1000 }));
    expect(codeOf(() => a.read('ppt/slides/slide1.xml'))).toBe('XML_TOO_LARGE');
  });

  it('enforces the per-entry limit for binary parts', () => {
    const zip = craftZip([deflatedEntry('ppt/media/image1.png', new Uint8Array(5000).map((_, i) => i * 7))]);
    const a = new ZipArchive(zip, withLimits({ maxEntryBytes: 1000 }));
    expect(codeOf(() => a.read('ppt/media/image1.png'))).toBe('ZIP_ENTRY_TOO_LARGE');
  });

  it('enforces the cumulative decompression budget', () => {
    const blob = new Uint8Array(4000).map((_, i) => (i * 31) & 255);
    const zip = craftZip([deflatedEntry('a.bin', blob), deflatedEntry('b.bin', blob), deflatedEntry('c.bin', blob)]);
    const a = new ZipArchive(zip, withLimits({ maxTotalBytes: 9000 }));
    a.read('a.bin');
    a.read('b.bin');
    expect(codeOf(() => a.read('c.bin'))).toBe('ZIP_TOTAL_TOO_LARGE');
  });

  it('detects CRC corruption', () => {
    const zip = craftZip([deflatedEntry('a.bin', enc('payload payload payload'), { crc: 0x12345678 })]);
    const a = new ZipArchive(zip, DEFAULT_LIMITS);
    expect(codeOf(() => a.read('a.bin'))).toBe('ZIP_CRC_MISMATCH');
  });

  it('rejects overlapping entries', () => {
    const zip = craftZip([storedEntry('a.bin', enc('same bytes')), storedEntry('b.bin', enc('same bytes'))], { overlapSecondOnFirst: true });
    expect(codeOf(() => new ZipArchive(zip, DEFAULT_LIMITS))).toBe('ZIP_OVERLAP');
  });

  it('enforces the entry-count limit', () => {
    const zip = craftZip([1, 2, 3, 4].map((i) => storedEntry(`f${i}.txt`, enc('x'))));
    expect(codeOf(() => new ZipArchive(zip, withLimits({ maxEntries: 3 })))).toBe('ZIP_TOO_MANY_ENTRIES');
  });

  it('enforces the file-size limit', () => {
    const zip = craftZip([storedEntry('a.txt', enc('hello'))]);
    expect(codeOf(() => new ZipArchive(zip, withLimits({ maxFileBytes: 10 })))).toBe('FILE_TOO_LARGE');
  });

  it('throws a clean error for a corrupt deflate stream', () => {
    const e = deflatedEntry('a.bin', enc('hello world, hello world, hello world'));
    e.stored = new Uint8Array(e.stored.length).fill(0xff);
    const a = new ZipArchive(craftZip([e]), DEFAULT_LIMITS);
    expect(codeOf(() => a.read('a.bin'))).toBe('ZIP_BAD_ENTRY');
  });
});
