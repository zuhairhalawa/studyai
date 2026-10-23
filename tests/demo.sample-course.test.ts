import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { StudyDB } from '../src/core/db/db';
import { deleteCourse, listLectures, loadSlides } from '../src/core/db/library';
import { parsePptx } from '../src/core/pptx';
import { SearchIndex } from '../src/core/search/search';
import { buildQueue } from '../src/core/study/queue';
import { planPack, type LectureContext } from '../src/core/study/pack';
import { slideVerificationText } from '../src/core/study/slide-text';
import { loadSampleCourse } from '../src/demo/sample-course';
import { SAMPLE_COURSE_SETTING } from '../src/demo/setting';
import { SAMPLE_COURSE, SAMPLE_PACK, sampleLectures } from '../src/demo/sample-content';

let db: StudyDB;
let n = 0;
beforeEach(() => {
  db = new StudyDB(`demo-${Date.now()}-${n++}`);
});

async function contexts(): Promise<LectureContext[]> {
  const out: LectureContext[] = [];
  for (const { fileName, bytes } of sampleLectures()) {
    const deck = await parsePptx(bytes);
    out.push({
      id: fileName,
      title: fileName.replace(/\.pptx$/, ''),
      fileHash: deck.fileHash,
      revision: 1,
      slideCount: deck.slides.length,
      slideText: (i) => (deck.slides[i - 1] ? slideVerificationText(deck.slides[i - 1]!) : undefined),
    });
  }
  return out;
}

describe('the sample lectures', () => {
  it('are read by the real engine without anything the student would have to check', async () => {
    for (const { fileName, bytes } of sampleLectures()) {
      const deck = await parsePptx(bytes);
      expect(deck.slides.length, fileName).toBe(7);
      expect(deck.report.slidesRequiringAttention, `${fileName}: a demo lecture should open without warnings`).toEqual([]);
    }
  });

  it('use every kind of slide the demo is meant to show: a table, a formula, code and speaker notes', async () => {
    const decks = await Promise.all(sampleLectures().map((l) => parsePptx(l.bytes)));
    const slides = decks.flatMap((d) => d.slides);
    expect(slides.some((s) => s.elements.some((e) => e.kind === 'table'))).toBe(true);
    expect(slides.some((s) => s.elements.some((e) => e.kind === 'shape' && e.paragraphs.some((p) => p.inlines.some((i) => i.kind === 'math'))))).toBe(true);
    expect(slides.some((s) => /PLOT-LEG/.test(s.text))).toBe(true);
    expect(slides.some((s) => s.notes.length > 0)).toBe(true);
  });
});

describe('the sample study material', () => {
  it('passes the pack check with every cited quote found on its slide and no finding at all', async () => {
    const plan = planPack(SAMPLE_PACK, 'course', await contexts());
    expect(plan.fatal).toBeUndefined();
    expect(plan.issues.map((i) => `${i.where}: ${i.message}`)).toEqual([]);
    expect(plan.stats.rejected).toBe(0);
    expect(plan.stats.sources).toBeGreaterThan(20);
    expect(plan.stats.verified).toBe(plan.stats.sources);
    expect(plan.lectureMap.every((l) => !!l.localId)).toBe(true);
  });

  it('is a varied practice exam and a useful set of cards, not one kind of item', () => {
    expect(new Set(SAMPLE_PACK.questions.map((q) => q.type))).toEqual(new Set(['mcq', 'truefalse', 'short', 'calculation', 'scenario', 'compare']));
    expect(new Set(SAMPLE_PACK.cards.map((c) => c.type)).size).toBeGreaterThanOrEqual(5);
    expect(SAMPLE_PACK.cards.length).toBeGreaterThanOrEqual(10);
  });
});

describe('only invented content', () => {
  it('has no web address, e-mail address or real-looking name in the lectures or the study material', async () => {
    const parts: string[] = [JSON.stringify(SAMPLE_PACK), JSON.stringify(SAMPLE_COURSE)];
    for (const { bytes } of sampleLectures()) {
      const deck = await parsePptx(bytes);
      parts.push(deck.meta.title ?? '', deck.meta.author ?? '', ...deck.slides.map((s) => `${s.text}\n${s.notes}`));
      expect(deck.meta.author).toBe('Invented Author');
    }
    const text = parts.join('\n');
    expect(text).not.toMatch(/https?:|www\.|@[a-z]|\.com\b|\.edu\b|\.org\b/i);
    expect(text).not.toMatch(/universit|college|institute|professor|\bProf\b|\bDr\b/i);
    expect(SAMPLE_COURSE.name).toMatch(/invented/i);
  });
});

describe('loadSampleCourse', () => {
  it('stores the lectures, the cards, the exam questions and the notes, all ready to study', async () => {
    const { courseId, created } = await loadSampleCourse(db);
    expect(created).toBe(true);
    const course = await db.courses.get(courseId);
    expect(course?.name).toBe(SAMPLE_COURSE.name);

    const lectures = await listLectures(db, courseId);
    expect(lectures.map((l) => l.title)).toEqual(['Lecture 1 - Reading a sky chart', 'Lecture 2 - Dead reckoning aloft']);
    expect((await loadSlides(db, lectures[0]!.id)).length).toBe(7);

    const cards = await db.cards.where('courseId').equals(courseId).toArray();
    const questions = await db.questions.where('courseId').equals(courseId).toArray();
    expect(cards).toHaveLength(SAMPLE_PACK.cards.length);
    expect(questions).toHaveLength(SAMPLE_PACK.questions.length);
    expect(cards.every((c) => c.status === 'approved' && c.sources.every((s) => s.verified === true))).toBe(true);
    expect(questions.every((q) => q.status === 'approved' && q.sources.every((s) => s.verified === true))).toBe(true);
    expect(buildQueue(cards, { now: Date.now(), newPerDay: 20, newToday: 0 }).length).toBe(cards.length); // the visitor can start a review at once
    expect(await db.notes.where('courseId').equals(courseId).count()).toBe(SAMPLE_PACK.notes.length);
    expect((await db.settings.get(SAMPLE_COURSE_SETTING))?.value).toBe(courseId);
  });

  it('can be searched', async () => {
    const { courseId } = await loadSampleCourse(db);
    const index = new SearchIndex();
    for (const l of await listLectures(db, courseId)) index.addLecture(l, SAMPLE_COURSE.name, await loadSlides(db, l.id));
    expect(index.search('head wind').some((h) => h.lectureTitle.includes('Dead reckoning'))).toBe(true);
    expect(index.search('mooring').length).toBeGreaterThan(0);
  });

  it('opens the same course when asked twice, and makes a new one only after it was deleted', async () => {
    const first = await loadSampleCourse(db);
    const again = await loadSampleCourse(db);
    expect(again).toEqual({ courseId: first.courseId, created: false });
    expect(await db.courses.count()).toBe(1);

    await deleteCourse(db, first.courseId);
    const third = await loadSampleCourse(db);
    expect(third.created).toBe(true);
    expect(third.courseId).not.toBe(first.courseId);
    expect(await db.courses.count()).toBe(1);
  });

  it('leaves nothing behind when it fails half way', async () => {
    const real = db.lectures.add.bind(db.lectures);
    let calls = 0;
    db.lectures.add = ((...args: Parameters<typeof real>) => (++calls === 2 ? Promise.reject(new Error('disk full')) : real(...args))) as typeof real;
    await expect(loadSampleCourse(db)).rejects.toThrow('disk full');
    expect(await db.courses.count()).toBe(0);
    expect(await db.lectures.count()).toBe(0);
    expect(await db.cards.count()).toBe(0);
    expect(await db.settings.get(SAMPLE_COURSE_SETTING)).toBeUndefined();
  });
});
