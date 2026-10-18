import { PptxError } from './errors';
import { sha256Hex } from './hash';
import { withLimits, type ExtractionLimits } from './limits';
import type { DeckMeta, Flag, MediaAsset, ParsedDeck, SlideData, SlideElement } from './model';
import { Package, BROWSER_IMAGE_MIMES, mimeFromName, sniffImageMime } from './opc';
import { buildReport, scoreSlide } from './report';
import { parseSlide, type DeckCtx } from './slide';
import { detectTopics } from './topics';
import { attr, child, descendants, kids, numAttr, ownText, path, type XNode } from './xml';

export interface ParseOptions {
  limits?: Partial<ExtractionLimits>;
  /** Called after every slide (for progress bars). */
  onProgress?: (done: number, total: number) => void;
}

const PRESENTATION_CT = /presentationml\.(presentation|slideshow|template)(\.macroEnabled)?\.main\+xml/;

function emptyFailedSlide(index: number, slideId: number, part: string, err: unknown): SlideData {
  const message = err instanceof Error ? err.message : 'Unknown error';
  return {
    index,
    slideId,
    part,
    hidden: false,
    status: 'failed',
    title: '',
    elements: [],
    notes: '',
    text: '',
    flags: [
      {
        code: 'SLIDE_PARSE_FAILED',
        severity: 'attention',
        slide: index,
        message: `This slide could not be read (${message}). None of its content is available.`,
      },
    ],
    confidence: 'low',
    counts: { tables: 0, pictures: 0, charts: 0, smartArt: 0, equations: 0, ole: 0, media: 0, shapes: 0 },
    hasAnimations: false,
    coverage: { rawChars: 0, capturedChars: 0, missing: [] },
  };
}

function readMeta(pkg: Package, presentation: XNode, slideCount: number, slideIdOrder: number[]): DeckMeta {
  const sz = child(presentation, 'p:sldSz');
  const meta: DeckMeta = {
    slideWidth: numAttr(sz, 'cx') ?? 9144000,
    slideHeight: numAttr(sz, 'cy') ?? 6858000,
    slideCount,
    sections: [],
  };
  const core = pkg.tryXml('docProps/core.xml');
  if (core) {
    const text = (name: string) => ownText(child(core, name)).trim() || undefined;
    meta.title = text('dc:title');
    meta.author = text('dc:creator');
    meta.created = text('dcterms:created');
    meta.modified = text('dcterms:modified');
  }
  const app = pkg.tryXml('docProps/app.xml');
  if (app) meta.application = ownText(child(app, 'ep:Application')).trim() || undefined;

  for (const section of descendants(presentation, 'p14:section')) {
    const ids = descendants(section, 'p14:sldId')
      .map((n) => numAttr(n, 'id'))
      .filter((n): n is number => n !== undefined && slideIdOrder.includes(n));
    meta.sections.push({ name: attr(section, 'name') ?? '', slideIds: ids });
  }
  return meta;
}

/** Load referenced media, sniff real types, and flag anything that cannot be shown. */
function finaliseMedia(pkg: Package, deck: DeckCtx, slides: SlideData[]): Map<string, MediaAsset> {
  const media = new Map<string, MediaAsset>();
  const failed = new Set<string>();
  for (const key of deck.mediaRefs) {
    if (!pkg.has(key)) {
      failed.add(key);
      continue;
    }
    try {
      const bytes = pkg.bytes(key);
      const mime = sniffImageMime(bytes) ?? mimeFromName(key) ?? 'application/octet-stream';
      media.set(key, { key, mime, bytes });
    } catch {
      failed.add(key);
    }
  }

  const seen = new Set<SlideElement>();
  const addFlag = (slide: SlideData, f: Omit<Flag, 'slide'>) => slide.flags.push({ ...f, slide: slide.index });

  const check = (slide: SlideData, el: SlideElement, key: string | undefined, apply: (mime: string | undefined, ok: boolean) => void) => {
    if (!key) return;
    if (failed.has(key) || !media.has(key)) {
      apply(undefined, false);
      if (!el.decorative) addFlag(slide, { code: 'MISSING_MEDIA', severity: 'attention', elementId: el.id, message: 'An image could not be read from the file, so it cannot be shown. Check the original slide.' });
      return;
    }
    const asset = media.get(key)!;
    const ok = BROWSER_IMAGE_MIMES.has(asset.mime);
    apply(asset.mime, ok);
    if (!ok && !el.decorative) {
      const big = el.kind === 'picture' && el.coverage >= 0.1;
      addFlag(slide, {
        code: 'UNRENDERABLE_IMAGE',
        severity: big ? 'attention' : 'warning',
        elementId: el.id,
        message: `An image in ${asset.mime.replace('image/x-', '').toUpperCase()} format cannot be displayed in the browser. Its content is not available here; view the original slide.`,
      });
    }
  };

  for (const slide of slides) {
    for (const el of slide.elements) {
      // Decorations are shared between slides: only process each element once.
      const first = !seen.has(el);
      seen.add(el);
      if (!first && el.decorative) continue;
      if (el.kind === 'picture') {
        check(slide, el, el.media, (mime, ok) => {
          if (mime) el.mime = mime;
          el.renderable = ok;
        });
      } else if (el.kind === 'ole') {
        check(slide, el, el.previewMedia, (mime, ok) => {
          el.previewRenderable = ok;
          void mime;
        });
      }
    }
    if (slide.background?.media && !media.has(slide.background.media)) delete slide.background.media;
  }
  return media;
}

export async function parsePptx(data: Uint8Array, opts: ParseOptions = {}): Promise<ParsedDeck> {
  const limits = withLimits(opts.limits);
  const pkg = new Package(data, limits);

  // Locate the main document part via the package relationships (never hard-coded).
  if (!pkg.has('_rels/.rels')) throw new PptxError('NOT_PPTX', 'Missing package relationships (_rels/.rels).');
  const mainRel = pkg.relsOfType('', 'officeDocument')[0] ?? [...pkg.rels('').values()].find((r) => r.type === 'officeDocument');
  if (!mainRel) throw new PptxError('NOT_PPTX', 'Package has no main document part.');
  const mainCt = pkg.contentType(mainRel.target) ?? '';
  if (!PRESENTATION_CT.test(mainCt)) {
    const kind = /wordprocessingml/.test(mainCt) ? 'a Word document' : /spreadsheetml/.test(mainCt) ? 'an Excel workbook' : 'not a PowerPoint presentation';
    throw new PptxError('NOT_PPTX', `This file is ${kind}.`);
  }

  const presentation = pkg.xml(mainRel.target);
  const rels = pkg.rels(mainRel.target);
  const sldIds = kids(path(presentation, 'p:sldIdLst'), 'p:sldId');
  if (sldIds.length > limits.maxSlides) {
    throw new PptxError('TOO_MANY_SLIDES', `Presentation has ${sldIds.length} slides; limit is ${limits.maxSlides}.`);
  }
  const slideRefs = sldIds
    .map((n) => ({ id: numAttr(n, 'id') ?? 0, part: rels.get(attr(n, 'r:id') ?? '')?.target }))
    .filter((s): s is { id: number; part: string } => !!s.part);

  const meta = readMeta(pkg, presentation, slideRefs.length, slideRefs.map((s) => s.id));
  const deck: DeckCtx = {
    pkg,
    limits,
    slideW: meta.slideWidth,
    slideH: meta.slideHeight,
    defaultTextStyle: child(presentation, 'p:defaultTextStyle'),
    masters: new Map(),
    layouts: new Map(),
    decor: new Map(),
    mediaRefs: new Set(),
  };

  const slides: SlideData[] = [];
  for (let i = 0; i < slideRefs.length; i++) {
    const ref = slideRefs[i]!;
    try {
      slides.push(parseSlide(deck, ref.part, i + 1, ref.id));
    } catch (err) {
      if (err instanceof PptxError && err.code === 'ZIP_TOTAL_TOO_LARGE') throw err;
      slides.push(emptyFailedSlide(i + 1, ref.id, ref.part, err));
    }
    opts.onProgress?.(i + 1, slideRefs.length);
  }

  const media = finaliseMedia(pkg, deck, slides);
  for (const s of slides) s.confidence = scoreSlide(s);

  const deckFlags: Flag[] = [];
  const topics = detectTopics(slides, meta.sections);
  const report = buildReport(slides, topics, deckFlags);
  return { meta, slides, media, report, fileHash: await sha256Hex(data), fileSize: data.length, flags: deckFlags };
}
