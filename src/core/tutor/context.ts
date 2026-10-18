import type { SlideData } from '../pptx/model';
import { slideToMarkdown } from '../study/markdown';
import type { SourceRefRow } from '../study/types';
import { LIMITS, type Excerpt } from './contract';

/**
 * Chooses and labels the slide text that will be sent with a question. Everything here runs in the browser BEFORE anything
 * leaves the device, so the screen can show the student exactly what will be sent.
 */

export interface ContextSlide {
  /** "note" = one of the student's own notes; `lectureId` then holds the note id and `slide` is 0. */
  kind?: 'slide' | 'note';
  lectureId: string;
  lectureTitle: string;
  /** Lecture revision, kept with citations so a replaced lecture can be noticed later. */
  revision: number;
  slide: number;
  title: string;
  text: string;
  /** What this slide does not say (see gaps.ts), found on the device. */
  gaps?: string[];
}

export interface BuiltContext {
  excerpts: Excerpt[];
  /** The gaps of the slides that are really being sent, without repeats. */
  gaps: string[];
  /** "S1" → where it came from, to turn the model's citations back into slide links. */
  refs: Map<string, { lectureId: string; slide: number; rev: number }>;
  /** The labels that are the student's own notes (they cannot be cited as lecture sources). */
  noteRefs: Set<string>;
  chars: number;
  approxTokens: number;
  /** Slides left out because of the size limits. */
  dropped: number;
  /** Slides whose text was shortened. */
  shortened: number;
}

/** The slide's text as Markdown without its heading line (the excerpt carries lecture, slide and title separately). */
export function slideContextText(slide: SlideData, slideHeight: number): string {
  return slideToMarkdown(slide, slideHeight).replace(/^### Slide \d+: [^\n]*\n+/, '').trim();
}

const CUT = '\n[…shortened]';

export function buildContext(slides: readonly ContextSlide[]): BuiltContext {
  const excerpts: Excerpt[] = [];
  const refs: BuiltContext['refs'] = new Map();
  const noteRefs = new Set<string>();
  const gaps: string[] = [];
  let chars = 0;
  let dropped = 0;
  let shortened = 0;
  for (const s of slides) {
    if (excerpts.length >= LIMITS.excerpts) {
      dropped += 1;
      continue;
    }
    let text = s.text.trim() || '(this slide has no readable text)';
    if (text.length > LIMITS.excerptText) {
      text = text.slice(0, LIMITS.excerptText - CUT.length) + CUT;
      shortened += 1;
    }
    if (chars + text.length > LIMITS.excerptsTotal) {
      dropped += 1;
      continue;
    }
    const ref = `S${excerpts.length + 1}`;
    const isNote = s.kind === 'note';
    excerpts.push({ ref, lectureTitle: s.lectureTitle.slice(0, LIMITS.name), slide: isNote ? 0 : s.slide, ...(isNote ? { kind: 'note' as const } : {}), title: s.title.slice(0, LIMITS.name), text });
    if (isNote) noteRefs.add(ref);
    else refs.set(ref, { lectureId: s.lectureId, slide: s.slide, rev: s.revision });
    // only a slide that is really sent brings its gaps with it
    for (const g of s.gaps ?? []) if (!gaps.includes(g) && gaps.length < 12) gaps.push(g);
    chars += text.length;
  }
  return { excerpts, gaps, refs, noteRefs, chars, approxTokens: Math.ceil(chars / 4), dropped, shortened };
}

/** Turns the labels an answer cites into stored source references (slide-level; there is no quote to verify). */
export function citesToSources(cites: readonly string[], refs: BuiltContext['refs']): SourceRefRow[] {
  const out: SourceRefRow[] = [];
  for (const c of cites) {
    const r = refs.get(c);
    if (r) out.push({ lectureId: r.lectureId, slide: r.slide, rev: r.rev });
  }
  return out;
}
