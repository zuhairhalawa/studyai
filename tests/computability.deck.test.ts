import { describe, expect, it } from 'vitest';
import { ScriptedGemini } from '../worker/src/scripted-gemini';
import { parsePptx } from '../src/core/pptx';
import type { ParsedDeck, SlideData } from '../src/core/pptx/model';
import { withPictureText } from '../src/core/pptx/picturetext';
import { buildBlueprint, gatherEvidence, isMathy, slideTraits, splitIntoRequests, type PlannedSlot, type Slot } from '../src/core/study/blueprint';
import { lectureToMarkdown } from '../src/core/study/markdown';
import { planPack, quoteInText, type LectureContext, type PackPlan } from '../src/core/study/pack';
import { slideVerificationText } from '../src/core/study/slide-text';
import { AiTaskSchema } from '../src/core/tutor/contract';
import { slideGaps } from '../src/core/tutor/gaps';
import { slideContextText } from '../src/core/tutor/context';
import { buildAiRequest, TEACHING_NOTES, teachingNotes } from '../src/core/tutor/prompts';
import { computabilityDeck } from './fixtures/computability-deck';

/**
 * A Computability and Complexity lecture (automata, the pumping lemma, Turing machines, decidability, reductions, NP-completeness):
 * formal definitions with tuples and symbols, exponents and subscripts as font baselines, state diagrams as pictures, transition tables.
 * Synthetic (tests/fixtures/computability-deck.ts). What matters here is that a theory course gets theory questions: a proof where
 * there is a proof, a run of a machine where there is a machine, a diagram question once the diagram has words, and no calculation
 * or story where there is none.
 */

let cached: ParsedDeck | undefined;
const load = async (): Promise<ParsedDeck> => (cached ??= await parsePptx(computabilityDeck()));
const slide = (deck: ParsedDeck, n: number): SlideData => deck.slides[n - 1]!;
const markdownOf = (deck: ParsedDeck, slides: SlideData[] = deck.slides) => lectureToMarkdown({ title: 'Computability and complexity', fileHash: deck.fileHash, slideCount: deck.slides.length, meta: deck.meta }, slides, 'L1');
/** The two state diagrams with their words typed, as a student would. */
const withTypedDiagrams = async () => {
  const deck = await load();
  const typed: Record<number, string> = { 5: 'two circles q0 and q1; q0 has a double ring and an arrow in; q0 to q1 labelled 0; q1 to q0 labelled 0; each state loops on 1', 9: 'q0 loops on 0; q0 to q1 on 1; q1 loops on 1; q1 to q_accept on blank' };
  return deck.slides.map((s) => {
    const pic = s.elements.find((e) => e.kind === 'picture');
    return typed[s.index] && pic ? withPictureText(s, pic.id, typed[s.index]!) : s;
  });
};

describe('reading a Computability and Complexity lecture', () => {
  it('reads all 15 slides, the 3 tables, the 2 diagrams and the 2 equations without a failure or a half-understood formula', async () => {
    const deck = await load();
    expect(deck.report).toMatchObject({ totalSlides: 15, processedSlides: 15, failedSlides: 0, tables: 3, pictures: 2, equations: 2 });
    for (const s of deck.slides) for (const e of s.elements) if (e.kind === 'shape') for (const p of e.paragraphs) for (const i of p.inlines) if (i.kind === 'math') expect(i.partial, `slide ${s.index}`).toBe(false);
  });

  it('keeps the symbols, the tuples, the exponents and the subscripts, so the AI sees the definitions as written', async () => {
    const md = markdownOf(await load());
    expect(md).toContain('- An alphabet Σ is a finite set of symbols, for example Σ = {0, 1}');
    expect(md).toContain('- Σ* is the set of all finite strings over Σ; ε is the empty string and |w| is the length of w');
    expect(md).toContain('- A language is a set of strings: L ⊆ Σ*');
    expect(md).toContain('δ: Q × Σ → Q is the transition function, q0 ∈ Q is the start state and F ⊆ Q is the set of accept states');
    expect(md).toContain('- The string w^{R} is w written backwards');
    expect(md).toContain('xy^{i}z ∈ A for every i ≥ 0');
    expect(md).toContain('2. Take s = 0^{p}1^{p}, which is in B and has length at least p.');
    expect(md).toContain('- A_{TM} = { ⟨M, w⟩ | M is a Turing machine that accepts w }');
    expect(md).toContain('5. This contradicts the pumping lemma. Therefore B is not regular. ∎');
    expect(md).toContain('| q0 | 0 | 0 | R | q0 |');
    expect(md).toContain('| q0 (start, accept) | q1 | q0 |');
    expect(md).toContain('[Picture — contents not available as text]');
  });

  it('finds a quote of a definition, with its subscript written either way', async () => {
    const deck = await load();
    const text = slideVerificationText(slide(deck, 10));
    expect(quoteInText('A_{TM} = { ⟨M, w⟩ | M is a Turing machine that accepts w }', text)).toBe(true);
    expect(quoteInText('A TM = { ⟨M, w⟩ | M is a Turing machine that accepts w }', text)).toBe(true);
    expect(quoteInText('M is a Turing machine that rejects w', text)).toBe(false);
  });
});

describe('knowing what is on each slide of a theory lecture', () => {
  it('tells a machine, a proof, a table and a diagram apart, and does not take a definition with symbols for a calculation', async () => {
    const deck = await load();
    const traits = (n: number) => Object.entries(slideTraits(slide(deck, n))).filter(([, v]) => v).map(([k]) => k);
    expect(traits(1)).toEqual([]);
    expect(traits(2)).toEqual([]);
    expect(traits(3)).toEqual(['math']); // Σ = {0, 1}, L ⊆ Σ*: formal, but nothing is worked out
    expect(traits(4)).toEqual(['machine']); // the DFA definition
    expect(traits(5)).toEqual(['machine', 'table', 'diagram']);
    expect(traits(6)).toEqual(['math']); // the lemma's statement
    expect(traits(7)).toEqual(['math', 'proof']); // the proof, with 0^n 1^n and xy²z (exponents, not arithmetic)
    expect(traits(8)).toEqual(['machine']);
    expect(traits(9)).toEqual(['machine', 'table', 'diagram']);
    expect(traits(10)).toEqual(['machine']);
    expect(traits(11)).toEqual(['machine', 'proof']);
    expect(traits(12)).toEqual(['math']);
    expect(traits(13)).toEqual(['math', 'table']); // P = ⋃ TIME(n^k) defines a class
    expect(traits(14)).toEqual([]);
    expect(traits(15)).toEqual([]);
    const e = gatherEvidence(deck.slides);
    expect(e).toMatchObject({ math: 5, arith: 0, machine: 6, proof: 2, diagram: 2, tables: 3, code: 0, algorithm: 0 });
    expect(isMathy(e)).toBe(true);
  });

  it('knows an arithmetic formula from a definition: a recurrence computes, a tuple does not', async () => {
    const { buildPptx, simpleSlide } = await import('./fixtures/pptx-builder');
    const deck = await parsePptx(buildPptx({ slides: [simpleSlide('Recurrence', ['T(n) = 2T(n/2) + n for every n of the form 2^k']), simpleSlide('Tuple', ['A DFA is a tuple (Q, Σ, δ, q0, F) with δ: Q × Σ → Q', 'Σ = {0, 1} and L ⊆ Σ*'])] }));
    expect(slideTraits(deck.slides[0]!).arith).toBe(true);
    expect(slideTraits(deck.slides[1]!).arith).toBe(false);
  });
});

describe('telling the student what a theory slide does not show', () => {
  it('says that the two state diagrams are pictures whose words are not available, and stops once they are typed', async () => {
    const deck = await load();
    const say = (n: number) => slideGaps(slide(deck, n)).map((g) => g.kind);
    expect(say(5)).toEqual(['picture-unread']);
    expect(say(9)).toEqual(['picture-unread']);
    for (const n of [3, 4, 6, 7, 8, 10, 11, 14]) expect(say(n), `slide ${n}`).toEqual([]);
    const typed = await withTypedDiagrams();
    expect(slideGaps(typed[4]!)).toEqual([]);
    expect(slideGaps(typed[8]!)).toEqual([]);
  });
});

describe('teaching a theory lecture', () => {
  it('tells the tutor how to teach a machine, a proof and a table, and only where they are', async () => {
    const deck = await load();
    const h = deck.meta.slideHeight;
    const notesFor = (n: number) => teachingNotes([{ title: slide(deck, n).title, text: slideContextText(slide(deck, n), h) }]);
    expect(notesFor(4)).toEqual([TEACHING_NOTES.machine]);
    expect(notesFor(5)).toContain(TEACHING_NOTES.machine);
    expect(notesFor(5)).toContain(TEACHING_NOTES.table);
    expect(notesFor(8)).toEqual([TEACHING_NOTES.machine]);
    expect(notesFor(7)).toEqual([TEACHING_NOTES.proof]); // a proof with exponents, no formula blocks
    expect(notesFor(11)).toContain(TEACHING_NOTES.proof);
    expect(notesFor(3)).toEqual([]);
    expect(TEACHING_NOTES.machine).toMatch(/trace a computation one step at a time, naming the state, the symbol read and the move or next state/);
    expect(TEACHING_NOTES.machine).toMatch(/Do not add states, transitions or behaviour that the slides do not show/);
  });

  it('asks for the run of a machine, not an invented program, when the question is about a machine', async () => {
    const deck = await load();
    const task = AiTaskSchema.parse({
      task: 'generate',
      lectureMarkdown: markdownOf(deck, [slide(deck, 8), slide(deck, 9)]),
      wants: { notes: false, cards: false, questions: true },
      amount: 'few',
      blueprint: [{ type: 'algorithm', difficulty: 3, marks: 6, points: 6, topic: 'Turing machines', slides: [8, 9] }],
    });
    const sys = buildAiRequest(task, 'gemini-3.1-flash-lite', 4_000).request.system!;
    expect(sys).toMatch(/For a machine or automaton on the slides: ask for its run on a given input \(or for a machine that does a stated job\), one marking point per transition or decision/);
  });
});

describe('planning and checking exam questions for a theory lecture', () => {
  const kindsOf = (plan: Slot[]) => plan.map((s) => s.type);

  it('plans a proof on the proofs, the run of a machine on the machines, a diagram question on the typed diagram, and no calculation or story', async () => {
    const deck = await load();
    const slides = await withTypedDiagrams();
    const plan = buildBlueprint({ slides, topics: deck.report.topics, count: 12 });
    const kinds = kindsOf(plan);
    expect(plan).toHaveLength(12);
    expect(kinds).toEqual(expect.arrayContaining(['proof', 'algorithm', 'diagram']));
    for (const banned of ['calculation', 'scenario', 'case']) expect(kinds, banned).not.toContain(banned);
    const on = (type: string) => plan.filter((s) => s.type === type).flatMap((s) => s.slides);
    expect(on('proof').every((n) => [6, 7, 11].includes(n)), JSON.stringify(on('proof'))).toBe(true);
    expect(on('proof').some((n) => n === 7 || n === 11)).toBe(true);
    expect(on('algorithm').some((n) => [4, 5, 8, 9, 10, 11].includes(n))).toBe(true);
    for (const s of plan.filter((x) => x.type === 'diagram')) expect(s.slides.some((n) => n === 5 || n === 9), JSON.stringify(s)).toBe(true);
    // the outline, the title and the summary are never examined; the formal slides are
    expect(plan.flatMap((s) => s.slides).filter((n) => n === 1 || n === 2 || n === 15)).toEqual([]);
    const covered = new Set(plan.flatMap((s) => s.slides));
    for (const n of [3, 4, 6, 7, 8, 10, 11, 13, 14]) expect(covered.has(n), `slide ${n} is not asked about`).toBe(true);
    expect(new Set(plan.map((s) => s.difficulty)).size).toBe(3);
  });

  it('follows a professor who wants proofs and machines, or no proofs', async () => {
    const deck = await load();
    const heavy = kindsOf(buildBlueprint({ slides: deck.slides, topics: deck.report.topics, count: 8, examStyle: 'Most questions are proofs and traces of machines.' }));
    expect(heavy.filter((k) => k === 'proof' || k === 'algorithm').length).toBeGreaterThanOrEqual(4);
    expect(kindsOf(buildBlueprint({ slides: deck.slides, topics: deck.report.topics, count: 8, examStyle: 'No proofs.' }))).not.toContain('proof');
  });

  async function ask(group: readonly Slot[], slides: SlideData[], deck: ParsedDeck): Promise<PackPlan> {
    const planned: PlannedSlot[] = group.map(({ n: _n, ...rest }) => rest);
    const task = AiTaskSchema.parse({ task: 'generate', lectureMarkdown: markdownOf(deck, slides), wants: { notes: false, cards: false, questions: true }, amount: 'normal', blueprint: planned });
    const { request } = buildAiRequest(task, 'gemini-3.1-flash-lite', 4_000);
    const out = await new ScriptedGemini().complete({ model: request.model, maxOutputTokens: request.maxOutputTokens, messages: request.messages, ...(request.system ? { system: request.system } : {}) }, new AbortController().signal);
    if (out.kind !== 'ok') throw new Error('the scripted model did not answer');
    const ctx: LectureContext = { id: 'lec', title: 'Computability and complexity', fileHash: deck.fileHash, revision: 1, slideCount: 15, slideText: (n) => (slides[n - 1] ? slideVerificationText(slides[n - 1]!) : undefined) };
    return planPack(JSON.parse(out.text), 'course', [ctx], {}, 0, { expected: planned });
  }

  it('turns the plan into questions that pass every structural check, each marking point answering an ask', async () => {
    const deck = await load();
    const slides = await withTypedDiagrams();
    const plan = buildBlueprint({ slides, topics: deck.report.topics, count: 10 });
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
  });
});
