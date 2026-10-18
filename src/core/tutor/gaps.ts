import type { SlideData } from '../pptx/model';
import { isMetaSlide, slideTraits } from '../study/blueprint';
import { tidyScripts } from '../pptx/topics';
import { slideQuestions } from '../study/slide-questions';

/**
 * What a slide does not say. Found on the device, with no AI, before a lesson part or a question is sent: the tutor is told
 * about these gaps so it points them out instead of guessing, and the student sees them too.
 */

export type GapKind = 'heading-only' | 'picture-unread' | 'refers-elsewhere' | 'formula-undefined' | 'diagram-inferred' | 'question-unanswered' | 'arrangement';

export interface Gap {
  slide: number;
  kind: GapKind;
  /** One sentence about the slide, as it is shown to the student and sent with the question. */
  message: string;
}

const words = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Phrases that point to something that is not on the slide itself. */
const REFERS =
  /\bsee (?:figure|fig\.?|table|slide|page|section|chapter|appendix|the (?:figure|table|diagram|board))\b|\bas (?:shown|seen|illustrated|explained) (?:above|below|earlier|previously|in (?:the )?(?:figure|diagram|table|chapter|textbook|book))\b|\b(?:the )?(?:figure|diagram|table|picture|graph|chart|code) (?:above|below)\b|\b(?:next|previous|following|last) slides?\b|\bon the (?:board|whiteboard)\b|\bas (?:we )?(?:discussed|saw|mentioned|covered)\b|\bin class\b|\bwill (?:be )?(?:shown|discussed|covered|explained) (?:later|in the next)/i;

/** Words that define the symbols of a formula. */
const DEFINES = /\b(?:where|denotes?|denoted|represents?|stands? for|is the|are the|is a|let|defined as|means)\b/i;

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/**
 * The symbols a formula uses: single letters and Greek letters (a run of letters such as "det" or "log" is a name, not a symbol),
 * in order of appearance, without repeats.
 */
export function formulaSymbols(latex: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  // "A_{\text{TM}}" is a name (of a language), defined where it is introduced, and ℕ ℤ ℚ ℝ ℂ are the number sets every course shares
  const stripped = latex
    .replace(/[A-Za-z]+\s*_\s*\{\s*\\(?:text|textrm|mathrm|operatorname)\s*\{[^}]*\}\s*\}/g, ' ')
    .replace(/\\mathbb\s*\{\s*[NZQRC]\s*\}/g, ' ')
    .replace(/\\(?:text|textrm|mathrm|operatorname|mathbf|mathit)\s*\{[^}]*\}/g, ' ');
  for (const m of stripped.matchAll(/\\([A-Za-z]+)|([A-Za-z]+)|([\p{Script=Greek}])/gu)) {
    if (m[1] !== undefined) {
      const g = GREEK[m[1]];
      if (g) add(g);
    } else if (m[2] !== undefined) {
      if (m[2].length === 1) add(m[2]);
    } else if (m[3] !== undefined) add(m[3]);
  }
  return out;
}

/** What the slide says in words: its text without its formulas, plus the cells of its tables. */
function proseOf(slide: SlideData): string {
  const parts: string[] = [];
  for (const e of slide.elements) {
    if (e.kind === 'shape' && !e.decorative && !e.hidden) {
      for (const p of e.paragraphs) parts.push(p.inlines.map((i) => (i.kind === 'text' ? i.text : ' ')).join(''));
    } else if (e.kind === 'table') for (const row of e.rows) for (const c of row) parts.push(c.text);
  }
  return parts.join('\n');
}

/** Whether the words of the slide use this symbol on its own ("T(n)", "let n be", "a ≥ 1"). */
const mentions = (prose: string, sym: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}])${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(prose);

const quote = (title: string): string => (title.trim() ? ` (“${tidyScripts(title.trim()).slice(0, 50)}”)` : '');

/** At most about this many characters, cut at a word. */
const shorten = (s: string, max = 100): string => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, '')}…`);

/** Short labels in boxes of their own (not the heading, not a bullet list) and the arrows or lines drawn between things. */
function floatingLabels(slide: SlideData): { labels: number; arrows: number } {
  const title = slide.title.trim();
  let labels = 0;
  let arrows = 0;
  for (const e of slide.elements) {
    if (e.decorative || e.hidden) continue;
    if (e.kind === 'line') arrows += 1;
    else if (e.kind === 'shape' && e.role !== 'title' && e.paragraphs.length === 1) {
      const text = e.paragraphs[0]!.text.trim();
      if (text && text !== title && text.length <= 40 && words(text) <= 4 && !/^check[- ]?in\b/i.test(text)) labels += 1;
    }
  }
  return { labels, arrows };
}

/** The gaps of one slide, in the order a student would meet them. */
export function slideGaps(slide: SlideData): Gap[] {
  if (slide.status !== 'ok') return [{ slide: slide.index, kind: 'heading-only', message: `Slide ${slide.index} could not be read, so nothing is known about it.` }];
  const out: Gap[] = [];
  const add = (kind: GapKind, message: string) => out.push({ slide: slide.index, kind, message });
  const traits = slideTraits(slide);
  const typed = (slide.pictureTexts?.length ?? 0) > 0;
  const body = Math.max(0, words(slide.text) - words(slide.title));

  if (body < 6 && !typed && !traits.diagram) add('heading-only', `Slide ${slide.index}${quote(slide.title)} has only a heading: it explains nothing by itself.`);

  // a picture whose words are not available (and not typed by the student) is a hole in the lesson
  const unread = slide.flags.some((f) => (f.code === 'LARGE_PICTURE' || f.code === 'UNRENDERABLE_IMAGE' || f.code === 'NO_EXTRACTABLE_TEXT') && !f.resolved) && slide.counts.pictures > 0;
  if (unread) add('picture-unread', `Slide ${slide.index}${quote(slide.title)} has a picture whose words are not available as text, so what it shows is not known (the student can type its words in).`);

  const refers = REFERS.exec(slide.text) ?? REFERS.exec(slide.notes);
  if (refers) add('refers-elsewhere', `Slide ${slide.index}${quote(slide.title)} refers to something that is not on the slide itself (“${refers[0].trim()}”).`);

  // (a recap restates what other slides define)
  if (traits.math && !DEFINES.test(slide.text) && !isMetaSlide(slide)) {
    // A symbol the slide's own words use ("T(n)", "n ≥ 1") is introduced there; the ones it never mentions are not explained.
    const prose = proseOf(slide);
    const latex = slide.elements.flatMap((e) => (e.kind === 'shape' ? e.paragraphs.flatMap((p) => p.inlines.flatMap((i) => (i.kind === 'math' ? [i.latex] : []))) : []));
    const unexplained = formulaSymbols(latex.join(' ')).filter((s) => !mentions(prose, s));
    // no readable formula symbols at all (a formula that could not be read): keep the plain warning
    if (latex.length === 0 || unexplained.length > 0) {
      const which = unexplained.length > 0 ? ` (not explained: ${unexplained.slice(0, 6).join(', ')})` : '';
      add('formula-undefined', `Slide ${slide.index}${quote(slide.title)} has a formula, and the slide does not say what its symbols mean${which}.`);
    }
  }

  // a question the slide puts to the student: the slide does not answer it, so nobody may claim it does
  const asked = slideQuestions(slide)[0];
  if (asked) add('question-unanswered', `Slide ${slide.index}${quote(slide.title)} asks a question (“${shorten(tidyScripts(asked.text))}”) and no answer to it is written on the slide.`);

  // labels and arrows set around the slide: what each marks or joins is shown by where it sits, which text does not keep
  const { labels, arrows } = floatingLabels(slide);
  if ((arrows >= 2 && labels >= 2) || labels >= 4) {
    add('arrangement', `Slide ${slide.index}${quote(slide.title)} has ${labels} short labels${arrows > 0 ? ` and ${arrows} arrows or lines` : ''} placed around the slide: what each one marks or joins is shown only by where it sits, so the text does not say it.`);
  }

  if (slide.flags.some((f) => f.code === 'SMARTART' && !f.resolved)) add('diagram-inferred', `Slide ${slide.index}${quote(slide.title)} is a diagram whose arrangement was inferred from its text, so the order or hierarchy may differ from the original.`);
  return out;
}

/** The gap messages for the slides that are being sent, without repeats, at most this many. */
export const MAX_GAPS = 12;
export function gapMessages(slides: readonly SlideData[]): string[] {
  const out: string[] = [];
  for (const s of slides) for (const g of slideGaps(s)) if (!out.includes(g.message)) out.push(g.message);
  return out.slice(0, MAX_GAPS);
}
