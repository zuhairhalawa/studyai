import { describe, expect, it } from 'vitest';
import { ScriptedGemini } from '../worker/src/scripted-gemini';
import { parsePptx } from '../src/core/pptx';
import type { ParsedDeck, SlideData } from '../src/core/pptx/model';
import { withPictureText } from '../src/core/pptx/picturetext';
import { buildBlueprint, isMathy, gatherEvidence, slideTraits, splitIntoRequests, type PlannedSlot, type Slot } from '../src/core/study/blueprint';
import { lectureToMarkdown } from '../src/core/study/markdown';
import { planPack, quoteInText, type LectureContext, type PackPlan } from '../src/core/study/pack';
import { slideVerificationText } from '../src/core/study/slide-text';
import { AiTaskSchema } from '../src/core/tutor/contract';
import { slideGaps } from '../src/core/tutor/gaps';
import { slideContextText } from '../src/core/tutor/context';
import { lessonParts } from '../src/core/tutor/lesson';
import { buildAiRequest, escapeData, TEACHING_NOTES, teachingNotes } from '../src/core/tutor/prompts';
import { buildPptx, simpleSlide } from './fixtures/pptx-builder';
import { mathDeck } from './fixtures/math-deck';

/**
 * A mathematical lecture (formulas, a proof by induction, a recurrence, pseudocode, a table, a matrix, a diagram, notation):
 * extraction, how the app knows what is on each slide, what it tells the student the slides do not say, how it plans and checks
 * exam questions, and how the tutor is told to teach it. The deck is synthetic (tests/fixtures/math-deck.ts).
 */

let cached: ParsedDeck | undefined;
const load = async (): Promise<ParsedDeck> => (cached ??= await parsePptx(mathDeck()));
const slide = (deck: ParsedDeck, n: number): SlideData => deck.slides[n - 1]!;
const mathOf = (s: SlideData) => s.elements.flatMap((e) => (e.kind === 'shape' ? e.paragraphs.flatMap((p) => p.inlines.flatMap((i) => (i.kind === 'math' ? [i] : []))) : []));
const markdownOf = (deck: ParsedDeck, slides: SlideData[] = deck.slides) => lectureToMarkdown({ title: 'Divide and conquer', fileHash: deck.fileHash, slideCount: deck.slides.length, meta: deck.meta }, slides, 'L1');
const typedRecursionTree = async () => {
  const deck = await load();
  const s = slide(deck, 10);
  const pic = s.elements.find((e) => e.kind === 'picture');
  return deck.slides.map((x) => (x.index === 10 && pic ? withPictureText(x, pic.id, 'T(n) at the root, two children T(n/2), four grandchildren T(n/4); every level does n work in all') : x));
};

describe('reading a mathematical lecture', () => {
  it('reads all twelve slides, the seven formulas, the table and the picture, with nothing failed or half-understood', async () => {
    const deck = await load();
    expect(deck.report).toMatchObject({ totalSlides: 12, processedSlides: 12, failedSlides: 0, equations: 7, tables: 1, pictures: 1 });
    for (const s of deck.slides) for (const m of mathOf(s)) expect(m.partial, `slide ${s.index}: ${m.latex}`).toBe(false);
  });

  it('keeps a formula as LaTeX for the AI and the screen, and as readable text for search', async () => {
    const deck = await load();
    const [sum] = mathOf(slide(deck, 4));
    expect(sum!.latex).toBe('\\sum_{i=1}^{n} {i} = \\frac{n(n+1)}{2}');
    expect(sum!.plain).toBe('∑_(i=1)^n i=(n(n+1))/2');
    const [recurrence, bound] = mathOf(slide(deck, 6));
    expect(recurrence!.latex).toBe('T \\left( n \\right) =2 T \\left( \\frac{n}{2} \\right) +n');
    // a function name is set apart from what precedes it ("n log n", not "nlog n") in both forms
    expect(bound!.plain).toContain('n log n');
    expect(bound!.latex).toContain('\\log');
    const [cases] = mathOf(slide(deck, 7));
    expect(cases!.latex).toContain('\\text{if }');
    expect(cases!.latex).toContain('\\log');
    const [matrix] = mathOf(slide(deck, 11));
    expect(matrix!.latex).toBe('\\begin{matrix} a & b \\\\ c & d \\end{matrix}');
    expect(slide(deck, 4).text).toContain('∑_(i=1)^n i=(n(n+1))/2'); // searchable
  });

  it('exports the whole lecture for the AI: formulas in $$ blocks, pseudocode with its indentation, the table as a table, symbols intact', async () => {
    const md = markdownOf(await load());
    expect(md).toContain('$$\\sum_{i=1}^{n} {i} = \\frac{n(n+1)}{2}$$');
    expect(md).toContain('$$\\sum_{i=1}^{k+1} {i} = \\frac{\\left( k+1 \\right) \\left( k+2 \\right)}{2}$$');
    expect(md).toContain('`MERGE-SORT(A, p, r)`\n`  if p < r`\n`    q = floor((p + r) / 2)`');
    expect(md).toContain('| Insertion sort | O(n) | O(n²) | O(1) |');
    expect(md).toContain('- ℕ is the set of natural numbers {1, 2, 3, …}');
    expect(md).toContain('- A ⊆ B means every element of A is also in B; ∅ is the empty set');
    expect(md).toContain('f(n) ∈ Θ(g(n))');
    expect(md).toContain('1. Base case: n = 1.'); // the proof's steps stay numbered and in order
    expect(md.indexOf('Base case')).toBeLessThan(md.indexOf('Inductive hypothesis'));
    expect(md.indexOf('Inductive hypothesis')).toBeLessThan(md.indexOf('Inductive step'));
    expect(md).toContain('**Speaker notes:** Draw the n = 1 case on the board');
  });

  it('keeps the characters < > & as they are on the slide, and sends them escaped so a slide cannot add instructions', async () => {
    const deck = await load();
    const md = markdownOf(deck, [slide(deck, 8)]);
    expect(md).toContain('if p < r');
    const task = AiTaskSchema.parse({ task: 'generate', lectureMarkdown: md, wants: { notes: false, cards: false, questions: true }, amount: 'few' });
    const user = buildAiRequest(task, 'gemini-3.1-flash-lite', 4_000).request.messages[0]!.content;
    expect(user).toContain('if p &lt; r');
    expect(user).not.toContain('if p < r');
    expect(escapeData('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });
});

describe('checking quotes of formulas, code and special characters', () => {
  it('finds a quote of an equation written as LaTeX, as text, or with the escapes the model was shown', async () => {
    const deck = await load();
    const text = (n: number) => slideVerificationText(slide(deck, n));
    expect(quoteInText('\\sum_{i=1}^{n} {i} = \\frac{n(n+1)}{2}', text(4))).toBe(true);
    expect(quoteInText('$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$', text(4))).toBe(true);
    expect(quoteInText('i=(n(n+1))/2', text(4))).toBe(true);
    expect(quoteInText('\\begin{matrix} a & b \\\\ c & d \\end{matrix}', text(11))).toBe(true);
    expect(quoteInText('\\begin{matrix} a &amp; b \\\\ c &amp; d \\end{matrix}', text(11))).toBe(true);
    expect(quoteInText('if p < r', text(8))).toBe(true);
    expect(quoteInText('if p &lt; r', text(8))).toBe(true); // copied with the escape it was shown with
    expect(quoteInText('Let a ≥ 1 and b &gt; 1 be constants', text(7))).toBe(true);
    expect(quoteInText('q = floor((p + r) / 2)', text(8))).toBe(true);
    expect(quoteInText('The determinant is the sum of the diagonal plus one', text(11))).toBe(false); // words that are not there are still caught
    expect(quoteInText('\\frac{n(n+2)}{2}', text(4))).toBe(false); // so is a formula with a changed number
  });

  it('marks such a quote verified in the import check, and one with a changed formula not', async () => {
    const deck = await load();
    const ctx: LectureContext = { id: 'L', title: 'Divide and conquer', fileHash: deck.fileHash, revision: 1, slideCount: 12, slideText: (n) => (deck.slides[n - 1] ? slideVerificationText(deck.slides[n - 1]!) : undefined) };
    const card = (slideNo: number, quote: string) => ({ type: 'qa', front: 'q', back: 'a', basis: 'lecture', sources: [{ lecture: 'L1', slide: slideNo, quote }] });
    const raw = { format: 'studyai-pack', version: 1, lectures: [{ ref: 'L1', title: 'Divide and conquer' }], cards: [card(4, '\\frac{n(n+1)}{2}'), card(8, 'if p &lt; r'), card(4, '\\frac{n(n+2)}{2}')] };
    expect(planPack(raw, 'c', [ctx], {}, 0).cards.map((c) => c.sources[0]!.verified)).toEqual([true, true, false]);
  });
});

describe('knowing what is on each slide of a mathematical lecture', () => {
  it('tells formulas, proofs, pseudocode, tables and pictures apart, without mistaking a complexity, a set or a summary for them', async () => {
    const deck = await load();
    const traits = (n: number) => Object.entries(slideTraits(slide(deck, n))).filter(([, v]) => v).map(([k]) => k);
    expect(traits(2)).toEqual([]); // objectives mention "prove" and "induction"
    expect(traits(3)).toEqual([]); // notation: O(g(n)) and {1, 2, 3} are not an algorithm or code
    expect(traits(4)).toEqual(['math', 'arith']);
    expect(traits(5)).toEqual(['math', 'arith', 'proof']);
    expect(traits(6)).toEqual(['math', 'arith']);
    expect(traits(7)).toEqual(['math']); // a theorem's statement is not a proof, and its formulas state a bound, they compute nothing
    expect(traits(8)).toEqual(['code', 'algorithm']); // from the monospaced lines, not from the word
    expect(traits(9)).toEqual(['table']); // O(n log n) is a result, not a procedure
    expect(traits(10)).toEqual(['diagram']);
    expect(traits(11)).toEqual(['math', 'arith']);
    expect(traits(12)).toEqual([]); // "Induction proves closed forms", "the master theorem": a summary
    const e = gatherEvidence(deck.slides);
    expect(e).toMatchObject({ math: 5, tables: 1, code: 1, algorithm: 1, proof: 1, diagram: 1 });
    expect(isMathy(e)).toBe(true);
  });
});

describe('a course that types its formulas as text instead of using the equation editor', () => {
  it('still finds the formulas, and does not take a stray equals sign, a sentence or code for one', async () => {
    const deck = await parsePptx(
      buildPptx({
        slides: [
          simpleSlide('Quadratic equations', ['The solutions of a x² + b x + c = 0 are', 'x = (−b ± √(b² − 4ac)) / 2a', 'The discriminant is b² − 4ac']),
          simpleSlide('Recurrences', ['T(n) = 2T(n/2) + n', 'The running time of merge sort satisfies this recurrence']),
          simpleSlide('A worked example', ['After the first step the sum = 7178 and nothing more is written there', 'The value n = 1 starts the argument in this case']),
          simpleSlide('Plain prose', ['Divide and conquer splits a problem into smaller problems of the same kind', 'It solves them recursively and combines the answers into one']),
        ],
      }),
    );
    const math = (n: number) => slideTraits(slide(deck, n)).math;
    expect([1, 2, 3, 4].map(math)).toEqual([true, true, false, false]);
    expect(isMathy(gatherEvidence(deck.slides))).toBe(true); // half of its slides are formulas
    const oneFormula = await parsePptx(buildPptx({ slides: [...Array.from({ length: 5 }, (_, i) => simpleSlide(`Topic ${i + 1}`, ['Divide and conquer splits a problem into smaller problems of the same kind', 'It solves them recursively and combines the answers into one'])), simpleSlide('One formula', ['T(n) = 2T(n/2) + n', 'Merge sort satisfies this recurrence and nothing else is claimed here'])] }));
    expect(isMathy(gatherEvidence(oneFormula.slides))).toBe(false); // one formula slide among six does not make a mathematical lecture
    // the code slide of the real deck is not mistaken for formulas: q = floor((p + r) / 2) has two operators but is set as code
    expect(slideTraits(slide(await load(), 8)).math).toBe(false);
  });
});

describe('telling the student what a mathematical slide does not explain', () => {
  it('names the symbols a formula uses that the slide never mentions, and leaves alone a slide that introduces its symbols', async () => {
    const deck = await load();
    const say = (n: number) => slideGaps(slide(deck, n)).map((g) => `${g.kind}: ${g.message}`);
    // the sum: n is in the claim, but the index i is never introduced; the board is mentioned in the notes
    expect(say(4)).toEqual([
      expect.stringMatching(/^refers-elsewhere: .*“on the board”/),
      'formula-undefined: Slide 4 (“Sum of the first n integers”) has a formula, and the slide does not say what its symbols mean (not explained: i).',
    ]);
    // T and n are introduced by "running time T(n)"; c is a constant nobody introduces
    expect(say(6)[0]).toMatch(/^formula-undefined: .*\(not explained: c, b\)\.$/);
    expect(say(5)).toEqual([]); // the proof uses n and k in its own words
    expect(say(7)).toEqual([]); // "Let a ≥ 1 and b > 1 be constants and let T(n) = aT(n/b) + f(n)"
    expect(say(8)).toEqual([]);
    expect(say(9)).toEqual([]);
    expect(say(10)).toEqual([expect.stringMatching(/^picture-unread: /)]); // the recursion tree is a picture
  });

  it('knows a typed diagram is no longer a hole', async () => {
    const slides = await typedRecursionTree();
    expect(slideGaps(slides[9]!)).toEqual([]);
    expect(slideTraits(slides[9]!).diagram).toBe(true);
  });
});

describe('teaching a mathematical lecture', () => {
  it('gives the tutor the formulas as LaTeX and the notes for exactly what is on the slides', async () => {
    const deck = await load();
    const h = deck.meta.slideHeight;
    const notesFor = (n: number) => teachingNotes([{ title: slide(deck, n).title, text: slideContextText(slide(deck, n), h) }]);
    expect(slideContextText(slide(deck, 4), h)).toContain('$$\\sum_{i=1}^{n} {i} = \\frac{n(n+1)}{2}$$');
    expect(notesFor(4)).toEqual([TEACHING_NOTES.formula]);
    expect(notesFor(5)).toEqual([TEACHING_NOTES.formula, TEACHING_NOTES.derivation, TEACHING_NOTES.proof]); // numbered steps of a proof with a formula
    expect(notesFor(8)).toEqual([TEACHING_NOTES.algorithm]); // pseudocode set in code, under the heading "Algorithm: merge sort"
    expect(notesFor(9)).toContain(TEACHING_NOTES.table);
    expect(notesFor(3)).toEqual([]);
    expect(TEACHING_NOTES.derivation).toMatch(/say that the step is skipped on the slide/);
    expect(TEACHING_NOTES.derivation).toMatch(/LaTeX between \$ signs and do not change a formula/);
  });

  it('builds a tutor request whose rules, notes and gaps all say: only what the slides say', async () => {
    const deck = await load();
    const h = deck.meta.slideHeight;
    const picked = [4, 5, 8];
    const task = {
      task: 'tutor' as const,
      mode: 'steps' as const,
      question: 'Teach me the sum and its proof.',
      excerpts: picked.map((n, i) => ({ ref: `S${i + 1}`, lectureTitle: 'Divide and conquer', slide: n, title: slide(deck, n).title, text: slideContextText(slide(deck, n), h) })),
      history: [],
      gaps: picked.flatMap((n) => slideGaps(slide(deck, n)).map((g) => g.message)),
    };
    const { request } = buildAiRequest(AiTaskSchema.parse(task), 'gemini-3.1-flash-lite', 4_000);
    const sys = request.system!;
    expect(sys).toContain('TEACHING NOTES FOR THESE SLIDES');
    for (const note of [TEACHING_NOTES.formula, TEACHING_NOTES.derivation, TEACHING_NOTES.proof, TEACHING_NOTES.algorithm]) expect(sys).toContain(note);
    expect(sys).toContain('(not explained: i)');
    expect(sys).toContain('$$\\sum_{i=1}^{n} {i} = \\frac{n(n+1)}{2}$$');
    expect(sys).toContain('`  if p &lt; r`'); // the pseudocode arrives with its indentation, and escaped
    expect(sys).toMatch(/Mathematics in \$\.\.\.\$ LaTeX/);
  });

  it('teaches the lecture in order, in parts of a few slides, without losing any slide', async () => {
    const deck = await load();
    const parts = lessonParts(deck.report.topics, deck.slides.length);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.flatMap((p) => p.slides)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(Math.max(...parts.map((p) => p.slides.length))).toBeLessThanOrEqual(4);
  });
});

describe('planning and checking exam questions for a mathematical lecture', () => {
  const topicsOf = (deck: ParsedDeck) => deck.report.topics;
  const kindsOf = (plan: Slot[]) => plan.map((s) => s.type);

  it('plans things to work out, each on the slide that has what it needs: a proof on the proof, a trace on the code, a comparison on the table', async () => {
    const deck = await load();
    const plan = buildBlueprint({ slides: deck.slides, topics: topicsOf(deck), count: 10 });
    const kinds = kindsOf(plan);
    expect(plan).toHaveLength(10);
    expect(kinds).toEqual(expect.arrayContaining(['proof', 'algorithm', 'compare']));
    expect(kinds.some((k) => k === 'calculation' || k === 'problem')).toBe(true);
    // a story about a notation slide is not an exam question in this lecture
    expect(kinds).not.toContain('scenario');
    expect(kinds).not.toContain('case');
    const on = (type: string) => plan.filter((s) => s.type === type).map((s) => s.slides);
    expect(on('proof')).toEqual([[5]]);
    expect(on('algorithm').every((s) => s.includes(8))).toBe(true);
    expect(on('compare').some((s) => s.includes(9))).toBe(true);
    for (const s of plan.filter((x) => x.type === 'calculation' || x.type === 'problem')) expect(s.slides.some((n) => slideTraits(slide(deck, n)).math), JSON.stringify(s)).toBe(true);
    // the title, the objectives and the summary are never examined; a formula slide counts as content
    expect(plan.flatMap((s) => s.slides).filter((n) => n === 1 || n === 2 || n === 12)).toEqual([]);
    const covered = new Set(plan.flatMap((s) => s.slides));
    for (const n of [3, 4, 5, 6, 7, 8, 9, 11]) expect(covered.has(n), `slide ${n} is not asked about`).toBe(true);
  });

  it('gives every question about as many marking points as the slides hold separate ideas, and harder questions more marks', async () => {
    const deck = await load();
    const plan = buildBlueprint({ slides: deck.slides, topics: topicsOf(deck), count: 10 });
    for (const s of plan) {
      expect(s.points, JSON.stringify(s)).toBeLessThanOrEqual(Math.max(1, s.marks));
      if (s.type !== 'mcq' && s.type !== 'truefalse') expect(s.difficulty >= 3 && s.marks <= 2, JSON.stringify(s)).toBe(false);
    }
    expect(new Set(plan.map((s) => s.difficulty)).size).toBe(3);
  });

  it('follows a professor who wants proofs and calculations, or none', async () => {
    const deck = await load();
    const heavy = kindsOf(buildBlueprint({ slides: deck.slides, topics: topicsOf(deck), count: 8, examStyle: 'Most questions are proofs and calculations.' }));
    expect(heavy.filter((k) => k === 'proof' || k === 'calculation' || k === 'problem').length).toBeGreaterThanOrEqual(4);
    const none = kindsOf(buildBlueprint({ slides: deck.slides, topics: topicsOf(deck), count: 8, examStyle: 'No proofs and no multiple choice.' }));
    expect(none).not.toContain('proof');
    expect(none).not.toContain('mcq');
  });

  it('does not plan a proof or a trace for a lecture that has none', async () => {
    const deck = await load();
    const noProof = deck.slides.filter((s) => s.index !== 5);
    expect(kindsOf(buildBlueprint({ slides: noProof, topics: topicsOf(deck), count: 10 }))).not.toContain('proof');
    const noCode = deck.slides.filter((s) => s.index !== 8);
    expect(kindsOf(buildBlueprint({ slides: noCode, topics: topicsOf(deck), count: 10 }))).not.toContain('algorithm');
  });

  /** One request through the real server-side prompt and the scripted model, then the real import check. */
  async function ask(group: readonly Slot[], slides: SlideData[], deck: ParsedDeck): Promise<PackPlan> {
    const planned: PlannedSlot[] = group.map(({ n: _n, ...rest }) => rest);
    const task = AiTaskSchema.parse({ task: 'generate', lectureMarkdown: markdownOf(deck, slides), wants: { notes: false, cards: false, questions: true }, amount: 'normal', blueprint: planned });
    const { request } = buildAiRequest(task, 'gemini-3.1-flash-lite', 4_000);
    const out = await new ScriptedGemini().complete({ model: request.model, maxOutputTokens: request.maxOutputTokens, messages: request.messages, ...(request.system ? { system: request.system } : {}) }, new AbortController().signal);
    if (out.kind !== 'ok') throw new Error('the scripted model did not answer');
    const ctx: LectureContext = { id: 'lec', title: 'Divide and conquer', fileHash: deck.fileHash, revision: 1, slideCount: 12, slideText: (n) => (slides[n - 1] ? slideVerificationText(slides[n - 1]!) : undefined) };
    return planPack(JSON.parse(out.text), 'course', [ctx], {}, 0, { expected: planned });
  }

  it('turns the plan into questions that pass every structural check, with the cited quotes found on the slides', async () => {
    const deck = await load();
    const slides = await typedRecursionTree();
    const plan = buildBlueprint({ slides, topics: topicsOf(deck), count: 10 });
    const packs: PackPlan[] = [];
    for (const g of splitIntoRequests(plan, 4_000)) packs.push(await ask(g, slides, deck));
    const questions = packs.flatMap((p) => p.questions);
    expect(questions).toHaveLength(10);
    for (const p of packs) {
      expect(p.quality?.stats.asPlanned?.met).toBe(p.quality?.stats.asPlanned?.of);
      expect(p.issues.filter((i) => i.severity === 'error')).toEqual([]);
      const faults = (p.quality?.issues ?? []).filter((i) => !/^(NO_HARD|ONLY_RECALL|ONE_TYPE|ONE_DIFFICULTY|DUPLICATE|POINT_NOT_ON_SLIDES)$/.test(i.code));
      expect(faults, JSON.stringify(faults)).toEqual([]);
    }
    expect(new Set(questions.map((q) => q.type)).size).toBeGreaterThanOrEqual(5);
    expect(questions.every((q) => q.sources.every((s) => s.verified !== false))).toBe(true);
  });
});
