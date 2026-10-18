import type { Paragraph } from './model';

/**
 * Small, pure helpers that decide what is worth putting in the study text from what PowerPoint stores.
 * Everything here only REMOVES noise or numbers things; it never adds content that is not in the file.
 */

const FILE_NAME = /[\w\-. ]+\.(png|jpe?g|gif|bmp|webp|svg|emf|wmf|tiff?|eps|pdf)\b/i;
const GENERIC = /^(picture|image|graphic|figure|photo|object|content placeholder|rectangle|group|shape)\s*\d*$/i;
const TECHNICAL_ID = /^cid:|@[0-9a-f]{6,}\.[0-9a-f]{6,}|^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{16,}$/i;
const AUTO_TAIL = /\s*(description\s+)?automatically\s+generated(\s+with\s+(low|medium|high)\s+confidence)?\.?\s*$/i;

export interface PictureDescription {
  text: string;
  /** Written by a machine (Office's "automatically generated" alt text), so it may be wrong or vague. */
  auto: boolean;
}

/**
 * The alt text of a picture, if it says something about the picture. File names ("fig03-02.eps"), mail attachment ids
 * ("cid:image001.jpg@01D0...") and placeholders ("Picture 6") say nothing and are dropped. Office's machine-written
 * descriptions are kept but marked, with their boilerplate sentence removed.
 */
export function describePicture(alt: string | undefined): PictureDescription | undefined {
  const raw = (alt ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return undefined;
  if (FILE_NAME.test(raw) || TECHNICAL_ID.test(raw) || GENERIC.test(raw)) return undefined;
  const auto = AUTO_TAIL.test(raw);
  const text = raw.replace(AUTO_TAIL, '').trim();
  if (!text) return undefined;
  return { text, auto };
}

/**
 * The visible marker of each paragraph in a list: "" for plain text, "-" for bullets, and a running number for numbered
 * paragraphs. Numbers restart when the list is interrupted by a non-numbered paragraph at the same or a shallower level,
 * and nested lists count on their own, as in PowerPoint.
 */
export function listMarkers(paragraphs: Pick<Paragraph, 'level' | 'bullet'>[]): string[] {
  const counters: number[] = [];
  return paragraphs.map((p) => {
    if (p.bullet === 'number') {
      counters[p.level] = (counters[p.level] ?? 0) + 1;
      counters.length = p.level + 1;
      return `${counters[p.level]}.`;
    }
    counters.length = p.bullet === 'bullet' ? p.level : 0; // a bullet keeps the numbering of the levels above it
    return p.bullet === 'bullet' ? '-' : '';
  });
}

/** Runs of spaces and tabs inside a line become one space (PowerPoint keeps spacing tricks that mean nothing in text). */
export function tidySpaces(text: string): string {
  return text.replace(/[ \t ]{2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1');
}

/** A paragraph made only of punctuation (a stray "." bullet) carries no study content. */
export function isOnlyPunctuation(text: string): boolean {
  return text.trim() !== '' && !/[\p{L}\p{N}]/u.test(text);
}

const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Speaker notes that only repeat what is already on the slide add nothing for the student or the tutor. */
export function notesAddNothing(notes: string, slideText: string): boolean {
  const n = squash(notes);
  if (!n) return true;
  return squash(slideText).includes(n);
}
