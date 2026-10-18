import type { Flag, SlideData } from './model';
import { scoreSlide } from './report';

/**
 * Text the student typed for pictures whose words are not in the file (the labels of a diagram, the values in a
 * screenshot). It is stored on the slide, shown in the study text under a heading that says who wrote it, and it settles the
 * "this picture may hold text" warnings for that picture. Nothing here is guessed: if the student typed nothing, nothing is added.
 */

export const PICTURE_TEXT_MAX = 4_000;
export const PICTURE_BLOCK_HEADING = '[Text typed by the student for the picture(s) on this slide]';

/** Flags that only mean "the words in this picture are not extracted". */
const PICTURE_FLAGS = new Set<Flag['code']>(['LARGE_PICTURE', 'UNRENDERABLE_IMAGE', 'NO_EXTRACTABLE_TEXT']);

export function cleanPictureText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\t/g, '    ').trimEnd()) // indentation and spacing are kept: diagrams are often typed as aligned text
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, PICTURE_TEXT_MAX);
}

export function pictureTextOf(slide: Pick<SlideData, 'pictureTexts'>, elementId: string): string {
  return slide.pictureTexts?.find((p) => p.elementId === elementId)?.text ?? '';
}

/** The slide's own study text, without any block of picture text added by the student. */
export function textWithoutPictureBlock(text: string): string {
  const at = text.indexOf(PICTURE_BLOCK_HEADING);
  return (at === -1 ? text : text.slice(0, at)).trimEnd();
}

function block(entries: { text: string }[]): string {
  return entries.length === 0 ? '' : `${PICTURE_BLOCK_HEADING}\n${entries.map((e) => e.text).join('\n\n')}`;
}

/**
 * Returns the slide with the given picture's text set (an empty text removes it). Study text, flags and confidence follow.
 * Warnings are kept but marked `resolved`, so removing the text brings the warning back.
 */
export function withPictureText(slide: SlideData, elementId: string, raw: string): SlideData {
  const pictures = slide.elements.filter((e) => e.kind === 'picture' && !e.decorative && !e.hidden);
  if (!pictures.some((p) => p.id === elementId)) return slide;
  const text = cleanPictureText(raw);
  const others = (slide.pictureTexts ?? []).filter((p) => p.elementId !== elementId && pictures.some((e) => e.id === p.elementId));
  const entries = text ? [...others, { elementId, text }] : others;
  // keep the entries in the order the pictures appear on the slide
  entries.sort((a, b) => pictures.findIndex((p) => p.id === a.elementId) - pictures.findIndex((p) => p.id === b.elementId));

  const allHaveText = pictures.length > 0 && pictures.every((p) => entries.some((e) => e.elementId === p.id));
  const flags: Flag[] = slide.flags
    .filter((f) => f.code !== 'PICTURE_TEXT_ADDED')
    .map((f) => {
      if (!PICTURE_FLAGS.has(f.code)) return f;
      const done = f.elementId ? entries.some((e) => e.elementId === f.elementId) : allHaveText;
      const { resolved: _was, ...rest } = f;
      return done ? { ...rest, resolved: true } : rest;
    });
  if (entries.length > 0) {
    flags.push({ code: 'PICTURE_TEXT_ADDED', severity: 'info', slide: slide.index, message: 'You typed the text of a picture on this slide. It is used as study text and marked as typed by you.' });
  }

  const base = textWithoutPictureBlock(slide.text);
  const merged = [base, block(entries)].filter(Boolean).join('\n\n');
  const { pictureTexts: _old, ...rest } = slide;
  const next: SlideData = { ...rest, ...(entries.length > 0 ? { pictureTexts: entries } : {}), flags, text: merged };
  return { ...next, confidence: scoreSlide(next) };
}

/**
 * After a lecture file is replaced by a newer version, keeps the text the student typed for pictures that are still there
 * (same slide position, same picture id and the same image part).
 */
export function carryPictureTexts(previous: SlideData[], next: SlideData[]): SlideData[] {
  return next.map((slide) => {
    const old = previous.find((p) => p.index === slide.index);
    if (!old?.pictureTexts?.length) return slide;
    let out = slide;
    for (const entry of old.pictureTexts) {
      const was = old.elements.find((e) => e.kind === 'picture' && e.id === entry.elementId);
      const now = out.elements.find((e) => e.kind === 'picture' && e.id === entry.elementId);
      if (was?.kind === 'picture' && now?.kind === 'picture' && was.media === now.media) out = withPictureText(out, entry.elementId, entry.text);
    }
    return out;
  });
}
