import type { SlideData } from '../pptx/model';
import { displayTitle } from '../pptx/topics';

/**
 * Everything on a slide that a quote may be checked against: its title, text, notes, the alt text of its pictures, and the LaTeX of
 * its formulas (a model that is shown a formula as LaTeX quotes it as LaTeX, while the slide's own text holds it in a linear form).
 */
export function slideVerificationText(s: SlideData): string {
  const alts = s.elements.map((e) => (e.kind === 'picture' ? (e.alt ?? '') : '')).join(' ');
  const latex = s.elements.flatMap((e) => (e.kind === 'shape' ? e.paragraphs.flatMap((p) => p.inlines.flatMap((i) => (i.kind === 'math' ? [i.latex] : []))) : []));
  return `${displayTitle(s)}\n${s.text}\n${s.notes}\n${alts}${latex.length > 0 ? `\n${latex.join('\n')}` : ''}`;
}
