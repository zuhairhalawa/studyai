import { describe, expect, it } from 'vitest';
import { parsePptx } from '../src/core/pptx';
import { withPictureText } from '../src/core/pptx/picturetext';
import type { SlideData } from '../src/core/pptx/model';
import { gapMessages, MAX_GAPS, slideGaps } from '../src/core/tutor/gaps';
import { PNG_1X1, bodySp, buildPptx, equationShape, mr, para, picture, simpleSlide, titleSp, type DeckSpec } from './fixtures/pptx-builder';

/** Synthetic lectures only. */
const slidesOf = async (spec: DeckSpec): Promise<SlideData[]> => (await parsePptx(buildPptx(spec))).slides;
const img = { rels: { rIdImg1: ['image', '../media/image1.png'] as [string, string] }, parts: { 'ppt/media/image1.png': PNG_1X1 } };
const kinds = (s: SlideData) => slideGaps(s).map((g) => g.kind);

describe('what a slide does not say', () => {
  it('has nothing to report for a slide that explains its topic', async () => {
    const [s] = await slidesOf({ slides: [simpleSlide('Firewalls', ['A firewall filters network traffic using rules and blocks untrusted addresses', 'It also logs every blocked attempt for later review'])] });
    expect(slideGaps(s!)).toEqual([]);
  });

  it('finds a slide that is only a heading, even with a few words under it', async () => {
    const [a, b] = await slidesOf({ slides: [simpleSlide('Buffer Overflows', ['Introduction to the attack']), simpleSlide('Thanks', [])] });
    expect(kinds(a!)).toEqual(['heading-only']);
    expect(slideGaps(a!)[0]!.message).toBe('Slide 1 (“Buffer Overflows”) has only a heading: it explains nothing by itself.');
    expect(kinds(b!)).toContain('heading-only');
  });

  it('finds a picture whose words are not available, and stops reporting it once the student has typed them', async () => {
    const spec: DeckSpec = { slides: [{ shapes: titleSp(2, 'Memory layout') + bodySp(3, [para('Two regions are shown here with their order from low to high addresses')]) + picture(4, 'rIdImg1', 4500000, 1800000, 3800000, 3600000), ...img }] };
    const [s] = await slidesOf(spec);
    expect(kinds(s!)).toContain('picture-unread');
    expect(slideGaps(s!).find((g) => g.kind === 'picture-unread')!.message).toMatch(/words are not available as text.*the student can type its words in/);
    const typed = withPictureText(s!, '4', 'high address\nstack\nheap\nlow address');
    expect(kinds(typed)).not.toContain('picture-unread');
  });

  it('finds a reference to something that is not on the slide', async () => {
    const phrases = ['See Figure 3 for the full layout of the memory', 'As shown above, the stack grows downward in memory', 'The diagram below summarises every step of the attack', 'This is explained on the next slide in more detail', 'As we discussed last week the heap is managed by the allocator', 'We will draw this on the board during the lecture itself'];
    const slides = await slidesOf({ slides: phrases.map((p, i) => simpleSlide(`Topic ${i}`, [p, 'Some other explanatory sentence that sits on this slide too'])) });
    slides.forEach((s, i) => expect(kinds(s), phrases[i]).toContain('refers-elsewhere'));
    expect(slideGaps(slides[0]!).find((g) => g.kind === 'refers-elsewhere')!.message).toContain('“See Figure');
  });

  it('does not take ordinary sentences for references', async () => {
    const slides = await slidesOf({ slides: [simpleSlide('Keys', ['We see that the key is shared between the two parties in a symmetric scheme', 'The next step is to encrypt the message with that shared key'])] });
    expect(kinds(slides[0]!)).not.toContain('refers-elsewhere');
  });

  it('finds a formula whose symbols are not defined, but not one that says what they mean', async () => {
    const eq = equationShape(5, `<m:f><m:num>${mr('a')}</m:num><m:den>${mr('b')}</m:den></m:f>`);
    const bare = await slidesOf({ slides: [{ shapes: titleSp(2, 'Ratio') + eq + bodySp(3, [para('The result scales with the ratio shown in the formula and nothing else')]) }] });
    expect(kinds(bare[0]!)).toContain('formula-undefined');
    const defined = await slidesOf({ slides: [{ shapes: titleSp(2, 'Ratio') + eq + bodySp(3, [para('where a is the number of packets sent and b is the number received successfully')]) }] });
    expect(kinds(defined[0]!)).not.toContain('formula-undefined');
  });

  it('says when a diagram’s arrangement was only inferred', async () => {
    const [s] = await slidesOf({ slides: [simpleSlide('Hierarchy', ['Root node with two children and a longer description of each child node here'])] });
    const withFlag: SlideData = { ...s!, flags: [...s!.flags, { code: 'SMARTART', severity: 'warning', message: 'SmartArt', slide: 1 }] };
    expect(kinds(withFlag)).toContain('diagram-inferred');
    const settled: SlideData = { ...s!, flags: [{ code: 'SMARTART', severity: 'warning', message: 'SmartArt', slide: 1, resolved: true }] };
    expect(kinds(settled)).not.toContain('diagram-inferred');
  });

  it('says that a slide that could not be read is unknown', async () => {
    const [s] = await slidesOf({ slides: [simpleSlide('Fine', ['Some ordinary text that has enough words on it to count as content here'])] });
    const failed: SlideData = { ...s!, status: 'failed' };
    expect(slideGaps(failed)[0]!.message).toBe('Slide 1 could not be read, so nothing is known about it.');
  });
});

describe('the gaps that are sent with a question', () => {
  it('lists each gap once, in slide order, and never more than the limit', async () => {
    const slides = await slidesOf({ slides: Array.from({ length: 20 }, (_, i) => simpleSlide(`Heading ${i + 1}`, [])) });
    const all = gapMessages(slides);
    expect(all).toHaveLength(MAX_GAPS);
    expect(all[0]).toContain('Slide 1');
    expect(new Set(all).size).toBe(all.length);
    expect(gapMessages([slides[0]!, slides[0]!])).toHaveLength(1); // the same slide twice is one gap
    expect(gapMessages([])).toEqual([]);
  });
});
