/**
 * Intermediate representation (IR) of a parsed PowerPoint deck.
 *
 * Design rules:
 *  - Everything extracted keeps a pointer back to where it came from
 *    (slide number + OOXML part + shape id) so the UI can show "source".
 *  - Nothing that could not be understood is silently dropped: it becomes an
 *    element of kind 'unsupported' / a flag, so the completeness report can
 *    tell the student what to double-check.
 *  - All geometry is in EMU (English Metric Units, 914400 per inch) exactly as
 *    stored in the file; the renderer converts.
 */

export type Emu = number;

export interface Box {
  x: Emu;
  y: Emu;
  w: Emu;
  h: Emu;
  /** Rotation in degrees (clockwise). */
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
}

// ---------------------------------------------------------------------------
// Flags (extraction quality notes)
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warning' | 'attention';

export const FLAG_CODES = [
  'SLIDE_PARSE_FAILED',
  'NO_EXTRACTABLE_TEXT',
  'LARGE_PICTURE',
  'UNRENDERABLE_IMAGE',
  'MISSING_MEDIA',
  'SMARTART',
  'CHART',
  'CHART_NO_DATA',
  'OLE_OBJECT',
  'EQUATION_OBJECT',
  'MATH_CONVERTED',
  'MATH_PARTIAL',
  'EMBEDDED_MEDIA',
  'INK',
  'UNSUPPORTED_OBJECT',
  'CUSTOM_GEOMETRY',
  'SYMBOL_FONT',
  'ANIMATIONS',
  'HIDDEN_SLIDE',
  'VERTICAL_TEXT',
  'TEXT_NOT_CAPTURED',
  'EXTERNAL_LINK',
  'MERGED_TABLE_CELLS',
  'GROUPED_SHAPES',
  'NESTING_LIMIT',
  'HIDDEN_SHAPE',
  'EXTRA_CONTENT_TYPE',
  'PICTURE_TEXT_ADDED',
] as const;

export type FlagCode = (typeof FLAG_CODES)[number];

export interface Flag {
  code: FlagCode;
  severity: Severity;
  message: string;
  /** 1-based slide number, when the flag belongs to a slide. */
  slide?: number;
  /** The student dealt with the cause (typed the text of the picture): kept as a record, no longer counts against the slide. */
  resolved?: boolean;
  /** OOXML shape id (p:cNvPr@id) of the affected element, when known. */
  elementId?: string;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface TextRun {
  kind: 'text';
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Font looks monospaced (Consolas, Courier, ...): treat as code. */
  mono?: boolean;
  sup?: boolean;
  sub?: boolean;
  /** Font size in points (already resolved through placeholder/master inheritance). */
  size?: number;
  /** Resolved #RRGGBB colour. */
  color?: string;
  link?: string;
  /** Set when the run is a PowerPoint field (slidenum, datetime, ...). */
  field?: string;
}

export interface MathInline {
  kind: 'math';
  /** LaTeX converted from Office Math (OMML). Best effort - always flagged. */
  latex: string;
  /** Linear plain-text version of the same equation (used for search). */
  plain: string;
  display: boolean;
  /** True when some OMML constructs were not understood. */
  partial: boolean;
}

export interface LineBreak {
  kind: 'break';
}

export type Inline = TextRun | MathInline | LineBreak;

export interface Paragraph {
  level: number;
  bullet: 'none' | 'bullet' | 'number';
  align?: 'l' | 'ctr' | 'r' | 'just';
  /** Space before and after the paragraph, in points (resolved through the style chain), when the file sets them. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** Line spacing as a multiple of the single line (0.9 = 90 %), when the file sets it. */
  lineSpacing?: number;
  /** Size in points of an empty paragraph (a blank line used as a spacer), when it has no text to take it from. */
  endSize?: number;
  inlines: Inline[];
  /** Plain text of the paragraph (math rendered via its `plain` form). */
  text: string;
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

export type PlaceholderRole =
  | 'title'
  | 'subtitle'
  | 'body'
  | 'footer'
  | 'slideNumber'
  | 'date'
  | 'other';

interface BaseElement {
  /** OOXML shape id (unique within the slide). */
  id: string;
  name: string;
  /** Paint order (document order, back to front). */
  z: number;
  /** Absolute box on the slide in EMU (group transforms already applied). */
  box?: Box;
  /** Alt text / description authored in PowerPoint. */
  alt?: string;
  /** Names of enclosing groups, outermost first. */
  groupPath?: string[];
  /** Header/footer/slide-number furniture: shown in the slide, excluded from study text. */
  decorative?: boolean;
  /** Shape is hidden in PowerPoint (kept in the data, not shown, not in study text). */
  hidden?: boolean;
}

export interface ShapeElement extends BaseElement {
  kind: 'shape';
  /** Preset geometry name ("rect", "roundRect", "ellipse", ...) or "custom". */
  geom: string;
  role?: PlaceholderRole;
  isTextBox: boolean;
  fill?: string;
  line?: { color: string; width: Emu };
  paragraphs: Paragraph[];
  anchor?: 'top' | 'middle' | 'bottom';
  /** Text scale applied by "shrink text on overflow" (1 = none). */
  fontScale?: number;
  vertical?: boolean;
}

export interface LineElement extends BaseElement {
  kind: 'line';
  geom: string;
  color?: string;
  width?: Emu;
  arrowEnd?: boolean;
  arrowStart?: boolean;
  dash?: string;
}

export interface PictureElement extends BaseElement {
  kind: 'picture';
  /** Key into the deck media map (the OPC part path, e.g. "ppt/media/image3.png"). */
  media?: string;
  mime?: string;
  /** False for EMF/WMF/TIFF etc. which browsers cannot display. */
  renderable: boolean;
  /** Fraction of the slide area covered by this picture (0..1). */
  coverage: number;
  crop?: { l: number; t: number; r: number; b: number };
}

export interface TableCell {
  paragraphs: Paragraph[];
  text: string;
  gridSpan: number;
  rowSpan: number;
  /** Cell is covered by a horizontally/vertically merged neighbour. */
  merged: boolean;
}

export interface TableElement extends BaseElement {
  kind: 'table';
  columnWidths: Emu[];
  rowHeights: Emu[];
  headerRow: boolean;
  rows: TableCell[][];
}

export interface ChartData {
  chartType: string;
  title?: string;
  categories: string[];
  series: { name: string; values: (number | string)[] }[];
  /** Series x-values for scatter/bubble charts. */
  xValues?: (number | string)[][];
}

export interface ChartElement extends BaseElement {
  kind: 'chart';
  chart: ChartData | null;
}

export interface SmartArtNode {
  text: string;
  depth: number;
}

export interface SmartArtElement extends BaseElement {
  kind: 'smartart';
  /** Text nodes of the diagram, ordered; depth is inferred from the data model. */
  outline: SmartArtNode[];
  /** Pre-rendered shapes from the diagram drawing part, relative to `box`. */
  shapes: ShapeElement[];
}

export interface OleElement extends BaseElement {
  kind: 'ole';
  progId?: string;
  previewMedia?: string;
  previewRenderable?: boolean;
}

export interface MediaElement extends BaseElement {
  kind: 'media';
  mediaKind: 'video' | 'audio';
  posterMedia?: string;
}

export interface UnsupportedElement extends BaseElement {
  kind: 'unsupported';
  what: string;
}

export type SlideElement =
  | ShapeElement
  | LineElement
  | PictureElement
  | TableElement
  | ChartElement
  | SmartArtElement
  | OleElement
  | MediaElement
  | UnsupportedElement;

// ---------------------------------------------------------------------------
// Slide / deck
// ---------------------------------------------------------------------------

export type Confidence = 'high' | 'medium' | 'low';

export interface SlideBackground {
  color?: string;
  media?: string;
}

export interface SlideCounts {
  tables: number;
  pictures: number;
  charts: number;
  smartArt: number;
  equations: number;
  ole: number;
  media: number;
  shapes: number;
}

export interface SlideData {
  /** 1-based position in the presentation (hidden slides included). */
  index: number;
  /** presentation.xml sldId@id. */
  slideId: number;
  /** OPC part name, e.g. "ppt/slides/slide3.xml". */
  part: string;
  layoutName?: string;
  layoutType?: string;
  hidden: boolean;
  status: 'ok' | 'failed';
  title: string;
  elements: SlideElement[];
  background?: SlideBackground;
  /** Speaker notes, plain text ('' when none). */
  notes: string;
  /** Study text: title + body + tables + chart/diagram text (no notes, no footers). */
  text: string;
  flags: Flag[];
  confidence: Confidence;
  counts: SlideCounts;
  hasAnimations: boolean;
  /** Text the student typed for pictures whose words are not in the file; already included in `text`. */
  pictureTexts?: { elementId: string; text: string }[];
  /** Internal completeness invariant: every a:t in the slide XML must be captured. */
  coverage: { rawChars: number; capturedChars: number; missing: string[] };
}

export interface DeckMeta {
  title?: string;
  author?: string;
  created?: string;
  modified?: string;
  application?: string;
  slideWidth: Emu;
  slideHeight: Emu;
  slideCount: number;
  sections: { name: string; slideIds: number[] }[];
}

export interface MediaAsset {
  key: string;
  mime: string;
  bytes: Uint8Array;
}

export interface Topic {
  id: string;
  title: string;
  /** Inclusive 1-based slide range. */
  startSlide: number;
  endSlide: number;
  source: 'section' | 'layout' | 'title';
  keyTerms: string[];
}

export interface ExtractionReport {
  totalSlides: number;
  processedSlides: number;
  failedSlides: number;
  /** Slides with at least one 'attention' flag or low confidence. */
  slidesRequiringAttention: number[];
  hiddenSlides: number[];
  tables: number;
  pictures: number;
  charts: number;
  smartArt: number;
  equations: number;
  oleObjects: number;
  embeddedMedia: number;
  slidesWithNotes: number;
  topics: Topic[];
  /** Plain-language list of things that may be missing from the extracted text. */
  potentiallyMissing: string[];
  flagsByCode: Partial<Record<FlagCode, number>>;
  /** 0..1: share of slides whose confidence is 'high'. */
  overallConfidence: number;
  confidenceLabel: Confidence;
  limitations: string[];
}

export interface ParsedDeck {
  meta: DeckMeta;
  slides: SlideData[];
  media: Map<string, MediaAsset>;
  report: ExtractionReport;
  /** SHA-256 (hex) of the original file, for duplicate detection. */
  fileHash: string;
  fileSize: number;
  /** Deck-level flags that are not tied to a single slide. */
  flags: Flag[];
}

// ---------------------------------------------------------------------------
// Source references (shared with notes, flashcards, questions, tutor answers)
// ---------------------------------------------------------------------------

export interface SourceRef {
  lectureId: string;
  /** 1-based slide number. */
  slide: number;
  /** Optional specific element on the slide. */
  elementId?: string;
  /** Short verbatim quote from the slide, when the reference supports a claim. */
  quote?: string;
}
