import type { SlideData } from '../pptx/model';

/**
 * Questions a slide puts to the student (a check-in, a poll, "Why is this proof a diagonalization?"). The slide asks them and does not
 * answer them in words, so an exam question or a lesson must not present its own answer as the slide's.
 */

const words = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** The label a lecture gives to a question it puts to the room. */
const CHECK_IN = /^\s*(?:check[- ]?in|quiz|poll|clicker|think[- ]pair[- ]share|your turn)\b/i;
/** A numbered or lettered answer to pick from. */
const OPTION = /^\s*(?:\d+|[A-Da-d])[.)]\s+\S/;
const CHOOSE = /\b(?:choose|select|pick|circle|tick|vote)\b/i;

export interface SlideQuestion {
  /** The question as the slide words it (its last line, up to the question mark). */
  text: string;
  /** The slide gives answers to pick from, none marked as right. */
  options: boolean;
}

/** The first lines of a slide, where a check-in names itself. */
function opening(slide: SlideData): string[] {
  return [slide.title, ...slide.text.split('\n').slice(0, 2)].map((l) => l.trim()).filter(Boolean);
}

/** Whether the slide is a check-in or quiz (named so at the top, or at the end of a slide that carries one). */
export function isCheckIn(slide: SlideData): boolean {
  return opening(slide).some((l) => CHECK_IN.test(l)) || slide.text.split('\n').some((l) => CHECK_IN.test(l));
}

export function slideQuestions(slide: SlideData): SlideQuestion[] {
  const out: SlideQuestion[] = [];
  const title = slide.title.trim();
  const checkIn = isCheckIn(slide);
  for (const e of slide.elements) {
    if (e.kind !== 'shape' || e.decorative || e.hidden || e.role === 'title') continue;
    const lines = e.paragraphs.flatMap((p) => p.text.split('\n').map((l) => l.trim())).filter(Boolean);
    const options = lines.some((l) => OPTION.test(l)) || lines.some((l) => CHOOSE.test(l));
    lines.forEach((line, i) => {
      if (!/\?$/.test(line) || line === title) return;
      // a question wrapped over two lines: "Given what we saw, which of these properties / can we establish …?"
      const text = (i > 0 && /^[a-z]/.test(line) ? `${lines[i - 1]} ${line}` : line).replace(/\s+/g, ' ');
      if (words(text) < 3) return; // "Questions?"
      // asked of the student, not the heading of a topic: a check-in, answers to pick from, or a question standing alone
      if (checkIn || options || e.paragraphs.length === 1) out.push({ text, options });
    });
  }
  return out;
}

/** The same, from the text of a slide as the quote check sees it (its heading, then its body). */
export function isQuestionText(text: string): boolean {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).some((l) => CHECK_IN.test(l)) && /\?/.test(text);
}

/** A slide that is only a question put to the room (a check-in): it has no answer to teach or to examine. */
export function isQuestionSlide(slide: SlideData): boolean {
  return opening(slide).slice(0, 2).some((l) => CHECK_IN.test(l)) && slideQuestions(slide).length > 0;
}
