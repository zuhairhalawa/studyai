import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { StudyDB } from '../src/core/db/db';
import { createCourse, importLecture, loadSlides } from '../src/core/db/library';
import { parsePptx } from '../src/core/pptx';
import { lectureNotesFromSlides, markdownToHtml, noteToHtmlDocument, noteToMarkdown, notesFromCards } from '../src/core/study/notes';
import { createCard, createNote, deleteNote, renameNote, saveNoteBlocks } from '../src/core/study/store';
import { bodySp, buildPptx, para, simpleSlide, titleSp, type DeckSpec } from './fixtures/pptx-builder';

let db: StudyDB;
let n = 0;
beforeEach(() => {
  db = new StudyDB(`nt-${Date.now()}-${n++}`);
});

const SPEC: DeckSpec = {
  slides: [simpleSlide('Intro', ['First point', 'Second point'], 'say hello'), { hidden: true, shapes: titleSp(2, 'Hidden one') + bodySp(3, [para('secret')]) }, simpleSlide('Wrap up', ['Done'])],
};

async function setup() {
  const course = await createCourse(db, { name: 'C' });
  const bytes = buildPptx(SPEC);
  const lecture = await importLecture(db, { courseId: course.id, fileName: 'Lecture 1.pptx', bytes, deck: await parsePptx(bytes) });
  return { course, lecture, slides: await loadSlides(db, lecture.id) };
}

describe('lecture notes from slides', () => {
  it('makes one auto block per visible slide with its source, skipping hidden slides', async () => {
    const { lecture, slides } = await setup();
    const blocks = lectureNotesFromSlides(lecture, slides);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toContain('## Slide 1: Intro');
    expect(blocks[0]!.text).toContain('- First point');
    expect(blocks[0]!.text).toContain('**Speaker notes:** say hello');
    expect(blocks[0]).toMatchObject({ origin: 'auto', basis: 'lecture' });
    expect(blocks[0]!.sources[0]).toMatchObject({ lectureId: lecture.id, slide: 1, verified: true, rev: 1 });
    expect(blocks[1]!.sources[0]!.slide).toBe(3); // slide numbers keep their original positions
    expect(blocks.some((b) => b.text.includes('secret'))).toBe(false);
  });
});

describe('notes store: your edits are never confused with generated text', () => {
  it('edited blocks become yours; untouched generated blocks keep their origin', async () => {
    const { course, lecture, slides } = await setup();
    const note = await createNote(db, { courseId: course.id, lectureId: lecture.id, title: ' Lecture 1 notes ', kind: 'lecture-notes', blocks: lectureNotesFromSlides(lecture, slides) }, 1000);
    expect(note.title).toBe('Lecture 1 notes');
    const [a, b] = note.blocks;
    await saveNoteBlocks(db, note.id, [{ ...a!, text: a!.text + '\n\nMy own remark.' }, b!], 2000);
    const saved = (await db.notes.get(note.id))!;
    expect(saved.blocks[0]).toMatchObject({ origin: 'user', updatedAt: 2000 });
    expect(saved.blocks[0]!.text).toContain('My own remark.');
    expect(saved.blocks[0]!.sources).toEqual(a!.sources); // sources stay attached
    expect(saved.blocks[1]).toMatchObject({ origin: 'auto', updatedAt: 1000 }); // untouched
  });

  it('adds new blocks as yours, deletes, renames and rejects empty titles', async () => {
    const { course } = await setup();
    const note = await createNote(db, { courseId: course.id, title: 'Mine' });
    await saveNoteBlocks(db, note.id, [{ id: 'blk1', text: 'hello', origin: 'user', basis: 'outside', sources: [], updatedAt: 0 }], 5);
    expect((await db.notes.get(note.id))!.blocks[0]).toMatchObject({ id: 'blk1', origin: 'user', text: 'hello' });
    await renameNote(db, note.id, 'Renamed');
    expect((await db.notes.get(note.id))!.title).toBe('Renamed');
    await expect(renameNote(db, note.id, '  ')).rejects.toThrow(/needs a title/);
    await expect(createNote(db, { courseId: course.id, title: '' })).rejects.toThrow(/needs a title/);
    await deleteNote(db, note.id);
    expect(await db.notes.count()).toBe(0);
  });
});

describe('revision sheets from cards', () => {
  it('collects only approved cards of the right kinds and keeps their provenance', async () => {
    const { course } = await setup();
    const mk = (over: Parameters<typeof createCard>[1]) => createCard(db, over, Date.now());
    await mk({ courseId: course.id, type: 'definition', front: 'What is **P**?', back: 'Problems solvable in polynomial time', basis: 'lecture', sources: [{ lectureId: 'x', slide: 3 }] });
    await mk({ courseId: course.id, type: 'formula', front: 'Area of a circle', back: '$\\pi r^2$', basis: 'outside' });
    await mk({ courseId: course.id, type: 'definition', front: 'What is NP?', back: 'hidden', status: 'pending' });
    await mk({ courseId: course.id, type: 'qa', front: 'q', back: 'a' });
    const cards = await db.cards.toArray();
    const defs = notesFromCards(cards, 'definitions');
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ text: '**P**: Problems solvable in polynomial time', basis: 'lecture' });
    expect(notesFromCards(cards, 'formulas')[0]!.text).toContain('Area of a circle');
    expect(notesFromCards(cards, 'revision-sheet')).toHaveLength(2);
    expect(notesFromCards(cards, 'mistakes')).toEqual([]);
  });
});

describe('exports', () => {
  it('Markdown keeps origin, basis and sources next to every block', async () => {
    const { course, lecture, slides } = await setup();
    const note = await createNote(db, { courseId: course.id, title: 'Notes', blocks: lectureNotesFromSlides(lecture, slides) });
    const md = noteToMarkdown(note, (id) => (id === lecture.id ? 'Lecture 1' : undefined));
    expect(md.startsWith('# Notes\n')).toBe(true);
    expect(md).toContain('<sub>Auto-extracted from slides · On the slides · Lecture 1, slide 1</sub>');
  });

  it('HTML is self-contained, converts maths to MathML and never passes raw HTML through', async () => {
    const hostile = ['Euler: $e^{i\\pi}+1=0$', '| a | b |\n|---|---|\n| 1 | 2 |', '<script>alert(1)</script>', '[x](javascript:alert(1))', '[ok](https://example.com)', '![tracker](https://evil.example/p.png)'];
    const html = await markdownToHtml(hostile.join('\n\n'));
    expect(html).toContain('<math');
    expect(html).toContain('<table>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain('href="https://example.com"'); // legitimate links survive
    expect(html).not.toMatch(/<img|evil.example/i); // no remote loads when the file is opened
    expect(html).toContain('[image: tracker]');
    const { course } = await setup();
    const note = await createNote(db, { courseId: course.id, title: 'A <b>title</b> & more', blocks: [{ text: 'hi', origin: 'user', basis: 'outside', sources: [] }] });
    const doc = await noteToHtmlDocument(note, () => undefined);
    expect(doc).toContain('<title>A &lt;b&gt;title&lt;/b&gt; &amp; more</title>');
    expect(doc).not.toMatch(/<link|<script|src=|https?:\/\//i); // fully offline
  });
});
