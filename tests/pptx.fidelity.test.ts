import { describe, expect, it } from 'vitest';
import { parsePptx } from '../src/core/pptx';
import { describePicture, isOnlyPunctuation, listMarkers, notesAddNothing, tidySpaces } from '../src/core/pptx/describe';
import type { ParsedDeck } from '../src/core/pptx/model';
import { lectureToMarkdown, slideToMarkdown } from '../src/core/study/markdown';
import { PNG_1X1, bodySp, buildPptx, para, picture, run, textBox, titleSp, type DeckSpec } from './fixtures/pptx-builder';

/**
 * Regression tests for defects found by comparing a real university lecture with its extraction. Every deck here is
 * synthetic: the real lecture (and anything quoted from it) is never part of the repository.
 */
const parse = async (spec: DeckSpec): Promise<ParsedDeck> => parsePptx(buildPptx(spec));
const img = { rels: { rIdImg1: ['image', '../media/image1.png'] as [string, string] }, parts: { 'ppt/media/image1.png': PNG_1X1 } };

describe('what a picture description is worth', () => {
  it('drops file names, mail attachment ids and placeholders (they say nothing about the picture)', () => {
    for (const alt of ['', undefined, 'fig03-02.eps', 'image1.png', 'Picture 6', 'Content Placeholder 5', 'cid:image001.jpg@01D072B1.9115D790', 'IMG_2041.JPG', '3f2b8c1e-9a4d-4e7f-8b6a-1c2d3e4f5a6b', 'Graphic 12']) {
      expect(describePicture(alt), String(alt)).toBeUndefined();
    }
  });

  it('keeps real descriptions, and marks machine-written ones after removing their boilerplate', () => {
    expect(describePicture('Architecture diagram')).toEqual({ text: 'Architecture diagram', auto: false });
    expect(describePicture('A diagram of a queue of jobs\n\nDescription automatically generated')).toEqual({ text: 'A diagram of a queue of jobs', auto: true });
    expect(describePicture('A graph with numbers  Description automatically generated with low confidence')).toEqual({ text: 'A graph with numbers', auto: true });
    expect(describePicture('Description automatically generated')).toBeUndefined(); // nothing left once the boilerplate is gone
  });
});

describe('list numbering', () => {
  const p = (level: number, bullet: 'none' | 'bullet' | 'number') => ({ level, bullet });
  it('numbers consecutive numbered paragraphs 1., 2., 3. and restarts after an interruption', () => {
    expect(listMarkers([p(0, 'number'), p(0, 'number'), p(0, 'none'), p(0, 'number')])).toEqual(['1.', '2.', '', '1.']);
  });
  it('counts nested lists on their own and keeps the outer count across them', () => {
    expect(listMarkers([p(0, 'number'), p(1, 'number'), p(1, 'number'), p(0, 'number'), p(1, 'number')])).toEqual(['1.', '1.', '2.', '2.', '1.']);
    expect(listMarkers([p(0, 'number'), p(1, 'bullet'), p(0, 'number')])).toEqual(['1.', '-', '2.']);
  });
});

describe('small text helpers', () => {
  it('collapses runs of spaces but not single ones, and glues punctuation back to the word', () => {
    expect(tidySpaces('dynamic memory for programmer   to allocate')).toBe('dynamic memory for programmer to allocate');
    expect(tidySpaces('word , next')).toBe('word, next');
    expect(tidySpaces('a b')).toBe('a b');
  });
  it('recognises a paragraph that is only punctuation', () => {
    for (const s of ['.', ' . ', '—', '•', '...']) expect(isOnlyPunctuation(s), s).toBe(true);
    for (const s of ['', 'a', '1', '.x', 'Ω']) expect(isOnlyPunctuation(s), s).toBe(false);
  });
  it('treats notes that repeat the slide as adding nothing, however they are spaced or cased', () => {
    expect(notesAddNothing('The same sentence, repeated.', 'Title\n\nthe SAME   sentence repeated')).toBe(true);
    expect(notesAddNothing('', 'anything')).toBe(true);
    expect(notesAddNothing('Stress the unbounded tape.', 'A tape that is infinite')).toBe(false);
  });
});

describe('titles', () => {
  const centred = textBox(2, 685800, 2500000, 7772400, 800000, [para([run('Chapter 4 – Security Issues', { sz: 4400 })])]) + textBox(3, 685800, 5000000, 7772400, 500000, [para([run('Dr. Example', { sz: 2000 })])]);
  it('finds the title of a title slide even though it sits in the middle of the slide (no title placeholder)', async () => {
    const deck = await parse({ slides: [{ layout: 1, shapes: centred }] });
    expect(deck.slides[0]!.title).toBe('Chapter 4 – Security Issues');
  });
  it('still refuses big text in the middle of an ordinary slide as a title', async () => {
    const deck = await parse({ slides: [{ layout: 2, shapes: centred }] });
    expect(deck.slides[0]!.title).toBe('');
  });
  it('never shows a picture marker or file name as the title of a slide that has none', async () => {
    const deck = await parse({ slides: [{ layout: 2, shapes: picture(4, 'rIdImg1', 0, 0, 3000000, 2000000, 'cid:image001.jpg@01D072B1.9115D790') + bodySp(5, [para('First real line of the slide')]), ...img }] });
    const slide = deck.slides[0]!;
    expect(slide.text).not.toContain('cid:');
    expect(lectureToMarkdown({ title: 't', fileHash: 'h', slideCount: 1, meta: deck.meta }, deck.slides, 'L1')).toContain('### Slide 1: First real line of the slide');
  });
});

describe('study text and the markdown the tutor reads', () => {
  const lists = bodySp(2, [para('Two kinds of memory:', { bullet: 'char' }), para('stack memory', { bullet: 'num', lvl: 1 }), para('heap memory', { bullet: 'num', lvl: 1 }), para('.', { bullet: 'char' }), para([run('Stack '), run('grows   down')], { bullet: 'char' })]);
  it('numbers numbered lists, drops a stray "." bullet and collapses spacing — in both renderings', async () => {
    const deck = await parse({ slides: [{ shapes: titleSp(3, 'Memory') + lists }] });
    const md = slideToMarkdown(deck.slides[0]!, deck.meta.slideHeight);
    for (const text of [deck.slides[0]!.text, md]) {
      expect(text).toContain('  1. stack memory');
      expect(text).toContain('  2. heap memory');
      expect(text).toContain('- Stack grows down');
      expect(text).not.toMatch(/^\s*[-\d.]+\s*\.?\s*$/m); // no bullet that holds nothing but a full stop
    }
    expect(md).not.toMatch(/grows {2,}down/);
  });

  it('leaves out a file-name description, labels a machine-written one, and omits small icons', async () => {
    const shapes =
      titleSp(2, 'Pictures') +
      picture(4, 'rIdImg1', 500000, 1500000, 4000000, 3000000, 'cid:image001.jpg@01D072B1.9115D790') +
      picture(5, 'rIdImg1', 5000000, 1500000, 3500000, 2500000, 'A diagram of a queue of jobs\n\nDescription automatically generated') +
      picture(6, 'rIdImg1', 100000, 100000, 300000, 300000, '');
    const deck = await parse({ slides: [{ shapes, ...img }] });
    const s = deck.slides[0]!;
    expect(s.text).not.toContain('cid:');
    expect(s.text).toContain('[Picture (automatic description, may be wrong): A diagram of a queue of jobs]');
    const md = slideToMarkdown(s, deck.meta.slideHeight);
    expect(md).not.toContain('cid:');
    expect(md).toContain('[Picture (automatic description, may be wrong): A diagram of a queue of jobs — contents not available as text]');
    expect(md.match(/\[Picture/g)).toHaveLength(2); // the big unnamed picture and the described one; the tiny icon is omitted
  });

  it('does not repeat speaker notes that only say what the slide already says', async () => {
    const sentence = 'The same sentence appears on the slide and in the notes.';
    const deck = await parse({ slides: [{ shapes: titleSp(2, 'Repeat') + bodySp(3, [para(sentence, { bullet: 'none' })]), notes: sentence }, { shapes: titleSp(2, 'Different') + bodySp(3, [para('Visible text')]), notes: 'Something only the lecturer says.' }] });
    expect(deck.slides[0]!.notes).toBe(sentence); // the data keeps the notes
    expect(slideToMarkdown(deck.slides[0]!, deck.meta.slideHeight)).not.toContain('Speaker notes');
    expect(slideToMarkdown(deck.slides[1]!, deck.meta.slideHeight)).toContain('**Speaker notes:** Something only the lecturer says.');
  });
});

describe('honest picture flags', () => {
  const flagsOf = async (w: number, h: number, layout: 1 | 2 = 2) => {
    const deck = await parse({ slides: [{ layout, shapes: titleSp(2, 'Diagram') + bodySp(3, [para('Some words on the slide')]) + picture(4, 'rIdImg1', 4000000, 2000000, w, h), ...img }] });
    return deck.slides[0]!.flags.filter((f) => f.code === 'LARGE_PICTURE');
  };
  it('flags a mid-sized picture that could hold a diagram, not only a huge one', async () => {
    const f = await flagsOf(3000000, 2300000); // about 11% of the slide
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warning');
  });
  it('does not flag an icon-sized picture', async () => {
    expect(await flagsOf(500000, 500000)).toHaveLength(0);
  });
  it('flags a picture even when the slide also has plenty of text', async () => {
    const long = Array.from({ length: 14 }, (_, i) => para(`Line ${i + 1} of a long list with enough words to pass six hundred characters easily.`, { bullet: 'char' }));
    const deck = await parse({ slides: [{ shapes: titleSp(2, 'Busy') + bodySp(3, long) + picture(4, 'rIdImg1', 5000000, 2000000, 3000000, 3000000), ...img }] });
    expect(deck.slides[0]!.text.length).toBeGreaterThan(600);
    expect(deck.slides[0]!.flags.map((f) => f.code)).toContain('LARGE_PICTURE');
  });
  it('treats a logo on a title slide as information, not a warning', async () => {
    const f = await flagsOf(3000000, 2300000, 1);
    expect(f[0]!.severity).toBe('info');
  });
});

describe('topic key terms', () => {
  it('uses short bold terms, not bold sentences', async () => {
    const shapes = titleSp(2, 'Heap') + bodySp(3, [para([run('Heap', { b: true }), run(' is managed by the program; '), run('this whole sentence is bold because the author shouted it', { b: true })], { bullet: 'char' })]);
    const deck = await parse({ slides: [{ shapes }] });
    const terms = deck.report.topics.flatMap((t) => t.keyTerms).map((t) => t.toLowerCase());
    expect(terms).toContain('heap');
    expect(terms.some((t) => t.includes('shouted'))).toBe(false);
  });
});
