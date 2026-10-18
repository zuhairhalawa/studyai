import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { StudyDB } from '../src/core/db/db';
import { createCourse, importLecture, loadSlides } from '../src/core/db/library';
import { parsePptx } from '../src/core/pptx';
import { draftCardsFromLecture } from '../src/core/study/drafts';
import { createScheduler, intervalLabel, isDifficult, newSchedulerState, previewReview, retrievability, reviewCard } from '../src/core/study/fsrs';
import { buildQueue, cardStats, nextDueAt, startOfDay } from '../src/core/study/queue';
import { answerCard, createCard, deleteCards, resetCardSchedule, setCardStatus, updateCard } from '../src/core/study/store';
import { bodySp, buildPptx, para, run, tableFrame, titleSp, type DeckSpec } from './fixtures/pptx-builder';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

let db: StudyDB;
let n = 0;
beforeEach(() => {
  db = new StudyDB(`cd-${Date.now()}-${n++}`);
});

describe('FSRS wrapper', () => {
  const det = createScheduler({ fuzz: false });

  it('starts new cards due immediately in state New', () => {
    const s = newSchedulerState(T0);
    expect(s).toMatchObject({ state: 0, reps: 0, lapses: 0, due: T0 });
    expect(retrievability(s, T0)).toBeUndefined();
  });

  it('Good moves a new card into learning, later into review with growing intervals', () => {
    let s = newSchedulerState(T0);
    s = reviewCard(s, 3, T0, det);
    expect(s.state).toBe(1); // learning step
    expect(s.due - T0).toBe(10 * 60_000); // default first learning step with Good
    s = reviewCard(s, 3, s.due, det);
    expect(s.state).toBe(2); // graduated to review
    const first = s.due - (s.lastReview ?? 0);
    expect(first).toBeGreaterThanOrEqual(DAY);
    const s2 = reviewCard(s, 3, s.due, det);
    expect(s2.due - (s2.lastReview ?? 0)).toBeGreaterThan(first); // intervals grow while you keep remembering
    expect(s2.reps).toBe(3);
  });

  it('Again on a mature card is a lapse: shorter interval, lapse counted, lower stability', () => {
    let s = newSchedulerState(T0);
    for (let i = 0; i < 4; i++) s = reviewCard(s, 3, s.due, det);
    expect(s.state).toBe(2);
    const before = s;
    const lapsed = reviewCard(s, 1, s.due, det);
    expect(lapsed.lapses).toBe(before.lapses + 1);
    expect(lapsed.state).toBe(3); // relearning
    expect(lapsed.stability).toBeLessThan(before.stability);
    expect(lapsed.due - s.due).toBeLessThan(DAY);
  });

  it('Easy schedules further out than Hard for the same card', () => {
    let s = newSchedulerState(T0);
    s = reviewCard(s, 3, T0, det);
    s = reviewCard(s, 3, s.due, det);
    const p = previewReview(s, s.due, det);
    expect(p[4].due).toBeGreaterThan(p[3].due);
    expect(p[3].due).toBeGreaterThanOrEqual(p[2].due);
    expect(p[2].due).toBeGreaterThan(p[1].due);
    expect(p[3].label).toMatch(/^\d+(d|mo)$/);
  });

  it('retrievability falls as time passes and is ~90% at the due date', () => {
    let s = newSchedulerState(T0);
    s = reviewCard(s, 3, T0, det);
    s = reviewCard(s, 3, s.due, det);
    const atDue = retrievability(s, s.due, det)!;
    expect(atDue).toBeGreaterThan(0.85);
    expect(atDue).toBeLessThan(0.95);
    expect(retrievability(s, s.due + 30 * DAY, det)!).toBeLessThan(atDue);
    expect(retrievability(s, s.lastReview!, det)!).toBeGreaterThan(0.99);
  });

  it('state survives JSON (backups) and labels intervals readably', () => {
    const s = reviewCard(newSchedulerState(T0), 3, T0, det);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect([intervalLabel(30_000), intervalLabel(10 * 60_000), intervalLabel(5 * 3_600_000), intervalLabel(3 * DAY), intervalLabel(90 * DAY), intervalLabel(400 * DAY)]).toEqual(['<1m', '10m', '5h', '3d', '3mo', '1.1y']);
  });

  it('flags difficult cards', () => {
    const s = { ...newSchedulerState(T0), state: 2 as const, difficulty: 8.5 };
    expect(isDifficult(s)).toBe(true);
    expect(isDifficult({ ...s, difficulty: 3, lapses: 3 })).toBe(true);
    expect(isDifficult({ ...s, difficulty: 3 })).toBe(false);
    expect(isDifficult(newSchedulerState(T0))).toBe(false);
  });
});

describe('card store', () => {
  it('creates, edits, approves, resets and deletes cards', async () => {
    const course = await createCourse(db, { name: 'C' });
    const c = await createCard(db, { courseId: course.id, type: 'qa', front: ' What is P? ', back: 'Poly time', basis: 'lecture' }, T0);
    expect(c).toMatchObject({ front: 'What is P?', status: 'approved', origin: 'user', fsrs: { state: 0 } });
    await expect(createCard(db, { courseId: course.id, type: 'qa', front: '', back: 'x' })).rejects.toThrow(/front and a back/);
    await updateCard(db, c.id, { back: 'Polynomial time' }, T0 + 1);
    expect((await db.cards.get(c.id))!.back).toBe('Polynomial time');
    await expect(updateCard(db, c.id, { front: '  ' })).rejects.toThrow(/front and a back/);
    await setCardStatus(db, [c.id], 'rejected', T0 + 2);
    expect((await db.cards.get(c.id))!.status).toBe('rejected');
    await deleteCards(db, [c.id]);
    expect(await db.cards.count()).toBe(0);
  });

  it('answering writes the review log and advances the schedule; pending cards cannot be reviewed', async () => {
    const course = await createCourse(db, { name: 'C' });
    const ok = await createCard(db, { courseId: course.id, type: 'qa', front: 'a', back: 'b' }, T0);
    const pending = await createCard(db, { courseId: course.id, type: 'qa', front: 'c', back: 'd', status: 'pending' }, T0);
    const after = await answerCard(db, ok.id, 3, 4_321.7, T0 + 1000);
    expect(after.fsrs.reps).toBe(1);
    expect(after.fsrs.state).toBe(1);
    const log = await db.reviews.toArray();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ cardId: ok.id, courseId: course.id, rating: 3, stateBefore: 0, durationMs: 4322 });
    await expect(answerCard(db, pending.id, 3, 1000, T0)).rejects.toThrow(/Only approved cards/);
    await resetCardSchedule(db, ok.id, T0 + 5);
    expect((await db.cards.get(ok.id))!.fsrs).toMatchObject({ state: 0, reps: 0 });
  });
});

describe('review queue and statistics', () => {
  async function seed() {
    const course = await createCourse(db, { name: 'C' });
    let seq = 0;
    const mk = (front: string, over: Partial<Parameters<typeof createCard>[1]> = {}) => createCard(db, { courseId: course.id, type: 'qa', front, back: 'b', ...over }, T0 + seq++);
    const cards = {
      newA: await mk('new A'),
      newB: await mk('new B'),
      newC: await mk('new C'),
      pending: await mk('pending', { status: 'pending' }),
      rejected: await mk('rejected', { status: 'rejected' }),
      dueReview: await mk('due review'),
      futureReview: await mk('future review'),
      learning: await mk('learning'),
    };
    const set = async (id: string, patch: Partial<ReturnType<typeof newSchedulerState>>) => db.cards.update(id, { fsrs: { ...newSchedulerState(T0), ...patch } });
    await set(cards.dueReview.id, { state: 2, due: T0 - 2 * DAY, stability: 5, difficulty: 5, reps: 3, lastReview: T0 - 7 * DAY });
    await set(cards.futureReview.id, { state: 2, due: T0 + 5 * DAY, stability: 20, difficulty: 5, reps: 3, lastReview: T0 - DAY });
    await set(cards.learning.id, { state: 1, due: T0 - 60_000, reps: 1, lastReview: T0 - 11 * 60_000 });
    return { course, cards, all: await db.cards.toArray() };
  }

  it('orders learning, then due reviews, then new cards within the daily allowance; never pending/rejected', async () => {
    const { cards, all } = await seed();
    const q = buildQueue(all, { now: T0, newPerDay: 2, newToday: 0 });
    expect(q.map((c) => c.front)).toEqual(['learning', 'due review', 'new A', 'new B']);
    expect(q.some((c) => c.id === cards.pending.id || c.id === cards.rejected.id || c.id === cards.futureReview.id)).toBe(false);
    expect(buildQueue(all, { now: T0, newPerDay: 2, newToday: 2 }).map((c) => c.front)).toEqual(['learning', 'due review']); // allowance used up
    expect(buildQueue(all, { now: T0, newPerDay: 20, newToday: 0, limit: 3 })).toHaveLength(3);
  });

  it('knows when the next card becomes available', async () => {
    const { all } = await seed();
    expect(nextDueAt(all, T0)).toBe(T0 + 5 * DAY);
    expect(nextDueAt([], T0)).toBeUndefined();
  });

  it('computes honest statistics from the cards and the review log', async () => {
    const { course, cards, all } = await seed();
    const mkLog = (id: string, at: number, rating: 1 | 2 | 3 | 4, stateBefore: 0 | 1 | 2 | 3) => ({ id, cardId: cards.newA.id, courseId: course.id, at, rating, stateBefore, durationMs: 1000 });
    await db.reviews.bulkAdd([mkLog('a', T0 - 1000, 3, 0), mkLog('b', T0 - 2000, 1, 2), mkLog('c', T0 - 3000, 4, 2), mkLog('d', T0 - 40 * DAY, 1, 2)]);
    const stats = cardStats(all, await db.reviews.toArray(), T0);
    expect(stats).toMatchObject({ total: 8, approved: 6, pending: 1, rejected: 1, newCards: 3, learning: 1, review: 2, dueNow: 2, reviewedToday: 3, newToday: 1, reviews30d: 3 });
    expect(stats.accuracy30d).toBeCloseTo(2 / 3, 5); // the 40-day-old review is outside the window
    expect(cardStats([], [], T0).accuracy30d).toBeUndefined();
    expect(startOfDay(T0)).toBeLessThanOrEqual(T0);
  });
});

describe('local card drafts (no AI)', () => {
  const SPEC: DeckSpec = {
    slides: [
      {
        shapes:
          titleSp(2, 'Basic definitions') +
          bodySp(3, [
            para([run('Decidable language', { b: true }), run(': a language for which some Turing machine halts on every input and accepts exactly its members')]),
            para([run('Example', { b: true }), run(': the language of palindromes over a binary alphabet and many others')]),
            para([run('NP', { b: true }), run(' is short')]),
            para('A plain bullet with no bold lead-in at all, so nothing is drafted'),
            para([run('Decidable language', { b: true }), run(': a language for which some Turing machine halts on every input and accepts exactly its members')]),
          ]),
      },
      { shapes: titleSp(2, 'P vs NP') + tableFrame(4, [['Class', 'Verify', 'Solve'], ['P', 'poly', 'poly'], ['NP', 'poly', 'unknown']]) },
      { shapes: titleSp(2, 'Tiny table') + tableFrame(4, [['A', 'B']]) },
    ],
  };

  it('drafts only regular patterns, as pending/auto cards with verified sources, without duplicates', async () => {
    const course = await createCourse(db, { name: 'C' });
    const bytes = buildPptx(SPEC);
    const deck = await parsePptx(bytes);
    const lecture = await importLecture(db, { courseId: course.id, fileName: 'l.pptx', bytes, deck });
    const slides = await loadSlides(db, lecture.id);
    const { cards, slidesScanned } = draftCardsFromLecture(lecture, slides);
    expect(slidesScanned).toBe(3);
    expect(cards.map((c) => c.type)).toEqual(['definition', 'comparison']);
    expect(cards[0]).toMatchObject({ front: 'What is **Decidable language**?', status: 'pending', origin: 'auto', basis: 'lecture' });
    expect(cards[0]!.back).toMatch(/^a language for which some Turing machine halts/);
    expect(cards[0]!.sources![0]!).toMatchObject({ slide: 1, verified: true, rev: 1 });
    expect(cards[1]!.back).toContain('| NP | poly | unknown |');
    expect(cards[1]!.front).toContain('P, NP');
    // "Example", the short "NP is short" and plain bullets are ignored; the duplicate is dropped.
    expect(cards.filter((c) => c.type === 'definition')).toHaveLength(1);
  });
});
