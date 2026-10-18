import { z } from 'zod';
import { FLAG_CODES, type DeckMeta, type ExtractionReport, type SlideData } from '../pptx/model';

/**
 * Validation for everything read back from an *untrusted* source (backup files).
 * Strings that end up in inline styles or links are constrained here as well
 * as at render time (defence in depth).
 */

const num = z.number();
const int = z.number().int();
const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const str = (max = 100_000) => z.string().max(max);
/** Identifiers are used inside ZIP entry names, so they are restricted to a safe alphabet. */
export const idStr = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const safeLink = z.string().max(2048).regex(/^(https?:|mailto:)/i);

const box = z.object({
  x: num,
  y: num,
  w: num,
  h: num,
  rot: num.optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
});

const textRun = z.object({
  kind: z.literal('text'),
  text: str(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  mono: z.boolean().optional(),
  sup: z.boolean().optional(),
  sub: z.boolean().optional(),
  size: num.optional(),
  color: hex.optional(),
  link: safeLink.optional(),
  field: str(64).optional(),
});
const mathInline = z.object({ kind: z.literal('math'), latex: str(), plain: str(), display: z.boolean(), partial: z.boolean() });
const lineBreak = z.object({ kind: z.literal('break') });

const paragraph = z.object({
  level: int.min(0).max(8),
  bullet: z.enum(['none', 'bullet', 'number']),
  align: z.enum(['l', 'ctr', 'r', 'just']).optional(),
  inlines: z.array(z.discriminatedUnion('kind', [textRun, mathInline, lineBreak])).max(5_000),
  text: str(),
});

const base = {
  id: str(200),
  name: str(500),
  z: num,
  box: box.optional(),
  alt: str(5_000).optional(),
  groupPath: z.array(str(500)).max(64).optional(),
  decorative: z.boolean().optional(),
  hidden: z.boolean().optional(),
};

const role = z.enum(['title', 'subtitle', 'body', 'footer', 'slideNumber', 'date', 'other']);

const shape = z.object({
  ...base,
  kind: z.literal('shape'),
  geom: str(100),
  role: role.optional(),
  isTextBox: z.boolean(),
  fill: hex.optional(),
  line: z.object({ color: hex, width: num }).optional(),
  paragraphs: z.array(paragraph).max(5_000),
  anchor: z.enum(['top', 'middle', 'bottom']).optional(),
  fontScale: num.optional(),
  vertical: z.boolean().optional(),
});

const line = z.object({
  ...base,
  kind: z.literal('line'),
  geom: str(100),
  color: hex.optional(),
  width: num.optional(),
  arrowEnd: z.boolean().optional(),
  arrowStart: z.boolean().optional(),
  dash: str(50).optional(),
});

const picture = z.object({
  ...base,
  kind: z.literal('picture'),
  media: str(1_000).optional(),
  mime: str(100).optional(),
  renderable: z.boolean(),
  coverage: num,
  crop: z.object({ l: num, t: num, r: num, b: num }).optional(),
});

const tableCell = z.object({ paragraphs: z.array(paragraph).max(500), text: str(), gridSpan: int, rowSpan: int, merged: z.boolean() });
const table = z.object({
  ...base,
  kind: z.literal('table'),
  columnWidths: z.array(num).max(200),
  rowHeights: z.array(num).max(2_000),
  headerRow: z.boolean(),
  rows: z.array(z.array(tableCell).max(200)).max(2_000),
});

const chartData = z.object({
  chartType: str(200),
  title: str(2_000).optional(),
  categories: z.array(str(2_000)).max(10_000),
  series: z.array(z.object({ name: str(2_000), values: z.array(z.union([num, str(2_000)])).max(10_000) })).max(200),
  xValues: z.array(z.array(z.union([num, str(2_000)])).max(10_000)).max(200).optional(),
});
const chart = z.object({ ...base, kind: z.literal('chart'), chart: chartData.nullable() });

const smartArt = z.object({
  ...base,
  kind: z.literal('smartart'),
  outline: z.array(z.object({ text: str(5_000), depth: int.min(0).max(64) })).max(5_000),
  shapes: z.array(shape).max(2_000),
});

const ole = z.object({
  ...base,
  kind: z.literal('ole'),
  progId: str(200).optional(),
  previewMedia: str(1_000).optional(),
  previewRenderable: z.boolean().optional(),
});
const media = z.object({ ...base, kind: z.literal('media'), mediaKind: z.enum(['video', 'audio']), posterMedia: str(1_000).optional() });
const unsupported = z.object({ ...base, kind: z.literal('unsupported'), what: str(500) });

const element = z.discriminatedUnion('kind', [shape, line, picture, table, chart, smartArt, ole, media, unsupported]);

const flag = z.object({
  code: z.enum(FLAG_CODES),
  severity: z.enum(['info', 'warning', 'attention']),
  message: str(5_000),
  slide: int.optional(),
  elementId: str(200).optional(),
  resolved: z.boolean().optional(),
});

const confidence = z.enum(['high', 'medium', 'low']);

export const slideSchema = z.object({
  index: int.min(1),
  slideId: num,
  part: str(500),
  layoutName: str(500).optional(),
  layoutType: str(100).optional(),
  hidden: z.boolean(),
  status: z.enum(['ok', 'failed']),
  title: str(5_000),
  elements: z.array(element).max(10_000),
  background: z.object({ color: hex.optional(), media: str(1_000).optional() }).optional(),
  notes: str(),
  text: str(1_000_000),
  pictureTexts: z.array(z.object({ elementId: str(200), text: str(10_000) })).max(500).optional(),
  flags: z.array(flag).max(10_000),
  confidence,
  counts: z.object({ tables: int, pictures: int, charts: int, smartArt: int, equations: int, ole: int, media: int, shapes: int }),
  hasAnimations: z.boolean(),
  coverage: z.object({ rawChars: int, capturedChars: int, missing: z.array(str(5_000)).max(100) }),
});

export const deckMetaSchema = z.object({
  title: str(1_000).optional(),
  author: str(1_000).optional(),
  created: str(100).optional(),
  modified: str(100).optional(),
  application: str(200).optional(),
  slideWidth: num,
  slideHeight: num,
  slideCount: int,
  sections: z.array(z.object({ name: str(1_000), slideIds: z.array(num).max(5_000) })).max(1_000),
});

const topic = z.object({
  id: str(64),
  title: str(5_000),
  startSlide: int,
  endSlide: int,
  source: z.enum(['section', 'layout', 'title']),
  keyTerms: z.array(str(200)).max(50),
});

export const reportSchema = z.object({
  totalSlides: int,
  processedSlides: int,
  failedSlides: int,
  slidesRequiringAttention: z.array(int).max(5_000),
  hiddenSlides: z.array(int).max(5_000),
  tables: int,
  pictures: int,
  charts: int,
  smartArt: int,
  equations: int,
  oleObjects: int,
  embeddedMedia: int,
  slidesWithNotes: int,
  topics: z.array(topic).max(5_000),
  potentiallyMissing: z.array(str(5_000)).max(500),
  flagsByCode: z.record(z.string(), int),
  overallConfidence: num,
  confidenceLabel: confidence,
  limitations: z.array(str(5_000)).max(100),
});

export const courseSchema = z.object({
  id: idStr,
  name: str(300),
  code: str(50).optional(),
  color: int.min(0).max(31),
  createdAt: num,
  updatedAt: num,
  archived: z.boolean(),
  examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  goal: str(2_000).optional(),
  /** Professor / exam-format instructions, applied to AI prompts and exam generation. */
  examStyle: str(5_000).optional(),
  order: num,
});

export const lectureSchema = z.object({
  id: idStr,
  courseId: idStr,
  title: str(500),
  order: num,
  fileName: str(500),
  fileHash: z.string().regex(/^[0-9a-f]{64}$/),
  fileSize: int,
  importedAt: num,
  updatedAt: num,
  revision: int,
  slideCount: int,
  meta: deckMetaSchema,
  report: reportSchema,
});

export const slideRowSchema = slideSchema.extend({ lectureId: idStr });

export const settingSchema = z.object({ key: str(200), value: z.unknown() });

// Compile-time guarantee that the validators accept exactly what the engine produces.
type Assert<T extends true> = T;
export type _SlideMatches = Assert<z.infer<typeof slideSchema> extends SlideData ? true : false>;
export type _MetaMatches = Assert<z.infer<typeof deckMetaSchema> extends DeckMeta ? true : false>;
// flagsByCode is a string-keyed record on the wire (forward compatible with new flag codes).
export type _ReportMatches = Assert<Omit<z.infer<typeof reportSchema>, 'flagsByCode'> extends Omit<ExtractionReport, 'flagsByCode'> ? true : false>;
