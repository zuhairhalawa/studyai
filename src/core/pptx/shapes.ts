import type {
  Box,
  ChartElement,
  Flag,
  FlagCode,
  LineElement,
  MediaElement,
  OleElement,
  PictureElement,
  PlaceholderRole,
  ShapeElement,
  SlideCounts,
  SlideElement,
  SmartArtElement,
  TableCell,
  TableElement,
  UnsupportedElement,
  Severity,
} from './model';
import type { ExtractionLimits } from './limits';
import { inheritPlaceholder, masterStyleFor, phOf, readXfrm, boxFromXfrm, type LayoutInfo } from './layout';
import { mimeFromName, BROWSER_IMAGE_MIMES, type Package, type Rel } from './opc';
import { colorFromFill, firstColorChild, resolveColorNode, type ColorCtx } from './theme';
import { describePicture } from './describe';
import { paragraphsToStudyText, parseParagraphs, resolveAlternate, type TextCtx, type TextSink } from './text';
import { chartToText, parseChartPart } from './chart';
import { drawingRelId, parseSmartArtData, parseSmartArtDrawing } from './smartart';
import { attr, child, firstDescendant, kids, numAttr, path, type XNode } from './xml';

export interface SlideCtx {
  pkg: Package;
  /** Part being parsed (slide, layout or master). */
  part: string;
  rels: Map<string, Rel>;
  slideW: number;
  slideH: number;
  slideNo: number;
  colors: ColorCtx;
  /** Layout used for placeholder inheritance (absent when parsing layout/master decorations). */
  layout?: LayoutInfo;
  defaultTextStyle?: XNode;
  mediaRefs: Set<string>;
  flags: Flag[];
  sink: TextSink;
  counts: SlideCounts;
  limits: ExtractionLimits;
  z: { n: number };
}

export interface WalkOpts {
  decorative: boolean;
  skipPlaceholders: boolean;
}

interface Xform {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

const IDENTITY: Xform = { sx: 1, sy: 1, tx: 0, ty: 0 };

function applyXf(box: Box, xf: Xform): Box {
  return { ...box, x: xf.tx + xf.sx * box.x, y: xf.ty + xf.sy * box.y, w: box.w * xf.sx, h: box.h * xf.sy };
}

function groupXf(parent: Xform, grpSpPr: XNode | undefined): Xform {
  const x = child(grpSpPr, 'a:xfrm');
  const off = child(x, 'a:off');
  const ext = child(x, 'a:ext');
  const chOff = child(x, 'a:chOff');
  const chExt = child(x, 'a:chExt');
  if (!x || !off || !ext || !chOff || !chExt) return parent;
  const cw = numAttr(chExt, 'cx') || 1;
  const ch = numAttr(chExt, 'cy') || 1;
  const kx = (numAttr(ext, 'cx') ?? cw) / cw;
  const ky = (numAttr(ext, 'cy') ?? ch) / ch;
  return {
    sx: parent.sx * kx,
    sy: parent.sy * ky,
    tx: parent.tx + parent.sx * ((numAttr(off, 'x') ?? 0) - (numAttr(chOff, 'x') ?? 0) * kx),
    ty: parent.ty + parent.sy * ((numAttr(off, 'y') ?? 0) - (numAttr(chOff, 'y') ?? 0) * ky),
  };
}

function flag(ctx: SlideCtx, code: FlagCode, severity: Severity, message: string, elementId?: string): void {
  // Layout/master parses (slideNo 0) do not report slide flags.
  if (ctx.slideNo === 0) return;
  ctx.flags.push({ code, severity, message, slide: ctx.slideNo, elementId });
}

function roleOf(type: string | undefined): PlaceholderRole {
  switch (type) {
    case 'title':
    case 'ctrTitle':
      return 'title';
    case 'subTitle':
      return 'subtitle';
    case undefined:
    case 'body':
    case 'obj':
      return 'body';
    case 'ftr':
      return 'footer';
    case 'sldNum':
      return 'slideNumber';
    case 'dt':
      return 'date';
    default:
      return 'other';
  }
}

interface Common {
  id: string;
  name: string;
  alt?: string;
  hidden: boolean;
}

function commonProps(cNvPr: XNode | undefined, ctx: SlideCtx): Common {
  const id = attr(cNvPr, 'id') ?? `auto-${ctx.z.n}`;
  return {
    id,
    name: attr(cNvPr, 'name') ?? `Object ${id}`,
    alt: attr(cNvPr, 'descr') || attr(cNvPr, 'title') || undefined,
    hidden: attr(cNvPr, 'hidden') === '1',
  };
}

function baseOf(c: Common, ctx: SlideCtx, opts: WalkOpts, groupPath: string[], box: Box | undefined) {
  return {
    id: c.id,
    name: c.name,
    z: ctx.z.n++,
    ...(box ? { box } : {}),
    ...(c.alt ? { alt: c.alt } : {}),
    ...(groupPath.length > 0 ? { groupPath } : {}),
    ...(opts.decorative ? { decorative: true } : {}),
    ...(c.hidden ? { hidden: true } : {}),
  };
}

function lineOf(spPr: XNode | undefined, style: XNode | undefined, ctx: SlideCtx): { color: string; width: number } | undefined {
  const ln = child(spPr, 'a:ln');
  const explicit = colorFromFill(ln, ctx.colors);
  if (explicit === null) return undefined;
  const width = numAttr(ln, 'w');
  if (typeof explicit === 'string') return { color: explicit, width: width ?? 12700 };
  const ref = child(style, 'a:lnRef');
  if (ref && (numAttr(ref, 'idx') ?? 0) > 0) {
    const c = resolveColorNode(firstColorChild(ref), ctx.colors);
    if (c) return { color: c, width: width ?? 12700 };
  }
  return undefined;
}

function textCtx(ctx: SlideCtx, sources: (XNode | undefined)[], extra: Partial<TextCtx> = {}): TextCtx {
  return {
    colors: ctx.colors,
    styleSources: sources,
    fontScale: 1,
    rels: ctx.rels,
    sink: ctx.sink,
    inheritBullets: false,
    ...extra,
  };
}

function parseShape(sp: XNode, xf: Xform, groupPath: string[], ctx: SlideCtx, opts: WalkOpts): ShapeElement | null {
  const nv = child(sp, 'p:nvSpPr');
  const c = commonProps(child(nv, 'p:cNvPr'), ctx);
  const ph = phOf(sp);
  if (ph && opts.skipPlaceholders) return null;
  const spPr = child(sp, 'p:spPr');
  const style = child(sp, 'p:style');
  const inherited = ph && ctx.layout ? inheritPlaceholder(ctx.layout, ph) : undefined;

  let box = readXfrm(spPr);
  box = box ? applyXf(box, xf) : inherited?.box;

  const role = ph ? roleOf(ph.type) : undefined;
  const txBody = child(sp, 'p:txBody');
  const bodyPr = child(txBody, 'a:bodyPr');
  const scaleRaw = numAttr(child(bodyPr, 'a:normAutofit'), 'fontScale');
  const fontScale = scaleRaw ? scaleRaw / 100000 : 1;

  const sources: (XNode | undefined)[] = [child(txBody, 'a:lstStyle')];
  if (ph && ctx.layout) {
    sources.push(inherited?.layoutPh?.lstStyle, inherited?.masterPh?.lstStyle, masterStyleFor(ctx.layout.master, ph.type));
  }
  sources.push(ctx.defaultTextStyle);

  const fontRefColor = resolveColorNode(firstColorChild(child(style, 'a:fontRef')), ctx.colors);
  const tctx = textCtx(ctx, sources, { fontScale, inheritBullets: !!ph, elementId: c.id, defaultColor: fontRefColor });
  const paragraphs = parseParagraphs(txBody, tctx);

  const prst = attr(child(spPr, 'a:prstGeom'), 'prst');
  const custom = !!child(spPr, 'a:custGeom');
  if (custom && !c.hidden && paragraphs.length === 0) {
    flag(ctx, 'CUSTOM_GEOMETRY', 'info', 'A freeform shape was found; its outline is approximated in the preview.', c.id);
  }

  let fill = colorFromFill(spPr, ctx.colors);
  if (fill === undefined) {
    const ref = child(style, 'a:fillRef');
    if (ref && (numAttr(ref, 'idx') ?? 0) > 0) fill = resolveColorNode(firstColorChild(ref), ctx.colors);
  }

  const vert = attr(bodyPr, 'vert');
  const anchorRaw = attr(bodyPr, 'anchor') ?? attr(inherited?.layoutPh?.bodyPr, 'anchor') ?? attr(inherited?.masterPh?.bodyPr, 'anchor');
  const element: ShapeElement = {
    kind: 'shape',
    ...baseOf(c, ctx, { ...opts, decorative: opts.decorative || role === 'footer' || role === 'slideNumber' || role === 'date' }, groupPath, box),
    geom: custom ? 'custom' : (prst ?? 'rect'),
    isTextBox: attr(child(nv, 'p:cNvSpPr'), 'txBox') === '1',
    paragraphs,
  };
  if (role) element.role = role;
  if (typeof fill === 'string') element.fill = fill;
  const line = lineOf(spPr, style, ctx);
  if (line) element.line = line;
  if (anchorRaw === 'ctr') element.anchor = 'middle';
  else if (anchorRaw === 'b') element.anchor = 'bottom';
  else if (anchorRaw === 't') element.anchor = 'top';
  if (fontScale !== 1) element.fontScale = fontScale;
  if (vert && vert !== 'horz') {
    element.vertical = true;
    flag(ctx, 'VERTICAL_TEXT', 'info', 'A text box uses vertical text direction, which the preview shows horizontally.', c.id);
  }
  const hasText = paragraphs.some((p) => p.text.trim() !== '');
  if (!element.decorative && !c.hidden && (hasText || typeof fill === 'string')) ctx.counts.shapes += 1;
  if (c.hidden && hasText) flag(ctx, 'HIDDEN_SHAPE', 'info', 'A hidden shape contains text. It is kept in the data but not shown or included in study text.', c.id);
  return element;
}

function parseConnector(cx: XNode, xf: Xform, groupPath: string[], ctx: SlideCtx, opts: WalkOpts): LineElement {
  const c = commonProps(path(cx, 'p:nvCxnSpPr', 'p:cNvPr'), ctx);
  const spPr = child(cx, 'p:spPr');
  const style = child(cx, 'p:style');
  const box = readXfrm(spPr);
  const ln = lineOf(spPr, style, ctx);
  const lnNode = child(spPr, 'a:ln');
  const headEnd = attr(child(lnNode, 'a:headEnd'), 'type');
  const tailEnd = attr(child(lnNode, 'a:tailEnd'), 'type');
  const el: LineElement = {
    kind: 'line',
    ...baseOf(c, ctx, opts, groupPath, box ? applyXf(box, xf) : undefined),
    geom: attr(child(spPr, 'a:prstGeom'), 'prst') ?? 'line',
  };
  if (ln) {
    el.color = ln.color;
    el.width = ln.width;
  }
  if (headEnd && headEnd !== 'none') el.arrowStart = true;
  if (tailEnd && tailEnd !== 'none') el.arrowEnd = true;
  const dash = attr(child(lnNode, 'a:prstDash'), 'val');
  if (dash && dash !== 'solid') el.dash = dash;
  return el;
}

interface BlipInfo {
  media?: string;
  mime?: string;
  renderable: boolean;
  crop?: { l: number; t: number; r: number; b: number };
}

function readBlip(blipFill: XNode | undefined, ctx: SlideCtx): BlipInfo {
  const blip = child(blipFill, 'a:blip');
  const embed = attr(blip, 'r:embed');
  const svgId = attr(firstDescendant(blip, 'asvg:svgBlip'), 'r:embed');
  const main = embed ? ctx.rels.get(embed) : undefined;
  const svg = svgId ? ctx.rels.get(svgId) : undefined;
  const mainMime = main ? mimeFromName(main.target) : undefined;
  const mainOk = !!mainMime && BROWSER_IMAGE_MIMES.has(mainMime);
  const pick = mainOk || !svg ? main : svg;
  const out: BlipInfo = { renderable: false };
  if (pick && !pick.external) {
    out.media = pick.target;
    out.mime = mimeFromName(pick.target);
    out.renderable = !!out.mime && BROWSER_IMAGE_MIMES.has(out.mime);
    ctx.mediaRefs.add(pick.target);
  }
  const src = child(blipFill, 'a:srcRect');
  if (src) {
    const f = (n: string) => (numAttr(src, n) ?? 0) / 100000;
    const crop = { l: f('l'), t: f('t'), r: f('r'), b: f('b') };
    if (crop.l || crop.t || crop.r || crop.b) out.crop = crop;
  }
  return out;
}

function parsePicture(pic: XNode, xf: Xform, groupPath: string[], ctx: SlideCtx, opts: WalkOpts): SlideElement | null {
  const nv = child(pic, 'p:nvPicPr');
  const c = commonProps(child(nv, 'p:cNvPr'), ctx);
  const ph = phOf(pic);
  if (ph && opts.skipPlaceholders) return null;
  let box = readXfrm(child(pic, 'p:spPr'));
  box = box ? applyXf(box, xf) : ctx.layout && ph ? inheritPlaceholder(ctx.layout, ph).box : undefined;
  const nvPr = child(nv, 'p:nvPr');
  const blip = readBlip(child(pic, 'p:blipFill'), ctx);

  const mediaKind = child(nvPr, 'a:videoFile') ? 'video' : child(nvPr, 'a:audioFile') || child(nvPr, 'a:wavAudioFile') ? 'audio' : undefined;
  if (mediaKind) {
    const el: MediaElement = { kind: 'media', ...baseOf(c, ctx, opts, groupPath, box), mediaKind };
    if (blip.media) el.posterMedia = blip.media;
    ctx.counts.media += 1;
    flag(ctx, 'EMBEDDED_MEDIA', 'info', `An embedded ${mediaKind} was found. Its content is not extracted; play it in PowerPoint.`, c.id);
    return el;
  }

  const slideArea = ctx.slideW * ctx.slideH;
  const el: PictureElement = {
    kind: 'picture',
    ...baseOf(c, ctx, opts, groupPath, box),
    renderable: blip.renderable,
    coverage: box && slideArea > 0 ? Math.min(1, (box.w * box.h) / slideArea) : 0,
  };
  if (blip.media) el.media = blip.media;
  if (blip.mime) el.mime = blip.mime;
  if (blip.crop) el.crop = blip.crop;
  if (!opts.decorative && !c.hidden) ctx.counts.pictures += 1;
  if (!blip.media) flag(ctx, 'MISSING_MEDIA', 'warning', 'A picture refers to an image that is not embedded (linked file or missing).', c.id);
  return el;
}

function parseTable(tbl: XNode, base: ReturnType<typeof baseOf>, ctx: SlideCtx): TableElement {
  const colWidths = kids(child(tbl, 'a:tblGrid'), 'a:gridCol').map((g) => numAttr(g, 'w') ?? 0);
  const tctx = textCtx(ctx, [ctx.defaultTextStyle], { elementId: base.id });
  const rowHeights: number[] = [];
  let anyMerged = false;
  const rows: TableCell[][] = kids(tbl, 'a:tr').map((tr) => {
    rowHeights.push(numAttr(tr, 'h') ?? 0);
    return kids(tr, 'a:tc').map((tc) => {
      const paragraphs = parseParagraphs(child(tc, 'a:txBody'), tctx);
      const gridSpan = numAttr(tc, 'gridSpan') ?? 1;
      const rowSpan = numAttr(tc, 'rowSpan') ?? 1;
      const merged = attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1';
      if (merged || gridSpan > 1 || rowSpan > 1) anyMerged = true;
      return { paragraphs, text: paragraphs.map((p) => p.text).join('\n').trim(), gridSpan, rowSpan, merged };
    });
  });
  if (anyMerged) flag(ctx, 'MERGED_TABLE_CELLS', 'info', 'A table has merged cells; the extracted grid keeps the merge spans.', base.id);
  ctx.counts.tables += 1;
  return {
    kind: 'table',
    ...base,
    columnWidths: colWidths,
    rowHeights,
    headerRow: attr(child(tbl, 'a:tblPr'), 'firstRow') === '1',
    rows,
  };
}

function parseGraphicFrame(gf: XNode, xf: Xform, groupPath: string[], ctx: SlideCtx, opts: WalkOpts): SlideElement | null {
  const nv = child(gf, 'p:nvGraphicFramePr');
  const c = commonProps(child(nv, 'p:cNvPr'), ctx);
  const ph = phOf(gf);
  if (ph && opts.skipPlaceholders) return null;
  let box = boxFromXfrm(child(gf, 'p:xfrm'));
  box = box ? applyXf(box, xf) : ctx.layout && ph ? inheritPlaceholder(ctx.layout, ph).box : undefined;
  const base = baseOf(c, ctx, opts, groupPath, box);
  const gd = path(gf, 'a:graphic', 'a:graphicData');
  const uri = attr(gd, 'uri') ?? '';

  if (uri.endsWith('/table')) {
    const tbl = child(gd, 'a:tbl');
    if (tbl) return parseTable(tbl, base, ctx);
  }

  if (uri.endsWith('/chart')) {
    const rid = attr(child(gd, 'c:chart'), 'r:id');
    const rel = rid ? ctx.rels.get(rid) : undefined;
    const part = rel && !rel.external ? ctx.pkg.tryXml(rel.target, false) : undefined;
    const data = part ? parseChartPart(part) : null;
    const el: ChartElement = { kind: 'chart', ...base, chart: data };
    ctx.counts.charts += 1;
    if (data) {
      flag(ctx, 'CHART', 'info', 'Chart values were read from the chart cache. The chart picture itself is not reproduced; compare with the original slide.', c.id);
    } else {
      flag(ctx, 'CHART_NO_DATA', 'attention', 'A chart was found but no data could be read from it. Its content is NOT in the extracted text.', c.id);
    }
    return el;
  }

  if (uri.endsWith('/diagram')) {
    return parseSmartArt(gd, base, c, ctx);
  }

  if (uri.endsWith('/ole')) {
    const alt = child(gd, 'mc:AlternateContent');
    const searchRoot = alt ? { name: 'x', attrs: {}, children: resolveAlternate(alt) } : gd;
    const ole = firstDescendant(searchRoot, 'p:oleObj');
    const progId = attr(ole, 'progId');
    const blip = readBlip(child(firstDescendant(ole ?? searchRoot, 'p:pic'), 'p:blipFill'), ctx);
    const el: OleElement = { kind: 'ole', ...base };
    if (progId) el.progId = progId;
    if (blip.media) el.previewMedia = blip.media;
    el.previewRenderable = blip.renderable;
    ctx.counts.ole += 1;
    if (progId && /^Equation|^MathType/i.test(progId)) {
      flag(ctx, 'EQUATION_OBJECT', 'attention', 'An old-style equation object (Equation Editor/MathType) was found. Only its picture is available, not the formula text. Check the original slide.', c.id);
    } else {
      flag(ctx, 'OLE_OBJECT', 'attention', `An embedded object${progId ? ` (${progId})` : ''} was found. Its contents are not extracted; only a preview picture may be available.`, c.id);
    }
    return el;
  }

  const el: UnsupportedElement = { kind: 'unsupported', ...base, what: `Graphic frame (${uri.slice(uri.lastIndexOf('/') + 1) || 'unknown type'})` };
  flag(ctx, 'UNSUPPORTED_OBJECT', 'attention', `An object of type "${uri || 'unknown'}" is not supported and was not extracted.`, c.id);
  return el;
}

function parseSmartArt(gd: XNode | undefined, base: ReturnType<typeof baseOf>, c: Common, ctx: SlideCtx): SmartArtElement {
  const ids = child(gd, 'dgm:relIds');
  const dmRel = ctx.rels.get(attr(ids, 'r:dm') ?? '');
  const data = dmRel && !dmRel.external ? ctx.pkg.tryXml(dmRel.target, false) : undefined;
  const outline = data ? parseSmartArtData(data) : [];
  let shapes: ShapeElement[] = [];
  if (data) {
    const drawingId = drawingRelId(data);
    const dRel = drawingId ? ctx.rels.get(drawingId) : [...ctx.rels.values()].find((r) => r.type === 'diagramDrawing');
    const drawing = dRel && !dRel.external ? ctx.pkg.tryXml(dRel.target, false) : undefined;
    if (drawing) {
      const baseBox = base.box;
      shapes = parseSmartArtDrawing(drawing, ctx.colors, (id) => textCtx(ctx, [ctx.defaultTextStyle], { elementId: id })).map((s) => {
        // Drawing coordinates are relative to the graphic frame.
        if (s.box && baseBox) s.box = { ...s.box, x: baseBox.x + s.box.x, y: baseBox.y + s.box.y };
        return s;
      });
    }
  }
  ctx.counts.smartArt += 1;
  flag(
    ctx,
    'SMARTART',
    'warning',
    outline.length > 0
      ? 'SmartArt diagram: its text was read from the data model and the hierarchy is inferred. The exact arrangement is not guaranteed; compare with the original slide.'
      : 'SmartArt diagram: no text could be read from it. Its content is NOT in the extracted text.',
    c.id,
  );
  return { kind: 'smartart', ...base, outline, shapes };
}

function walk(nodes: XNode[], xf: Xform, groupPath: string[], depth: number, ctx: SlideCtx, opts: WalkOpts, out: SlideElement[]): void {
  for (const n of nodes) {
    switch (n.name) {
      case 'p:sp': {
        const el = parseShape(n, xf, groupPath, ctx, opts);
        if (el) out.push(el);
        break;
      }
      case 'p:cxnSp':
        out.push(parseConnector(n, xf, groupPath, ctx, opts));
        break;
      case 'p:pic': {
        const el = parsePicture(n, xf, groupPath, ctx, opts);
        if (el) out.push(el);
        break;
      }
      case 'p:graphicFrame': {
        const el = parseGraphicFrame(n, xf, groupPath, ctx, opts);
        if (el) out.push(el);
        break;
      }
      case 'p:grpSp': {
        const c = commonProps(path(n, 'p:nvGrpSpPr', 'p:cNvPr'), ctx);
        if (depth >= ctx.limits.maxGroupDepth) {
          flag(ctx, 'NESTING_LIMIT', 'warning', 'Shape groups are nested too deeply; some inner shapes were not read.', c.id);
          break;
        }
        walk(n.children, groupXf(xf, child(n, 'p:grpSpPr')), [...groupPath, c.name], depth + 1, ctx, opts, out);
        break;
      }
      case 'p:contentPart': {
        const c = commonProps(undefined, ctx);
        const el: UnsupportedElement = { kind: 'unsupported', ...baseOf({ ...c, name: 'Ink / content part' }, ctx, opts, groupPath, undefined), what: 'Ink or content part' };
        flag(ctx, 'INK', 'warning', 'Handwritten ink or an embedded content part was found. It is not extracted.', c.id);
        out.push(el);
        break;
      }
      case 'mc:AlternateContent':
        walk(resolveAlternate(n), xf, groupPath, depth, ctx, opts, out);
        break;
      default:
        break; // nvGrpSpPr, grpSpPr, extLst
    }
  }
}

export function parseSpTree(tree: XNode | undefined, ctx: SlideCtx, opts: WalkOpts): SlideElement[] {
  const out: SlideElement[] = [];
  if (tree) walk(tree.children, IDENTITY, [], 0, ctx, opts, out);
  return out;
}

// ---------------------------------------------------------------------------
// Study text
// ---------------------------------------------------------------------------

function readingOrder(a: SlideElement, b: SlideElement, slideH: number): number {
  const ay = a.box?.y ?? 0;
  const by = b.box?.y ?? 0;
  const tol = slideH * 0.04;
  if (Math.abs(ay - by) > tol) return ay - by;
  return (a.box?.x ?? 0) - (b.box?.x ?? 0);
}

/**
 * The slide's visible, non-decorative content in reading order: the title first,
 * then everything else top-to-bottom / left-to-right. Used for study text and for
 * the "extracted content" view so both always agree.
 */
export function orderedContentElements(elements: SlideElement[], slideH: number): SlideElement[] {
  const live = elements.filter((e) => !e.decorative && !e.hidden);
  const title = live.find((e): e is ShapeElement => e.kind === 'shape' && e.role === 'title');
  const rest = live.filter((e) => e !== title).sort((a, b) => readingOrder(a, b, slideH));
  return title ? [title, ...rest] : rest;
}

/** Flatten a slide's visible, non-decorative content to reading-order study text. */
export function elementsToStudyText(elements: SlideElement[], slideH: number): string {
  const ordered = orderedContentElements(elements, slideH);
  const title = ordered[0]?.kind === 'shape' && ordered[0].role === 'title' ? ordered[0] : undefined;
  const rest = title ? ordered.slice(1) : ordered;
  const parts: string[] = [];
  if (title) {
    const t = paragraphsToStudyText(title.paragraphs.map((p) => ({ ...p, bullet: 'none' as const })));
    if (t) parts.push(t);
  }
  for (const e of rest) {
    switch (e.kind) {
      case 'shape': {
        const t = paragraphsToStudyText(e.paragraphs);
        if (t) parts.push(t);
        break;
      }
      case 'table': {
        const lines = e.rows
          .map((r) => r.filter((c) => !c.merged).map((c) => c.text.replace(/\s*\n\s*/g, ' ')).join(' | '))
          .filter((l) => l.replace(/[\s|]/g, '') !== '');
        if (lines.length) parts.push(lines.join('\n'));
        break;
      }
      case 'chart':
        if (e.chart) parts.push(chartToText(e.chart));
        break;
      case 'smartart': {
        const lines = e.outline.map((n) => `${'  '.repeat(n.depth)}- ${n.text}`);
        if (lines.length) parts.push(`Diagram:\n${lines.join('\n')}`);
        break;
      }
      case 'picture': {
        // File names, mail attachment ids and "Picture 3" say nothing about the picture and are skipped.
        const d = describePicture(e.alt);
        if (d) parts.push(`[Picture${d.auto ? ' (automatic description, may be wrong)' : ''}: ${d.text}]`);
        break;
      }
      default:
        break;
    }
  }
  return parts.join('\n\n');
}
