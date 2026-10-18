/**
 * Hard limits applied to every uploaded presentation. PowerPoint files are
 * untrusted input: they are ZIP archives containing XML, so the main risks are
 * decompression bombs, XML entity expansion and pathological nesting.
 */
export interface ExtractionLimits {
  /** Maximum size of the .pptx file itself. */
  maxFileBytes: number;
  /** Maximum number of entries in the ZIP central directory. */
  maxEntries: number;
  /** Maximum uncompressed size of any single non-XML entry (images, media). */
  maxEntryBytes: number;
  /** Maximum uncompressed size of any single XML entry. */
  maxXmlBytes: number;
  /** Maximum cumulative number of bytes decompressed while reading one deck. */
  maxTotalBytes: number;
  /** Maximum uncompressed/compressed ratio for entries above 1 MiB. */
  maxCompressionRatio: number;
  maxSlides: number;
  /** Maximum shape-group nesting that is followed. */
  maxGroupDepth: number;
  /** Maximum XML element nesting accepted by the parser. */
  maxXmlDepth: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS: ExtractionLimits = {
  maxFileBytes: 250 * MiB,
  maxEntries: 10_000,
  maxEntryBytes: 120 * MiB,
  maxXmlBytes: 24 * MiB,
  maxTotalBytes: 900 * MiB,
  maxCompressionRatio: 300,
  maxSlides: 1_000,
  maxGroupDepth: 12,
  maxXmlDepth: 200,
};

export function withLimits(overrides?: Partial<ExtractionLimits>): ExtractionLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}
