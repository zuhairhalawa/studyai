import { describe, expect, it } from 'vitest';
import { lessonParts, lessonQuestion } from '../src/core/tutor/lesson';

const t = (title: string, startSlide: number, endSlide: number) => ({ title, startSlide, endSlide });

describe('the guided lesson path', () => {
  it('follows the deck’s own topics in slide order, one part per topic when it is small', () => {
    const parts = lessonParts([t('Memory', 4, 6), t('Intro', 1, 3), t('Attacks', 7, 8)], 8);
    expect(parts.map((p) => [p.n, p.topic, p.start, p.end])).toEqual([
      [1, 'Intro', 1, 3],
      [2, 'Memory', 4, 6],
      [3, 'Attacks', 7, 8],
    ]);
    expect(parts[0]!.slides).toEqual([1, 2, 3]);
    expect(parts[1]!.title).toBe('Memory (slides 4–6)');
  });

  it('cuts a long topic into even parts of at most four slides, never skipping or repeating a slide', () => {
    const parts = lessonParts([t('Architecture', 7, 15)], 19); // nine slides
    expect(parts.map((p) => p.slides.length)).toEqual([3, 3, 3]);
    expect(parts.flatMap((p) => p.slides)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(parts[0]!.title).toBe('Architecture (part 1 of 3, slides 7–9)');
    expect(lessonParts([t('Five', 1, 5)], 5).map((p) => p.slides.length)).toEqual([3, 2]);
    expect(lessonParts([t('Four', 1, 4)], 4)).toHaveLength(1);
    expect(lessonParts([t('One', 3, 3)], 3)[0]!.title).toBe('One (slide 3)');
  });

  it('packs neighbouring small topics into one part (at most four slides) instead of one request per slide', () => {
    const parts = lessonParts([t('Title', 1, 1), t('Thanks', 2, 2), t('Goals', 3, 3), t('Memory', 4, 5), t('Layout', 6, 9), t('Wrap-up', 10, 10)], 10);
    expect(parts.map((p) => [p.start, p.end, p.topic])).toEqual([
      [1, 3, 'Title · Thanks · Goals'],
      [4, 5, 'Memory'], // adding the next topic would exceed four slides
      [6, 9, 'Layout'],
      [10, 10, 'Wrap-up'],
    ]);
    expect(parts[0]!.topic).toBe('Title · Thanks · Goals'); // the question to the tutor names every topic
    expect(parts[0]!.title).toBe('Title · Thanks · +1 more (slides 1–3)'); // the list shows at most two
    // every slide appears exactly once, in order, however the parts are packed
    expect(parts.flatMap((p) => p.slides)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('never packs a piece of a long topic with its neighbours, so the pieces stay separate parts', () => {
    const parts = lessonParts([t('Short', 1, 1), t('Long', 2, 7), t('After', 8, 8)], 8);
    expect(parts.map((p) => [p.start, p.end])).toEqual([[1, 1], [2, 4], [5, 7], [8, 8]]);
  });

  it('walks through the slides in order when the deck has no usable topics, and ignores impossible ranges', () => {
    expect(lessonParts([], 9).flatMap((p) => p.slides)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(lessonParts([t('Broken', 5, 2), t('Beyond', 8, 12)], 6).map((p) => p.topic)).toEqual(['The lecture', 'The lecture']);
    expect(lessonParts([], 0)).toEqual([]);
  });

  it('lets a later part name the parts that were really taught, newest five, so it connects even when old answers are gone from the chat', () => {
    const parts = lessonParts([t('One', 1, 2), t('Two', 3, 4), t('Three', 5, 6), t('Four', 7, 8), t('Five', 9, 10), t('Six', 11, 12), t('Seven', 13, 14)], 14, 2);
    expect(lessonQuestion(parts[1]!, false, [])).not.toMatch(/So far/); // nothing taught yet, nothing claimed
    expect(lessonQuestion(parts[1]!, false, [parts[0]!])).toMatch(/Connect it to what we have already covered \(So far we have covered One \(slides 1–2\)\.\)\./);
    const many = lessonQuestion(parts[6]!, false, parts.slice(0, 6));
    expect(many).toContain('1 earlier part and Two (slides 3–4); Three (slides 5–6); Four (slides 7–8); Five (slides 9–10); Six (slides 11–12)');
    expect(many).not.toContain('One (slides 1–2)'); // only the newest five are named
    expect(lessonQuestion(parts[6]!, false, parts.slice(0, 5))).not.toContain('earlier part'); // exactly five: all named
    expect(lessonQuestion(parts[0]!, true, parts.slice(1, 3))).not.toMatch(/So far/); // a first part never claims anything covered
    expect(lessonQuestion(parts[6]!, false, parts.slice(0, 6)).length).toBeLessThan(900); // still a question a student can read and send
  });

  it('asks for the lesson in order, from the slides only, and says to continue on later parts', () => {
    const [first, second] = lessonParts([t('Intro', 1, 2), t('Memory', 3, 3)], 3, 2);
    expect(lessonQuestion(first!, true)).toMatch(/^Teach me "Intro" \(slides 1–2\) from the beginning, in the order of the slides/);
    expect(lessonQuestion(first!, true)).toMatch(/Use only these slides/);
    expect(lessonQuestion(second!, false)).toMatch(/^Now teach me the next part: "Memory" \(slide 3\)/);
    expect(lessonQuestion(second!, false)).toMatch(/Connect it to what we have already covered/);
  });
});
