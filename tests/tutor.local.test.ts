import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { exportBackup, readBackup, applyBackup } from '../src/core/backup/backup';
import { StudyDB } from '../src/core/db/db';
import { createCourse, deleteCourse, importLecture, loadSlides } from '../src/core/db/library';
import { parsePptx } from '../src/core/pptx';
import { appendMessage, createSession, deleteSession, renameSession, toHistory } from '../src/core/tutor/chat';
import { buildContext, citesToSources, slideContextText, type ContextSlide } from '../src/core/tutor/context';
import { LIMITS } from '../src/core/tutor/contract';
import type { TutorMessageRow } from '../src/core/study/types';
import { buildPptx, simpleSlide } from './fixtures/pptx-builder';

let db: StudyDB;
let n = 0;
beforeEach(() => {
  db = new StudyDB(`tutor-${Date.now()}-${n++}`);
});

const slide = (i: number, text = 'A tape that is infinite.'): ContextSlide => ({ lectureId: 'L', lectureTitle: 'Lecture 4', revision: 2, slide: i, title: `Slide ${i}`, text });

describe('context: which slide text leaves the device', () => {
  it('labels slides S1, S2, … and remembers where each came from', () => {
    const c = buildContext([slide(3), slide(5, 'Another slide.')]);
    expect(c.excerpts.map((e) => [e.ref, e.slide, e.title])).toEqual([['S1', 3, 'Slide 3'], ['S2', 5, 'Slide 5']]);
    expect(c.refs.get('S2')).toEqual({ lectureId: 'L', slide: 5, rev: 2 });
    expect(c.chars).toBe('A tape that is infinite.'.length + 'Another slide.'.length);
    expect(c.approxTokens).toBe(Math.ceil(c.chars / 4));
    expect(c.dropped + c.shortened).toBe(0);
  });

  it('keeps within the size limits and says what was left out or shortened', () => {
    const big = buildContext([slide(1, 'x'.repeat(LIMITS.excerptText + 500))]);
    expect(big.shortened).toBe(1);
    expect(big.excerpts[0]!.text.length).toBeLessThanOrEqual(LIMITS.excerptText);
    expect(big.excerpts[0]!.text.endsWith('[…shortened]')).toBe(true);

    const many = buildContext(Array.from({ length: LIMITS.excerpts + 5 }, (_, i) => slide(i + 1)));
    expect(many.excerpts).toHaveLength(LIMITS.excerpts);
    expect(many.dropped).toBe(5);

    const heavy = buildContext(Array.from({ length: 10 }, (_, i) => slide(i + 1, 'y'.repeat(LIMITS.excerptText))));
    expect(heavy.chars).toBeLessThanOrEqual(LIMITS.excerptsTotal);
    expect(heavy.dropped).toBeGreaterThan(0);
  });

  it('gives an empty slide a plain note instead of nothing, and sends no pictures', () => {
    expect(buildContext([slide(1, '   ')]).excerpts[0]!.text).toBe('(this slide has no readable text)');
  });

  it('reads real slide text from a parsed deck, without the heading line', async () => {
    const deck = await parsePptx(buildPptx({ slides: [simpleSlide('Turing Machines', ['A tape that is infinite', 'A finite control'], 'Stress the tape.')] }));
    const text = slideContextText(deck.slides[0]!, deck.meta.slideHeight);
    expect(text).toContain('A tape that is infinite');
    expect(text).toContain('Speaker notes:');
    expect(text).not.toMatch(/^### Slide/);
  });

  it('labels notes as notes: no slide number, no source link', () => {
    const c = buildContext([slide(3), { kind: 'note', lectureId: 'note-1', lectureTitle: 'My notes', revision: 0, slide: 0, title: 'Tape trick', text: 'A strip of paper.' }]);
    expect(c.excerpts[1]).toMatchObject({ ref: 'S2', kind: 'note', slide: 0, title: 'Tape trick' });
    expect([...c.noteRefs]).toEqual(['S2']);
    expect(c.refs.has('S2')).toBe(false); // a note cannot be cited as a lecture source
    expect(citesToSources(['S1', 'S2'], c.refs)).toEqual([{ lectureId: 'L', slide: 3, rev: 2 }]);
  });

  it('turns only the citations that were really sent into stored sources', () => {
    const c = buildContext([slide(3), slide(5)]);
    expect(citesToSources(['S2', 'S9', 'S1'], c.refs)).toEqual([{ lectureId: 'L', slide: 5, rev: 2 }, { lectureId: 'L', slide: 3, rev: 2 }]);
  });
});

describe('context: the gaps of the slides that are really sent', () => {
  it('carries the gaps of the slides that were kept, once each, and not those of slides that were left out', () => {
    const withGaps = (i: number, gaps: string[]): ContextSlide => ({ ...slide(i), gaps });
    const c = buildContext([withGaps(1, ['Slide 1 has only a heading.']), withGaps(2, ['Slide 1 has only a heading.', 'Slide 2 refers to the next slide.']), slide(3)]);
    expect(c.gaps).toEqual(['Slide 1 has only a heading.', 'Slide 2 refers to the next slide.']);
    // slides over the size limit are dropped, and so are their gaps
    const heavy = buildContext(Array.from({ length: 9 }, (_, i) => ({ ...slide(i + 1, 'y'.repeat(LIMITS.excerptText)), gaps: [`gap ${i + 1}`] })));
    expect(heavy.dropped).toBeGreaterThan(0);
    expect(heavy.gaps.every((g, i) => g === `gap ${i + 1}`)).toBe(true);
    expect(heavy.gaps.length).toBe(heavy.excerpts.length);
    expect(buildContext([slide(1)]).gaps).toEqual([]);
    // at most twelve, however many slides
    expect(buildContext(Array.from({ length: 20 }, (_, i) => ({ ...slide(i + 1), gaps: [`gap ${i + 1}`] }))).gaps).toHaveLength(12);
  });
});

describe('chats are stored on this device', () => {
  it('creates sessions, appends messages in order, renames and deletes with the messages', async () => {
    const course = await createCourse(db, { name: 'Computability' });
    const s = await createSession(db, { courseId: course.id, title: '  What is a tape?  ', mode: 'explain' });
    expect(s.title).toBe('What is a tape?');
    await appendMessage(db, { sessionId: s.id, courseId: course.id, role: 'user', text: 'What is a tape?', sent: { slides: 1, chars: 20, mode: 'explain' } }, 1000);
    await appendMessage(db, { sessionId: s.id, courseId: course.id, role: 'assistant', text: 'An infinite strip [S1].', basis: 'lecture', sources: [{ lectureId: 'L', slide: 2 }], followups: ['And the head?'] }, 2000);
    const msgs = await db.tutorMessages.where('sessionId').equals(s.id).sortBy('createdAt');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect((await db.tutorSessions.get(s.id))!.updatedAt).toBe(2000);
    await renameSession(db, s.id, 'Tape questions');
    await renameSession(db, s.id, '   '); // an empty name is ignored
    expect((await db.tutorSessions.get(s.id))!.title).toBe('Tape questions');
    await deleteSession(db, s.id);
    expect(await db.tutorSessions.count()).toBe(0);
    expect(await db.tutorMessages.count()).toBe(0);
  });

  it('sends back only recent, successful turns, within the history limits', () => {
    const m = (role: 'user' | 'assistant', text: string, extra: Partial<TutorMessageRow> = {}): TutorMessageRow => ({ id: crypto.randomUUID(), sessionId: 's', courseId: 'c', role, text, createdAt: 0, ...extra });
    const many = Array.from({ length: 30 }, (_, i) => m(i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`));
    const h = toHistory(many);
    expect(h).toHaveLength(LIMITS.historyMessages);
    expect(h.at(-1)!.text).toBe('turn 29');
    expect(toHistory([m('user', 'q'), m('assistant', '', { error: 'No answer' }), m('assistant', 'failed text', { error: 'boom' })])).toEqual([{ role: 'user', text: 'q' }]);
    const long = [m('user', 'a'.repeat(LIMITS.historyMessage)), m('assistant', 'b'.repeat(LIMITS.historyMessage)), m('user', 'c'.repeat(LIMITS.historyMessage)), m('assistant', 'd'.repeat(LIMITS.historyMessage)), m('user', 'e'.repeat(LIMITS.historyMessage))];
    const total = toHistory(long).reduce((x, t) => x + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(LIMITS.historyTotal);
  });

  it('deleting a course removes its chats; chats survive a backup and restore', async () => {
    const course = await createCourse(db, { name: 'Computability' });
    const keep = await createCourse(db, { name: 'Security' });
    const a = await createSession(db, { courseId: course.id, title: 'A', mode: 'quiz' });
    const b = await createSession(db, { courseId: keep.id, title: 'B', mode: 'explain' });
    await appendMessage(db, { sessionId: a.id, courseId: course.id, role: 'user', text: 'qa' });
    await appendMessage(db, { sessionId: b.id, courseId: keep.id, role: 'user', text: 'qb', sent: { slides: 2, chars: 99, mode: 'explain' } });

    // a lecture so the backup has something real to carry too
    const deck = await parsePptx(buildPptx({ slides: [simpleSlide('Intro', ['Hello'])] }));
    await importLecture(db, { courseId: keep.id, fileName: 'x.pptx', bytes: new Uint8Array([1]), deck });
    expect((await loadSlides(db, (await db.lectures.toArray())[0]!.id)).length).toBeGreaterThan(0);

    const blob = await exportBackup(db, undefined, 'test');
    const restoreDb = new StudyDB(`tutor-restore-${Date.now()}-${n++}`);
    const parsed = await readBackup(new Uint8Array(await blob.arrayBuffer()));
    await applyBackup(restoreDb, parsed, 'replace');
    expect((await restoreDb.tutorSessions.toArray()).map((s) => s.title).sort()).toEqual(['A', 'B']);
    expect((await restoreDb.tutorMessages.where('courseId').equals(keep.id).toArray())[0]).toMatchObject({ text: 'qb', sent: { slides: 2, chars: 99, mode: 'explain' } });

    await deleteCourse(db, course.id);
    expect((await db.tutorSessions.toArray()).map((s) => s.title)).toEqual(['B']);
    expect(await db.tutorMessages.where('courseId').equals(course.id).count()).toBe(0);
    expect(await db.tutorMessages.where('courseId').equals(keep.id).count()).toBe(1);
  });
});
