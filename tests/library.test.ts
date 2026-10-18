import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { StudyDB } from '../src/core/db/db';
import {
  createCourse,
  deleteCourse,
  deleteLecture,
  findDuplicates,
  findSameNamed,
  importLecture,
  listLectures,
  loadMedia,
  loadSlides,
  reorderLectures,
  replaceLecture,
  titleFromFileName,
  updateCourse,
} from '../src/core/db/library';
import { parsePptx } from '../src/core/pptx';
import { SearchIndex, makeSnippet } from '../src/core/search/search';
import { PNG_1X1, bodySp, buildPptx, para, picture, simpleSlide, titleSp, type DeckSpec } from './fixtures/pptx-builder';

let db: StudyDB;
let counter = 0;
beforeEach(() => {
  db = new StudyDB(`test-${Date.now()}-${counter++}`);
});

async function deckOf(spec: DeckSpec) {
  const bytes = buildPptx(spec);
  return { bytes, deck: await parsePptx(bytes) };
}

const lecture1: DeckSpec = {
  slides: [
    simpleSlide('Turing Machines', ['A tape that is infinite', 'A finite control'], 'Draw the 7-tuple on the board'),
    simpleSlide('Decidability', ['Halting problem is undecidable', 'Reduction from A_TM']),
    {
      shapes: titleSp(2, 'Architecture') + picture(4, 'rIdImg1', 500000, 1500000, 3000000, 2000000, 'Layered architecture'),
      rels: { rIdImg1: ['image', '../media/image1.png'] },
      parts: { 'ppt/media/image1.png': PNG_1X1 },
    },
  ],
};

describe('titleFromFileName', () => {
  it('cleans hash prefixes, extensions and underscores', () => {
    expect(titleFromFileName('057203435eb7ecb77ccaafde892dbacf_MIT18_404f20_lec9.pptx')).toBe('MIT18 404f20 lec9');
    expect(titleFromFileName('Ch01-Introduction to Security concepts.pptx')).toBe('Ch01-Introduction to Security concepts');
  });
});

describe('library', () => {
  it('creates, orders and updates courses', async () => {
    const a = await createCourse(db, { name: '  Algorithms  ', code: 'CS201' });
    const b = await createCourse(db, { name: 'Security' });
    expect([a.name, a.code, a.order, b.order]).toEqual(['Algorithms', 'CS201', 0, 1]);
    await expect(createCourse(db, { name: '   ' })).rejects.toThrow(/needs a name/);
    await updateCourse(db, a.id, { examDate: '2026-12-20', examStyle: 'Answers must come strictly from the slides' });
    expect(await db.courses.get(a.id)).toMatchObject({ examDate: '2026-12-20', examStyle: expect.stringContaining('strictly') });
    await expect(updateCourse(db, 'nope', { name: 'x' })).rejects.toThrow(/not found/);
  });

  it('imports a lecture with slides, media and the original file', async () => {
    const course = await createCourse(db, { name: 'Computability' });
    const { bytes, deck } = await deckOf(lecture1);
    const row = await importLecture(db, { courseId: course.id, fileName: 'abcdefabcdefabcdefabcdefabcdefab_Lecture_1.pptx', bytes, deck });
    expect(row).toMatchObject({ title: 'Lecture 1', order: 0, revision: 1, slideCount: 3, fileHash: deck.fileHash });
    const slides = await loadSlides(db, row.id);
    expect(slides.map((s) => s.title)).toEqual(['Turing Machines', 'Decidability', 'Architecture']);
    expect(slides[0]!.notes).toBe('Draw the 7-tuple on the board');
    const media = await loadMedia(db, row.id);
    expect([...media.keys()]).toEqual(['ppt/media/image1.png']);
    expect(new Uint8Array(await media.get('ppt/media/image1.png')!.blob.arrayBuffer())).toEqual(PNG_1X1);
    const stored = await db.files.get(row.id);
    expect(new Uint8Array(await stored!.blob.arrayBuffer())).toEqual(bytes);
  });

  it('detects identical files and same-named files for re-import', async () => {
    const course = await createCourse(db, { name: 'C' });
    const { bytes, deck } = await deckOf(lecture1);
    expect(await findDuplicates(db, deck.fileHash)).toEqual([]);
    await importLecture(db, { courseId: course.id, fileName: 'L1.pptx', bytes, deck });
    const dups = await findDuplicates(db, deck.fileHash);
    expect(dups).toHaveLength(1);
    expect(dups[0]!.course?.name).toBe('C');
    expect((await findSameNamed(db, course.id, 'l1.PPTX'))?.fileName).toBe('L1.pptx');
    expect(await findSameNamed(db, course.id, 'other.pptx')).toBeUndefined();
  });

  it('re-imports a changed file in place (same id, position and title; new revision)', async () => {
    const course = await createCourse(db, { name: 'C' });
    const first = await deckOf(lecture1);
    const a = await importLecture(db, { courseId: course.id, fileName: 'L1.pptx', ...first });
    const b = await importLecture(db, { courseId: course.id, fileName: 'L2.pptx', ...(await deckOf({ slides: [simpleSlide('Other', ['x'])] })) });
    await db.lectures.update(a.id, { title: 'My custom title' });

    const second = await deckOf({ slides: [simpleSlide('Turing Machines v2', ['edited']), simpleSlide('Extra slide', ['new'])] });
    const next = await replaceLecture(db, a.id, { fileName: 'L1.pptx', ...second });
    expect(next).toMatchObject({ id: a.id, title: 'My custom title', order: 0, revision: 2, slideCount: 2, fileHash: second.deck.fileHash });
    expect((await loadSlides(db, a.id)).map((s) => s.title)).toEqual(['Turing Machines v2', 'Extra slide']);
    expect((await loadMedia(db, a.id)).size).toBe(0); // old image gone
    expect((await db.lectures.get(b.id))!.order).toBe(1); // untouched
    expect(await db.slides.where('lectureId').equals(b.id).count()).toBe(1);
  });

  it('cascades deletes and keeps other lectures intact', async () => {
    const course = await createCourse(db, { name: 'C' });
    const a = await importLecture(db, { courseId: course.id, fileName: 'a.pptx', ...(await deckOf(lecture1)) });
    const b = await importLecture(db, { courseId: course.id, fileName: 'b.pptx', ...(await deckOf({ slides: [simpleSlide('B', ['b'])] })) });
    await deleteLecture(db, a.id);
    expect(await db.slides.where('lectureId').equals(a.id).count()).toBe(0);
    expect(await db.media.where('lectureId').equals(a.id).count()).toBe(0);
    expect(await db.files.get(a.id)).toBeUndefined();
    expect(await db.slides.where('lectureId').equals(b.id).count()).toBe(1);
    await deleteCourse(db, course.id);
    expect(await db.lectures.count()).toBe(0);
    expect(await db.slides.count()).toBe(0);
    expect(await db.files.count()).toBe(0);
  });

  it('reorders lectures and rejects inconsistent orders', async () => {
    const course = await createCourse(db, { name: 'C' });
    const ids: string[] = [];
    for (const n of ['a', 'b', 'c']) ids.push((await importLecture(db, { courseId: course.id, fileName: `${n}.pptx`, ...(await deckOf({ slides: [simpleSlide(n, [n])] })) })).id);
    await reorderLectures(db, course.id, [ids[2]!, ids[0]!, ids[1]!]);
    expect((await listLectures(db, course.id)).map((l) => l.fileName)).toEqual(['c.pptx', 'a.pptx', 'b.pptx']);
    await expect(reorderLectures(db, course.id, [ids[0]!, ids[1]!])).rejects.toThrow(/does not match/);
    await expect(reorderLectures(db, course.id, [ids[0]!, ids[1]!, 'bogus'])).rejects.toThrow(/does not match/);
  });
});

describe('search', () => {
  async function seed() {
    const algo = await createCourse(db, { name: 'Algorithms' });
    const sec = await createCourse(db, { name: 'Security' });
    const l1 = await importLecture(db, { courseId: algo.id, fileName: 'l1.pptx', ...(await deckOf(lecture1)) });
    const l2 = await importLecture(db, {
      courseId: sec.id,
      fileName: 'l2.pptx',
      ...(await deckOf({ slides: [simpleSlide('Public key cryptography', ['RSA relies on factoring', 'Diffie-Hellman exchanges keys'], 'Mention the halting analogy only briefly')] })),
    });
    const index = new SearchIndex();
    await index.rebuild(db);
    return { algo, sec, l1, l2, index };
  }

  it('finds slides by title, body and notes with prefix matching', async () => {
    const { index, l1 } = await seed();
    expect(index.size).toBe(4);
    const hits = index.search('turing');
    expect(hits[0]).toMatchObject({ lectureId: l1.id, slide: 1, title: 'Turing Machines', courseName: 'Algorithms' });
    expect(index.search('decid')[0]).toMatchObject({ slide: 2 }); // prefix
    expect(index.search('7-tuple board')[0]).toMatchObject({ slide: 1, inNotes: true });
    expect(index.search('RSA factoring')[0]!.title).toBe('Public key cryptography');
    expect(index.search('layered architecture')[0]).toMatchObject({ slide: 3 }); // picture alt text
    expect(index.search('')).toEqual([]);
    expect(index.search('zzzzqqq')).toEqual([]);
  });

  it('filters by course and lecture', async () => {
    const { index, algo, sec, l2 } = await seed();
    const all = index.search('halting');
    expect(all.map((h) => h.courseName).sort()).toEqual(['Algorithms', 'Security']);
    expect(index.search('halting', { courseId: algo.id }).map((h) => h.courseName)).toEqual(['Algorithms']);
    expect(index.search('halting', { courseId: sec.id }).map((h) => h.courseName)).toEqual(['Security']);
    expect(index.search('halting', { lectureId: l2.id })).toHaveLength(1);
  });

  it('highlights matches in structured snippets (no HTML)', async () => {
    const { index } = await seed();
    const hit = index.search('infinite tape')[0]!;
    const hits = hit.snippet.filter((p) => p.hit).map((p) => p.text.toLowerCase());
    expect(hits).toEqual(expect.arrayContaining(['tape', 'infinite']));
    expect(hit.snippet.map((p) => p.text).join('')).not.toMatch(/<mark>|<b>/);
  });

  it('updates incrementally when a lecture is removed or replaced', async () => {
    const { index, l1 } = await seed();
    index.removeLecture(l1.id);
    expect(index.search('turing')).toEqual([]);
    expect(index.size).toBe(1);
  });

  it('makeSnippet windows around the first match and escapes nothing (plain text)', () => {
    const long = `${'lorem ipsum '.repeat(40)}the halting problem is undecidable ${'dolor sit '.repeat(40)}`;
    const parts = makeSnippet(long, ['halting']);
    const joined = parts.map((p) => p.text).join('');
    expect(joined.length).toBeLessThan(260);
    expect(parts.some((p) => p.hit && p.text.toLowerCase() === 'halting')).toBe(true);
    expect(makeSnippet('<script>alert(1)</script> halting', ['halting']).map((p) => p.text).join('')).toContain('<script>'); // returned as text; React escapes it
  });
});

describe('fixtures used by library tests are valid', () => {
  it('bodySp/para helpers produce parseable slides', async () => {
    const { deck } = await deckOf({ slides: [{ shapes: titleSp(2, 'T') + bodySp(3, [para('x')]) }] });
    expect(deck.report.failedSlides).toBe(0);
  });
});
