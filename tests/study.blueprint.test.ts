import { describe, expect, it } from 'vitest';
import { parsePptx } from '../src/core/pptx';
import type { SlideData } from '../src/core/pptx/model';
import { buildBlueprint, describeSlot, difficultyMix, gatherEvidence, parseExamStyle, pointsFor, slideTraits, slotTokens, splitIntoRequests, type Slot } from '../src/core/study/blueprint';
import type { QuestionType } from '../src/core/study/types';
import { PNG_1X1, bodySp, buildPptx, equationShape, mr, para, picture, simpleSlide, titleSp, type DeckSpec } from './fixtures/pptx-builder';

/** Synthetic lectures only: nothing from a real course. */
async function slidesOf(spec: DeckSpec): Promise<SlideData[]> {
  return (await parsePptx(buildPptx(spec))).slides;
}
const img = { rels: { rIdImg1: ['image', '../media/image1.png'] as [string, string] }, parts: { 'ppt/media/image1.png': PNG_1X1 } };
const words = (n: number, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

// A conceptual, security-flavoured lecture: four topics, the last one is only headings.
function conceptual(): DeckSpec {
  const body = (extra: string) => [`${extra} is something a student should understand and be able to explain with the slides`, `the second point says how ${extra} relates to the attack and the vulnerability on the system`];
  return {
    slides: [
      simpleSlide('Threats overview', body('A threat')),
      simpleSlide('Attackers', body('An attacker')),
      simpleSlide('Vulnerabilities', body('A vulnerability')),
      simpleSlide('Firewalls', body('A firewall')),
      simpleSlide('Encryption', body('Encryption')),
      simpleSlide('Authentication', body('Authentication')),
      simpleSlide('Policy basics', body('A policy')),
      simpleSlide('Audits', body('An audit')),
      simpleSlide('Thanks', ['Questions?']),
      simpleSlide('Acknowledgements', ['Slides adapted from the textbook']),
    ],
  };
}
const topicsConceptual = [
  { title: 'Threats', startSlide: 1, endSlide: 3 },
  { title: 'Defences', startSlide: 4, endSlide: 6 },
  { title: 'Policies', startSlide: 7, endSlide: 8 },
  { title: 'Wrap-up', startSlide: 9, endSlide: 10 },
];

describe('difficulty and marks', () => {
  it('mixes about a third easy, forty per cent medium and a third hard, and any start of the plan already has a mix', () => {
    for (const n of [3, 6, 8, 10, 12, 20]) {
      const mix = difficultyMix(n);
      expect(mix).toHaveLength(n);
      const count = (d: number) => mix.filter((x) => x === d).length;
      expect(count(1), `easy of ${n}`).toBeGreaterThanOrEqual(1);
      expect(count(3), `hard of ${n}`).toBeGreaterThanOrEqual(1);
      expect(count(2), `medium of ${n}`).toBeGreaterThanOrEqual(Math.floor(n * 0.3));
      expect(new Set(mix.slice(0, 3)).size, `first three of ${n}`).toBeGreaterThanOrEqual(2);
    }
    expect(difficultyMix(1)).toEqual([2]);
    expect(difficultyMix(0)).toEqual([]);
  });

  it('gives about one marking point per mark for written questions and exactly one for auto-marked ones', () => {
    expect(pointsFor('mcq', 1)).toBe(1);
    expect(pointsFor('truefalse', 3)).toBe(1);
    expect(pointsFor('short', 2)).toBe(2);
    expect(pointsFor('scenario', 6)).toBe(6);
    expect(pointsFor('long', 30)).toBe(8); // capped
    expect(pointsFor('short', 0.4)).toBe(1);
  });

  it('estimates a bigger question as a bigger answer', () => {
    expect(slotTokens({ type: 'scenario', marks: 6, points: 6 })).toBeGreaterThan(slotTokens({ type: 'short', marks: 2, points: 2 }));
    expect(slotTokens({ type: 'mcq', marks: 1, points: 1 })).toBeLessThan(slotTokens({ type: 'short', marks: 2, points: 2 }));
  });
});

describe('reading the professor’s exam instructions', () => {
  it('finds the kinds of question that are asked for, and how much "most" counts', () => {
    const h = parseExamStyle('Most questions are scenarios and answers are 1–3 sentences.');
    expect(h.prefer.get('scenario')).toBe(6); // what the professor stresses counts three times as much as what is merely mentioned
    expect(h.maxMarks).toBe(3);
    expect(parseExamStyle('There will be a compare and contrast question and a proof.').prefer.get('compare')).toBe(2);
  });

  it('understands "no multiple choice" and "do not ask true/false" as exclusions, and "only" as exclusive', () => {
    const h = parseExamStyle('No multiple choice. Do not ask true/false questions. Proofs are worth most.');
    expect(h.avoid.has('mcq')).toBe(true);
    expect(h.avoid.has('truefalse')).toBe(true);
    expect(h.prefer.has('mcq')).toBe(false);
    expect(h.prefer.get('proof')).toBeGreaterThanOrEqual(2);
    expect([...(parseExamStyle('Only short answer questions.').only ?? [])]).toEqual(['short']);
  });

  it('reads nothing into empty or unrelated text', () => {
    for (const t of [undefined, '', '   ', 'Bring a calculator-free pen and arrive early to the room.']) {
      const h = parseExamStyle(t);
      expect(h.avoid.size, String(t)).toBe(0);
      expect(h.only).toBeUndefined();
      expect(h.maxMarks).toBeUndefined();
    }
  });
});

describe('what kind of material it is', () => {
  it('detects equations, tables, pictures, code, proofs and attack vocabulary slide by slide', async () => {
    const slides = await slidesOf({
      slides: [
        { shapes: titleSp(2, 'Ratio') + equationShape(5, `<m:f><m:num>${mr('a')}</m:num><m:den>${mr('b')}</m:den></m:f>`) },
        { shapes: titleSp(2, 'Halting') + bodySp(3, [para('Theorem: the halting problem is undecidable'), para('Proof by contradiction')]) },
        { shapes: titleSp(2, 'Sorting') + bodySp(3, [para('Algorithm: for each item compare with its neighbour'), para('Step 1 pick the smallest item')]) },
        { shapes: titleSp(2, 'Diagram') + picture(4, 'rIdImg1', 300000, 1800000, 3800000, 3000000), ...img },
        simpleSlide('Threat', ['An attacker can exploit a vulnerability to breach the system']),
        simpleSlide('Plain', ['Just a normal sentence about nothing in particular here today']),
      ],
    });
    const t = slides.map(slideTraits);
    expect(t[0]!.math).toBe(true);
    expect(t[1]!.proof).toBe(true);
    expect(t[2]!.algorithm).toBe(true);
    expect(t[3]!.diagram).toBe(true);
    expect(t[4]!.security).toBe(true);
    expect(Object.values(t[5]!).some(Boolean)).toBe(false);
    const e = gatherEvidence(slides);
    expect(e).toMatchObject({ math: 1, proof: 1, algorithm: 1, diagram: 1, security: 1 });
  });

  it('does not call a lecture mathematical because a typed diagram label contains an equals sign', async () => {
    const slides = await slidesOf({ slides: [simpleSlide('Memory', ['Store sum = 7178 then jump forward ten bytes in memory for the next step'])] });
    expect(slideTraits(slides[0]!).math).toBe(false);
  });
});

describe('the exam blueprint', () => {
  it('plans a varied set: every substantial topic is asked about, the types are not all recall, the difficulty is mixed', async () => {
    const slides = await slidesOf(conceptual());
    const plan = buildBlueprint({ slides, topics: topicsConceptual, count: 8 });
    expect(plan).toHaveLength(8);
    expect(plan.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // topics with something to ask about are all covered; the headings-only wrap-up is not given a question
    expect(new Set(plan.map((s) => s.topic))).toEqual(new Set(['Threats', 'Defences', 'Policies']));
    // not just recall: scenario, case, compare, problem... are present
    const recall = new Set<QuestionType>(['define', 'short', 'truefalse', 'mcq']);
    expect(plan.filter((s) => !recall.has(s.type)).length).toBeGreaterThanOrEqual(4);
    expect(plan.some((s) => s.type === 'scenario' || s.type === 'case' || s.type === 'attack')).toBe(true);
    expect(new Set(plan.map((s) => s.difficulty)).size).toBe(3);
    // no kind of question that the slides cannot support
    for (const s of plan) expect(['proof', 'calculation', 'problem', 'algorithm', 'programming', 'diagram']).not.toContain(s.type);
  });

  it('makes the marks proportional to the difficulty and the marking points proportional to the marks', async () => {
    const slides = await slidesOf(conceptual());
    const plan = buildBlueprint({ slides, topics: topicsConceptual, count: 10 });
    const avg = (d: number) => {
      const xs = plan.filter((s) => s.difficulty === d && s.type !== 'mcq' && s.type !== 'truefalse').map((s) => s.marks);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    };
    expect(avg(3)).toBeGreaterThan(avg(2));
    expect(avg(2)).toBeGreaterThan(avg(1));
    for (const s of plan) {
      expect(s.points, describeSlot(s)).toBe(pointsFor(s.type, s.marks));
      if (s.type !== 'mcq' && s.type !== 'truefalse') expect(Math.abs(s.points - s.marks)).toBeLessThanOrEqual(1);
      expect(s.marks).toBeGreaterThan(0);
    }
  });

  it('bases each question on slides of its own topic, more slides for harder questions, and never on slides that have nothing on them', async () => {
    const slides = await slidesOf(conceptual());
    const range = new Map(topicsConceptual.map((t) => [t.title, t]));
    const plan = buildBlueprint({ slides, topics: topicsConceptual, count: 9 });
    for (const s of plan) {
      const t = range.get(s.topic)!;
      expect(s.slides.length, describeSlot(s)).toBeGreaterThanOrEqual(1);
      // the question belongs to the topic it is built around; a question that combines slides may reach the slides next to it
      expect(s.slides.some((n) => n >= t.startSlide && n <= t.endSlide), describeSlot(s)).toBe(true);
      for (const n of s.slides) expect(n).toBeLessThanOrEqual(8); // slides 9 and 10 only have a heading
      // the slides of one question are neighbours, never a jump over a section
      const sorted = [...s.slides].sort((a, b) => a - b);
      sorted.slice(1).forEach((n, i) => expect(n - sorted[i]!, describeSlot(s)).toBeLessThanOrEqual(1));
    }
    const meanSlides = (d: number) => {
      const xs = plan.filter((s) => s.difficulty === d).map((s) => s.slides.length);
      return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    };
    expect(meanSlides(3)).toBeGreaterThanOrEqual(meanSlides(1));
  });

  it('is deterministic, and gives a different plan for different settings', async () => {
    const slides = await slidesOf(conceptual());
    const a = buildBlueprint({ slides, topics: topicsConceptual, count: 8 });
    expect(buildBlueprint({ slides, topics: topicsConceptual, count: 8 })).toEqual(a);
    expect(buildBlueprint({ slides, topics: topicsConceptual, count: 5 })).not.toEqual(a.slice(0, 5));
  });

  it('asks for calculations, proofs and diagrams only where a slide has the equation, the theorem or the picture', async () => {
    const slides = await slidesOf({
      slides: [
        { shapes: titleSp(2, 'Ratio') + equationShape(5, `<m:f><m:num>${mr('a')}</m:num><m:den>${mr('b')}</m:den></m:f>`) + bodySp(3, [para('The ratio of a to b is used to scale values and compare quantities')]) },
        { shapes: titleSp(2, 'Halting') + bodySp(3, [para('Theorem: the halting problem is undecidable for all programs and inputs'), para('Proof by contradiction assumes a decider exists and derives a contradiction')]) },
        { shapes: titleSp(2, 'Machine') + bodySp(3, [para('The machine has a tape and a head that reads and writes symbols one at a time')]) + picture(4, 'rIdImg1', 4500000, 1800000, 3800000, 3600000), ...img },
        simpleSlide('Variants', ['A variant allows several tapes or several heads but computes the same class of functions']),
      ],
    });
    const topics = [
      { title: 'Ratios', startSlide: 1, endSlide: 1 },
      { title: 'Undecidability', startSlide: 2, endSlide: 2 },
      { title: 'Machines', startSlide: 3, endSlide: 4 },
    ];
    const plan = buildBlueprint({ slides, topics, count: 12 });
    const byType = (t: QuestionType) => plan.filter((s) => s.type === t);
    for (const s of byType('calculation').concat(byType('problem'))) expect(s.slides, describeSlot(s)).toContain(1);
    for (const s of byType('proof')) expect(s.slides, describeSlot(s)).toContain(2);
    for (const s of byType('diagram')) expect(s.slides, describeSlot(s)).toContain(3);
    // with this material they are offered at all
    expect(plan.some((s) => ['calculation', 'problem', 'proof', 'diagram'].includes(s.type))).toBe(true);
  });

  it('follows the professor’s instructions: leaves out what is ruled out, keeps to "only", caps the marks for short answers', async () => {
    const slides = await slidesOf(conceptual());
    const noObjective = buildBlueprint({ slides, topics: topicsConceptual, count: 12, examStyle: 'No multiple choice. Do not ask true/false.' });
    expect(noObjective.some((s) => s.type === 'mcq' || s.type === 'truefalse')).toBe(false);
    const onlyScenario = buildBlueprint({ slides, topics: topicsConceptual, count: 6, examStyle: 'Only scenario questions.' });
    expect(onlyScenario.every((s) => s.type === 'scenario')).toBe(true);
    const short = buildBlueprint({ slides, topics: topicsConceptual, count: 8, examStyle: 'Answers are 1-2 sentences.' });
    for (const s of short) if (s.type !== 'mcq' && s.type !== 'truefalse') expect(s.marks, describeSlot(s)).toBeLessThanOrEqual(2);
    const mostly = buildBlueprint({ slides, topics: topicsConceptual, count: 12, examStyle: 'Most questions are scenarios.' });
    const base = buildBlueprint({ slides, topics: topicsConceptual, count: 12 });
    expect(mostly.filter((s) => s.type === 'scenario').length).toBeGreaterThan(base.filter((s) => s.type === 'scenario').length);
  });

  it('asks about what has not been asked yet: slides that already have questions are used last, and covered topics get fewer', async () => {
    const slides = await slidesOf(conceptual());
    const fresh = buildBlueprint({ slides, topics: topicsConceptual, count: 6 });
    const existing = [
      { topic: 'Threats', slides: [1, 2, 3], type: 'define' as const },
      { topic: 'Threats', slides: [1, 2], type: 'short' as const },
      { topic: 'Threats', slides: [3], type: 'mcq' as const },
    ];
    const next = buildBlueprint({ slides, topics: topicsConceptual, count: 6, existing });
    const share = (plan: Slot[], t: string) => plan.filter((s) => s.topic === t).length;
    expect(share(next, 'Threats')).toBeLessThanOrEqual(share(fresh, 'Threats'));
    expect(share(next, 'Defences') + share(next, 'Policies')).toBeGreaterThan(share(fresh, 'Defences') + share(fresh, 'Policies') - 1);
    // with only slide 3 untouched in a topic, the first new question there is based on it
    const partly = buildBlueprint({ slides: slides.slice(0, 3), topics: [{ title: 'Threats', startSlide: 1, endSlide: 3 }], count: 1, existing: [{ topic: 'Threats', slides: [1, 2], type: 'define' }] });
    expect(partly[0]!.slides).toContain(3);
  });

  it('plans nothing for no slides, no substance or no questions, and never more than thirty', async () => {
    const slides = await slidesOf(conceptual());
    expect(buildBlueprint({ slides: [], topics: [], count: 5 })).toEqual([]);
    expect(buildBlueprint({ slides, topics: topicsConceptual, count: 0 })).toEqual([]);
    expect(buildBlueprint({ slides: await slidesOf({ slides: [simpleSlide('Thanks', ['Questions?'])] }), topics: [], count: 4 })).toEqual([]);
    expect(buildBlueprint({ slides, topics: topicsConceptual, count: 500 }).length).toBeLessThanOrEqual(30);
  });

  it('works without any topics: the lecture is one topic', async () => {
    const slides = await slidesOf(conceptual());
    const plan = buildBlueprint({ slides, topics: [], count: 4 });
    expect(plan).toHaveLength(4);
    expect(new Set(plan.map((s) => s.topic))).toEqual(new Set(['The lecture']));
  });
});

/**
 * Defects found by planning an exam for a real lecture (19 slides cut into twelve topics of one slide each): a question about the
 * objectives slide, an "algorithm" question from a slide that only says "secret algorithms", no attack question for a security
 * lecture, a six-mark scenario from four bullet points, and the biggest section getting one question out of eight. The decks here
 * are synthetic.
 */
describe('planning for a lecture cut into many tiny topics', () => {
  const bullets = (a: string, b: string, c: string) => [a, b, c];
  const tiny = async (): Promise<{ slides: SlideData[]; topics: { title: string; startSlide: number; endSlide: number }[] }> => {
    const spec: DeckSpec = {
      slides: [
        simpleSlide('Objectives', ['Learn about memory regions, stack frames and heap blocks in a program', 'Learn how an attacker exploits a vulnerability in a running program', 'Learn which countermeasures stop an attack and how to apply them in practice']),
        simpleSlide('Memory regions', bullets('The stack holds local variables and grows downward in memory', 'The heap holds dynamic memory and grows upward in memory', 'The text region holds the program code and is read from the file')),
        simpleSlide('Stack frames', bullets('Each function call saves a frame on the stack with its local variables', 'The frame also saves the return address of the caller', 'When the function ends the frame is removed from the stack')),
        simpleSlide('Heap blocks', bullets('Dynamic blocks are allocated by the program when it needs them', 'The allocator keeps track of the blocks that are in use', 'A block that is freed can be reused for a later request')),
        simpleSlide('Design flaws', bullets('Relying on secret algorithms is a design flaw that attackers exploit', 'More privilege than necessary lets an attacker do more damage', 'Sharing resources between users can leak information to an attacker')),
        simpleSlide('Overflow basics', bullets('A cache keeps recent items close and an attacker can flood it', 'Adding more items than fit pushes out the neighbouring entries', 'An overwritten return address changes the program flow of the attacker victim')),
        simpleSlide('Exploit results', bullets('A vulnerability lets an attacker run commands of their choice on the system', 'An attacker can halt the program and deny service to others', 'An attacker can enter a system that was meant to be closed')),
        simpleSlide('Countermeasures', bullets('A countermeasure such as input checking blocks an attack at its source', 'Least privilege limits what an exploit can do after it succeeds', 'Reviewing code finds a vulnerability before an attacker does')),
        simpleSlide('Thanks', ['Questions?']),
      ],
    };
    const slides = await slidesOf(spec);
    // one topic per slide, as a deck cut up by its titles gives
    return { slides, topics: slides.map((s) => ({ title: s.title, startSlide: s.index, endSlide: s.index })) };
  };

  it('never asks about the objectives, outline or thank-you slides', async () => {
    const { slides, topics } = await tiny();
    const plan = buildBlueprint({ slides, topics, count: 20 });
    for (const s of plan) {
      expect(s.slides, describeSlot(s)).not.toContain(1);
      expect(s.slides, describeSlot(s)).not.toContain(9);
      expect(['Objectives', 'Thanks']).not.toContain(s.topic);
    }
  });

  it('does not take a sentence that mentions algorithms for an algorithm to trace', async () => {
    const { slides, topics } = await tiny();
    expect(slideTraits(slides[4]!).algorithm).toBe(false); // "Relying on secret algorithms is a design flaw"
    expect(gatherEvidence(slides).algorithm).toBe(0);
    const plan = buildBlueprint({ slides, topics, count: 12 });
    expect(plan.some((s) => s.type === 'algorithm' || s.type === 'programming')).toBe(false);
    const steps = await slidesOf({ slides: [simpleSlide('Sorting', ['Step 1 pick the smallest item', 'Step 2 swap it to the front', 'Step 3 repeat for the rest of the list'])] });
    expect(slideTraits(steps[0]!).algorithm).toBe(true);
    const labelled = await slidesOf({ slides: [simpleSlide('Search', ['Algorithm: look at the middle item and halve the range each time'])] });
    expect(slideTraits(labelled[0]!).algorithm).toBe(true);
  });

  it('plans an attack-and-countermeasure question for a security lecture even when every topic is a single slide', async () => {
    const { slides, topics } = await tiny();
    const plan = buildBlueprint({ slides, topics, count: 8 });
    const attacks = plan.filter((s) => s.type === 'attack');
    expect(attacks.length).toBeGreaterThanOrEqual(1);
    for (const a of attacks) expect(a.slides.some((n) => slideTraits(slides[n - 1]!).security), describeSlot(a)).toBe(true);
    // a lecture about something else gets none
    const plain = await slidesOf({ slides: Array.from({ length: 6 }, (_, i) => simpleSlide(`Topic ${i + 1}`, [`The first thing to know about subject ${i + 1} is how it is organised in practice`, 'It is arranged in layers that each have a separate purpose and owner'])) });
    const plainPlan = buildBlueprint({ slides: plain, topics: plain.map((s) => ({ title: s.title, startSlide: s.index, endSlide: s.index })), count: 8 });
    expect(plainPlan.some((s) => s.type === 'attack')).toBe(false);
  });

  it('takes neighbouring tiny topics together when there are more topics than questions, so the biggest section is not squeezed to one question', async () => {
    const spec: DeckSpec = {
      slides: [
        simpleSlide('Small one', ['A short topic with a few words of content that is enough to ask about once']),
        ...Array.from({ length: 5 }, (_, i) => simpleSlide(`Big part ${i + 1}`, [`The first point about part ${i + 1} of the big topic explained in some detail here`, `The second point about part ${i + 1} adds more detail about how it works`, `The third point about part ${i + 1} gives an example and a consequence for it`])),
        simpleSlide('Small two', ['Another short topic with a few words of content that is enough to ask once']),
        simpleSlide('Small three', ['A third short topic with a few words of content that is enough to ask once']),
        simpleSlide('Small four', ['A fourth short topic with a few words of content that is enough to ask once']),
      ],
    };
    const slides = await slidesOf(spec);
    const topics = [
      { title: 'Small one', startSlide: 1, endSlide: 1 },
      { title: 'Big topic', startSlide: 2, endSlide: 6 },
      { title: 'Small two', startSlide: 7, endSlide: 7 },
      { title: 'Small three', startSlide: 8, endSlide: 8 },
      { title: 'Small four', startSlide: 9, endSlide: 9 },
    ];
    const plan = buildBlueprint({ slides, topics, count: 4 });
    expect(plan).toHaveLength(4);
    const inBig = plan.filter((s) => s.topic === 'Big topic').length;
    expect(inBig).toBeGreaterThanOrEqual(2); // 5 of 9 slides, and more than one question
    // every slot names a real topic of the lecture, so the exam builder’s topic filter finds it
    for (const s of plan) expect(topics.map((t) => t.title)).toContain(s.topic);
    // and the small topics are still reached
    expect(plan.some((s) => s.topic.startsWith('Small'))).toBe(true);
  });

  it('never plans the same kind of question on the same slides twice, in one plan or against questions that already exist', async () => {
    const { slides, topics } = await tiny();
    const same = (a: Slot, b: { type?: string; slides: readonly number[] }) => a.type === b.type && (a.slides.every((n) => b.slides.includes(n)) || b.slides.every((n) => a.slides.includes(n)));
    // a seven-slide lecture holds only so many different (kind, slides) combinations, so the counts stay within what it can supply
    for (const count of [4, 6, 9, 12]) {
      const plan = buildBlueprint({ slides, topics, count });
      plan.forEach((s, i) => plan.slice(i + 1).forEach((o) => expect(same(s, o), `${count}: ${describeSlot(s)} / ${describeSlot(o)}`).toBe(false)));
    }
    // asking again with the first plan in the bank: nothing in the new plan repeats a question that exists
    const first = buildBlueprint({ slides, topics, count: 8 });
    const bank = first.map((s) => ({ topic: s.topic, slides: s.slides, type: s.type }));
    const next = buildBlueprint({ slides, topics, count: 8, existing: bank });
    for (const s of next) for (const b of bank) expect(same(s, b), `${describeSlot(s)} repeats ${b.type} on ${b.slides}`).toBe(false);
  });

  it('asks about topics that nobody has asked about first, and only then comes back to covered ones', async () => {
    const body = (n: string) => [`The first point about ${n} is explained with enough words to be asked about`, `The second thing about ${n} adds a different detail that is worth a question`, `A third matter about ${n} gives an example and its consequence in practice`];
    const slides = await slidesOf({ slides: [simpleSlide('Alpha', body('alpha')), simpleSlide('Beta', body('beta')), simpleSlide('Gamma', body('gamma')), simpleSlide('Delta', body('delta'))] });
    const topics = slides.map((s) => ({ title: s.title, startSlide: s.index, endSlide: s.index }));
    // Alpha and Beta already have questions on every slide; Gamma and Delta have none
    const existing = [
      { topic: 'Alpha', slides: [1], type: 'short' as const },
      { topic: 'Alpha', slides: [1], type: 'define' as const },
      { topic: 'Beta', slides: [2], type: 'short' as const },
      { topic: 'Beta', slides: [2], type: 'define' as const },
    ];
    const plan = buildBlueprint({ slides, topics, count: 2, existing });
    // nothing goes to the covered topics, and both untouched slides are reached
    for (const s of plan) expect(['Gamma', 'Delta'], describeSlot(s)).toContain(s.topic);
    // (a question that combines slides may reach the covered slide next to them)
    expect([...new Set(plan.flatMap((s) => s.slides))]).toEqual(expect.arrayContaining([3, 4]));
    // depth in the untouched topics comes before going back: four questions are all about Gamma and Delta, and with eight the covered topics return
    expect(new Set(buildBlueprint({ slides, topics, count: 4, existing }).map((s) => s.topic))).toEqual(new Set(['Gamma', 'Delta']));
    expect(new Set(buildBlueprint({ slides, topics, count: 8, existing }).map((s) => s.topic)).size).toBe(4);
  });

  it('does not take topics together across a section break: a heading-only divider slide in between keeps them apart', async () => {
    const body = (n: string) => [`The first point about ${n} explained with enough words to be asked about`, `The second point about ${n} explained with enough words to be asked about`, `The third point about ${n} explained with enough words to be asked about`];
    // Beta and Gamma are the smallest topics, so they are the pair that would be taken together first, if nothing stopped it
    const small = (n: string) => [`The only point about ${n} explained with enough words to be asked about`];
    const slides = await slidesOf({ slides: [simpleSlide('Alpha', [...body('alpha'), ...body('alpha again')]), simpleSlide('Beta', small('beta')), simpleSlide('Part two', ['Introduction']), simpleSlide('Gamma', small('gamma')), simpleSlide('Delta', [...body('delta'), ...body('delta again')])] });
    const topics = slides.map((s) => ({ title: s.title, startSlide: s.index, endSlide: s.index }));
    for (const count of [2, 3, 4]) {
      for (const s of buildBlueprint({ slides, topics, count })) {
        const sorted = [...s.slides].sort((a, b) => a - b);
        // slide 3 is the divider: no question may join slides from both sides of it
        expect(sorted.some((n) => n < 3) && sorted.some((n) => n > 3), `${count}: ${describeSlot(s)}`).toBe(false);
        expect(s.slides).not.toContain(3);
      }
    }
  });

  it('never plans more marking points than the slides hold separate ideas, and gives a hard question several slides to draw on', async () => {
    const { slides, topics } = await tiny();
    const idea = (n: number) => slides[n - 1]!.text.split('\n').slice(1).map((l) => l.replace(/^\s*[-*>]\s*/, '').trim()).filter((l) => l.split(/\s+/).length >= 3 && !l.startsWith('[')).length;
    const plan = buildBlueprint({ slides, topics, count: 12 });
    for (const s of plan) {
      if (s.type === 'mcq' || s.type === 'truefalse') continue;
      const ideas = s.slides.reduce((n, x) => n + idea(x), 0);
      expect(s.points, describeSlot(s)).toBeLessThanOrEqual(Math.max(1, ideas));
      expect(s.marks, describeSlot(s)).toBe(s.points); // about one mark per point
    }
    // each of these slides has three ideas, so a six-mark question needs at least two slides
    for (const s of plan.filter((x) => x.points >= 4)) expect(s.slides.length, describeSlot(s)).toBeGreaterThanOrEqual(2);
  });

  it('labels a question with the topic it was built around, even when it reaches into a bigger neighbour', async () => {
    const { slides, topics } = await tiny();
    const plan = buildBlueprint({ slides, topics, count: 12 });
    const topicOfSlide = (n: number) => topics.find((t) => n >= t.startSlide && n <= t.endSlide)!.title;
    for (const s of plan) expect(s.slides.map(topicOfSlide), describeSlot(s)).toContain(s.topic);
  });

  it('spreads the questions over the slides instead of piling them on one', async () => {
    const { slides, topics } = await tiny();
    const plan = buildBlueprint({ slides, topics, count: 14 });
    const uses = new Map<number, number>();
    for (const s of plan) for (const n of s.slides) uses.set(n, (uses.get(n) ?? 0) + 1);
    // 7 usable slides and 14 questions: some reuse is unavoidable, but it is spread out, not piled on one slide
    const most = Math.max(...uses.values());
    const least = Math.min(...[...uses.entries()].filter(([n]) => n >= 2 && n <= 8).map(([, c]) => c));
    expect(most - least, JSON.stringify([...uses])).toBeLessThanOrEqual(3);
    expect(uses.size).toBe(7); // every usable slide is used at least once
  });

  it('plans an attack question from the lecture as a whole, not only where one topic has several attack slides', async () => {
    const { slides, topics } = await tiny();
    // twelve questions over seven one-slide topics: nothing is merged, so each part is a single slide
    const plan = buildBlueprint({ slides, topics, count: 12 });
    expect(plan.some((s) => s.type === 'attack')).toBe(true);
  });

  it('gives every topic that has something to ask about a question of its own when there are enough questions, labelled with that topic', async () => {
    const { slides, topics } = await tiny();
    const usable = topics.filter((t) => t.title !== 'Objectives' && t.title !== 'Thanks').map((t) => t.title);
    const plan = buildBlueprint({ slides, topics, count: 12 });
    expect(new Set(plan.map((s) => s.topic))).toEqual(new Set(usable));
  });

  it('does not ask for six marks from slides that hold three ideas in all, however hard the question', async () => {
    // eight slides with a single idea each: even four slides together hold only four separate ideas
    const spec: DeckSpec = { slides: Array.from({ length: 8 }, (_, i) => simpleSlide(`Idea ${i + 1}`, [`The only thing this slide says about idea number ${i + 1} is one long and detailed sentence`])) };
    const slides = await slidesOf(spec);
    const topics = [{ title: 'Ideas', startSlide: 1, endSlide: 8 }];
    const plan = buildBlueprint({ slides, topics, count: 6 });
    expect(plan.some((s) => s.difficulty === 3)).toBe(true);
    for (const s of plan) {
      if (s.type === 'mcq' || s.type === 'truefalse') continue;
      expect(s.points, describeSlot(s)).toBeLessThanOrEqual(s.slides.length); // one idea per slide, one point per idea
      expect(s.marks, describeSlot(s)).toBe(s.points);
    }
  });
});

describe('splitting the plan into requests', () => {
  const slot = (n: number, type: QuestionType, marks: number): Slot => ({ n, type, difficulty: 2, marks, points: pointsFor(type, marks), topic: 'T', slides: [n] });

  it('keeps each request inside the answer limit, in the plan’s order, with at least one question each', () => {
    const slots = [slot(1, 'scenario', 6), slot(2, 'short', 2), slot(3, 'scenario', 6), slot(4, 'compare', 4), slot(5, 'mcq', 1), slot(6, 'case', 6), slot(7, 'long', 8)];
    const groups = splitIntoRequests(slots, 4_000);
    expect(groups.flat().map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const g of groups) {
      expect(g.length).toBeGreaterThanOrEqual(1);
      expect(g.length === 1 || g.reduce((n, s) => n + slotTokens(s), 0) <= 0.7 * 4_000 - 150, `group of ${g.length}`).toBe(true);
    }
    expect(groups.length).toBeGreaterThan(1);
    // one oversized slot still gets its own request
    expect(splitIntoRequests([slot(1, 'long', 8)], 400)).toHaveLength(1);
    expect(splitIntoRequests([], 4_000)).toEqual([]);
  });

  it('fits more small questions into one request than big ones', () => {
    const small = Array.from({ length: 10 }, (_, i) => slot(i + 1, 'mcq', 1));
    const big = Array.from({ length: 10 }, (_, i) => slot(i + 1, 'scenario', 6));
    expect(splitIntoRequests(small, 4_000)[0]!.length).toBeGreaterThan(splitIntoRequests(big, 4_000)[0]!.length);
  });

  it('describes a slot in one readable line', () => {
    expect(describeSlot({ n: 1, type: 'scenario', difficulty: 3, marks: 6, points: 6, topic: 'Defences', slides: [4, 5] })).toBe('Scenario · hard · 6 marks · Defences · slides 4, 5');
    expect(describeSlot({ n: 2, type: 'mcq', difficulty: 1, marks: 1, points: 1, topic: 'Threats', slides: [2] })).toBe('Multiple choice · easy · 1 mark · Threats · slide 2');
  });
});

// keep the helper referenced so an unused-variable rule never hides a typo in it
void words;
