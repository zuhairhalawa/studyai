import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import type { LectureRow } from '../db/db';
import type { SlideData } from '../pptx/model';
import { displayTitle } from '../pptx/topics';
import { slideToMarkdown } from './markdown';
import { BASIS_LABEL, type CardRow, type NoteBlock, type NoteKind, type NoteRow } from './types';

type NewBlock = Omit<NoteBlock, 'id' | 'updatedAt'>;

/**
 * Complete lecture notes built from the slides, with no AI: one block per slide, in lecture order.
 * Every block is labelled "auto-extracted", cites its slide, and carries the slide's own words,
 * so it is exactly as trustworthy as the extraction (see the lecture's report for caveats).
 */
export function lectureNotesFromSlides(lecture: Pick<LectureRow, 'id' | 'revision' | 'meta'>, slides: SlideData[]): NewBlock[] {
  return slides
    .filter((s) => s.status === 'ok' && !s.hidden)
    .map((s) => ({
      text: slideToMarkdown(s, lecture.meta.slideHeight).replace(/^### /, '## '),
      origin: 'auto' as const,
      basis: 'lecture' as const,
      sources: [{ lectureId: lecture.id, slide: s.index, quote: displayTitle(s).slice(0, 200), verified: true, rev: lecture.revision }],
    }));
}

const CARD_NOTE: Partial<Record<NoteKind, CardRow['type'][]>> = {
  definitions: ['definition'],
  formulas: ['formula'],
  comparison: ['comparison'],
  'revision-sheet': ['definition', 'concept', 'formula', 'comparison'],
  mistakes: [],
};

/** Collect approved flashcards into a revision sheet (definitions, formulas or comparisons). */
export function notesFromCards(cards: CardRow[], kind: NoteKind): NewBlock[] {
  const types = CARD_NOTE[kind] ?? [];
  return cards
    .filter((c) => c.status === 'approved' && types.includes(c.type))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((c) => ({
      text: c.type === 'comparison' ? `**${c.front.replace(/\*\*/g, '')}**\n\n${c.back}` : `**${c.front.replace(/^What is |\?$/g, '').replace(/\*\*/g, '')}**: ${c.back}`,
      origin: c.origin,
      basis: c.basis,
      sources: c.sources,
    }));
}

const ORIGIN_LABEL = { user: 'Written by you', imported: 'Imported study pack', auto: 'Auto-extracted from slides', ai: 'AI-generated' } as const;
export const originLabel = (o: NoteBlock['origin']): string => ORIGIN_LABEL[o];

/** Markdown export with provenance kept visible (origin and sources after each block). */
export function noteToMarkdown(note: NoteRow, lectureTitle: (id: string) => string | undefined): string {
  const lines = [`# ${note.title}`, ''];
  for (const b of note.blocks) {
    lines.push(b.text.trim(), '');
    const src = b.sources.map((s) => `${lectureTitle(s.lectureId) ?? 'lecture'}, slide ${s.slide}`).join('; ');
    lines.push(`<sub>${originLabel(b.origin)} · ${BASIS_LABEL[b.basis]}${src ? ` · ${src}` : ''}</sub>`, '');
  }
  return lines.join('\n').trim() + '\n';
}

interface HNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  value?: string;
}

const SAFE_HREF = /^(https?:|mailto:|#)/i;

/**
 * Exported notes are opened as local files, so links and images from (possibly AI-written) markdown
 * must be neutralised: only http(s)/mailto/# links survive, and images become plain alt text.
 */
function rehypeNeutraliseLinks() {
  const walk = (node: HNode): void => {
    if (node.type === 'element' && node.tagName === 'a') {
      const href = node.properties?.['href'];
      if (typeof href === 'string' && !SAFE_HREF.test(href.trim())) delete node.properties!['href'];
    }
    if (node.children) {
      node.children = node.children.map((c) => {
        if (c.type === 'element' && c.tagName === 'img') {
          const alt = c.properties?.['alt'];
          return { type: 'text', value: `[image${typeof alt === 'string' && alt ? `: ${alt}` : ''}]` };
        }
        walk(c);
        return c;
      });
    }
  };
  return (tree: HNode) => walk(tree);
}

/** Markdown → HTML (no raw HTML allowed; maths as MathML so no stylesheet or fonts are needed). */
export async function markdownToHtml(md: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeKatex, { output: 'mathml', trust: false, strict: 'ignore' })
    .use(rehypeNeutraliseLinks)
    .use(rehypeStringify)
    .process(md);
  return String(file);
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A complete, self-contained HTML file (inline CSS only; works offline and prints well). */
export async function noteToHtmlDocument(note: NoteRow, lectureTitle: (id: string) => string | undefined): Promise<string> {
  const body = await markdownToHtml(noteToMarkdown(note, lectureTitle));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(note.title)}</title>
<style>
  body{font:17px/1.65 Georgia,'Times New Roman',serif;color:#18212b;max-width:46rem;margin:2rem auto;padding:0 1rem}
  h1,h2,h3{font-family:system-ui,sans-serif;line-height:1.25}
  sub{display:block;font:13px system-ui,sans-serif;color:#5b6876;margin:-.4rem 0 1.2rem}
  table{border-collapse:collapse}th,td{border:1px solid #b7c0ca;padding:.3rem .6rem}th{background:#e9edf1}
  code,pre{font-family:Consolas,monospace;background:#e9edf1;border-radius:4px}pre{padding:.7rem;overflow:auto}code{padding:.1em .3em}pre code{padding:0}
  blockquote{border-left:3px solid #b7c0ca;margin-left:0;padding-left:1rem;color:#435060}
  @media print{body{margin:0;max-width:none}}
</style></head><body>
${body}
</body></html>
`;
}
