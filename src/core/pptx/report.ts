import type { Confidence, ExtractionReport, Flag, FlagCode, SlideData, Topic } from './model';

export function scoreSlide(slide: SlideData): Confidence {
  if (slide.status === 'failed') return 'low';
  const open = slide.flags.filter((f) => !f.resolved);
  if (open.some((f) => f.severity === 'attention')) return 'low';
  if (open.some((f) => f.severity === 'warning')) return 'medium';
  return 'high';
}

/** Plain-language label per flag code, used in the "potentially missing content" list. */
const MISSING_LABEL: Partial<Record<FlagCode, string>> = {
  SLIDE_PARSE_FAILED: 'Slide could not be read at all',
  NO_EXTRACTABLE_TEXT: 'No extractable text: content is in pictures/objects (type it in to use it)',
  LARGE_PICTURE: 'Picture that may hold text or a diagram (not read automatically)',
  UNRENDERABLE_IMAGE: 'Image in a format the browser cannot show (EMF/WMF/TIFF)',
  MISSING_MEDIA: 'Image that is missing or could not be read',
  SMARTART: 'SmartArt: text was read but arrangement/hierarchy is inferred',
  CHART_NO_DATA: 'Chart whose data could not be read',
  OLE_OBJECT: 'Embedded object whose contents are not extracted',
  EQUATION_OBJECT: 'Old-style equation object (picture only, no formula text)',
  MATH_PARTIAL: 'Equation that was only partially converted',
  EMBEDDED_MEDIA: 'Embedded video/audio (not extracted)',
  INK: 'Handwritten ink (not extracted)',
  UNSUPPORTED_OBJECT: 'Unsupported object that was not extracted',
  SYMBOL_FONT: 'Symbol-font characters that may be mis-decoded',
  TEXT_NOT_CAPTURED: 'Text in an unsupported container (kept under "Unplaced text")',
  NESTING_LIMIT: 'Deeply nested groups that were not fully read',
  HIDDEN_SHAPE: 'Hidden shapes with text (kept, not shown)',
};

const LIMITATIONS = [
  'Text inside pictures, screenshots and scanned images is not read automatically. Where a picture holds words, you can type them in; they are then used as study text and marked as typed by you.',
  'The slide preview is rebuilt from the file’s XML. Fonts, gradients, effects and SmartArt arrangement can differ from PowerPoint; the extracted text is the source of truth.',
  'Animations and transitions are not captured; animated content is extracted as if fully revealed.',
  'Equations are converted from PowerPoint’s equation format to LaTeX on a best-effort basis; verify important formulas against the original.',
  'Embedded video, audio, ink and OLE objects are not extracted.',
  'Speaker notes are extracted as plain text (formatting is dropped).',
];

function listSlides(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  if (sorted.length > 12) return `${sorted.slice(0, 12).join(', ')} … (+${sorted.length - 12} more)`;
  return sorted.join(', ');
}

export function buildReport(slides: SlideData[], topics: Topic[], deckFlags: Flag[]): ExtractionReport {
  const flagsByCode: Partial<Record<FlagCode, number>> = {};
  const slidesByCode = new Map<FlagCode, number[]>();
  for (const s of slides) {
    for (const f of s.flags) {
      if (f.resolved) continue;
      flagsByCode[f.code] = (flagsByCode[f.code] ?? 0) + 1;
      const list = slidesByCode.get(f.code) ?? [];
      list.push(s.index);
      slidesByCode.set(f.code, list);
    }
  }

  const potentiallyMissing: string[] = [];
  for (const [code, label] of Object.entries(MISSING_LABEL) as [FlagCode, string][]) {
    const nums = slidesByCode.get(code);
    if (nums && nums.length > 0) {
      const distinct = new Set(nums).size;
      potentiallyMissing.push(`${label} — slide${distinct > 1 ? 's' : ''} ${listSlides(nums)}`);
    }
  }

  const sum = (pick: (s: SlideData) => number) => slides.reduce((n, s) => n + pick(s), 0);
  // Weighted: a slide whose text was read but has a diagram/picture to double-check
  // ('medium') counts for much more than one whose content is missing ('low').
  const weight: Record<Confidence, number> = { high: 1, medium: 0.75, low: 0.3 };
  const overall = slides.length === 0 ? 0 : slides.reduce((n, s) => n + weight[s.confidence], 0) / slides.length;
  const failed = slides.filter((s) => s.status === 'failed').length;
  let label: Confidence = overall >= 0.85 ? 'high' : overall >= 0.6 ? 'medium' : 'low';
  if (failed > 0 && label === 'high') label = 'medium';

  return {
    totalSlides: slides.length,
    processedSlides: slides.length - failed,
    failedSlides: failed,
    slidesRequiringAttention: slides.filter((s) => s.confidence === 'low').map((s) => s.index),
    hiddenSlides: slides.filter((s) => s.hidden).map((s) => s.index),
    tables: sum((s) => s.counts.tables),
    pictures: sum((s) => s.counts.pictures),
    charts: sum((s) => s.counts.charts),
    smartArt: sum((s) => s.counts.smartArt),
    equations: sum((s) => s.counts.equations),
    oleObjects: sum((s) => s.counts.ole),
    embeddedMedia: sum((s) => s.counts.media),
    slidesWithNotes: slides.filter((s) => s.notes.trim() !== '').length,
    topics,
    potentiallyMissing: [...potentiallyMissing, ...deckFlags.map((f) => f.message)],
    flagsByCode,
    overallConfidence: Math.round(overall * 100) / 100,
    confidenceLabel: label,
    limitations: LIMITATIONS,
  };
}

/** Slide-based lines of `potentiallyMissing` end with the slide numbers; deck-level ones do not. */
const SLIDE_BASED = / — slides? [\d, ]+(…\s*\(\+\d+ more\))?$/;

/** The report again for the same deck after slides changed (for example the student typed picture text). */
export function rebuildReport(previous: ExtractionReport, slides: SlideData[]): ExtractionReport {
  const deckFlags: Flag[] = previous.potentiallyMissing.filter((m) => !SLIDE_BASED.test(m)).map((message) => ({ code: 'EXTRA_CONTENT_TYPE', severity: 'info', message }));
  return buildReport(slides, previous.topics, deckFlags);
}
