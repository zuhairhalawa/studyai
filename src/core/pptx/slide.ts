import type { ExtractionLimits } from './limits';
import type { Flag, PictureElement, ShapeElement, SlideBackground, SlideCounts, SlideData, SlideElement } from './model';
import { loadLayout, phOf, type LayoutInfo, type MasterInfo } from './layout';
import type { Package } from './opc';
import { elementsToStudyText, parseSpTree, type SlideCtx } from './shapes';
import { parseParagraphs, resolveAlternate, type TextSink } from './text';
import { colorFromFill, firstColorChild, parseClrMap, resolveColorNode, type ColorCtx } from './theme';
import { allDescendants, attr, child, ownText, path, type XNode } from './xml';
import { FALLBACK_THEME } from './theme';

/** State shared by all slides of one deck. */
export interface DeckCtx {
  pkg: Package;
  limits: ExtractionLimits;
  slideW: number;
  slideH: number;
  defaultTextStyle?: XNode;
  masters: Map<string, MasterInfo>;
  layouts: Map<string, LayoutInfo>;
  decor: Map<string, SlideElement[]>;
  mediaRefs: Set<string>;
}

function emptyCounts(): SlideCounts {
  return { tables: 0, pictures: 0, charts: 0, smartArt: 0, equations: 0, ole: 0, media: 0, shapes: 0 };
}

function throwawaySink(): TextSink {
  return { captured: [], flags: [], equations: 0, slide: 0 };
}

function getLayout(deck: DeckCtx, part: string): LayoutInfo | undefined {
  const hit = deck.layouts.get(part);
  if (hit) return hit;
  if (!deck.pkg.has(part)) return undefined;
  try {
    const l = loadLayout(deck.pkg, part, deck.masters);
    deck.layouts.set(part, l);
    return l;
  } catch {
    return undefined;
  }
}

/** Non-placeholder shapes from a layout or master (logos, rules, decorations). */
function decorOf(deck: DeckCtx, part: string, cSld: XNode | undefined, colors: ColorCtx): SlideElement[] {
  const cached = deck.decor.get(part);
  if (cached) return cached;
  const ctx: SlideCtx = {
    pkg: deck.pkg,
    part,
    rels: deck.pkg.rels(part),
    slideW: deck.slideW,
    slideH: deck.slideH,
    slideNo: 0,
    colors,
    defaultTextStyle: deck.defaultTextStyle,
    mediaRefs: deck.mediaRefs,
    flags: [],
    sink: throwawaySink(),
    counts: emptyCounts(),
    limits: deck.limits,
    z: { n: 0 },
  };
  const els = parseSpTree(child(cSld, 'p:spTree'), ctx, { decorative: true, skipPlaceholders: true });
  deck.decor.set(part, els);
  return els;
}

function backgroundOf(cSld: XNode | undefined, part: string, deck: DeckCtx, colors: ColorCtx): SlideBackground | undefined {
  const bg = child(cSld, 'p:bg');
  if (!bg) return undefined;
  const pr = child(bg, 'p:bgPr');
  if (pr) {
    const blip = child(pr, 'a:blipFill');
    const embed = attr(child(blip, 'a:blip'), 'r:embed');
    if (embed) {
      const rel = deck.pkg.rels(part).get(embed);
      if (rel && !rel.external) {
        deck.mediaRefs.add(rel.target);
        return { media: rel.target };
      }
    }
    const col = colorFromFill(pr, colors);
    if (typeof col === 'string') return { color: col };
  }
  const ref = child(bg, 'p:bgRef');
  if (ref) {
    const col = resolveColorNode(firstColorChild(ref), colors);
    if (col) return { color: col };
  }
  return undefined;
}

/** All a:t strings in the slide XML that are actually "live" (after AlternateContent resolution). */
function collectRawText(node: XNode, out: string[]): void {
  for (const c of node.children) {
    if (c.name === 'a:t') {
      const s = ownText(c);
      if (s.trim() !== '') out.push(s);
    } else if (c.name === 'mc:AlternateContent') {
      for (const inner of resolveAlternate(c)) {
        if (inner.name === 'a:t') {
          const s = ownText(inner);
          if (s.trim() !== '') out.push(s);
        } else collectRawText(inner, out);
      }
    } else collectRawText(c, out);
  }
}

function missingText(root: XNode, captured: string[]): string[] {
  const raw: string[] = [];
  collectRawText(root, raw);
  const pool = new Map<string, number>();
  for (const s of captured) pool.set(s, (pool.get(s) ?? 0) + 1);
  const missing: string[] = [];
  for (const s of raw) {
    const n = pool.get(s) ?? 0;
    if (n > 0) pool.set(s, n - 1);
    else missing.push(s);
  }
  return missing;
}

/**
 * Decks made without title placeholders (LaTeX exports, custom layouts) still
 * have a visual title: the largest, top-most short text. Only real slide text
 * is ever returned - nothing is invented.
 */
/** A picture covering at least this share of the slide may hold words or a diagram (smaller ones are usually icons). */
const PICTURE_MAY_HOLD_TEXT = 0.06;

function inferTitle(own: SlideElement[], slideH: number, layoutType?: string): string {
  // A title slide's title sits in the middle of the slide, not at the top.
  const limit = layoutType === 'title' ? 0.7 : 0.3;
  let best: { size: number; y: number; text: string } | undefined;
  for (const e of own) {
    if (e.kind !== 'shape' || e.decorative || e.hidden || !e.box) continue;
    if (e.box.y + e.box.h / 2 > slideH * limit) continue;
    const paras = e.paragraphs.filter((p) => p.text.trim() !== '');
    if (paras.length === 0 || paras.length > 2) continue;
    const text = paras.map((p) => p.text.replace(/\s+/g, ' ').trim()).join(' ');
    if (text.length > 150) continue;
    const size = Math.max(0, ...paras[0]!.inlines.map((i) => (i.kind === 'text' ? (i.size ?? 0) : 0)));
    if (size < 20) continue;
    if (!best || size > best.size || (size === best.size && e.box.y < best.y)) best = { size, y: e.box.y, text };
  }
  return best?.text ?? '';
}

export function parseNotes(deck: DeckCtx, notesPart: string): string {
  const root = deck.pkg.tryXml(notesPart, false);
  const tree = path(root, 'p:cSld', 'p:spTree');
  if (!tree) return '';
  const shapes: XNode[] = [];
  const visit = (nodes: XNode[]) => {
    for (const n of nodes) {
      if (n.name === 'p:sp') shapes.push(n);
      else if (n.name === 'p:grpSp') visit(n.children);
      else if (n.name === 'mc:AlternateContent') visit(resolveAlternate(n));
    }
  };
  visit(tree.children);
  const rels = deck.pkg.rels(notesPart);
  const colors: ColorCtx = { theme: FALLBACK_THEME, clrMap: parseClrMap(undefined) };
  const textOf = (sp: XNode): string =>
    parseParagraphs(child(sp, 'p:txBody'), { colors, styleSources: [], fontScale: 1, rels, sink: throwawaySink(), inheritBullets: false })
      .map((p) => p.text.replace(/\n/g, ' ').trimEnd())
      .join('\n')
      .trim();

  const bodies = shapes.filter((sp) => {
    const ph = phOf(sp);
    return ph && (ph.type === 'body' || (ph.type === undefined && ph.idx === '1'));
  });
  const chosen = bodies.length > 0 ? bodies : shapes.filter((sp) => !phOf(sp));
  return chosen.map(textOf).filter(Boolean).join('\n').trim();
}

export function parseSlide(deck: DeckCtx, part: string, index: number, slideId: number): SlideData {
  const root = deck.pkg.xml(part, false);
  const rels = deck.pkg.rels(part);
  const layoutRel = [...rels.values()].find((r) => r.type === 'slideLayout');
  const layout = layoutRel ? getLayout(deck, layoutRel.target) : undefined;

  const override = child(child(root, 'p:clrMapOvr'), 'a:overrideClrMapping');
  const baseMap = layout?.clrMap ?? parseClrMap(undefined);
  const colors: ColorCtx = {
    theme: layout?.master.theme ?? FALLBACK_THEME,
    clrMap: override ? { ...baseMap, ...override.attrs } : baseMap,
  };

  const flags: Flag[] = [];
  const sink: TextSink = { captured: [], flags, equations: 0, slide: index };
  const counts = emptyCounts();
  const ctx: SlideCtx = {
    pkg: deck.pkg,
    part,
    rels,
    slideW: deck.slideW,
    slideH: deck.slideH,
    slideNo: index,
    colors,
    layout,
    defaultTextStyle: deck.defaultTextStyle,
    mediaRefs: deck.mediaRefs,
    flags,
    sink,
    counts,
    limits: deck.limits,
    z: { n: 0 },
  };

  const cSld = child(root, 'p:cSld');
  const own = parseSpTree(child(cSld, 'p:spTree'), ctx, { decorative: false, skipPlaceholders: false });

  // A small digits-only text box near the bottom that equals the slide number is furniture
  // (many decks type the number by hand instead of using the slide-number field).
  for (const e of own) {
    if (e.kind !== 'shape' || e.decorative || !e.box || e.box.y < deck.slideH * 0.85) continue;
    const t = e.paragraphs.map((p) => p.text).join('').trim();
    if (/^\d{1,3}$/.test(t) && Number(t) === index) e.decorative = true;
  }

  // Layout and master decorations (logos, lines) sit behind the slide's own shapes.
  const decor: SlideElement[] = [];
  if (layout && attr(root, 'showMasterSp') !== '0') {
    if (layout.showMasterSp) {
      decor.push(...decorOf(deck, layout.master.part, layout.master.cSld, { theme: layout.master.theme, clrMap: layout.master.clrMap }));
    }
    decor.push(...decorOf(deck, layout.part, layout.cSld, colors));
  }

  const elements: SlideElement[] = [...decor, ...own];
  const bg =
    backgroundOf(cSld, part, deck, colors) ??
    (layout ? backgroundOf(layout.cSld, layout.part, deck, colors) : undefined) ??
    (layout ? backgroundOf(layout.master.cSld, layout.master.part, deck, colors) : undefined);

  const notesRel = [...rels.values()].find((r) => r.type === 'notesSlide');
  const notes = notesRel ? parseNotes(deck, notesRel.target) : '';

  const titleEl = own.find((e): e is ShapeElement => e.kind === 'shape' && e.role === 'title' && !e.hidden);
  const placeholderTitle = (titleEl?.paragraphs.map((p) => p.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ') ?? '').trim();
  const title = placeholderTitle || inferTitle(own, deck.slideH, layout?.type);

  let text = elementsToStudyText(own, deck.slideH);

  // Completeness invariant: every a:t in the slide XML must have been captured somewhere.
  const missing = missingText(root, sink.captured);
  if (missing.length > 0) {
    flags.push({
      code: 'TEXT_NOT_CAPTURED',
      severity: 'attention',
      slide: index,
      message: `${missing.length} piece(s) of text exist in the slide but were found in an unsupported container. They are listed under "Unplaced text"; check the original slide.`,
    });
    text += `${text ? '\n\n' : ''}[Unplaced text]\n${missing.join('\n')}`;
  }

  counts.equations = sink.equations;
  if (sink.equations > 0) {
    flags.push({
      code: 'MATH_CONVERTED',
      severity: 'info',
      slide: index,
      message: `${sink.equations} equation(s) were converted from PowerPoint's equation format to LaTeX. Verify symbols against the original slide.`,
    });
  }

  const hidden = attr(root, 'show') === '0';
  if (hidden) flags.push({ code: 'HIDDEN_SLIDE', severity: 'info', slide: index, message: 'This slide is hidden in the presentation (not shown when presenting).' });

  const timing = child(root, 'p:timing');
  const hasAnimations = !!timing && allDescendants(timing, 'p:cTn').some((c) => c.attrs['presetClass'] !== undefined);
  if (hasAnimations) {
    flags.push({
      code: 'ANIMATIONS',
      severity: 'info',
      slide: index,
      message: 'This slide has animations. All content is extracted as if fully revealed; the original reveal order is not captured.',
    });
  }

  const visible = own.filter((e) => !e.decorative && !e.hidden);
  // Any sizeable picture may be a diagram, a screenshot or a table with words in it, whatever its alt text says.
  const bigPicture = visible
    .filter((e): e is PictureElement => e.kind === 'picture' && e.coverage >= PICTURE_MAY_HOLD_TEXT)
    .sort((a, b) => b.coverage - a.coverage)[0];
  if (text.trim() === '' && visible.some((e) => e.kind === 'picture' || e.kind === 'ole' || e.kind === 'unsupported')) {
    flags.push({
      code: 'NO_EXTRACTABLE_TEXT',
      severity: 'attention',
      slide: index,
      message: 'This slide has no extractable text. Its content is in picture(s) or objects and is NOT available as text (no OCR is performed).',
    });
  } else if (bigPicture) {
    flags.push({
      code: 'LARGE_PICTURE',
      // Hero/logo pictures on title slides are decoration, not lecture content.
      severity: layout?.type === 'title' ? 'info' : 'warning',
      slide: index,
      elementId: bigPicture.id,
      message: 'A picture on this slide may contain text, a diagram or a screenshot that was not extracted. Check the original slide.',
    });
  }

  return {
    index,
    slideId,
    part,
    layoutName: layout?.name,
    layoutType: layout?.type,
    hidden,
    status: 'ok',
    title,
    elements,
    ...(bg ? { background: bg } : {}),
    notes,
    text,
    flags,
    confidence: 'high',
    counts,
    hasAnimations,
    coverage: {
      rawChars: (() => {
        const raw: string[] = [];
        collectRawText(root, raw);
        return raw.reduce((n, s) => n + s.length, 0);
      })(),
      capturedChars: sink.captured.reduce((n, s) => n + s.length, 0),
      missing: missing.slice(0, 50),
    },
  };
}
