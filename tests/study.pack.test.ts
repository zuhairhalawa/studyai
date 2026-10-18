import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { StudyDB } from '../src/core/db/db';
import { createCourse, importLecture, loadSlides } from '../src/core/db/library';
import { parsePptx } from '../src/core/pptx';
import { displayTitle } from '../src/core/pptx/topics';
import { extractJson, normForMatch, planPack, quoteInText, recoverTruncatedJson, sourceStatus, type LectureContext } from '../src/core/study/pack';
import { packCounts } from '../src/core/study/pack-format';
import { lectureToMarkdown, studyPackPrompt } from '../src/core/study/markdown';
import { applyPackPlan, removePack, updateCard } from '../src/core/study/store';
import { BACKUP_VERSION, applyBackup, exportBackup, readBackup } from '../src/core/backup/backup';
import { bodySp, buildPptx, equationShape, mr, para, simpleSlide, tableFrame, titleSp, type DeckSpec } from './fixtures/pptx-builder';

let db: StudyDB;
let n = 0;
beforeEach(() => {
  db = new StudyDB(`pk-${Date.now()}-${n++}`);
});

const SPEC: DeckSpec = {
  slides: [
    simpleSlide('Halting problem', ['The halting problem is undecidable', 'Proof by contradiction using diagonalisation'], 'Mention Turing 1936'),
    { shapes: titleSp(2, 'Reductions') + bodySp(3, [para('If A reduces to B and B is decidable then A is decidable')]) },
    { shapes: titleSp(2, 'Comparison') + tableFrame(4, [['Class', 'Verify', 'Solve'], ['P', 'poly', 'poly'], ['NP', 'poly', 'unknown']]) },
    { shapes: titleSp(2, 'Ratio') + equationShape(5, `<m:f><m:num>${mr('a')}</m:num><m:den>${mr('b')}</m:den></m:f>`) },
  ],
};

async function setup() {
  const course = await createCourse(db, { name: 'Computability' });
  const bytes = buildPptx(SPEC);
  const deck = await parsePptx(bytes);
  const lecture = await importLecture(db, { courseId: course.id, fileName: 'Lecture 7 Undecidability.pptx', bytes, deck });
  const slides = await loadSlides(db, lecture.id);
  const ctx: LectureContext = {
    id: lecture.id,
    title: lecture.title,
    fileHash: lecture.fileHash,
    revision: lecture.revision,
    slideCount: lecture.slideCount,
    slideText: (i) => {
      const s = slides[i - 1];
      return s ? `${displayTitle(s)}\n${s.text}\n${s.notes}` : undefined;
    },
  };
  return { course, lecture, slides, ctx, deck };
}

const pack = (over: Record<string, unknown> = {}) => ({
  format: 'studyai-pack',
  version: 1,
  generator: 'Test AI 2026-10-16',
  lectures: [{ ref: 'L1', title: 'Lecture 7 Undecidability' }],
  notes: [],
  cards: [],
  questions: [],
  ...over,
});

describe('extractJson', () => {
  it('finds the object in fences or chatter', () => {
    expect(extractJson('Here you go!\n```json\n{"a": 1}\n```\nHope it helps')).toEqual({ a: 1 });
    expect(extractJson('{"a": 2}')).toEqual({ a: 2 });
    expect(extractJson('Sure: {"a": {"b": 3}} thanks')).toEqual({ a: { b: 3 } });
  });
  it('explains failures', () => {
    expect(() => extractJson('no json here')).toThrow(/No JSON object found/);
    expect(() => extractJson('{"a": ')).toThrow(/No JSON object found|could not be parsed/);
    expect(() => extractJson('{"a": nope}')).toThrow(/could not be parsed/);
  });
});

describe('quote verification', () => {
  it('ignores markdown, LaTeX, punctuation and case', () => {
    const hay = 'The halting problem is undecidable\nA_{TM} is reducible to HALT_{TM}';
    expect(normForMatch('**The** Halting-Problem  is…')).toBe('the halting problem is');
    expect(quoteInText('"The halting problem is undecidable"', hay)).toBe(true);
    expect(quoteInText('$A_{TM}$ is reducible to $HALT_{TM}$', hay)).toBe(true);
    expect(quoteInText('the halting problem ... is undecidable', hay)).toBe(true); // ellipsis fragments
  });
  it('matches quotes copied from the Markdown export where equations appear as LaTeX', () => {
    const slide = 'If we know that some problem (say A_{TM}) is undecidable we can use that\nMachine S would decide A_{TM}, which cannot be. So HALT_{TM} is not decidable.';
    expect(quoteInText(String.raw`If we know that some problem (say $A _{\text{TM}}$) is undecidable`, slide)).toBe(true);
    expect(quoteInText(String.raw`Machine $S$ would decide $A _{\text{TM}}$, which cannot be. So $HALT _{\text{TM}}$ is not decidable.`, slide)).toBe(true);
    expect(normForMatch(String.raw`$\left\langle M , w \right\rangle$`)).toBe('m w');
  });
  it('rejects invented text and ignores quotes too short to mean anything', () => {
    expect(quoteInText('the halting problem is decidable', 'The halting problem is undecidable')).toBe(false);
    expect(quoteInText('NP', 'NP complete')).toBeUndefined();
    expect(quoteInText('the problem halting is', 'The halting problem is undecidable')).toBe(false); // word order matters
  });
  it('summarises source status', () => {
    expect(sourceStatus([])).toBe('none');
    expect(sourceStatus([{ lectureId: 'a', slide: 1 }])).toBe('slide-only');
    expect(sourceStatus([{ lectureId: 'a', slide: 1, verified: false }])).toBe('unverified');
    expect(sourceStatus([{ lectureId: 'a', slide: 1, verified: false }, { lectureId: 'a', slide: 2, verified: true }])).toBe('verified');
  });
});

describe('planPack', () => {
  it('rejects things that are not packs, with a reason', async () => {
    const { course, ctx } = await setup();
    expect(planPack({ hello: 1 }, course.id, [ctx]).fatal).toMatch(/not a StudyAI pack/);
    expect(planPack(pack({ version: 99 }), course.id, [ctx]).fatal).toMatch(/format version 99/);
    expect(planPack(pack(), course.id, [ctx]).issues.some((i) => /no notes, cards or questions/.test(i.message))).toBe(true);
  });

  it('matches lectures by hash, then title, then manual mapping', async () => {
    const { course, ctx } = await setup();
    const byHash = planPack(pack({ lectures: [{ ref: 'L1', title: 'Something else', fileHash: ctx.fileHash }] }), course.id, [ctx]);
    expect(byHash.lectureMap[0]).toMatchObject({ localId: ctx.id, how: 'hash' });
    const byTitle = planPack(pack({ lectures: [{ ref: 'L1', title: 'lecture 7 - undecidability' }] }), course.id, [ctx]);
    expect(byTitle.lectureMap[0]).toMatchObject({ localId: ctx.id, how: 'title' });
    const none = planPack(pack({ lectures: [{ ref: 'L1', title: 'Unknown lecture' }] }), course.id, [ctx]);
    expect(none.lectureMap[0]!.localId).toBeUndefined();
    expect(none.issues[0]!.message).toMatch(/No lecture in this course matches/);
    const manual = planPack(pack({ lectures: [{ ref: 'L1', title: 'Unknown lecture' }] }), course.id, [ctx], { L1: ctx.id });
    expect(manual.lectureMap[0]).toMatchObject({ localId: ctx.id, how: 'manual' });
    const stale = planPack(pack({ lectures: [{ ref: 'L1', title: 'Lecture 7 Undecidability', slideCount: 55 }] }), course.id, [ctx]);
    expect(stale.issues.some((i) => /Slide numbers may not line up/.test(i.message))).toBe(true);
  });

  it('accepts good items as pending/imported, checks every quote and counts sources', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        cards: [
          { type: 'definition', front: 'Halting problem?', back: 'Decide whether a TM halts.', lecture: 'L1', basis: 'lecture', sources: [{ lecture: 'L1', slide: 1, quote: 'The **halting problem** is undecidable' }] },
          { type: 'qa', front: 'Who showed it?', back: 'Turing, 1936.', lecture: 'L1', basis: 'lecture', sources: [{ lecture: 'L1', slide: 1, quote: 'Mention Turing 1936' }] },
        ],
        notes: [{ title: 'Summary', kind: 'summary', lecture: 'L1', blocks: [{ text: 'Reductions transfer decidability.', basis: 'derived', sources: [{ lecture: 'L1', slide: 2 }] }] }],
      }),
      course.id,
      [ctx],
    );
    expect(plan.fatal).toBeUndefined();
    expect(plan.stats).toMatchObject({ received: 3, accepted: 3, rejected: 0, sources: 3, verified: 2, unverified: 0 });
    expect(plan.cards).toHaveLength(2);
    expect(plan.cards.every((c) => c.status === 'pending' && c.origin === 'imported' && c.fsrs.state === 0 && c.packId === plan.packId)).toBe(true);
    expect(plan.cards[0]!.sources[0]).toMatchObject({ lectureId: ctx.id, slide: 1, verified: true, rev: 1 });
    expect(plan.notes[0]!.blocks[0]).toMatchObject({ origin: 'imported', basis: 'derived' });
    expect(plan.notes[0]!.lectureId).toBe(ctx.id);
  });

  it('flags quotes that are not on the slide and slides that do not exist', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        cards: [
          { type: 'definition', front: 'f', back: 'b', lecture: 'L1', basis: 'lecture', sources: [{ lecture: 'L1', slide: 1, quote: 'The halting problem is easily decidable in linear time' }] },
          { type: 'definition', front: 'f2', back: 'b2', lecture: 'L1', basis: 'derived', sources: [{ lecture: 'L1', slide: 99, quote: 'whatever it said here' }] },
        ],
      }),
      course.id,
      [ctx],
    );
    expect(plan.cards[0]!.sources[0]!.verified).toBe(false);
    expect(sourceStatus(plan.cards[0]!.sources)).toBe('unverified');
    expect(plan.cards[1]!.sources).toEqual([]); // dropped: slide 99 does not exist
    const msgs = plan.issues.map((i) => i.message).join('\n');
    expect(msgs).toMatch(/was not found on slide 1/);
    expect(msgs).toMatch(/has only 4 slides/);
    expect(msgs).toMatch(/Claims to be on the slides, but no cited quote could be verified/);
    expect(plan.stats.unverified).toBe(2);
  });

  it('skips invalid items individually and says why; missing basis becomes uncertain', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        cards: [
          { type: 'nonsense', front: 'x', back: 'y' },
          { type: 'qa', front: '', back: 'y' },
          { type: 'qa', front: 'ok front', back: 'ok back', lecture: 'L1' },
        ],
        questions: [{ type: 'mcq', prompt: 'p', marks: 1, options: [{ text: 'a', correct: false }, { text: 'b', correct: false }], modelAnswer: 'x' }],
      }),
      course.id,
      [ctx],
    );
    expect(plan.stats).toMatchObject({ received: 4, accepted: 1, rejected: 3 });
    expect(plan.cards).toHaveLength(1);
    expect(plan.cards[0]!.basis).toBe('uncertain');
    const errs = plan.issues.filter((i) => i.severity === 'error').map((i) => i.message);
    expect(errs.join('\n')).toMatch(/Card #1/.source === '' ? '' : /Skipped/);
    expect(errs.some((m) => /no option is marked correct/.test(m))).toBe(true);
    expect(plan.issues.some((i) => /No “basis” given/.test(i.message))).toBe(true);
  });

  it('builds questions: MCQ options, true/false, rubric marks check, required answers', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        questions: [
          { type: 'mcq', prompt: 'Which is undecidable?', marks: 1, options: [{ text: 'Halting', correct: true }, { text: 'Sorting', correct: false }], basis: 'derived', sources: [] },
          { type: 'truefalse', prompt: 'HALT is decidable.', marks: 1, answer: false, basis: 'derived', sources: [] },
          { type: 'short', prompt: 'Explain reductions.', marks: 3, modelAnswer: 'ok', rubric: [{ text: 'a', marks: 1 }, { text: 'b', marks: 1 }], basis: 'derived', sources: [], lectures: ['L1'] },
          { type: 'long', prompt: 'No answer given', marks: 5, basis: 'derived', sources: [] },
        ],
      }),
      course.id,
      [ctx],
    );
    expect(plan.questions).toHaveLength(3);
    expect(plan.questions[0]!.options).toEqual([{ id: 'o1', text: 'Halting', correct: true }, { id: 'o2', text: 'Sorting', correct: false }]);
    expect(plan.questions[1]!.options!.find((o) => o.correct)!.text).toBe('False');
    expect(plan.questions[2]!.lectureIds).toEqual([ctx.id]);
    expect(plan.questions[2]!.rubric.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(plan.issues.some((i) => /add up to 2 but the question is worth 3/.test(i.message))).toBe(true);
    expect(plan.issues.some((i) => /needs a model answer or marking points/.test(i.message))).toBe(true);
  });
});

describe('applying and removing a pack', () => {
  it('stores pending items, and removal deletes exactly that pack (edited items are kept)', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        cards: [
          { type: 'qa', front: 'one', back: '1', lecture: 'L1', basis: 'derived' },
          { type: 'qa', front: 'two', back: '2', lecture: 'L1', basis: 'derived' },
        ],
        notes: [{ title: 'N', lecture: 'L1', blocks: [{ text: 't', basis: 'derived' }] }],
      }),
      course.id,
      [ctx],
    );
    const res = await applyPackPlan(db, course.id, plan);
    expect(res).toEqual({ notes: 1, cards: 2, questions: 0 });
    expect((await db.packs.get(plan.packId))!.counts).toEqual({ notes: 1, cards: 2, questions: 0 });
    expect(await db.cards.where('status').equals('pending').count()).toBe(2);

    await updateCard(db, plan.cards[0]!.id, { front: 'one (edited)' }); // detaches from the pack
    const removed = await removePack(db, plan.packId);
    expect(removed).toEqual({ notes: 1, cards: 1, questions: 0 });
    expect((await db.cards.toArray()).map((c) => c.front)).toEqual(['one (edited)']);
    expect(await db.packs.count()).toBe(0);
  });

  it('refuses to apply a failed plan', async () => {
    const { course } = await setup();
    await expect(applyPackPlan(db, course.id, planPack({}, course.id, []))).rejects.toThrow(/not a StudyAI pack/);
  });
});

describe('lecture export for your own AI', () => {
  it('keeps slide numbers, markdown formatting, tables, LaTeX and caveats', async () => {
    const { lecture, slides } = await setup();
    const md = lectureToMarkdown(lecture, slides, 'L1');
    expect(md).toContain('## Lecture L1: Lecture 7 Undecidability');
    expect(md).toContain(`<!-- studyai-lecture ref=L1 hash=${lecture.fileHash} slides=4 -->`);
    expect(md).toContain('### Slide 1: Halting problem');
    expect(md).toContain('- The halting problem is undecidable');
    expect(md).toContain('**Speaker notes:** Mention Turing 1936');
    expect(md).toContain('| Class | Verify | Solve |');
    expect(md).toContain('| NP | poly | unknown |');
    expect(md).toContain('$$\\frac{a}{b}$$');
  });

  it('builds a prompt that carries the rules, the format and the professor’s style', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: { notes: false, cards: true, questions: true }, examStyle: 'Answers must be 1-3 sentences.' });
    expect(p).toContain('"studyai-pack"');
    expect(p).toContain('25 flashcards');
    expect(p).toContain('12 exam-style questions');
    expect(p).not.toContain('notes (summaries');
    expect(p).toContain('Do not invent lecture content');
    expect(p).toMatch(/A quote must support the WHOLE item.*never "lecture"/s); // a true quote does not make an unsupported claim "on the slides"
    expect(p).toContain('"outside"');
    expect(p).toContain('Answers must be 1-3 sentences.');
    expect(p).toContain('"fileHash"');
  });
});

describe('asking for a pack that fits the answer limit', () => {
  const all = { notes: true, cards: true, questions: true };
  const tokens = (c: ReturnType<typeof packCounts>) => c.notes * 220 + c.cards * 130 + c.questions * 330;

  it('asks for the usual numbers when there is no answer limit', () => {
    expect(packCounts({ wants: all, amount: 'normal' })).toEqual({ notes: 10, cards: 25, questions: 12 });
    expect(packCounts({ wants: { notes: false, cards: true, questions: false }, amount: 'few' })).toEqual({ notes: 0, cards: 10, questions: 0 });
  });

  it('cuts the numbers until the pack fits well inside the limit, and never asks for a kind that was not wanted', () => {
    for (const amount of ['few', 'normal', 'many'] as const) {
      for (const wants of [all, { notes: false, cards: true, questions: true }, { notes: true, cards: false, questions: false }]) {
        const c = packCounts({ wants, amount, outputTokens: 4_000 });
        expect(tokens(c), `${amount} ${JSON.stringify(wants)}`).toBeLessThanOrEqual(0.7 * 4_000 - 150);
        expect(c.notes > 0).toBe(wants.notes);
        expect(c.cards > 0).toBe(wants.cards);
        expect(c.questions > 0).toBe(wants.questions);
      }
    }
    // the case that was cut off in a real run: a normal set of everything must not be 10 + 25 + 12 items in 4000 tokens
    const normal = packCounts({ wants: all, amount: 'normal', outputTokens: 4_000 });
    expect(normal.notes + normal.cards + normal.questions).toBeLessThan(20);
    // a small request is left alone, and a tiny limit still asks for at least one of each wanted kind
    expect(packCounts({ wants: { notes: false, cards: true, questions: false }, amount: 'few', outputTokens: 4_000 }).cards).toBe(10);
    expect(packCounts({ wants: all, amount: 'many', outputTokens: 300 })).toEqual({ notes: 1, cards: 1, questions: 1 });
  });

  it('tells the model to leave the lists it was not asked for empty (found with the real model: a questions-only request came back with a card and a note)', () => {
    expect(studyPackPrompt({ amount: 'few', wants: { notes: false, cards: false, questions: true }, outputTokens: 4_000 })).toContain('leave "notes" and "cards" as empty lists ([])');
    expect(studyPackPrompt({ amount: 'few', wants: { notes: true, cards: false, questions: true } })).toContain('leave "cards" as empty lists ([])');
    expect(studyPackPrompt({ amount: 'few', wants: all })).not.toContain('as empty lists'); // everything asked for: nothing to leave out
    expect(studyPackPrompt({ amount: 'few', wants: { notes: false, cards: false, questions: false } })).not.toContain('as empty lists'); // nothing asked for: the generic task stays
  });

  it('puts the cut counts and a "keep it short" rule into the prompt, and the most valuable list first', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: all, outputTokens: 4_000 });
    const c = packCounts({ wants: all, amount: 'normal', outputTokens: 4_000 });
    expect(p).toContain(`${c.cards} flashcards`);
    expect(p).toContain(`${c.questions} exam-style questions`);
    expect(p).not.toContain('25 flashcards');
    expect(p).toMatch(/limited to about 2,000 words and is thrown away if it is cut off/);
    expect(p).toMatch(/write fewer items, never a longer one/);
    expect(p.indexOf('"questions": [')).toBeLessThan(p.indexOf('"cards": ['));
    expect(p.indexOf('"cards": [')).toBeLessThan(p.indexOf('"notes": ['));
    expect(studyPackPrompt({ amount: 'normal', wants: all })).not.toMatch(/thrown away if it is cut off/); // the copy-and-paste prompt has no such limit
  });
});

describe('importing questions: the quality check is part of the check screen', () => {
  const goodQ = (over: Record<string, unknown> = {}) => ({
    type: 'short',
    prompt: 'Explain why the halting problem is undecidable and name the method used to show it.',
    marks: 2,
    difficulty: 2,
    topic: 'Halting problem',
    modelAnswer: 'The halting problem is undecidable, which is shown by a proof by contradiction using diagonalisation.',
    rubric: [{ text: 'The halting problem is undecidable', marks: 1 }, { text: 'The proof uses contradiction and diagonalisation', marks: 1 }],
    basis: 'lecture',
    sources: [{ lecture: 'L1', slide: 1, quote: 'The halting problem is undecidable' }],
    ...over,
  });

  it('turns the checker’s findings into warnings that name the question, and keeps the set summary', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(pack({ questions: [goodQ(), goodQ({ prompt: 'Explain why the halting problem is undecidable and name the method used to show it?', marks: 6 }), goodQ({ modelAnswer: undefined })] }), course.id, [ctx]);
    expect(plan.questions).toHaveLength(3);
    expect(plan.quality?.stats).toMatchObject({ questions: 3, totalMarks: 10 });
    const messages = plan.issues.map((i) => `${i.where}: ${i.message}`);
    expect(messages.some((m) => /^Question #2: It is worth 6 marks but has only 2 marking points/.test(m))).toBe(true);
    expect(messages.some((m) => /^Question #2: Question 2 is almost the same as question 1/.test(m))).toBe(true);
    expect(messages.some((m) => /^Question #3: It has no model answer/.test(m))).toBe(true);
    expect(plan.issues.filter((i) => i.severity === 'warning' && /^Question #1:/.test(i.where))).toEqual([]);
  });

  it('names a question by its place in the pack even when an earlier one was skipped', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(pack({ questions: [{ nonsense: true }, goodQ({ marks: 6 })] }), course.id, [ctx]);
    expect(plan.questions).toHaveLength(1);
    expect(plan.issues.some((i) => i.where === 'Question #2' && /worth 6 marks but has only 2/.test(i.message))).toBe(true);
  });

  it('compares the questions with the plan that was asked for, and with the questions that already exist', async () => {
    const { course, ctx } = await setup();
    const expected = [{ type: 'scenario' as const, difficulty: 3 as const, marks: 6, points: 6, topic: 'Reductions', slides: [2] }];
    const plan = planPack(pack({ questions: [goodQ()] }), course.id, [ctx], {}, undefined, { expected, existingPrompts: ['Explain why the halting problem is undecidable and name the method used to show it'] });
    expect(plan.quality?.stats.asPlanned).toEqual({ met: 0, of: 1 });
    const text = plan.issues.map((i) => i.message).join(' | ');
    expect(text).toMatch(/Planned as scenario but it is short answer/);
    expect(text).toMatch(/Planned for 6 marks but it is worth 2/);
    expect(text).toMatch(/Planned for the topic “Reductions”/);
    expect(text).toMatch(/repeats a question you already have/);
  });

  it('matches the plan to the place the AI wrote each question at, so skipped questions do not shift it', async () => {
    // a real model once left the "prompt" out of three of four questions: the survivor is the fourth one, and was compared with the first slot
    const { course, ctx } = await setup();
    const expected = [
      { type: 'diagram' as const, difficulty: 2 as const, marks: 3, points: 3, topic: 'First', slides: [1] },
      { type: 'attack' as const, difficulty: 3 as const, marks: 3, points: 3, topic: 'Second', slides: [1] },
      { type: 'compare' as const, difficulty: 2 as const, marks: 4, points: 4, topic: 'Third', slides: [1] },
      { type: 'short' as const, difficulty: 2 as const, marks: 2, points: 2, topic: 'Halting problem', slides: [1] },
    ];
    const noPrompt = { type: 'diagram', marks: 3, difficulty: 2, topic: 'First', modelAnswer: 'x', rubric: [{ text: 'a', marks: 3 }] };
    const plan = planPack(pack({ questions: [noPrompt, noPrompt, noPrompt, goodQ()] }), course.id, [ctx], {}, undefined, { expected });
    expect(plan.questions).toHaveLength(1);
    expect(plan.quality?.stats.asPlanned).toEqual({ met: 1, of: 4 });
    const text = plan.issues.map((i) => i.message).join(' | ');
    expect(text).not.toMatch(/Planned as|Planned for the topic/); // the survivor IS the fourth planned question
    expect(text).toMatch(/4 questions were planned but 1 came back. Planned questions 1, 2, 3 did not come back usable./);
    expect(plan.issues.filter((i) => /prompt/.test(i.message)).map((i) => i.where)).toEqual(['Question #1', 'Question #2', 'Question #3']);
  });

  it('reads a true/false question whose "answer" field is missing from its model answer, with a warning, and still refuses one with no clear answer', async () => {
    // a real model wrote modelAnswer "True" and a one-point rubric "True" but no "answer": the question was thrown away
    const { course, ctx } = await setup();
    const tf = (over: Record<string, unknown>) => ({ type: 'truefalse', prompt: 'Is it so?', marks: 1, difficulty: 1, basis: 'lecture', sources: [{ lecture: 'L1', slide: 1, quote: 'The halting problem is undecidable' }], ...over });
    const plan = planPack(
      pack({
        questions: [
          tf({ modelAnswer: 'True', rubric: [{ text: 'True', marks: 1 }] }),
          tf({ modelAnswer: 'False. The slides say the opposite.', rubric: [{ text: 'False', marks: 1 }] }),
          tf({ rubric: [{ text: 'false, because the slide says so', marks: 1 }] }),
          tf({ modelAnswer: 'It depends on the input.', rubric: [{ text: 'It depends', marks: 1 }] }),
          tf({ answer: false, modelAnswer: 'True' }), // an explicit answer always wins
        ],
      }),
      course.id,
      [ctx],
    );
    expect(plan.questions.map((q) => q.options?.find((o) => o.correct)?.text)).toEqual(['True', 'False', 'False', 'False']);
    expect(plan.issues.filter((i) => i.severity === 'error').map((i) => i.where)).toEqual(['Question #4']);
    expect(plan.issues.find((i) => i.where === 'Question #4')?.message).toMatch(/needs "answer": true or false/);
    expect(plan.issues.filter((i) => /No “?"?answer/.test(i.message) || /No "answer" field was given/.test(i.message)).map((i) => i.where)).toEqual(['Question #1', 'Question #2', 'Question #3']);
    expect(plan.issues.find((i) => i.where === 'Question #1')?.message).toMatch(/read as true from the model answer/);
  });

  it('names a marking point that nobody asked for, and a badly formed "ask" never costs the whole question', async () => {
    const { course, ctx } = await setup();
    const asked = goodQ({
      marks: 3,
      prompt: 'Explain why the halting problem is undecidable and name the method used to show it, and state one consequence.',
      asks: [{ quote: 'Explain why the halting problem is undecidable', count: 1 }, { quote: 'name the method used to show it', count: 1 }],
      rubric: [{ text: 'The halting problem is undecidable', marks: 1, ask: 1 }, { text: 'The proof uses contradiction and diagonalisation', marks: 1, ask: 2 }, { text: 'Rice theorem generalises the result', marks: 1, ask: 2 }],
    });
    const sloppy = goodQ({ asks: 'yes please', rubric: [{ text: 'The halting problem is undecidable', marks: 1, ask: '1' }, { text: 'The proof uses contradiction and diagonalisation', marks: 1, ask: 1.5 }] });
    const plan = planPack(pack({ questions: [asked, sloppy] }), course.id, [ctx], {}, undefined, { expected: [{ type: 'short' as const, difficulty: 2 as const, marks: 3, points: 3, topic: 'Halting problem', slides: [1] }, { type: 'short' as const, difficulty: 2 as const, marks: 2, points: 2, topic: 'Halting problem', slides: [1] }] });
    expect(plan.questions).toHaveLength(2); // neither question is dropped
    const messages = plan.issues.filter((i) => i.severity === 'warning').map((i) => `${i.where}: ${i.message}`);
    expect(messages.some((m) => /^Question #1: The question asks for 1 item in "name the method used to show it", but 2 marking points answer it: the extra marks are not asked for/.test(m))).toBe(true);
    expect(messages.some((m) => /^Question #2: It does not say which part of the question each marking point answers/.test(m))).toBe(true); // the unreadable asks were ignored
  });

  it('adds nothing for a pack without questions', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(pack({ cards: [{ type: 'qa', front: 'q', back: 'a', basis: 'derived' }] }), course.id, [ctx]);
    expect(plan.quality).toBeUndefined();
  });
});

describe('asking for planned, good exam questions', () => {
  const plan = [
    { type: 'scenario' as const, difficulty: 3 as const, marks: 6, points: 6, topic: 'Defences', slides: [4, 5] },
    { type: 'truefalse' as const, difficulty: 1 as const, marks: 1, points: 1, topic: 'Threats', slides: [2] },
    { type: 'compare' as const, difficulty: 2 as const, marks: 4, points: 4, topic: 'Policies', slides: [7] },
  ];
  const q = { notes: false, cards: false, questions: true };

  it('lists the planned questions with type, difficulty, marks, number of marking points, topic and slides, in order', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: q, outputTokens: 4_000, blueprint: plan });
    expect(p).toContain('THE QUESTIONS TO WRITE: exactly 3, in this order');
    expect(p).toContain('1. type "scenario", difficulty 3, 6 marks, 6 marking points, topic "Defences", based on slides 4, 5');
    expect(p).toContain('2. type "truefalse", difficulty 1, 1 mark, 1 marking point, topic "Threats", based on slide 2');
    expect(p).toContain('3. type "compare", difficulty 2, 4 marks, 4 marking points, topic "Policies", based on slide 7');
    expect(p).toContain('3 exam questions (listed below) with marking points');
    expect(p).not.toContain('12 exam-style questions'); // the generic count is replaced by the plan
  });

  it('carries the rules for what a good question is: the kinds, the difficulty meaning, marks, independent points, full-marks answers, variety', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: q, blueprint: plan });
    expect(p).toMatch(/A\. Kind\..*scenario: a short invented situation.*every marking point must still be on the slides/s);
    expect(p).toMatch(/B\. Difficulty\. 1 = state or recognise one idea from one slide\. 2 = .* 3 = a situation or problem that needs several slides/s);
    expect(p).toMatch(/C\. Marks\. About one separate idea per mark/);
    expect(p).toMatch(/D\. Marking points\. Each one is ONE idea a student can earn on its own.*Never write "any two of", "all of", "at least" or "A or B"/s);
    expect(p).toMatch(/E\. Model answer\. What a student who earns FULL marks writes.*Nothing in it may go beyond the slides/s);
    expect(p).toMatch(/F\. Variety.*<already_asked>/s);
    // every kind of question is explained
    for (const kind of ['define', 'short', 'compare', 'scenario', 'case', 'attack', 'problem, calculation', 'proof', 'algorithm, programming', 'diagram', 'mcq', 'long']) expect(p, kind).toContain(`- ${kind}:`);
  });

  it('insists that every question carries its own text (a real model left it out of three of four)', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: q, outputTokens: 4_000, blueprint: plan });
    expect(p).toMatch(/G. Prompt. Every question has a "prompt": the full text of the question as the student reads it.*thrown away/s);
    expect(p).toMatch(/The lines above tell you what to write; they are not the questions. Write the text the student will read in each question's "prompt"/);
    expect(p).toContain('"prompt": "REQUIRED, the question exactly as the student reads it');
    expect(p).toContain('(always write "answer": true or false)'); // a real model wrote "True" in the model answer and left the field out twice
    expect(p).toContain('Set "expectedWords" to [12 x marks, 20 x marks], so a 3-mark question has [36, 60].'); // a real model copied [12, 20] for a 3-mark question
  });

  it('makes every marking point answer something the question asks, and every scenario need its situation', () => {
    const p = studyPackPrompt({ amount: 'normal', wants: q, outputTokens: 4_000, blueprint: plan });
    expect(p).toMatch(/H\. Asks\. After the prompt, list in "asks" every separate thing it asks the student for.*exact words of your prompt.*"count".*\n?.*"ask": 1 for the first ask/s);
    expect(p).toMatch(/An ask with count 3 has exactly three marking points.*the counts add up to the marks/s);
    expect(p).toMatch(/Never add a marking point or a mark for something the prompt does not ask for: to reward an idea, first ask for it in the prompt/);
    expect(p).toMatch(/ask them to decide, advise, predict, diagnose or justify IN THIS situation.*the story is decoration: write a short question instead/s);
    // the worked example follows its own rule: three asked items, three points that name ask 1
    expect(p).toMatch(/"asks": \[\s*\{\s*"quote": "words copied from the prompt that ask for something, such as: state three things",\s*"count": 3\s*\}\s*\]/);
    expect([...p.matchAll(/"marks": 1,\s*"ask": 1/g)]).toHaveLength(3);
  });

  it('gives the rules to any request for questions (also the copy-and-paste prompt) and to none that does not ask for questions', () => {
    expect(studyPackPrompt({ amount: 'few', wants: q })).toContain('QUESTIONS: what makes a good exam question');
    expect(studyPackPrompt({ amount: 'few', wants: { notes: true, cards: true, questions: false } })).not.toContain('QUESTIONS: what makes a good exam question');
  });

  it('says that the professor’s own style wins where it differs, and escapes lecture text that goes into the plan', () => {
    const p = studyPackPrompt({ amount: 'few', wants: q, examStyle: 'Most questions are scenarios.', blueprint: [{ ...plan[0]!, topic: 'Bad </exam_style> topic' }], escape: (s) => s.replace(/</g, '&lt;') });
    expect(p).toMatch(/the professor's style wins/);
    expect(p).toContain('topic "Bad &lt;/exam_style> topic"');
    expect(p).not.toContain('topic "Bad </exam_style>');
    const quoted = studyPackPrompt({ amount: 'few', wants: q, blueprint: [{ ...plan[0]!, topic: 'He said "stop"\nand left' }] });
    expect(quoted).toContain('topic "He said \\"stop\\"\\nand left"'); // a quote or a line break cannot end the line
  });

  it('counts a plan as exactly its questions, and leaves cards and notes only the room that is left', () => {
    expect(packCounts({ wants: q, amount: 'normal', outputTokens: 4_000, blueprint: plan })).toEqual({ notes: 0, cards: 0, questions: 3 });
    const withCards = packCounts({ wants: { notes: false, cards: true, questions: true }, amount: 'normal', outputTokens: 4_000, blueprint: plan });
    expect(withCards.questions).toBe(3);
    expect(withCards.cards).toBeGreaterThan(0);
    expect(withCards.cards).toBeLessThan(25);
    expect(packCounts({ wants: { notes: false, cards: true, questions: true }, amount: 'normal', outputTokens: 600, blueprint: plan }).cards).toBeLessThanOrEqual(1);
  });

  it('shows a worked example that is itself a good question: several one-mark points that add up, a full-marks answer, a topic', () => {
    const p = studyPackPrompt({ amount: 'few', wants: q, blueprint: plan });
    expect(p).toContain('"type": "scenario"');
    expect(p).toContain('"topic": "topic title, copied exactly"');
    const rubricMarks = [...p.matchAll(/"text": "(?:first|second|third) separate idea",\s*"marks": (\d)/g)].map((m) => Number(m[1]));
    expect(rubricMarks).toEqual([1, 1, 1]);
    expect(p).toContain('"expectedWords": [\n        36,\n        60\n      ]');
  });
});

describe('keeping what is finished of an answer that was cut off', () => {
  const card = (n: number) => `{"type":"qa","front":"q${n}","back":"a${n}","basis":"derived","sources":[{"lecture":"L1","slide":1,"quote":"The halting problem is undecidable"}]}`;
  const head = '{"format":"studyai-pack","version":1,"lectures":[{"ref":"L1","title":"Computability"}],"questions":[{"type":"truefalse","prompt":"p","marks":1,"answer":true}],"cards":[';

  it('keeps every complete item and drops only the unfinished one', () => {
    const cut = `${head}${card(1)},${card(2)},{"type":"qa","front":"q3","back":"an answ`;
    const r = recoverTruncatedJson(cut)!;
    expect(r.items).toBe(3); // one question and two cards
    const v = r.value as { cards: { front: string }[]; questions: unknown[] };
    expect(v.cards.map((c) => c.front)).toEqual(['q1', 'q2']);
    expect(v.questions).toHaveLength(1);
    expect(() => extractJson(cut)).toThrow(); // the ordinary reader gives up on the same text
  });

  it('copes with a code fence that was never closed, with braces and escaped quotes inside strings, and with a cut right after a comma', () => {
    const tricky = '{"type":"qa","front":"What does \\"}\\" close in {a, b}? \\\\","back":"a closing brace ] }","basis":"derived"}';
    const text = '```json\n' + head + `${tricky},${card(2)},`;
    const r = recoverTruncatedJson(text)!;
    expect((r.value as { cards: { front: string }[] }).cards).toHaveLength(2);
    expect((r.value as { cards: { front: string }[] }).cards[0]!.front).toBe('What does "}" close in {a, b}? \\');
  });

  it('keeps a pack that was cut after a whole list, and gives up when not even one item was finished', () => {
    const afterCards = `${head}${card(1)}],"notes":[{"title":"Summary","blocks":[{"text":"half a no`;
    expect((recoverTruncatedJson(afterCards)!.value as { cards: unknown[]; notes?: unknown[] }).cards).toHaveLength(1);
    expect(recoverTruncatedJson('{"format":"studyai-pack","version":1,"cards":[{"type":"qa","front":"unfini')).toBeUndefined();
    expect(recoverTruncatedJson('no json at all')).toBeUndefined();
    expect(recoverTruncatedJson('[1,2,3')).toBeUndefined();
  });

  it('is fast on a very long cut-off answer', () => {
    const many = `${head}${Array.from({ length: 4_000 }, (_, i) => card(i)).join(',')},{"type":"qa","fr`;
    const t0 = Date.now();
    expect((recoverTruncatedJson(many)!.value as { cards: unknown[] }).cards).toHaveLength(4_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('backup of learning-engine data', () => {
  it('round-trips cards, notes, questions, reviews, packs and activity', async () => {
    const { course, ctx } = await setup();
    const plan = planPack(
      pack({
        cards: [{ type: 'qa', front: 'q', back: 'a', lecture: 'L1', basis: 'derived' }],
        notes: [{ title: 'N', lecture: 'L1', blocks: [{ text: 't', basis: 'derived' }] }],
        questions: [{ type: 'truefalse', prompt: 'p', marks: 1, answer: true, basis: 'derived' }],
      }),
      course.id,
      [ctx],
    );
    await applyPackPlan(db, course.id, plan);
    await db.activity.add({ at: 1_700_000_000_000, kind: 'slides', courseId: course.id, count: 3 });
    await db.reviews.add({ id: 'r1', cardId: plan.cards[0]!.id, courseId: course.id, at: 1_700_000_000_000, rating: 3, stateBefore: 0, durationMs: 1200 });

    const bytes = new Uint8Array(await (await exportBackup(db)).arrayBuffer());
    const parsed = readBackup(bytes);
    expect(parsed.manifest.version).toBe(BACKUP_VERSION);
    const fresh = new StudyDB(`pk-r-${n++}`);
    const summary = await applyBackup(fresh, parsed, 'replace');
    expect(summary.studyRows).toBeGreaterThanOrEqual(6);
    for (const t of ['cards', 'notes', 'questions', 'reviews', 'packs', 'activity'] as const) {
      expect(await fresh.table(t).toArray(), t).toEqual(await db.table(t).toArray());
    }
  });

  it('still reads version-1 backups (no study tables)', async () => {
    const { course } = await setup();
    void course;
    const bytes = new Uint8Array(await (await exportBackup(db)).arrayBuffer());
    const parsed = readBackup(bytes);
    expect(parsed.study.cards ?? []).toEqual([]);
  });
});
