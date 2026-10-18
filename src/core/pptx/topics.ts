import type { DeckMeta, SlideData, Topic } from './model';

/**
 * Heuristic topic detection. It never invents content: topics are ranges of
 * existing slides, labelled by the deck's own section names or slide titles.
 * Order of preference: PowerPoint sections → section-header/title layouts →
 * runs of slides with the same (normalised) title.
 */

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'into', 'about', 'what', 'when', 'where', 'which', 'your', 'you', 'can', 'will']);

/** A title as a person reads it in a list: "A_{TM} is undecidable" is "A_TM is undecidable" (the slide's own text keeps the braces). */
export const tidyScripts = (t: string): string => t.replace(/([_^])\{([^{}\s]+)\}/g, '$1$2');

export function displayTitle(slide: SlideData): string {
  if (slide.title) return tidyScripts(slide.title);
  const first = slide.text.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('[Picture'));
  return first ? tidyScripts(first.replace(/^[-\s]+/, '').slice(0, 80)) : `Slide ${slide.index}`;
}

export function normaliseTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\(?\b(cont(inued|\.)?|part\s*\d+|continuation)\b\)?/g, '')
    .replace(/[\s\-–—:.,;!?()[\]]+/g, ' ')
    .replace(/\s\d+$/, '')
    .trim();
}

function keyTermsFor(slides: SlideData[]): string[] {
  const counts = new Map<string, { term: string; n: number }>();
  const add = (raw: string, weight: number, maxWords = 8) => {
    const term = raw.replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, '').trim();
    if (term.length < 3 || term.length > 60 || term.split(' ').length > maxWords || STOP.has(term.toLowerCase())) return;
    const key = term.toLowerCase();
    const cur = counts.get(key);
    if (cur) cur.n += weight;
    else counts.set(key, { term, n: weight });
  };
  for (const s of slides) {
    if (s.title) add(s.title, 2);
    for (const el of s.elements) {
      if (el.kind !== 'shape' || el.decorative || el.hidden) continue;
      for (const p of el.paragraphs) {
        for (const i of p.inlines) if (i.kind === 'text' && i.bold && !i.mono) add(i.text, 1, 3); // a bold sentence is emphasis, not a term
      }
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || b.term.length - a.term.length)
    .slice(0, 8)
    .map((c) => c.term);
}

function make(id: number, title: string, slides: SlideData[], start: number, end: number, source: Topic['source']): Topic {
  return {
    id: `t${id}`,
    title,
    startSlide: slides[start]!.index,
    endSlide: slides[end]!.index,
    source,
    keyTerms: keyTermsFor(slides.slice(start, end + 1)),
  };
}

export function detectTopics(slides: SlideData[], sections: DeckMeta['sections']): Topic[] {
  if (slides.length === 0) return [];
  const posById = new Map(slides.map((s, i) => [s.slideId, i]));

  // 1. PowerPoint sections (a single auto-named section carries no information).
  const named = sections.filter((s) => s.slideIds.some((id) => posById.has(id)));
  if (named.length > 1) {
    const starts: { name: string; pos: number }[] = [];
    for (const s of named) {
      const pos = Math.min(...s.slideIds.map((id) => posById.get(id) ?? Infinity));
      if (Number.isFinite(pos)) starts.push({ name: s.name, pos });
    }
    starts.sort((a, b) => a.pos - b.pos);
    if (starts[0] && starts[0].pos > 0) starts.unshift({ name: displayTitle(slides[0]!), pos: 0 });
    return starts.map((st, i) => make(i + 1, st.name || displayTitle(slides[st.pos]!), slides, st.pos, (starts[i + 1]?.pos ?? slides.length) - 1, 'section'));
  }

  // 2. Section-header layouts start new topics.
  const headers = slides.map((s, i) => (s.layoutType === 'secHead' ? i : -1)).filter((i) => i >= 0);
  if (headers.length >= 2 || (headers.length === 1 && slides.length > 4)) {
    const starts = [...new Set([0, ...headers])].sort((a, b) => a - b);
    return starts.map((pos, i) => make(i + 1, displayTitle(slides[pos]!), slides, pos, (starts[i + 1] ?? slides.length) - 1, 'layout'));
  }

  // 3. Runs of slides that share a normalised title.
  const topics: Topic[] = [];
  let runStart = 0;
  for (let i = 1; i <= slides.length; i++) {
    const prev = normaliseTitle(displayTitle(slides[i - 1]!));
    const cur = i < slides.length ? normaliseTitle(displayTitle(slides[i]!)) : null;
    if (cur === null || cur !== prev) {
      topics.push(make(topics.length + 1, displayTitle(slides[runStart]!), slides, runStart, i - 1, 'title'));
      runStart = i;
    }
  }
  return topics;
}
