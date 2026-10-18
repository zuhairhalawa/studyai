import type { Flag, Inline, MathInline, Paragraph, TextRun } from './model';
import { colorFromFill, type ColorCtx } from './theme';
import { attr, child, numAttr, ownText, type XNode } from './xml';
import { isDisplayMath, ommlToLatex } from './math';
import { decodeSymbolText, hasSymbolPua, isSymbolFont } from './symbols';
import type { Rel } from './opc';
import { normalizeMathAlnum } from './unicode';
import { isOnlyPunctuation, listMarkers, tidySpaces } from './describe';

/** Collects side information while paragraphs are parsed. */
export interface TextSink {
  /** Every a:t string consumed (used for the completeness invariant). */
  captured: string[];
  flags: Flag[];
  equations: number;
  slide: number;
}

export interface TextCtx {
  colors: ColorCtx;
  /** Style containers (with a:lvlNpPr children) in priority order. */
  styleSources: (XNode | undefined)[];
  /** Default text colour (from p:style/a:fontRef), when the shape defines one. */
  defaultColor?: string;
  fontScale: number;
  rels: Map<string, Rel>;
  sink: TextSink;
  elementId?: string;
  /** When true, bullets default to those from the style chain; textboxes default to none. */
  inheritBullets: boolean;
}

interface LevelStyle {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  algn?: string;
  bullet?: 'none' | 'bullet' | 'number';
  spcBef?: XNode;
  spcAft?: XNode;
  lnSpc?: XNode;
}

const MONO_FONT = /consolas|courier|mono|menlo|monaco|lucida console|source code|fira code|cascadia|jetbrains|hack|inconsolata|dejavu sans mono|liberation mono/i;

function bulletOf(pPr: XNode | undefined): 'none' | 'bullet' | 'number' | undefined {
  if (!pPr) return undefined;
  for (const c of pPr.children) {
    if (c.name === 'a:buNone') return 'none';
    if (c.name === 'a:buChar' || c.name === 'a:buBlip') return 'bullet';
    if (c.name === 'a:buAutoNum') return 'number';
  }
  return undefined;
}

function boolAttr(n: XNode | undefined, name: string): boolean | undefined {
  const v = n?.attrs[name];
  if (v === undefined) return undefined;
  return v === '1' || v === 'true';
}

function resolveLevel(ctx: TextCtx, level: number): LevelStyle {
  const out: LevelStyle = {};
  for (const src of ctx.styleSources) {
    const lvl = child(src, `a:lvl${level + 1}pPr`);
    if (!lvl) continue;
    const def = child(lvl, 'a:defRPr');
    if (out.size === undefined) {
      const sz = numAttr(def, 'sz');
      if (sz !== undefined) out.size = sz / 100;
    }
    out.bold ??= boolAttr(def, 'b');
    out.italic ??= boolAttr(def, 'i');
    if (out.color === undefined && def) {
      const c = colorFromFill(def, ctx.colors);
      if (typeof c === 'string') out.color = c;
    }
    out.algn ??= attr(lvl, 'algn');
    out.bullet ??= bulletOf(lvl);
    out.spcBef ??= child(lvl, 'a:spcBef');
    out.spcAft ??= child(lvl, 'a:spcAft');
    out.lnSpc ??= child(lvl, 'a:lnSpc');
  }
  return out;
}

function safeLink(rels: Map<string, Rel>, rPr: XNode | undefined): string | undefined {
  const id = attr(child(rPr, 'a:hlinkClick'), 'r:id');
  if (!id) return undefined;
  const rel = rels.get(id);
  if (!rel || !rel.external) return undefined;
  return /^(https?:|mailto:)/i.test(rel.target) ? rel.target : undefined;
}

function sameFormat(a: TextRun, b: TextRun): boolean {
  return (
    a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.mono === b.mono &&
    a.sup === b.sup && a.sub === b.sub && a.size === b.size && a.color === b.color && a.link === b.link && a.field === b.field
  );
}

function mergeRuns(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const cur of inlines) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'text' && cur.kind === 'text' && sameFormat(prev, cur)) prev.text += cur.text;
    else out.push(cur.kind === 'text' ? { ...cur } : cur);
  }
  return out;
}

/** Choose the branch of an mc:AlternateContent block we understand. */
export const SUPPORTED_MC_NAMESPACES = new Set(['a14', 'p14', 'p15', 'a16', 'p16', 'a', 'p', 'r', 'm', 'c', 'cx1', 'asvg']);

export function resolveAlternate(alt: XNode): XNode[] {
  for (const choice of alt.children) {
    if (choice.name !== 'mc:Choice') continue;
    const requires = (choice.attrs['Requires'] ?? '').split(/\s+/).filter(Boolean);
    if (requires.every((r) => SUPPORTED_MC_NAMESPACES.has(r))) return choice.children;
  }
  const fb = alt.children.find((c) => c.name === 'mc:Fallback');
  return fb ? fb.children : [];
}

function runFromRPr(text: string, rPr: XNode | undefined, base: LevelStyle, ctx: TextCtx): TextRun {
  const latin = attr(child(rPr, 'a:latin'), 'typeface');
  const sym = attr(child(rPr, 'a:sym'), 'typeface');
  const fontIsSymbol = isSymbolFont(latin) || isSymbolFont(sym);
  let t = text;
  if (fontIsSymbol || hasSymbolPua(t)) {
    const dec = decodeSymbolText(t, fontIsSymbol);
    t = dec.text;
    if (dec.unmapped || hasSymbolPua(t)) {
      ctx.sink.flags.push({
        code: 'SYMBOL_FONT',
        severity: 'warning',
        slide: ctx.sink.slide,
        elementId: ctx.elementId,
        message: 'Some characters use a symbol font (e.g. Symbol/Wingdings) and could not be decoded reliably. Check the original slide for the intended symbol.',
      });
    }
  }
  const baseline = numAttr(rPr, 'baseline');
  const explicitSize = numAttr(rPr, 'sz');
  const sizePt = (explicitSize !== undefined ? explicitSize / 100 : (base.size ?? 18)) * ctx.fontScale;
  const fill = rPr ? colorFromFill(rPr, ctx.colors) : undefined;
  const u = attr(rPr, 'u');
  const strike = attr(rPr, 'strike');
  const run: TextRun = { kind: 'text', text: t, size: Math.round(sizePt * 10) / 10 };
  const bold = boolAttr(rPr, 'b') ?? base.bold;
  const italic = boolAttr(rPr, 'i') ?? base.italic;
  if (bold) run.bold = true;
  if (italic) run.italic = true;
  if (u && u !== 'none') run.underline = true;
  if (strike && strike !== 'noStrike') run.strike = true;
  if (latin && MONO_FONT.test(latin)) run.mono = true;
  if (baseline !== undefined && baseline > 0) run.sup = true;
  if (baseline !== undefined && baseline < 0) run.sub = true;
  const color = typeof fill === 'string' ? fill : (base.color ?? ctx.defaultColor);
  if (color) run.color = color;
  const link = safeLink(ctx.rels, rPr);
  if (link) run.link = link;
  return run;
}

function mathInline(node: XNode): MathInline {
  const r = ommlToLatex(node);
  return { kind: 'math', latex: r.latex, plain: r.plain, display: isDisplayMath(node), partial: r.partial };
}

function collectInlines(children: XNode[], base: LevelStyle, ctx: TextCtx, out: Inline[]): void {
  for (const n of children) {
    switch (n.name) {
      case 'a:r':
      case 'a:fld': {
        const t = child(n, 'a:t');
        const raw = ownText(t);
        if (t) ctx.sink.captured.push(raw);
        if (raw === '') break;
        const r = runFromRPr(raw, child(n, 'a:rPr'), base, ctx);
        if (n.name === 'a:fld') r.field = attr(n, 'type') ?? 'field';
        out.push(r);
        break;
      }
      case 'a:br':
        out.push({ kind: 'break' });
        break;
      case 'a14:m':
      case 'm:oMath':
      case 'm:oMathPara': {
        const m = mathInline(n);
        ctx.sink.equations += 1;
        if (m.partial) {
          ctx.sink.flags.push({
            code: 'MATH_PARTIAL',
            severity: 'warning',
            slide: ctx.sink.slide,
            elementId: ctx.elementId,
            message: 'An equation contains constructs that were only partially converted. Compare with the original slide.',
          });
        }
        out.push(m);
        break;
      }
      case 'mc:AlternateContent':
        collectInlines(resolveAlternate(n), base, ctx, out);
        break;
      default:
        break; // a:pPr, a:endParaRPr, extLst
    }
  }
}

/** Mark lowered/raised text so "A" + subscript "TM" reads as A_{TM}, not "ATM". */
function scripted(op: '_' | '^', text: string): string {
  const core = text.trim();
  if (!core) return text;
  const lead = text.slice(0, text.length - text.trimStart().length);
  const trail = text.slice(text.trimEnd().length);
  const body = [...core].length > 1 ? `{${core}}` : core;
  return `${lead}${op}${body}${trail}`;
}

/** Plain text of a paragraph: math letters folded to ASCII, sub/superscripts marked, equations in linear form. */
export function inlinesToText(inlines: Inline[]): string {
  let s = '';
  for (const i of inlines) {
    if (i.kind === 'text') {
      const t = normalizeMathAlnum(i.text);
      s += i.sub ? scripted('_', t) : i.sup ? scripted('^', t) : t;
    } else if (i.kind === 'math') s += i.plain;
    else s += '\n';
  }
  return s;
}

/** A spacing element (a:spcBef, a:spcAft) in points: exact points, or a percentage of the line at this font size. */
function spacingPts(n: XNode | undefined, size: number): number | undefined {
  const pts = numAttr(child(n, 'a:spcPts'), 'val');
  if (pts !== undefined) return pts / 100;
  const pct = numAttr(child(n, 'a:spcPct'), 'val');
  return pct !== undefined ? (pct / 100000) * size * 1.2 : undefined;
}

export function parseParagraph(p: XNode, ctx: TextCtx): Paragraph {
  const pPr = child(p, 'a:pPr');
  const level = Math.max(0, Math.min(8, numAttr(pPr, 'lvl') ?? 0));
  const base = resolveLevel(ctx, level);
  const explicit = bulletOf(pPr);
  const bullet = explicit ?? (ctx.inheritBullets ? (base.bullet ?? 'none') : 'none');
  const inlines: Inline[] = [];
  collectInlines(p.children, base, ctx, inlines);
  const merged = mergeRuns(inlines);
  const para: Paragraph = { level, bullet, inlines: merged, text: inlinesToText(merged) };
  const algn = attr(pPr, 'algn') ?? base.algn;
  if (algn === 'l' || algn === 'ctr' || algn === 'r' || algn === 'just') para.align = algn;
  // the vertical rhythm of the text: blank lines and spacing between paragraphs decide where the words sit among the shapes
  const endSize = numAttr(child(p, 'a:endParaRPr'), 'sz');
  const size = merged.find((i): i is TextRun => i.kind === 'text')?.size ?? (endSize !== undefined ? endSize / 100 : undefined) ?? base.size ?? 18;
  if (merged.length === 0) para.endSize = endSize !== undefined ? endSize / 100 : size;
  const before = spacingPts(child(pPr, 'a:spcBef') ?? base.spcBef, size);
  const after = spacingPts(child(pPr, 'a:spcAft') ?? base.spcAft, size);
  if (before !== undefined) para.spaceBefore = before;
  if (after !== undefined) para.spaceAfter = after;
  const line = numAttr(child(child(pPr, 'a:lnSpc') ?? base.lnSpc, 'a:spcPct'), 'val');
  if (line !== undefined) para.lineSpacing = line / 100000;
  return para;
}

export function parseParagraphs(txBody: XNode | undefined, ctx: TextCtx): Paragraph[] {
  if (!txBody) return [];
  return txBody.children.filter((c) => c.name === 'a:p').map((p) => parseParagraph(p, ctx));
}

/** The text of one paragraph for study purposes: one line, spacing tricks removed (code in a monospaced font is left alone). */
export function paragraphBody(p: Paragraph): string {
  const raw = p.text.replace(/\n/g, ' ').trim();
  return p.inlines.some((i) => i.kind === 'text' && i.mono) ? raw : tidySpaces(raw);
}

/** Slide numbers / dates typed into ordinary text boxes are furniture, not content. */
function isFurniture(p: Paragraph): boolean {
  const furniture = (i: Inline) => i.kind === 'text' && (i.field === 'slidenum' || i.field?.startsWith('datetime'));
  return p.inlines.length > 0 && p.inlines.every(furniture);
}

/** The paragraphs that carry study content: not empty, not furniture, not a stray "." bullet. */
export function contentParagraphs(paragraphs: Paragraph[]): Paragraph[] {
  return paragraphs.filter((p) => {
    const body = paragraphBody(p);
    return body !== '' && !isFurniture(p) && !isOnlyPunctuation(body);
  });
}

/** Study-text rendering of paragraphs (bullets as "- ", numbered lists numbered 1., 2., ..., indentation by level). */
export function paragraphsToStudyText(paragraphs: Paragraph[]): string {
  const rows = contentParagraphs(paragraphs);
  const markers = listMarkers(rows);
  return rows.map((p, i) => (p.bullet === 'none' ? paragraphBody(p) : `${'  '.repeat(p.level)}${markers[i]} ${paragraphBody(p)}`)).join('\n');
}
