import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { StudyDB, type CourseRow, type LectureRow } from '../src/core/db/db';
import { createCourse } from '../src/core/db/library';
import { deriveSessions, lectureProgress, recommendNext, recordSlideView, strongTopics, topicProgress, viewedKey, type RecommendInput } from '../src/core/study/progress';
import { newSchedulerState } from '../src/core/study/fsrs';
import type { AttemptRow, CardRow, ExamRow, QuestionRow } from '../src/core/study/types';

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = new Date(2026, 9, 16, 15, 0, 0).getTime(); // local time, so day arithmetic matches the code under test

let db: StudyDB;
let n = 0;
beforeEach(() => {
  db = new StudyDB(`pg-${Date.now()}-${n++}`);
});

describe('recording what you studied', () => {
  it('stores each viewed slide once (sorted) and merges nearby views into one activity row', async () => {
    const course = await createCourse(db, { name: 'C' });
    await recordSlideView(db, course.id, 'L1', 3, NOW);
    await recordSlideView(db, course.id, 'L1', 1, NOW + 2 * MIN);
    await recordSlideView(db, course.id, 'L1', 3, NOW + 4 * MIN); // revisit: not a new slide
    expect((await db.settings.get(viewedKey('L1')))!.value).toEqual([1, 3]);
    const rows = await db.activity.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'slides', lectureId: 'L1', count: 3, at: NOW + 4 * MIN });
    await recordSlideView(db, course.id, 'L1', 5, NOW + 30 * MIN); // a later sitting
    await recordSlideView(db, course.id, 'L2', 1, NOW + 30 * MIN); // another lecture
    expect(await db.activity.count()).toBe(3);
  });
});

describe('progress', () => {
  const lecture = { slideCount: 10 };
  it('computes lecture coverage and ignores out-of-range slide numbers', () => {
    expect(lectureProgress(lecture, undefined)).toEqual({ viewed: 0, total: 10, percent: 0 });
    expect(lectureProgress(lecture, [1, 2, 2, 5, 99, 0])).toEqual({ viewed: 3, total: 10, percent: 30 });
    expect(lectureProgress({ slideCount: 0 }, [1])).toEqual({ viewed: 0, total: 0, percent: 0 });
  });

  it('marks a topic done only when every one of its slides was viewed', () => {
    const l = { report: { topics: [{ id: 't1', title: 'A', startSlide: 1, endSlide: 3, source: 'title' as const, keyTerms: [] }, { id: 't2', title: 'B', startSlide: 4, endSlide: 4, source: 'title' as const, keyTerms: [] }] } } as unknown as LectureRow;
    expect(topicProgress(l, [1, 2, 4]).map((t) => [t.id, t.viewed, t.total, t.done])).toEqual([['t1', 2, 3, false], ['t2', 1, 1, true]]);
  });
});

describe('derived study sessions', () => {
  it('groups events of the same course within 30 minutes and keeps courses apart', () => {
    const review = (id: string, at: number, courseId = 'c1') => ({ id, cardId: 'x', courseId, at, rating: 3 as const, stateBefore: 0 as const, durationMs: 1 });
    const sessions = deriveSessions({
      reviews: [review('a', NOW), review('b', NOW + 5 * MIN), review('c', NOW + 25 * MIN), review('d', NOW + 2 * DAY), review('e', NOW, 'c2')],
      activity: [{ id: 1, at: NOW + 10 * MIN, kind: 'slides', courseId: 'c1', count: 7 }, { id: 2, at: NOW, kind: 'notes', courseId: 'c1', count: 1 }],
      attempts: [{ id: 'a1', examId: 'e', courseId: 'c1', startedAt: NOW + 20 * MIN, submittedAt: NOW + 50 * MIN, elapsedMs: 0, status: 'submitted', answers: {}, grades: {}, flagged: [] }],
    });
    expect(sessions).toHaveLength(3); // course 1 (first sitting), course 1 two days later, course 2
    const first = sessions.find((s) => s.courseId === 'c1' && s.start === NOW)!;
    expect(first).toMatchObject({ reviews: 3, slides: 7, exams: 1, end: NOW + 50 * MIN });
    expect(sessions[0]!.start).toBe(NOW + 2 * DAY); // newest first
    expect(sessions.find((s) => s.courseId === 'c2')).toMatchObject({ reviews: 1 });
  });
});

describe('next best step', () => {
  const course = (over: Partial<CourseRow> = {}): CourseRow => ({ id: 'c1', name: 'Algorithms', color: 0, createdAt: 0, updatedAt: 0, archived: false, order: 0, ...over });
  const lecture = (over: Partial<LectureRow> = {}) => ({ id: 'l1', courseId: 'c1', title: 'Sorting', order: 0, slideCount: 10, report: { topics: [] }, ...over }) as unknown as LectureRow;
  const card = (over: Partial<CardRow> = {}): CardRow => ({ id: `k${Math.random()}`, courseId: 'c1', type: 'qa', front: 'f', back: 'b', tags: [], basis: 'derived', sources: [], origin: 'user', status: 'approved', createdAt: 0, updatedAt: 0, fsrs: newSchedulerState(0), ...over });
  const dueCard = () => card({ fsrs: { ...newSchedulerState(0), state: 2, due: NOW - DAY, reps: 3, stability: 4, difficulty: 5, lastReview: NOW - 5 * DAY } });
  const question = (over: Partial<QuestionRow> = {}): QuestionRow => ({ id: `q${Math.random()}`, courseId: 'c1', type: 'short', prompt: 'p', marks: 2, difficulty: 2, lectureIds: [], rubric: [], basis: 'derived', sources: [], origin: 'user', status: 'approved', createdAt: 0, updatedAt: 0, ...over });
  const base = (over: Partial<RecommendInput> = {}): RecommendInput => ({ now: NOW, courses: [course()], lectures: [lecture()], cards: [], questions: [], exams: [], attempts: [], viewed: new Map(), ...over });
  const attempt = (over: Partial<AttemptRow> = {}): AttemptRow => ({ id: 'a1', examId: 'e1', courseId: 'c1', startedAt: NOW - DAY, elapsedMs: 0, status: 'submitted', submittedAt: NOW - DAY, answers: {}, grades: {}, flagged: [], ...over });
  const exam = (): ExamRow => ({ id: 'e1', courseId: 'c1', createdAt: 0, questionIds: [], config: { title: 'Midterm prep', lectureIds: [], topics: [], count: 1, types: [], difficulty: 'mixed', hints: true, reveal: 'after', layout: 'one', conditions: false } });
  const isoIn = (days: number) => {
    const d = new Date(NOW + days * DAY);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('nothing at all → create a course, then add lectures', () => {
    expect(recommendNext(base({ courses: [], lectures: [] }))).toMatchObject({ kind: 'add-material', href: '/' });
    expect(recommendNext(base({ lectures: [] }))).toMatchObject({ kind: 'add-material', courseId: 'c1', href: '/course/c1' });
  });

  it('priorities, highest first, each with a reason', () => {
    // 1. unfinished exam beats everything
    const inProgress = attempt({ status: 'in-progress', submittedAt: undefined });
    expect(recommendNext(base({ attempts: [inProgress], exams: [exam()], cards: [dueCard()] }))).toMatchObject({ kind: 'resume-exam', title: 'Finish “Midterm prep”', href: '/exam/a1' });
    // 2. exam within 14 days and no recent practice
    const near = base({ courses: [course({ examDate: isoIn(5) })], questions: [question()], cards: [dueCard()] });
    expect(recommendNext(near)).toMatchObject({ kind: 'practice-exam', reason: expect.stringContaining('in 5 days') });
    //    ...but not if you practised yesterday: then due cards win
    expect(recommendNext({ ...near, attempts: [attempt()] }).kind).toBe('review-cards');
    //    ...nor if there is no question bank to practise with
    expect(recommendNext(base({ courses: [course({ examDate: isoIn(5) })], cards: [dueCard()] })).kind).toBe('review-cards');
    // exam far away or past: ignored
    expect(recommendNext(base({ courses: [course({ examDate: isoIn(40) })], questions: [question()] })).kind).not.toBe('practice-exam');
    expect(recommendNext(base({ courses: [course({ examDate: isoIn(-3) })], questions: [question()] })).kind).not.toBe('practice-exam');
    // 3. due cards
    expect(recommendNext(base({ cards: [dueCard(), dueCard()] }))).toMatchObject({ kind: 'review-cards', title: 'Review 2 due cards in Algorithms', href: '/course/c1/review' });
    // new cards that were never studied are not "due"
    expect(recommendNext(base({ cards: [card()] })).kind).toBe('read-lecture');
    // 4. imported items waiting
    expect(recommendNext(base({ cards: [card({ status: 'pending' })], questions: [question({ status: 'pending' })] }))).toMatchObject({ kind: 'approve-items', title: 'Check 2 imported items in Algorithms' });
  });

  it('weak topic, then the least-read lecture, then all clear', () => {
    const q1 = question({ id: 'qa', topic: 'Reductions', marks: 4 });
    const q2 = question({ id: 'qb', topic: 'Reductions', marks: 4 });
    const weak = attempt({ grades: { qa: { marks: 1, max: 4, items: [], by: 'self', gradedAt: 0 }, qb: { marks: 0, max: 4, items: [], by: 'self', gradedAt: 0 } } });
    expect(recommendNext(base({ questions: [q1, q2], attempts: [weak] }))).toMatchObject({ kind: 'revise-topic', title: 'Revise “Reductions” in Algorithms', reason: expect.stringContaining('13%') });
    const lectures = [lecture({ id: 'l1', title: 'Read most', order: 0 }), lecture({ id: 'l2', title: 'Read least', order: 1 })];
    const r = recommendNext(base({ lectures, viewed: new Map([['l1', [1, 2, 3, 4, 5, 6]], ['l2', [1]]]) }));
    expect(r).toMatchObject({ kind: 'read-lecture', title: 'Study “Read least”', reason: 'You have viewed 1 of 10 slides.', href: '/lecture/l2?slide=2' });
    expect(recommendNext(base({ viewed: new Map([['l1', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]]) })).kind).toBe('all-clear');
  });

  it('a lecture you have open counts as opened and resumes where you left off, even before any slide counts as viewed', () => {
    const lectures = [lecture({ id: 'l1', title: 'Only one', order: 0 })];
    const opened = recommendNext(base({ lectures, last: { lectureId: 'l1', slide: 4 } }));
    expect(opened).toMatchObject({ kind: 'read-lecture', reason: 'You left off at slide 4 of 10.', href: '/lecture/l1?slide=4' });
    // with some slides viewed the count is shown too, and a stale slide number is clamped into the lecture
    expect(recommendNext(base({ lectures, viewed: new Map([['l1', [1, 2]]]), last: { lectureId: 'l1', slide: 99 } }))).toMatchObject({ reason: 'You left off at slide 10 of 10; 2 viewed so far.', href: '/lecture/l1?slide=10' });
    // a resume point in a different lecture does not change the wording for this one
    expect(recommendNext(base({ lectures, last: { lectureId: 'other', slide: 4 } }))).toMatchObject({ reason: 'You have not opened this lecture yet.', href: '/lecture/l1?slide=1' });
  });

  it('archived courses are never recommended', () => {
    expect(recommendNext(base({ courses: [course({ archived: true })], cards: [dueCard()] })).kind).not.toBe('review-cards');
  });

  it('strong topics need enough evidence and a high score', () => {
    const qs = new Map([['qa', question({ id: 'qa', topic: 'Sorting', marks: 2 })], ['qb', question({ id: 'qb', topic: 'Sorting', marks: 2 })], ['qc', question({ id: 'qc', topic: 'Graphs', marks: 2 })]]);
    const a = attempt({ grades: { qa: { marks: 2, max: 2, items: [], by: 'auto', gradedAt: 0 }, qb: { marks: 2, max: 2, items: [], by: 'auto', gradedAt: 0 }, qc: { marks: 2, max: 2, items: [], by: 'auto', gradedAt: 0 } } });
    expect(strongTopics([a], qs, 2, 80)).toEqual([{ topic: 'Sorting', earned: 4, max: 4, questions: 2, percent: 100 }]); // Graphs has only one question
  });
});
