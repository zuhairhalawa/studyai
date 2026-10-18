import { describe, expect, it } from 'vitest';
import { ScriptedGemini } from '../worker/src/scripted-gemini';
import { parsePptx } from '../src/core/pptx';
import type { SlideData } from '../src/core/pptx/model';
import { withPictureText } from '../src/core/pptx/picturetext';
import { buildBlueprint, slideTraits, splitIntoRequests, type PlannedSlot, type Slot } from '../src/core/study/blueprint';
import { lectureToMarkdown } from '../src/core/study/markdown';
import { planPack, type LectureContext, type PackPlan } from '../src/core/study/pack';
import { RECALL_TYPES } from '../src/core/study/pack-quality';
import { AiTaskSchema } from '../src/core/tutor/contract';
import { buildAiRequest } from '../src/core/tutor/prompts';
import { PNG_1X1, bodySp, buildPptx, equationShape, mr, para, picture, simpleSlide, tableFrame, titleSp, type DeckSpec } from './fixtures/pptx-builder';

/**
 * Evaluates exam generation without any AI: the plan, the real server-side prompt, a scripted model that reads that prompt, and
 * the real import check. It measures what the task is about (diversity of kinds, difficulty, marking points, slide coverage) and
 * shows that the same checks flag a model that only writes recall questions. Synthetic lectures only.
 */

const img = { rels: { rIdImg1: ['image', '../media/image1.png'] as [string, string] }, parts: { 'ppt/media/image1.png': PNG_1X1 } };

/** A security-flavoured lecture with distinct, realistic bullets, grouped in four topics of two slides. */
const SECURITY: DeckSpec = {
  slides: [
    simpleSlide('Firewalls', ['A firewall filters network traffic using a list of rules', 'It blocks packets that come from untrusted addresses', 'Every blocked attempt is written to a log for later review']),
    simpleSlide('Proxies', ['A proxy server sits between users and the internet', 'It hides the internal addresses of the company network', 'It can cache popular pages to save bandwidth for everybody']),
    simpleSlide('Encryption', ['Encryption protects data in transit from anyone listening on the network', 'Symmetric encryption uses one shared secret key', 'Asymmetric encryption uses a public key and a private key']),
    simpleSlide('Hashing', ['A hash turns data of any size into a short fixed value', 'The same input always gives the same hash value', 'It is practically impossible to recover the input from a hash']),
    simpleSlide('Authentication', ['Authentication proves who a user is before access is granted', 'A password is something you know and a token is something you have', 'A fingerprint is something you are and cannot easily be shared']),
    simpleSlide('Authorisation', ['Authorisation decides what an authenticated user is allowed to do', 'Least privilege gives a user only the access the job needs', 'Roles group permissions so that they are easy to review']),
    simpleSlide('Logging', ['A log records events such as logins and failed access attempts', 'Logs must be protected so that an attacker cannot erase traces', 'Regular reviews of the logs find attacks that were missed']),
    simpleSlide('Patching', ['A patch fixes a known vulnerability in the software', 'Attackers scan for systems that have not been patched yet', 'A tested rollout plan avoids breaking services with a bad patch']),
  ],
};
const SECURITY_TOPICS = [
  { title: 'Network defences', startSlide: 1, endSlide: 2 },
  { title: 'Cryptography', startSlide: 3, endSlide: 4 },
  { title: 'Access control', startSlide: 5, endSlide: 6 },
  { title: 'Operations', startSlide: 7, endSlide: 8 },
];

/** A lecture with a formula, a theorem and its proof, an algorithm, a table and a diagram. */
const MATHS: DeckSpec = {
  slides: [
    { shapes: titleSp(2, 'Scaling') + equationShape(5, `<m:f><m:num>${mr('a')}</m:num><m:den>${mr('b')}</m:den></m:f>`) + bodySp(3, [para('where a is the new size and b is the old size of the object being scaled')]) },
    simpleSlide('Halting', ['Theorem: no program decides for every program and input whether it halts', 'Proof by contradiction assumes such a decider exists and builds a program that defeats it', 'The contradiction shows that no such decider can exist']),
    simpleSlide('Sorting', ['Algorithm: selection sort', 'Step 1 find the smallest item in the unsorted part of the list', 'Step 2 swap it with the first unsorted item and repeat for the rest']),
    { shapes: titleSp(2, 'Classes') + tableFrame(4, [['Class', 'Verify', 'Solve'], ['P', 'fast', 'fast'], ['NP', 'fast', 'unknown']]) + bodySp(3, [para('The table compares how hard it is to verify an answer and to find one')]) },
    { shapes: titleSp(2, 'The machine') + bodySp(3, [para('A machine has a tape and a head that reads and writes one symbol at a time')]) + picture(4, 'rIdImg1', 4500000, 1800000, 3800000, 3600000), ...img },
    simpleSlide('Variants', ['A variant with several tapes computes the same functions as one tape', 'A nondeterministic variant may try several moves at once and accepts if one works', 'Neither variant computes anything that the basic machine cannot']),
  ],
};
const MATHS_TOPICS = MATHS.slides.map((_, i) => ({ title: ['Scaling', 'Halting problem', 'Sorting', 'Complexity classes', 'Machines', 'Variants'][i]!, startSlide: i + 1, endSlide: i + 1 }));

async function load(spec: DeckSpec, picture?: { slide: number; text: string }) {
  const deck = await parsePptx(buildPptx(spec));
  const slides: SlideData[] = deck.slides.map((s) => {
    if (picture && s.index === picture.slide) {
      const pic = s.elements.find((e) => e.kind === 'picture');
      if (pic) return withPictureText(s, pic.id, picture.text);
    }
    return s;
  });
  const markdown = (selected: SlideData[]) => lectureToMarkdown({ title: 'Lecture', fileHash: deck.fileHash, slideCount: slides.length, meta: deck.meta }, selected, 'L1');
  const ctx: LectureContext = {
    id: 'lec-1',
    title: 'Lecture',
    fileHash: deck.fileHash,
    revision: 1,
    slideCount: slides.length,
    slideText: (n) => (slides[n - 1] ? `${slides[n - 1]!.title}\n${slides[n - 1]!.text}\n${slides[n - 1]!.notes}` : undefined),
  };
  return { slides, markdown, ctx };
}

/** One request through the real server-side prompt and the scripted model, then the real import check. */
async function ask(group: readonly Slot[], lecture: Awaited<ReturnType<typeof load>>, alreadyAsked: string[] = []): Promise<PackPlan> {
  const planned: PlannedSlot[] = group.map(({ n: _n, ...rest }) => rest);
  const task = AiTaskSchema.parse({ task: 'generate', lectureMarkdown: lecture.markdown(lecture.slides), wants: { notes: false, cards: false, questions: true }, amount: 'normal', blueprint: planned, ...(alreadyAsked.length ? { alreadyAsked } : {}) });
  const { request } = buildAiRequest(task, 'gemini-3.1-flash-lite', 4_000);
  const outcome = await new ScriptedGemini().complete({ model: request.model, maxOutputTokens: request.maxOutputTokens, messages: request.messages, ...(request.system ? { system: request.system } : {}) }, new AbortController().signal);
  if (outcome.kind !== 'ok') throw new Error('the scripted model did not answer');
  return planPack(JSON.parse(outcome.text), 'course', [lecture.ctx], {}, 0, { expected: planned, existingPrompts: alreadyAsked });
}

/** Faults of the kind that make an exam unfair to mark or badly built (not advice about the mix). */
const STRUCTURAL = /^(POINTS_FEW|POINTS_MANY|POINT_BUNDLE|POINTS_OVERLAP|POINTS_NOT_INDEPENDENT|POINT_EITHER|NO_MODEL_ANSWER|NO_RUBRIC|ANSWER_MISSES_POINT|ANSWER_THIN|ANSWER_LONG|POINT_NOT_ON_SLIDES|TYPE_MISMATCH|DIFFICULTY_MARKS|DUPLICATE)$/;
const faults = (p: PackPlan) => (p.quality?.issues ?? []).filter((i) => STRUCTURAL.test(i.code));

describe('exam generation, planned: a security lecture', () => {
  it('produces questions of several kinds and all three difficulties, that match the plan and pass the structural checks', async () => {
    const lecture = await load(SECURITY);
    const plan = buildBlueprint({ slides: lecture.slides, topics: SECURITY_TOPICS, count: 8 });
    const groups = splitIntoRequests(plan, 4_000);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const packs: PackPlan[] = [];
    for (const g of groups) packs.push(await ask(g, lecture));
    const questions = packs.flatMap((p) => p.questions);
    expect(questions).toHaveLength(8);

    // diversity: not just recall
    const kinds = new Set(questions.map((q) => q.type));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    expect(questions.filter((q) => RECALL_TYPES.has(q.type)).length / questions.length).toBeLessThanOrEqual(0.5);
    // difficulty means something: the harder, the more marks
    expect(new Set(questions.map((q) => q.difficulty)).size).toBe(3);
    const mean = (d: number) => {
      const m = questions.filter((q) => q.difficulty === d && !['mcq', 'truefalse'].includes(q.type)).map((q) => q.marks);
      return m.reduce((a, b) => a + b, 0) / Math.max(1, m.length);
    };
    expect(mean(3)).toBeGreaterThan(mean(2));
    expect(mean(2)).toBeGreaterThan(mean(1));
    // marking points: about one per mark, adding up exactly
    for (const q of questions.filter((x) => x.rubric.length > 0)) {
      expect(q.rubric.reduce((n, r) => n + r.marks, 0)).toBeCloseTo(q.marks, 5);
      expect(Math.abs(q.rubric.length - q.marks)).toBeLessThanOrEqual(1);
    }
    // coverage: the questions cite most of the lecture
    const cited = new Set(questions.flatMap((q) => q.sources.map((s) => s.slide)));
    expect(cited.size).toBeGreaterThanOrEqual(5);
    // topics: copied exactly, so the exam builder can filter by them
    for (const q of questions) expect(SECURITY_TOPICS.map((t) => t.title)).toContain(q.topic);
    // the import check agrees: as planned, and no structural fault
    for (const p of packs) {
      expect(p.quality?.stats.asPlanned?.met).toBe(p.quality?.stats.asPlanned?.of);
      expect(faults(p), JSON.stringify(faults(p))).toEqual([]);
      expect(p.stats.rejected).toBe(0);
    }
  });

  it('asks again for what is missing: a second round skips what the first round covered, and never repeats a question', async () => {
    const lecture = await load(SECURITY);
    const first = buildBlueprint({ slides: lecture.slides, topics: SECURITY_TOPICS, count: 4 });
    const pack1 = await ask(first, lecture);
    const bank = pack1.questions.map((q) => ({ topic: q.topic, slides: q.sources.map((s) => s.slide), type: q.type, prompt: q.prompt }));
    const second = buildBlueprint({ slides: lecture.slides, topics: SECURITY_TOPICS, count: 4, existing: bank });
    const firstSlides = new Set(first.flatMap((s) => s.slides));
    const secondSlides = new Set(second.flatMap((s) => s.slides));
    // the second round reaches every slide the first one left, and the two rounds together cover the whole lecture
    const left = lecture.slides.map((s) => s.index).filter((n) => !firstSlides.has(n));
    expect(left.length).toBeGreaterThanOrEqual(1);
    for (const n of left) expect(secondSlides.has(n), `slide ${n} was left by round one`).toBe(true);
    // as the dialog does: each earlier question is trimmed to 200 characters before it is sent
    const pack2 = await ask(second, lecture, bank.map((b) => b.prompt.replace(/\s+/g, ' ').trim().slice(0, 200)));
    const all = [...pack1.questions, ...pack2.questions];
    expect(all).toHaveLength(8);
    expect(new Set(all.map((q) => q.prompt)).size).toBe(8); // no repeats
    expect(faults(pack2).filter((f) => f.code === 'DUPLICATE')).toEqual([]);
    const cited = new Set(all.flatMap((q) => q.sources.map((s) => s.slide)));
    expect(cited.size).toBe(lecture.slides.length); // together they cover every slide
  });

  it('follows the professor: no multiple choice or true/false, short answers, and the plan says so', async () => {
    const lecture = await load(SECURITY);
    const plan = buildBlueprint({ slides: lecture.slides, topics: SECURITY_TOPICS, count: 6, examStyle: 'No multiple choice. Do not ask true/false. Answers are 1-3 sentences.' });
    const pack = (await Promise.all(splitIntoRequests(plan, 4_000).map((g) => ask(g, lecture)))).flatMap((p) => p.questions);
    expect(pack.some((q) => q.type === 'mcq' || q.type === 'truefalse')).toBe(false);
    for (const q of pack) expect(q.marks).toBeLessThanOrEqual(3);
  });
});

describe('exam generation, planned: a lecture with a formula, a proof, an algorithm, a table and a diagram', () => {
  it('asks the kinds of question the material supports, each built on a slide that has what it needs', async () => {
    const lecture = await load(MATHS, { slide: 5, text: 'tape (infinite)\nhead (arrow pointing at one cell)\nstate: q0' });
    const plan = buildBlueprint({ slides: lecture.slides, topics: MATHS_TOPICS, count: 12 });
    const types = new Set(plan.map((s) => s.type));
    for (const t of ['calculation', 'proof', 'algorithm', 'diagram'] as const) expect(types.has(t) || t === 'calculation' && types.has('problem'), `a ${t} question is planned`).toBe(true);
    const needs: Record<string, (s: SlideData) => boolean> = {
      calculation: (s) => slideTraits(s).math,
      problem: (s) => slideTraits(s).math,
      proof: (s) => slideTraits(s).proof,
      algorithm: (s) => slideTraits(s).algorithm || slideTraits(s).code,
      diagram: (s) => slideTraits(s).diagram,
    };
    for (const s of plan) {
      const need = needs[s.type];
      if (need) expect(s.slides.some((n) => need(lecture.slides[n - 1]!)), `${s.type} on slides ${s.slides}`).toBe(true);
    }
    const groups = splitIntoRequests(plan, 4_000);
    const packs: PackPlan[] = [];
    for (const g of groups) packs.push(await ask(g, lecture));
    for (const p of packs) {
      expect(p.quality?.stats.asPlanned?.met).toBe(p.quality?.stats.asPlanned?.of);
      expect(faults(p), JSON.stringify(faults(p))).toEqual([]);
    }
    expect(packs.flatMap((p) => p.questions)).toHaveLength(12);
  });
});

describe('the same checks on a model that only writes recall questions', () => {
  /** What an unplanned model tends to write: definitions and short answers, one slide each, the same two marks, no hard question. */
  function lazyPack(lecture: Awaited<ReturnType<typeof load>>): unknown {
    const q = (n: number) => {
      const s = lecture.slides[n - 1]!;
      const first = s.text.split('\n').find((l) => l.startsWith('- '))!.slice(2);
      return {
        type: n % 4 === 0 ? 'mcq' : n % 3 === 0 ? 'truefalse' : 'short',
        prompt: `What is stated about ${s.title.toLowerCase()}?`,
        marks: 2,
        difficulty: n % 2 ? 1 : 2,
        topic: 'General',
        modelAnswer: first,
        rubric: [{ text: `Any two points about ${s.title.toLowerCase()}`, marks: 1 }, { text: 'All of the key points are listed', marks: 1 }],
        options: n % 4 === 0 ? [{ text: first, correct: true }, { text: 'Something else', correct: false }] : undefined,
        answer: n % 3 === 0 ? true : undefined,
        basis: 'lecture',
        sources: [{ lecture: 'L1', slide: n, quote: first.split(/\s+/).slice(0, 8).join(' ') }],
      };
    };
    return { format: 'studyai-pack', version: 1, lectures: [{ ref: 'L1', title: 'Lecture' }], questions: [1, 2, 3, 4, 5, 6].map(q) };
  }

  it('flags the missing variety, the missing hard question, the unfair marking points and the thin model answers', async () => {
    const lecture = await load(SECURITY);
    const plan = planPack(lazyPack(lecture), 'course', [lecture.ctx], {}, 0);
    const codes = new Set((plan.quality?.issues ?? []).map((i) => i.code));
    for (const c of ['ONLY_RECALL', 'NO_HARD', 'POINTS_NOT_INDEPENDENT', 'ANSWER_MISSES_POINT']) expect(codes.has(c as never), c).toBe(true);
    expect(plan.quality!.stats.byDifficulty[3]).toBe(0);
    expect(plan.quality!.stats.recallShare).toBe(1);
    // and the planned run on the same lecture is clearly better by every one of these measures
    const planned = await ask(splitIntoRequests(buildBlueprint({ slides: lecture.slides, topics: SECURITY_TOPICS, count: 6 }), 4_000)[0]!, lecture);
    expect(planned.quality!.stats.recallShare).toBeLessThan(plan.quality!.stats.recallShare);
    expect(planned.quality!.stats.byDifficulty[3]).toBeGreaterThan(0);
    expect(faults(planned).length).toBeLessThan(faults(plan).length);
  });
});
