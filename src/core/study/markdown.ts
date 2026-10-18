import type { LectureRow } from '../db/db';
import type { Inline, Paragraph, SlideData } from '../pptx/model';
import { chartToText } from '../pptx/chart';
import { describePicture, listMarkers, notesAddNothing } from '../pptx/describe';
import { pictureTextOf } from '../pptx/picturetext';
import { orderedContentElements } from '../pptx/shapes';
import { contentParagraphs } from '../pptx/text';
import { displayTitle } from '../pptx/topics';
import { slideGaps } from '../tutor/gaps';
export { studyPackPrompt, type PromptOptions } from './pack-format';

/**
 * Markdown export of lectures, designed to be pasted into an AI chat (Claude, Gemini, …) together
 * with `studyPackPrompt()`. Slides keep their numbers so the AI can cite them and the app can verify
 * every quote when the result is imported. Equations are kept as LaTeX.
 */

function inlineMd(i: Inline): string {
  if (i.kind === 'break') return '  \n';
  if (i.kind === 'math') {
    if (i.display) return `\n$$${i.latex}$$\n`;
    // Keep the spaces that separated the equation from the words around it.
    return `${/^\s/.test(i.plain) ? ' ' : ''}$${i.latex}$${/\s$/.test(i.plain) ? ' ' : ''}`;
  }
  let t = i.text;
  if (!t.trim()) return t;
  if (i.mono) t = `\`${t}\``;
  if (i.bold) t = `**${t.trim()}**${/\s$/.test(t) ? ' ' : ''}`;
  else if (i.italic) t = `*${t.trim()}*${/\s$/.test(t) ? ' ' : ''}`;
  if (i.sub) t = `_{${i.text.trim()}}`;
  if (i.sup) t = `^{${i.text.trim()}}`;
  return t;
}

function paragraphMd(p: Paragraph, marker: string): string {
  const joined = p.inlines.map(inlineMd).join('').replace(/\s+\n/g, '\n').trim();
  // Runs of spaces mean nothing in text (code in a monospaced font is left alone; "  \n" is a Markdown hard break).
  const body = p.inlines.some((i) => i.kind === 'text' && i.mono) ? joined : joined.replace(/[ \t ]{2,}(?!\n)/g, ' ');
  if (!body) return '';
  return p.bullet === 'none' ? body : `${'  '.repeat(p.level)}${marker} ${body}`;
}

/** The paragraphs of a shape that carry content, with their list markers (numbered lists count 1., 2., ...). */
function shapeMarkdown(paragraphs: Paragraph[]): string {
  const rows = contentParagraphs(paragraphs);
  const markers = listMarkers(rows);
  return rows.map((p, i) => paragraphMd(p, markers[i]!)).filter(Boolean).join('\n');
}

export function slideToMarkdown(slide: SlideData, slideHeight: number): string {
  const parts: string[] = [];
  for (const el of orderedContentElements(slide.elements, slideHeight)) {
    switch (el.kind) {
      case 'shape': {
        if (el.role === 'title') break; // already in the heading
        const md = shapeMarkdown(el.paragraphs);
        if (md) parts.push(md);
        break;
      }
      case 'table': {
        const rows = el.rows.map((r) => r.filter((c) => !c.merged).map((c) => c.text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')));
        if (rows.length === 0) break;
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
        parts.push([pad(rows[0]!), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(pad)].join('\n'));
        break;
      }
      case 'chart':
        if (el.chart) parts.push(chartToText(el.chart).split('\n').map((l) => `> ${l}`).join('\n'));
        break;
      case 'smartart':
        if (el.outline.length) parts.push(`Diagram:\n${el.outline.map((n) => `${'  '.repeat(n.depth)}- ${n.text}`).join('\n')}`);
        break;
      case 'picture': {
        const d = describePicture(el.alt);
        const typed = pictureTextOf(slide, el.id);
        // A small picture without a description is an icon or a bullet: nothing to tell the reader or the tutor.
        if (!d && !typed && el.coverage < 0.06) break;
        const label = `Picture${d ? `${d.auto ? ' (automatic description, may be wrong)' : ''}: ${d.text}` : ''}`;
        // Text the student typed is shown as such, so nobody mistakes it for something the file itself contains.
        parts.push(typed ? `[${label} — the words in the picture, typed by the student:]\n${typed.split('\n').map((l) => `> ${l}`).join('\n')}` : `[${label} — contents not available as text]`);
        break;
      }
      default:
        break;
    }
  }
  if (slide.status === 'failed') parts.push('[This slide could not be read.]');
  const body = parts.join('\n\n');
  const notes = notesAddNothing(slide.notes, `${displayTitle(slide)}\n${body}`) ? '' : slide.notes.trim();
  // A flag the student settled (by typing a picture's words) is no longer a caveat: "content not available" would contradict the text right above it.
  const caveats = slide.flags.filter((f) => f.severity !== 'info' && f.code !== 'LARGE_PICTURE' && !f.resolved).map((f) => f.message);
  // What the slide asks without answering, and labels whose positions carry the meaning: the reader must not fill these in as if the slide said them.
  for (const g of slideGaps(slide)) if (g.kind === 'question-unanswered' || g.kind === 'arrangement') caveats.push(g.message);
  return [
    `### Slide ${slide.index}: ${displayTitle(slide)}`,
    body || '(no extractable text)',
    notes ? `**Speaker notes:** ${notes.replace(/\n/g, ' ')}` : '',
    caveats.length ? `> Extraction caveats: ${caveats.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function lectureToMarkdown(lecture: Pick<LectureRow, 'title' | 'fileHash' | 'slideCount' | 'meta'>, slides: SlideData[], ref: string): string {
  return [
    `## Lecture ${ref}: ${lecture.title}`,
    `<!-- studyai-lecture ref=${ref} hash=${lecture.fileHash} slides=${lecture.slideCount} -->`,
    '',
    slides.map((s) => slideToMarkdown(s, lecture.meta.slideHeight)).join('\n\n---\n\n'),
  ].join('\n');
}
