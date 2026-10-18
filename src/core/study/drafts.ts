import type { LectureRow } from '../db/db';
import type { Paragraph, SlideData, TableElement, TextRun } from '../pptx/model';
import { orderedContentElements } from '../pptx/shapes';
import { displayTitle } from '../pptx/topics';
import { normForMatch } from './pack';
import type { NewCard } from './store';

/**
 * Local, rule-based flashcard drafts from slide text — no AI involved.
 *
 * It only recognises two very regular patterns, so it is deliberately modest:
 *   - "**Term**: explanation" (a bold lead-in followed by an explanation) → definition card
 *   - a table                                                           → comparison card
 * Everything is created as *pending* with origin "auto" so you decide what to keep.
 */

const SKIP_TERMS = /^(defn|definition|def|example|examples|note|notes|theorem|lemma|claim|proof|recall|today|last time|check-in|idea|remark|question|answer|step|goal|summary|outline|agenda)\b/i;

function leadingBold(p: Paragraph): { term: string; rest: string } | undefined {
  const runs = p.inlines.filter((i): i is TextRun => i.kind === 'text');
  if (runs.length < 2 || !runs[0]!.bold) return undefined;
  let term = '';
  let i = 0;
  while (i < runs.length && runs[i]!.bold) term += runs[i++]!.text;
  const rest = runs.slice(i).map((r) => r.text).join('') + p.inlines.filter((x) => x.kind === 'math').map((m) => (m.kind === 'math' ? m.plain : '')).join('');
  const cleanTerm = term.replace(/[:：\-–—\s]+$/, '').trim();
  const cleanRest = rest.replace(/^\s*(?:[:：\-–—]|\bis\b|\bare\b|\bmeans\b)\s*/i, '').trim();
  const words = cleanTerm.split(/\s+/).length;
  if (cleanTerm.length < 2 || cleanTerm.length > 60 || words > 8 || SKIP_TERMS.test(cleanTerm)) return undefined;
  if (cleanRest.length < 20 || cleanRest.split(/\s+/).length < 4) return undefined;
  return { term: cleanTerm, rest: cleanRest };
}

function tableToMarkdown(t: TableElement): string {
  const rows = t.rows.map((r) => r.filter((c) => !c.merged).map((c) => c.text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')));
  if (rows.length < 2) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
  return [pad(rows[0]!), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(pad)].join('\n');
}

export interface DraftResult {
  cards: NewCard[];
  slidesScanned: number;
}

export function draftCardsFromLecture(lecture: Pick<LectureRow, 'id' | 'courseId' | 'revision' | 'meta'>, slides: SlideData[]): DraftResult {
  const cards: NewCard[] = [];
  const seen = new Set<string>();
  const push = (card: NewCard) => {
    const key = normForMatch(card.front + ' ' + card.back);
    if (seen.has(key)) return;
    seen.add(key);
    cards.push(card);
  };

  for (const slide of slides) {
    if (slide.status !== 'ok') continue;
    const where = displayTitle(slide);
    for (const el of orderedContentElements(slide.elements, lecture.meta.slideHeight)) {
      if (el.kind === 'shape') {
        for (const p of el.paragraphs) {
          const hit = leadingBold(p);
          if (!hit) continue;
          push({
            courseId: lecture.courseId,
            lectureId: lecture.id,
            type: 'definition',
            front: `What is **${hit.term}**?`,
            back: hit.rest,
            tags: ['auto'],
            basis: 'lecture',
            origin: 'auto',
            status: 'pending',
            sources: [{ lectureId: lecture.id, slide: slide.index, quote: p.text.replace(/\s+/g, ' ').trim().slice(0, 300), verified: true, rev: lecture.revision }],
          });
        }
      } else if (el.kind === 'table') {
        const md = tableToMarkdown(el);
        const labels = el.rows.slice(1).map((r) => r[0]?.text.trim()).filter(Boolean);
        if (!md || labels.length < 2) continue;
        push({
          courseId: lecture.courseId,
          lectureId: lecture.id,
          type: 'comparison',
          front: `Compare ${labels.slice(0, 4).join(', ')}${labels.length > 4 ? ', …' : ''} (${where}).`,
          back: md,
          tags: ['auto'],
          basis: 'lecture',
          origin: 'auto',
          status: 'pending',
          sources: [{ lectureId: lecture.id, slide: slide.index, quote: el.rows.map((r) => r.map((c) => c.text).join(' ')).join(' ').slice(0, 300), verified: true, rev: lecture.revision }],
        });
      }
    }
  }
  return { cards, slidesScanned: slides.length };
}
