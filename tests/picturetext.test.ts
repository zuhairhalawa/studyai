import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBackup, exportBackup, readBackup } from '../src/core/backup/backup';
import { StudyDB } from '../src/core/db/db';
import { createCourse, importLecture, loadSlides, replaceLecture, setPictureText } from '../src/core/db/library';
import { parsePptx } from '../src/core/pptx';
import type { Flag } from '../src/core/pptx/model';
import { PICTURE_BLOCK_HEADING, PICTURE_TEXT_MAX, cleanPictureText, pictureTextOf, textWithoutPictureBlock, withPictureText } from '../src/core/pptx/picturetext';
import { SearchIndex } from '../src/core/search/search';
import { slideToMarkdown } from '../src/core/study/markdown';
import { PNG_1X1, bodySp, buildPptx, para, picture, titleSp, type DeckSpec } from './fixtures/pptx-builder';

/** Synthetic decks only: nothing from a real lecture is used in the repository. */
const img = { rels: { rIdImg1: ['image', '../media/image1.png'] as [string, string] }, parts: { 'ppt/media/image1.png': PNG_1X1 } };
const diagramSlide = (extra = ''): DeckSpec['slides'][number] => ({
  shapes: titleSp(2, 'Memory') + bodySp(3, [para('Two regions of memory', { bullet: 'char' })]) + picture(4, 'rIdImg1', 4500000, 1800000, 3800000, 3600000) + extra,
  ...img,
});
const twoPictures: DeckSpec['slides'][number] = {
  shapes: titleSp(2, 'Two figures') + picture(4, 'rIdImg1', 300000, 1800000, 3800000, 3000000) + picture(5, 'rIdImg1', 4700000, 1800000, 3800000, 3000000),
  ...img,
};

async function load(spec: DeckSpec) {
  const bytes = buildPptx(spec);
  return { bytes, deck: await parsePptx(bytes) };
}

describe('typing the words of a picture', () => {
  it('adds them to the study text under a heading that says who wrote them, and settles the picture warning', async () => {
    const { deck } = await load({ slides: [diagramSlide()] });
    const slide = deck.slides[0]!;
    expect(slide.flags.some((f) => f.code === 'LARGE_PICTURE' && !f.resolved)).toBe(true);
    expect(slide.confidence).toBe('medium');

    const typed = withPictureText(slide, '4', 'high address\nstack\nheap\nlow address');
    expect(typed.text).toContain(PICTURE_BLOCK_HEADING);
    expect(typed.text).toContain('high address\nstack\nheap\nlow address');
    expect(typed.text.startsWith(slide.text)).toBe(true); // the file's own text is untouched and comes first
    expect(typed.flags.find((f) => f.code === 'LARGE_PICTURE')).toMatchObject({ resolved: true });
    expect(typed.flags.some((f) => f.code === 'PICTURE_TEXT_ADDED')).toBe(true);
    expect(typed.confidence).toBe('high');
    expect(typed.pictureTexts).toEqual([{ elementId: '4', text: 'high address\nstack\nheap\nlow address' }]);
    expect(slide.pictureTexts).toBeUndefined(); // the original object is not changed
  });

  it('removing the text restores the slide exactly, warning included', async () => {
    const { deck } = await load({ slides: [diagramSlide()] });
    const slide = deck.slides[0]!;
    const back = withPictureText(withPictureText(slide, '4', 'something'), '4', '   ');
    expect(back.text).toBe(slide.text);
    expect(back.pictureTexts).toBeUndefined();
    expect(back.flags.find((f) => f.code === 'LARGE_PICTURE')?.resolved).toBeUndefined();
    expect(back.flags.some((f) => f.code === 'PICTURE_TEXT_ADDED')).toBe(false);
    expect(back.confidence).toBe('medium');
  });

  it('keeps one block for several pictures, in slide order, and only settles a slide-level warning when all have text', async () => {
    const { deck } = await load({ slides: [twoPictures] });
    const s0 = deck.slides[0]!;
    const second = withPictureText(s0, '5', 'second figure');
    const both = withPictureText(second, '4', 'first figure');
    expect(both.pictureTexts!.map((p) => p.text)).toEqual(['first figure', 'second figure']);
    expect(both.text.split(PICTURE_BLOCK_HEADING)).toHaveLength(2); // one heading, however many pictures
    expect(textWithoutPictureBlock(both.text)).toBe(s0.text);
    expect(pictureTextOf(both, '5')).toBe('second figure');
  });

  it('ignores a picture id that is not on the slide and cleans what is typed', async () => {
    const { deck } = await load({ slides: [diagramSlide()] });
    const slide = deck.slides[0]!;
    expect(withPictureText(slide, '999', 'x')).toBe(slide);
    expect(cleanPictureText('a  b   \r\n\r\n\r\n\r\n  c\t \r\n')).toBe('a  b\n\n  c'); // line ends and blank runs are tidied, spacing inside lines is kept
    expect(cleanPictureText('x'.repeat(PICTURE_TEXT_MAX + 500))).toHaveLength(PICTURE_TEXT_MAX);
  });
});

describe('what the rest of the app sees', () => {
  it('the tutor-facing markdown shows the typed words as typed by the student, right where the picture is', async () => {
    const { deck } = await load({ slides: [diagramSlide()] });
    const typed = withPictureText(deck.slides[0]!, '4', 'stack\nheap');
    const md = slideToMarkdown(typed, deck.meta.slideHeight);
    expect(md).toContain('[Picture — the words in the picture, typed by the student:]\n> stack\n> heap');
    expect(md).not.toContain('contents not available as text');
    expect(slideToMarkdown(deck.slides[0]!, deck.meta.slideHeight)).toContain('contents not available as text'); // untouched slide still says so
  });

  it('stops telling the tutor that the picture is unavailable once the student has typed its words (a settled warning is not a caveat)', async () => {
    const { deck } = await load({ slides: [diagramSlide()] });
    const s = deck.slides[0]!;
    const emf: Flag = { code: 'UNRENDERABLE_IMAGE', severity: 'warning', message: 'An image in EMF format cannot be displayed. Its content is not available here; view the original slide.', slide: 1, elementId: '4' };
    const withCaveat = { ...s, flags: [...s.flags, emf] };
    expect(slideToMarkdown(withCaveat, deck.meta.slideHeight)).toContain('Extraction caveats: An image in EMF format');
    const typed = withPictureText(withCaveat, '4', 'stack\nheap');
    expect(typed.flags.find((f) => f.code === 'UNRENDERABLE_IMAGE')).toMatchObject({ resolved: true });
    const md = slideToMarkdown(typed, deck.meta.slideHeight);
    expect(md).not.toContain('Extraction caveats');
    expect(md).not.toContain('Its content is not available here');
    expect(md).toContain('> stack');
  });

  it('search finds words that only exist in the typed picture text', async () => {
    const { deck } = await load({ slides: [diagramSlide()] });
    const typed = withPictureText(deck.slides[0]!, '4', 'uninitialized data bss segment');
    const index = new SearchIndex();
    index.addLecture({ id: 'L', courseId: 'C', title: 'Lecture' }, 'Course', [typed]);
    expect(index.search('bss segment').map((h) => h.slide)).toEqual([1]);
    const plain = new SearchIndex();
    plain.addLecture({ id: 'L', courseId: 'C', title: 'Lecture' }, 'Course', deck.slides);
    expect(plain.search('bss segment')).toHaveLength(0);
  });
});

describe('persistence', () => {
  let db: StudyDB;
  let n = 0;
  beforeEach(() => {
    db = new StudyDB(`pic-${Date.now()}-${n++}`);
  });
  const importIt = async (spec: DeckSpec) => {
    const { bytes, deck } = await load(spec);
    const course = await createCourse(db, { name: 'C' });
    const lecture = await importLecture(db, { courseId: course.id, fileName: 'l.pptx', bytes, deck });
    return { course, lecture, bytes, deck };
  };

  it('saves to the slide row, updates the extraction report, and can be undone', async () => {
    const { lecture } = await importIt({ slides: [diagramSlide(), { shapes: titleSp(2, 'Plain') + bodySp(3, [para('text')]) }] });
    expect(lecture.report.potentiallyMissing.join(' ')).toMatch(/Picture that may hold text or a diagram.*slide 1/);
    await setPictureText(db, lecture.id, 1, '4', 'high address\nlow address');
    const slides = await loadSlides(db, lecture.id);
    expect(slides[0]!.text).toContain('low address');
    expect(slides[0]!.confidence).toBe('high');
    const after = (await db.lectures.get(lecture.id))!;
    expect(after.report.potentiallyMissing.join(' ')).not.toMatch(/Picture that may hold text/);
    expect(after.report.overallConfidence).toBeGreaterThan(lecture.report.overallConfidence);
    expect(after.report.flagsByCode.PICTURE_TEXT_ADDED).toBe(1);
    expect(after.updatedAt).toBeGreaterThanOrEqual(lecture.updatedAt);

    await setPictureText(db, lecture.id, 1, '4', '');
    expect((await loadSlides(db, lecture.id))[0]!.text).not.toContain('low address');
    expect((await db.lectures.get(lecture.id))!.report.potentiallyMissing.join(' ')).toMatch(/Picture that may hold text/);
    await expect(setPictureText(db, lecture.id, 1, '999', 'x')).rejects.toThrow(/not on this slide/);
    await expect(setPictureText(db, lecture.id, 9, '4', 'x')).rejects.toThrow(/Slide not found/);
  });

  it('survives replacing the lecture file with a newer version that still has the same picture', async () => {
    const { lecture } = await importIt({ slides: [diagramSlide()] });
    await setPictureText(db, lecture.id, 1, '4', 'kept words');
    const next = await load({ slides: [diagramSlide(), { shapes: titleSp(2, 'New slide') + bodySp(3, [para('added later')]) }] });
    const updated = await replaceLecture(db, lecture.id, { fileName: 'l2.pptx', bytes: next.bytes, deck: next.deck });
    const slides = await loadSlides(db, lecture.id);
    expect(slides[0]!.text).toContain('kept words');
    expect(slides[0]!.pictureTexts).toEqual([{ elementId: '4', text: 'kept words' }]);
    expect(updated.report.flagsByCode.PICTURE_TEXT_ADDED).toBe(1);
    expect(updated.report.potentiallyMissing.join(' ')).not.toMatch(/Picture that may hold text/);
  });

  it('is dropped when the new file has a different picture in its place', async () => {
    const { lecture } = await importIt({ slides: [diagramSlide()] });
    await setPictureText(db, lecture.id, 1, '4', 'old words');
    const other = { ...diagramSlide(), rels: { rIdImg1: ['image', '../media/image2.png'] as [string, string] }, parts: { 'ppt/media/image2.png': PNG_1X1 } };
    const next = await load({ slides: [other] });
    await replaceLecture(db, lecture.id, { fileName: 'l2.pptx', bytes: next.bytes, deck: next.deck });
    expect((await loadSlides(db, lecture.id))[0]!.text).not.toContain('old words');
  });

  it('travels in a backup and comes back intact', async () => {
    const { lecture } = await importIt({ slides: [diagramSlide()] });
    await setPictureText(db, lecture.id, 1, '4', 'words in a backup');
    const zip = new Uint8Array(await (await exportBackup(db)).arrayBuffer());
    const fresh = new StudyDB(`pic-restore-${Date.now()}-${n++}`);
    await applyBackup(fresh, readBackup(zip), 'replace');
    const slides = await loadSlides(fresh, lecture.id);
    expect(slides[0]!.pictureTexts).toEqual([{ elementId: '4', text: 'words in a backup' }]);
    expect(slides[0]!.text).toContain('words in a backup');
    expect(slides[0]!.flags.find((f) => f.code === 'LARGE_PICTURE')?.resolved).toBe(true);
  });
});
