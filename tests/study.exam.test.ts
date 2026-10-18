import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { StudyDB } from '../src/core/db/db';
import { createCourse } from '../src/core/db/library';
import { createExam, saveAnswer, saveGrade, setElapsed, startAttempt, submitAttempt, toggleFlag } from '../src/core/study/attempts';
import { autoGrade, filterBank, keywordHints, lengthAdvice, markManual, markWithRubric, missedQuestionIds, mulberry32, scoreAttempt, selectQuestions, weakTopics, wordCount } from '../src/core/study/exam';
import { saveQuestion } from '../src/core/study/store';
import type { AttemptRow, ExamConfig, QuestionRow } from '../src/core/study/types';

let db: StudyDB;
let n = 0;
beforeEach(() => {
  db = new StudyDB(`ex-${Date.now()}-${n++}`);
});

let seq = 0;
function q(over: Partial<QuestionRow> = {}): QuestionRow {
  seq += 1;
  return {
    id: `q${seq}`,
    courseId: 'c1',
    type: 'short',
    prompt: `Question ${seq}`,
    marks: 2,
    difficulty: 2,
    lectureIds: [],
    rubric: [],
    basis: 'derived',
    sources: [],
    origin: 'user',
    status: 'approved',
    createdAt: seq,
    updatedAt: seq,
    ...over,
  };
}
const mcq = (over: Partial<QuestionRow> = {}) => q({ type: 'mcq', marks: 2, options: [{ id: 'o1', text: 'A', correct: true }, { id: 'o2', text: 'B', correct: false }, { id: 'o3', text: 'C', correct: false }], ...over });

const config = (over: Partial<ExamConfig> = {}): ExamConfig => ({ title: 'T', lectureIds: [], topics: [], count: 5, types: [], difficulty: 'mixed', hints: true, reveal: 'after', layout: 'one', conditions: false, ...over });

describe('choosing questions', () => {
  it('only approved questions matching lecture/topic/type/difficulty are eligible; general questions are always eligible', () => {
    const bank = [
      q({ id: 'a', lectureIds: ['L1'], topic: 'Reductions' }),
      q({ id: 'b', lectureIds: ['L2'], topic: 'Reductions' }),
      q({ id: 'g', lectureIds: [] }),
      q({ id: 'p', lectureIds: ['L1'], status: 'pending' }),
      q({ id: 'r', lectureIds: ['L1'], status: 'rejected' }),
      q({ id: 'h', lectureIds: ['L1'], difficulty: 3, type: 'proof' }),
    ];
    const ids = (c: Partial<ExamConfig>) => filterBank(bank, config(c)).map((x) => x.id).sort();
    expect(ids({})).toEqual(['a', 'b', 'g', 'h']);
    expect(ids({ lectureIds: ['L1'] })).toEqual(['a', 'g', 'h']);
    expect(ids({ topics: ['reductions'] })).toEqual(['a', 'b']);
    expect(ids({ types: ['proof'] })).toEqual(['h']);
    expect(ids({ difficulty: 3 })).toEqual(['h']);
  });

  it('is deterministic for a seeded generator and reports shortfalls', () => {
    const bank = Array.from({ length: 10 }, (_, i) => q({ id: `s${i}` }));
    const a = selectQuestions(bank, config({ count: 4 }), mulberry32(7));
    const b = selectQuestions(bank, config({ count: 4 }), mulberry32(7));
    expect(a.ids).toEqual(b.ids);
    expect(new Set(a.ids).size).toBe(4);
    expect(a.available).toBe(10);
    const few = selectQuestions(bank.slice(0, 3), config({ count: 8 }), mulberry32(1));
    expect(few.ids).toHaveLength(3);
    expect(few.notes.join(' ')).toMatch(/Only 3 matching questions available \(you asked for 8\)/);
  });

  it('steers towards a total mark target and says when it cannot hit it', () => {
    const bank = [q({ marks: 10 }), q({ marks: 10 }), q({ marks: 5 }), q({ marks: 5 }), q({ marks: 20 }), q({ marks: 1 })];
    const sel = selectQuestions(bank, config({ count: 6, totalMarks: 30 }), mulberry32(3));
    expect(sel.totalMarks).toBeGreaterThanOrEqual(28);
    expect(sel.totalMarks).toBeLessThanOrEqual(31.5);
    const impossible = selectQuestions([q({ marks: 40 })], config({ count: 3, totalMarks: 10 }), mulberry32(3));
    expect(impossible.notes.join(' ')).toMatch(/closest total available/);
  });
});

describe('automatic marking (multiple choice / true-false)', () => {
  it('single correct option: all or nothing; unanswered and invalid ids score zero', () => {
    const question = mcq();
    expect(autoGrade(question, { optionIds: ['o1'], timeMs: 0 })).toMatchObject({ marks: 2, max: 2, by: 'auto', comment: 'Correct.' });
    expect(autoGrade(question, { optionIds: ['o2'], timeMs: 0 })).toMatchObject({ marks: 0, comment: 'Incorrect.' });
    expect(autoGrade(question, { optionIds: ['o1', 'o2'], timeMs: 0 })!.marks).toBe(0); // ticking everything is not an answer
    expect(autoGrade(question, undefined)).toMatchObject({ marks: 0, comment: 'No answer given.' });
    expect(autoGrade(question, { optionIds: ['nope'], timeMs: 0 })!.comment).toBe('No answer given.');
  });

  it('several correct options: credit for right picks, deduction for wrong ones, never negative', () => {
    const question = mcq({ marks: 4, options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: true }, { id: 'c', text: 'C', correct: false }, { id: 'd', text: 'D', correct: false }] });
    expect(autoGrade(question, { optionIds: ['a', 'b'], timeMs: 0 })!.marks).toBe(4);
    expect(autoGrade(question, { optionIds: ['a'], timeMs: 0 })!.marks).toBe(2);
    expect(autoGrade(question, { optionIds: ['a', 'c'], timeMs: 0 })!.marks).toBe(0);
    expect(autoGrade(question, { optionIds: ['c', 'd'], timeMs: 0 })!.marks).toBe(0);
    expect(autoGrade(question, { optionIds: ['a'], timeMs: 0 })!.comment).toMatch(/1 of 2 right answers/);
  });

  it('does not mark written questions', () => {
    expect(autoGrade(q({ type: 'long' }), { text: 'x', timeMs: 0 })).toBeUndefined();
  });
});

describe('self-marking against marking points', () => {
  const written = q({ type: 'short', marks: 3, rubric: [{ id: 'r1', text: 'Defines a reduction', marks: 1 }, { id: 'r2', text: 'Explains why decidability transfers', marks: 2 }] });

  it('clamps each award to the point’s value, caps the total, and always flags subjective marks as uncertain', () => {
    const g = markWithRubric(written, { r1: 5, r2: 1.5 }, 'self', 'ok', 1000);
    expect(g.items).toEqual([{ pointId: 'r1', awarded: 1 }, { pointId: 'r2', awarded: 1.5 }]);
    expect(g).toMatchObject({ marks: 2.5, max: 3, by: 'self', uncertain: true, comment: 'ok', gradedAt: 1000 });
    expect(markWithRubric(written, { r1: -4, r2: Number.NaN }).marks).toBe(0);
    expect(markWithRubric(written, {}).items.every((i) => i.awarded === 0)).toBe(true);
  });

  it('manual marks (questions with no marking points) are clamped to the question’s marks', () => {
    const noRubric = q({ marks: 4 });
    expect(markManual(noRubric, 9)).toMatchObject({ marks: 4, by: 'manual', uncertain: true });
    expect(markManual(noRubric, -1).marks).toBe(0);
  });

  it('keyword hints are suggestions: keywords first, distinctive words otherwise', () => {
    const k = q({ rubric: [{ id: 'r1', text: 'x', marks: 1, keywords: ['reduction', 'decidable'] }, { id: 'r2', text: 'y', marks: 1, keywords: ['halting'] }, { id: 'r3', text: 'Explains that undecidability propagates through reductions', marks: 1 }] });
    const h = keywordHints(k, 'A reduction maps instances; if B is decidable then so is A.');
    expect(h[0]).toMatchObject({ pointId: 'r1', status: 'likely', matched: ['reduction', 'decidable'] });
    expect(h[1]).toMatchObject({ pointId: 'r2', status: 'missing', matched: [] });
    expect(h[2]!.status).toBe('missing');
    expect(keywordHints(k, 'undecidability propagates through reductions')[2]!.status).toBe('likely');
    expect(keywordHints(k, 'reduction only')[0]!.status).toBe('unclear');
  });

  it('counts words and gives length advice only when the question defines one', () => {
    expect(wordCount("Don't panic: it's 3 words? No — it's more.")).toBe(8);
    expect(wordCount(undefined)).toBe(0);
    const s = q({ expectedWords: [5, 10] });
    expect(lengthAdvice(s, '')).toMatchObject({ ok: false, message: 'Aim for 5–10 words.' });
    expect(lengthAdvice(s, 'one two three')).toMatchObject({ ok: false, words: 3 });
    expect(lengthAdvice(s, 'one two three four five six')).toMatchObject({ ok: true });
    expect(lengthAdvice(s, 'a b c d e f g h i j k l')).toMatchObject({ ok: false });
    expect(lengthAdvice(q(), 'anything')).toBeUndefined();
  });
});

describe('scoring', () => {
  const qs = [mcq({ id: 'm1', topic: 'Basics' }), q({ id: 'w1', marks: 4, topic: 'Reductions' }), q({ id: 'w2', marks: 2, topic: 'Reductions' }), q({ id: 'w3', marks: 2, topic: 'Basics' })];
  const attempt = (over: Partial<AttemptRow>): AttemptRow => ({ id: 'a1', examId: 'e1', courseId: 'c1', startedAt: 0, elapsedMs: 0, status: 'submitted', answers: {}, grades: {}, flagged: [], ...over });

  it('classifies each question and keeps pending (unmarked written) answers out of the totals until marked', () => {
    const a = attempt({
      answers: { m1: { optionIds: ['o1'], timeMs: 0 }, w1: { text: 'some answer', timeMs: 0 }, w2: { text: 'answered', timeMs: 0 } },
      grades: { m1: { marks: 2, max: 2, items: [], by: 'auto', gradedAt: 0 }, w2: { marks: 1, max: 2, items: [], by: 'self', uncertain: true, gradedAt: 0 } },
    });
    const s = scoreAttempt(qs, a);
    expect(s.results.map((r) => r.outcome)).toEqual(['full', 'pending', 'partial', 'unanswered']);
    expect(s).toMatchObject({ earned: 3, max: 10, pending: 1, complete: false, percent: 30 });
    expect(s.maxMarked).toBe(6); // m1 (2) + w2 (2) + unanswered w3 (2)
    const topics = Object.fromEntries(s.topics.map((t) => [t.topic, t.percent]));
    expect(topics).toEqual({ Reductions: 50, Basics: 50 }); // w1 is pending so it is not counted against you yet
    expect(missedQuestionIds(s)).toEqual(['w2', 'w3']);
  });

  it('is complete and final once everything is marked', () => {
    const grades = { m1: { marks: 0, max: 2, items: [], by: 'auto' as const, gradedAt: 0 }, w1: { marks: 4, max: 4, items: [], by: 'self' as const, gradedAt: 0 }, w2: { marks: 0, max: 2, items: [], by: 'self' as const, gradedAt: 0 }, w3: { marks: 2, max: 2, items: [], by: 'self' as const, gradedAt: 0 } };
    const s = scoreAttempt(qs, attempt({ answers: { m1: { optionIds: ['o2'], timeMs: 0 }, w1: { text: 'a', timeMs: 0 }, w2: { text: 'b', timeMs: 0 }, w3: { text: 'c', timeMs: 0 } }, grades }));
    expect(s).toMatchObject({ complete: true, earned: 6, max: 10, percent: 60 });
    expect(s.results.map((r) => r.outcome)).toEqual(['zero', 'full', 'zero', 'full']);
  });

  it('finds weak topics across submitted attempts only, with a minimum evidence threshold', () => {
    const bank = new Map(qs.map((x) => [x.id, x]));
    const a1 = attempt({ id: 'a1', grades: { w1: { marks: 1, max: 4, items: [], by: 'self', gradedAt: 0 }, w2: { marks: 0, max: 2, items: [], by: 'self', gradedAt: 0 }, m1: { marks: 2, max: 2, items: [], by: 'auto', gradedAt: 0 }, w3: { marks: 2, max: 2, items: [], by: 'self', gradedAt: 0 } } });
    const inProgress = attempt({ id: 'a2', status: 'in-progress', grades: { w1: { marks: 4, max: 4, items: [], by: 'self', gradedAt: 0 } } });
    const weak = weakTopics([a1, inProgress], bank, 2, 60);
    expect(weak).toEqual([{ topic: 'Reductions', earned: 1, max: 6, questions: 2, percent: 17 }]);
    expect(weakTopics([a1], bank, 3, 60)).toEqual([]); // not enough evidence
  });
});

describe('attempt lifecycle (autosave, resume, submit)', () => {
  async function setup() {
    const course = await createCourse(db, { name: 'C' });
    const questions = [mcq({ id: 'qm', courseId: course.id }), q({ id: 'qw', courseId: course.id, marks: 3, rubric: [{ id: 'r1', text: 'p', marks: 3 }] })];
    for (const x of questions) await saveQuestion(db, x);
    const exam = await createExam(db, course.id, config({ minutes: 30 }), questions.map((x) => x.id));
    return { course, questions, exam };
  }

  it('requires questions and autosaves answers, flags and elapsed time without losing earlier ones', async () => {
    const { course, questions, exam } = await setup();
    await expect(createExam(db, course.id, config(), [])).rejects.toThrow(/at least one question/);
    const a = await startAttempt(db, exam.id, 1000);
    expect(a).toMatchObject({ status: 'in-progress', elapsedMs: 0, startedAt: 1000, answers: {}, grades: {} });
    await saveAnswer(db, a.id, 'qw', { text: 'first draft' });
    await saveAnswer(db, a.id, 'qw', { text: 'first draft, extended', hintUsed: true });
    await saveAnswer(db, a.id, 'qm', { optionIds: ['o1'] });
    await toggleFlag(db, a.id, 'qw');
    await setElapsed(db, a.id, 90_000);
    await setElapsed(db, a.id, 30_000); // never goes backwards
    const saved = (await db.attempts.get(a.id))!;
    expect(saved.answers['qw']).toEqual({ timeMs: 0, text: 'first draft, extended', hintUsed: true });
    expect(saved.answers['qm']!.optionIds).toEqual(['o1']);
    expect(saved.flagged).toEqual(['qw']);
    expect(saved.elapsedMs).toBe(90_000);
    await toggleFlag(db, a.id, 'qw');
    expect((await db.attempts.get(a.id))!.flagged).toEqual([]);
    expect(questions).toHaveLength(2);
  });

  it('submit marks objective questions exactly, leaves written ones pending, then locks the answers', async () => {
    const { questions, exam } = await setup();
    const a = await startAttempt(db, exam.id);
    await saveAnswer(db, a.id, 'qm', { optionIds: ['o1'] });
    await saveAnswer(db, a.id, 'qw', { text: 'my answer' });
    await expect(saveGrade(db, a.id, 'qw', markManual(questions[1]!, 2))).rejects.toThrow(/Submit the exam before marking/);
    const done = await submitAttempt(db, a.id, questions, 120_000, 5000);
    expect(done).toMatchObject({ status: 'submitted', submittedAt: 5000, elapsedMs: 120_000 });
    expect(done.grades['qm']).toMatchObject({ marks: 2, by: 'auto' });
    expect(done.grades['qw']).toBeUndefined();
    await expect(saveAnswer(db, a.id, 'qw', { text: 'changed my mind' })).rejects.toThrow(/already been submitted/);
    await expect(submitAttempt(db, a.id, questions, 0)).rejects.toThrow(/already been submitted/);

    await saveGrade(db, a.id, 'qw', markWithRubric(questions[1]!, { r1: 2 }));
    const scored = scoreAttempt(questions, (await db.attempts.get(a.id))!);
    expect(scored).toMatchObject({ earned: 4, max: 5, complete: true, percent: 80 });
  });

  it('a question with no answer at all is zero, not pending', async () => {
    const { questions, exam } = await setup();
    const a = await startAttempt(db, exam.id);
    const done = await submitAttempt(db, a.id, questions, 10);
    expect(done.grades['qm']).toMatchObject({ marks: 0, comment: 'No answer given.' });
    expect(scoreAttempt(questions, done).results.map((r) => r.outcome)).toEqual(['zero', 'unanswered']);
  });
});
