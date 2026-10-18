import { describe, expect, it } from 'vitest';
import { displayTitle, parsePptx } from '../src/core/pptx';
import type { ParsedDeck, SlideData } from '../src/core/pptx/model';
import { buildBlueprint, parseExamStyle, slideTraits } from '../src/core/study/blueprint';
import { lectureToMarkdown } from '../src/core/study/markdown';
import { QUESTION_RULES } from '../src/core/study/pack-format';
import { auditFindings } from '../src/core/study/audit';
import { quoteInText } from '../src/core/study/pack';
import { assessQuestions, keyWords, scenarioAddsNothing } from '../src/core/study/pack-quality';
import { slideVerificationText } from '../src/core/study/slide-text';
import { isQuestionText, slideQuestions } from '../src/core/study/slide-questions';
import { formulaSymbols, slideGaps } from '../src/core/tutor/gaps';
import { slideContextText } from '../src/core/tutor/context';
import { TEACHING_NOTES, TUTOR_RULES, teachingNotes } from '../src/core/tutor/prompts';
import { PNG_1X1, arrowLine, bodySp, buildPptx, equationShape, mr, para, picture, run, simpleSlide, textBox, titleSp, type DeckSpec } from './fixtures/pptx-builder';

/**
 * What a real lecture on computability and complexity showed that the synthetic decks did not: a title slide and a credits slide that
 * were examined as content, set notation and "a 1-1 correspondence" taken for arithmetic, monospaced digits taken for code, a
 * photograph taken for a diagram, check-in questions printed on slides with no answer, labels and arrows whose positions carry the
 * meaning, and symbols that are names or number sets reported as unexplained. Every slide here is invented; the patterns are the point.
 */

const img = { rels: { rIdImg1: ['image', '../media/image1.png'] as [string, string] }, parts: { 'ppt/media/image1.png': PNG_1X1 } };
const mono = (t: string) => para([run(t, { font: 'Consolas' })], { bullet: 'none' });
const sup = (base: string, s: string) => `<m:sSup><m:e>${base}</m:e><m:sup>${s}</m:sup></m:sSup>`;
const subName = (base: string, name: string) => `<m:sSub><m:e>${base}</m:e><m:sub><m:r><m:rPr><m:nor/></m:rPr><m:t>${name}</m:t></m:r></m:sub></m:sSub>`;

/** The 1-based numbers the slides below have. */
const SLIDE = { title: 1, sets: 2, digits: 3, photo: 4, credits: 5, checkIn: 6, proof: 7, regions: 8, bullets: 9, names: 10, recap: 11 } as const;

function deckSpec(): DeckSpec {
  return {
    title: 'Languages and machines',
    slides: [
      { shapes: titleSp(2, 'Course 99.123 Lecture 3', 'ctrTitle') + bodySp(3, [para('Spring term, Professor Example, Department of Computer Science, Building Four, Room 101')], 1) },
      {
        ...img,
        shapes:
          titleSp(2, 'Sets of strings') +
          bodySp(3, [para('Let f : ℕ → ℝ be a 1-1 correspondence if it is both injective and onto'), para('A language over an alphabet is a set of strings')]) +
          equationShape(5, sup(mr('0'), mr('n')) + sup(mr('1'), mr('n'))) +
          equationShape(6, mr('Q×Σ→Q')) +
          equationShape(7, mr('A−B')),
      },
      {
        shapes:
          titleSp(2, 'The diagonal') +
          bodySp(3, [para('The number built from the diagonal differs from every row of the list in one digit')]) +
          [['7', 100000], ['4', 700000], ['≠7', 1300000], ['≠4', 1900000]].map(([t, x], i) => textBox(10 + i, x as number, 5000000, 500000, 300000, [mono(t as string)])).join(''),
      },
      {
        ...img,
        shapes: titleSp(2, 'A photograph') + bodySp(3, [para('The picture is only decoration and shows the lecturer’s dog on a lawn')]) + picture(4, 'rIdImg1', 8000000, 100000, 300000, 300000, 'A dog'),
      },
      { shapes: textBox(2, 100000, 100000, 6000000, 300000, [para('Example University')]) + textBox(3, 100000, 600000, 8000000, 600000, [para('For the licence and the terms of use of this material, visit: https://example.org/terms.')]) },
      {
        shapes:
          textBox(2, 100000, 100000, 3000000, 300000, [para('Check-in 3.2')]) +
          bodySp(3, [para('Is the language L decidable?'), para('1. Yes, because it is regular.'), para('2. No, because it is not.'), para('3. There is not enough information.')], 1),
      },
      {
        shapes:
          titleSp(2, 'A proof by contradiction') +
          bodySp(3, [para('Theorem: the set is not countable'), para('Proof by contradiction: assume a list of all the elements exists'), para('Build an element that differs from the n-th element of the list'), para('This contradicts the assumption')]) +
          textBox(8, 100000, 5200000, 6000000, 300000, [para('Why is this proof a diagonalization?')]),
      },
      {
        shapes:
          titleSp(2, 'Regions') +
          ['decidable', 'recognizable', 'all languages', 'complement'].map((t, i) => textBox(10 + i, 500000 + i * 1800000, 2500000, 1500000, 300000, [para(t)])).join('') +
          arrowLine(20, 1500000, 3000000, 1200000, 0) +
          arrowLine(21, 3300000, 3000000, 1200000, 0),
      },
      simpleSlide('Four properties', ['The first property holds for every machine of this kind', 'The second property holds only when the input is short', 'The third property depends on the alphabet chosen', 'The fourth property follows from the first two']),
      {
        ...img,
        shapes: titleSp(2, 'Names of languages') + equationShape(5, subName(mr('A'), 'TM') + mr('⊆') + mr('ℝ')) + bodySp(3, [para('The language is written with a subscript naming the problem it stands for')]),
      },
      { ...img, shapes: titleSp(2, 'Quick review of today') + bodySp(3, [para('Showed that two sets can be matched one to one')]) + equationShape(5, mr('f:A→B')) },
    ],
  };
}

let cached: ParsedDeck | undefined;
const load = async (): Promise<ParsedDeck> => (cached ??= await parsePptx(buildPptx(deckSpec())));
const slide = (d: ParsedDeck, n: number): SlideData => d.slides[n - 1]!;
const traits = (s: SlideData) => Object.entries(slideTraits(s)).filter(([, v]) => v).map(([k]) => k);
const kinds = (s: SlideData) => slideGaps(s).map((g) => g.kind);
const textOf = (d: ParsedDeck, n: number) => slideContextText(slide(d, n), d.meta.slideHeight);

describe('what a slide is about, on a lecture about languages and machines', () => {
  it('does not take set notation, a product of sets or "a 1-1 correspondence" for arithmetic', async () => {
    const d = await load();
    expect(traits(slide(d, SLIDE.sets))).toEqual(['math']);
  });

  it('does not take a credits line that says "For information … visit:" for code', async () => {
    const d = await load();
    expect(slideTraits(slide(d, SLIDE.credits)).code).toBe(false);
    expect(traits(slide(d, SLIDE.credits))).toEqual([]);
  });

  it('does not take digits and "≠7" set in a monospaced font to label a table for code or for an algorithm', async () => {
    const d = await load();
    const s = slide(d, SLIDE.digits);
    expect(traits(s)).not.toContain('code');
    expect(traits(s)).not.toContain('algorithm');
    expect(teachingNotes([{ title: s.title, text: textOf(d, SLIDE.digits) }])).not.toContain(TEACHING_NOTES.algorithm);
  });

  it('does not take a small photograph for a diagram', async () => {
    const d = await load();
    expect(slideTraits(slide(d, SLIDE.photo)).diagram).toBe(false);
  });
});

describe('slides that are not course content', () => {
  it('never asks about the title slide, the credits, a check-in or the review of the day', async () => {
    const d = await load();
    const plan = buildBlueprint({ slides: d.slides, topics: d.report.topics, count: 10 });
    const asked = new Set(plan.flatMap((q) => q.slides));
    for (const n of [SLIDE.title, SLIDE.credits, SLIDE.checkIn, SLIDE.recap]) expect(asked.has(n), `slide ${n}`).toBe(false);
    // ... while the slides with content are asked about
    for (const n of [SLIDE.sets, SLIDE.proof]) expect(asked.has(n), `slide ${n}`).toBe(true);
  });

  it('knows a check-in from a slide that merely contains a question', async () => {
    const d = await load();
    expect(slideQuestions(slide(d, SLIDE.checkIn)).map((q) => q.text)).toEqual(['Is the language L decidable?']);
    expect(slideQuestions(slide(d, SLIDE.proof)).map((q) => q.text)).toEqual(['Why is this proof a diagonalization?']);
    expect(slideQuestions(slide(d, SLIDE.bullets))).toEqual([]);
  });
});

describe('telling the student what a theory slide does not say', () => {
  it('reports a question the slide asks and does not answer, on a check-in and on a content slide', async () => {
    const d = await load();
    expect(kinds(slide(d, SLIDE.checkIn))).toContain('question-unanswered');
    const g = slideGaps(slide(d, SLIDE.proof)).find((x) => x.kind === 'question-unanswered')!;
    expect(g.message).toBe('Slide 7 (“A proof by contradiction”) asks a question (“Why is this proof a diagonalization?”) and no answer to it is written on the slide.');
  });

  it('reports labels and arrows whose positions carry the meaning, and not a list of bullets', async () => {
    const d = await load();
    expect(slideGaps(slide(d, SLIDE.regions)).find((g) => g.kind === 'arrangement')!.message).toBe(
      'Slide 8 (“Regions”) has 4 short labels and 2 arrows or lines placed around the slide: what each one marks or joins is shown only by where it sits, so the text does not say it.',
    );
    expect(kinds(slide(d, SLIDE.bullets))).not.toContain('arrangement');
    expect(kinds(slide(d, SLIDE.proof))).not.toContain('arrangement');
  });

  it('does not report a language name with a subscript, a standard number set, or the formulas of a review slide as unexplained', async () => {
    const d = await load();
    expect(kinds(slide(d, SLIDE.names))).not.toContain('formula-undefined');
    expect(kinds(slide(d, SLIDE.recap))).not.toContain('formula-undefined');
    expect(formulaSymbols('A _{\\text{TM}} \\subseteq \\mathbb{R}')).toEqual([]);
    expect(formulaSymbols('f : A \\to \\mathbb{N}')).toEqual(['f', 'A']); // a symbol the slide uses is still one to explain
  });
});

describe('what the tutor and the question writer are told about questions on slides', () => {
  it('tells the tutor not to present its own answer as the slide’s, only where a slide asks a question', async () => {
    const d = await load();
    expect(teachingNotes([{ title: slide(d, SLIDE.checkIn).title, text: textOf(d, SLIDE.checkIn) }])).toContain(TEACHING_NOTES.question);
    expect(teachingNotes([{ title: slide(d, SLIDE.proof).title, text: textOf(d, SLIDE.proof) }])).toContain(TEACHING_NOTES.question);
    expect(teachingNotes([{ title: slide(d, SLIDE.bullets).title, text: textOf(d, SLIDE.bullets) }])).not.toContain(TEACHING_NOTES.question);
    expect(TEACHING_NOTES.question).toMatch(/not answered by the slide/);
    expect(TEACHING_NOTES.question).toMatch(/Beyond the slides:/);
  });

  it('tells the question writer that a question on a slide is not an answer, and that a proof has only the slide’s steps', () => {
    expect(QUESTION_RULES).toMatch(/I\. Questions printed on slides\./);
    expect(QUESTION_RULES).toMatch(/Do not use your own answer to it as a marking point/);
    expect(QUESTION_RULES).toMatch(/Use only the steps the slides show: never add a step, a lemma or a reason the slides leave out/);
  });
});

describe('a professor who wants scenarios and theory with short, complete answers, and proofs where they fit', () => {
  const STYLE = 'Mostly scenarios and theoretical questions requiring short, complete answers, including proofs where appropriate.';

  it('reads "mostly scenarios and theoretical" as the emphasis and "including proofs" as a mention', () => {
    const h = parseExamStyle(STYLE);
    expect(h.prefer.get('scenario')).toBe(6);
    for (const t of ['short', 'define', 'compare'] as const) expect(h.prefer.get(t), t).toBe(6);
    expect(h.prefer.get('proof')).toBe(2); // the emphasis stops at "including"
    expect(parseExamStyle('Mostly scenarios, including proofs.').prefer.get('proof')).toBe(2);
    expect(parseExamStyle('Mostly scenarios and proofs.').prefer.get('proof')).toBe(6);
    expect(h.avoid.has('long')).toBe(true); // short answers: no essay
    expect(h.maxMarks).toBe(5);
  });

  it('still lets "short answers" alone, and "1-3 sentences", mean what they meant', () => {
    expect(parseExamStyle('Short answer questions.').prefer.get('short')).toBe(2);
    expect(parseExamStyle('Most answers are 1–3 sentences.').maxMarks).toBe(3);
    expect(parseExamStyle('Mostly proofs, with some calculations.').prefer.get('calculation')).toBe(2);
    expect(parseExamStyle('Mostly proofs, calculations and traces.').prefer.get('calculation')).toBe(6);
  });

  it('plans several proofs for a lecture made of proofs, scenarios and short questions around them, and proofs keep their marks', async () => {
    const proofSlide = (name: string) => simpleSlide(`${name} is not decidable`, [`Theorem: ${name} is not decidable by any machine`, `Proof by contradiction: assume a machine decides ${name}`, 'Build a second machine that uses it and does the opposite', 'Run the second machine on its own description, which gives a contradiction']);
    const defSlide = (name: string) => simpleSlide(`Defining ${name}`, [`${name} is a set of strings over the alphabet`, `A machine recognizes ${name} when it accepts exactly its strings`, `A machine decides ${name} when it halts on every input`]);
    const spec: DeckSpec = { slides: [proofSlide('Alpha'), proofSlide('Beta'), proofSlide('Gamma'), proofSlide('Delta'), defSlide('Alpha'), defSlide('Beta'), defSlide('Gamma')] };
    const deck = await parsePptx(buildPptx(spec));
    const plan = buildBlueprint({ slides: deck.slides, topics: deck.report.topics, count: 12, examStyle: STYLE });
    const proofs = plan.filter((q) => q.type === 'proof');
    expect(proofs.length).toBeGreaterThanOrEqual(3);
    expect(proofs.length).toBeLessThanOrEqual(4);
    expect(buildBlueprint({ slides: deck.slides, topics: deck.report.topics, count: 12 }).filter((q) => q.type === 'proof').length).toBeGreaterThanOrEqual(3);
    for (const p of proofs) expect(p.marks, 'a proof is not cut to the short-answer limit').toBeGreaterThan(5);
    for (const q of plan) if (q.type !== 'proof' && q.type !== 'mcq' && q.type !== 'truefalse') expect(q.marks, q.type).toBeLessThanOrEqual(5);
    expect(plan.some((q) => q.type === 'long')).toBe(false);
    // with no proof wanted, none is planned
    expect(buildBlueprint({ slides: deck.slides, topics: deck.report.topics, count: 12, examStyle: 'No proofs.' }).some((q) => q.type === 'proof')).toBe(false);
  });
});

describe('the vertical rhythm of a text box', () => {
  it('keeps the space before and after a paragraph, its line spacing, and the size of a blank line', async () => {
    const r = (t: string) => `<a:r><a:rPr lang="en-US" sz="2000"/><a:t>${t}</a:t></a:r>`;
    const p = (ppr: string, inner: string) => `<a:p>${ppr ? `<a:pPr>${ppr}</a:pPr>` : ''}${inner}</a:p>`;
    const body =
      p('<a:spcBef><a:spcPts val="1200"/></a:spcBef>', r('First')) +
      p('<a:spcBef><a:spcPts val="1200"/></a:spcBef>', '<a:endParaRPr lang="en-US" sz="2000"/>') +
      p('<a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="50000"/></a:spcBef><a:spcAft><a:spcPts val="600"/></a:spcAft>', r('Second')) +
      p('', r('Third'));
    const shape = `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 3"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="800000"/><a:ext cx="8000000" cy="4000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody></p:sp>`;
    const deck = await parsePptx(buildPptx({ slides: [{ shapes: shape }] }));
    const el = deck.slides[0]!.elements.find((e) => e.kind === 'shape')!;
    const paras = el.kind === 'shape' ? el.paragraphs : [];
    expect(paras.map((x) => x.text)).toEqual(['First', '', 'Second', 'Third']);
    expect(paras[0]).toMatchObject({ spaceBefore: 12 });
    expect(paras[1]).toMatchObject({ spaceBefore: 12, endSize: 20 }); // a blank line is as tall as its font says
    expect(paras[2]).toMatchObject({ lineSpacing: 0.9, spaceAfter: 6, spaceBefore: 12 }); // 50 % of a 20 pt line
    expect(paras[3]!.spaceBefore).toBeUndefined();
    expect(paras[3]!.lineSpacing).toBeUndefined();
  });
});

describe('a title with a subscript, as a person reads it', () => {
  it('is listed as "A_TM is undecidable" and named so in the gaps, while the slide text keeps its braces', async () => {
    const r = (t: string, rPr = '') => `<a:r><a:rPr lang="en-US"${rPr}/><a:t>${t}</a:t></a:r>`;
    const title = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${r('A')}${r('TM', ' baseline="-25000"')}${r(' is undecidable')}</a:p></p:txBody></p:sp>`;
    const deck = await parsePptx(buildPptx({ slides: [{ shapes: title + textBox(8, 100000, 5200000, 6000000, 300000, [para('Why is this proof a diagonalization?')]) + bodySp(3, [para('Assume a machine decides the language and build a second machine that does the opposite')]) }] }));
    const s = deck.slides[0]!;
    expect(s.title).toBe('A_{TM} is undecidable'); // the slide's own text, as the search and the AI context see it
    expect(displayTitle(s)).toBe('A_TM is undecidable');
    expect(slideGaps(s).find((g) => g.kind === 'question-unanswered')!.message).toContain('Slide 1 (“A_TM is undecidable”) asks a question');
  });
});

describe('what the AI is told about a slide that asks a question or places its labels', () => {
  it('puts both in the slide’s caveats in the lecture text, so they are not answered or inferred as if the slide said them', async () => {
    const d = await load();
    const md = lectureToMarkdown({ title: 'Languages and machines', fileHash: d.fileHash, slideCount: d.slides.length, meta: d.meta }, [slide(d, SLIDE.proof), slide(d, SLIDE.regions), slide(d, SLIDE.bullets)], 'L1');
    const caveat = (n: number) => md.split('---').find((s) => s.includes(`### Slide ${n}:`))!;
    expect(caveat(SLIDE.proof)).toContain('> Extraction caveats: Slide 7 (“A proof by contradiction”) asks a question (“Why is this proof a diagonalization?”) and no answer to it is written on the slide.');
    expect(caveat(SLIDE.regions)).toMatch(/> Extraction caveats: Slide 8 \(“Regions”\) has 4 short labels and 2 arrows or lines placed around the slide/);
    expect(caveat(SLIDE.bullets)).not.toContain('Extraction caveats');
  });
});

describe('a question whose only source is a check-in', () => {
  it('is reported, because the slide asks and does not answer; one that also cites a slide with the answer is not', async () => {
    const d = await load();
    const ctx = { slideText: (_lecture: string, n: number) => (d.slides[n - 1] ? slideVerificationText(d.slides[n - 1]!) : undefined) };
    const question = (slides: number[], type: 'short' | 'mcq' = 'short') => ({
      type,
      prompt: 'Is the language L decidable? Say yes or no and give one reason.',
      marks: 2,
      difficulty: 2,
      rubric: [{ text: 'States that L is not decidable.', marks: 1 }, { text: 'Gives the reason that the language is not regular.', marks: 1 }],
      modelAnswer: 'No, L is not decidable, because the language is not regular and so on.',
      sources: slides.map((n) => ({ lectureId: 'lec', slide: n })),
    });
    const codes = (slides: number[], type?: 'short' | 'mcq') => assessQuestions([question(slides, type)], ctx).issues.map((i) => i.code);
    expect(codes([SLIDE.checkIn])).toContain('SOURCE_IS_QUESTION');
    expect(codes([SLIDE.checkIn], 'mcq')).toContain('SOURCE_IS_QUESTION');
    expect(codes([SLIDE.checkIn, SLIDE.proof])).not.toContain('SOURCE_IS_QUESTION');
    expect(codes([SLIDE.proof])).not.toContain('SOURCE_IS_QUESTION'); // a content slide that holds a question among its text
    expect(isQuestionText(slideVerificationText(slide(d, SLIDE.checkIn)))).toBe(true);
    expect(isQuestionText(slideVerificationText(slide(d, SLIDE.proof)))).toBe(false);
  });
});

describe('what the real model’s answers on a theory lecture showed', () => {
  it('finds a quote whose subscripts and superscripts are written joined or apart, and still rejects a changed one', () => {
    const slide = 'Proof: let Q_1 and Q_2 decide B.\n1. Start Q_1 and Q_2 on z in lockstep until one halts.\nIt disagrees with the k^{th} entry at the k^{th} position.\nB_{AB} is recognizable';
    expect(quoteInText('1. Start Q1 and Q2 on z in lockstep until one halts.', slide)).toBe(true);
    expect(quoteInText('disagrees with the kth entry at the kth position', slide)).toBe(true);
    expect(quoteInText('B_AB is recognizable', slide)).toBe(true);
    expect(quoteInText('BAB is recognizable', slide)).toBe(true);
    expect(quoteInText('let Q_{1} and Q_{2} decide B', slide)).toBe(true);
    // and the other way round: the slide has "M1", the quote "M_1"
    expect(quoteInText('Start Q_1 and Q_2 on z in lockstep', 'Start Q1 and Q2 on z in lockstep until one halts')).toBe(true);
    expect(quoteInText('Start Q1 and Q3 on z in lockstep until one halts', slide)).toBe(false);
    expect(quoteInText('disagrees with the mth entry at the kth position', slide)).toBe(false);
  });

  it('does not call a short quote “unconfirmed” when its words stand in the question as written', () => {
    const sent = [{ n: 1, type: 'scenario' as const, prompt: 'A machine H decides the language. Describe the construction of $D$ and state four outcomes of its execution.', marks: 2, rubric: [{ text: 'D simulates H on its own description', marks: 1 }, { text: 'D does the opposite of H', marks: 1 }] }];
    const verdict = (quote: string) => [{ n: 1, points: [{ point: 1, asked: 'yes' as const, quote, note: '' }, { point: 2, asked: 'yes' as const, quote: 'state four outcomes', note: '' }] }];
    expect(auditFindings(verdict('Describe the construction of D'), sent)).toEqual([]);
    // a quote that is not in the question is still reported
    expect(auditFindings(verdict('Prove that D is a decider'), sent).map((f) => f.kind)).toEqual(['unconfirmed']);
  });

  it('takes "provide the proof" for a request for a proof', () => {
    const ctx = { slideText: () => 'Theorem and proof by contradiction' };
    const proof = (prompt: string) => ({ type: 'proof' as const, prompt, marks: 2, difficulty: 3, rubric: [{ text: 'Assume the opposite', marks: 1 }, { text: 'Reach a contradiction', marks: 1 }], modelAnswer: 'Assume the opposite and reach a contradiction.', sources: [{ lectureId: 'lec', slide: 1 }] });
    const flagged = (prompt: string) => assessQuestions([proof(prompt)], ctx).issues.some((i) => i.code === 'TYPE_MISMATCH');
    expect(flagged('Provide the proof by contradiction that the set is uncountable. State two steps.')).toBe(false);
    expect(flagged('Describe the set. State two things about it.')).toBe(true);
  });

  it('tells the tutor never to name the block of gaps to the student, and what a gap can be', () => {
    expect(TUTOR_RULES).toMatch(/never name the block, its tags or "known gaps" to the student/);
    expect(TUTOR_RULES).toMatch(/a question the slide asks and does not answer, labels and arrows whose positions are not in the text/);
  });
});

describe('a "scenario" that only restates the slide, and algorithm points that pay one step twice', () => {
  // invented slides with the same shape as the ones the real model was given
  const construction = [
    'Theorem: the language L is not decidable',
    'Suppose, for contradiction, that some machine H decides L.',
    'Use H to construct machine D.',
    'D = "On input w',
    '1. Run H on input w w.',
    '2. Answer yes if H answers no, and no if H answers yes."',
    'D accepts w iff D does not accept w. Contradiction.',
  ].join('\n');
  const parallel = [
    'Theorem: if A and its complement are recognizable then A is decidable',
    'Argument: let machine P1 recognize A and machine P2 recognize the complement.',
    'T = "On input x',
    '1. Run P1 and P2 on x together until one accepts.',
    '2. If P1 accepts then accept. If P2 accepts then reject."',
  ].join('\n');
  const ctx = (text: string) => ({ slideText: () => text });
  const written = (over: Record<string, unknown>) => ({
    type: 'scenario' as const,
    prompt: '',
    marks: 3,
    difficulty: 3,
    rubric: [{ text: 'Assume some machine H decides L', marks: 1 }, { text: 'Build D from H', marks: 1 }, { text: 'D accepts w iff D does not accept w', marks: 1 }],
    modelAnswer: 'Assume some machine H decides L. Build D from H. D accepts w iff D does not accept w, a contradiction.',
    sources: [{ lectureId: 'lec', slide: 1 }],
    ...over,
  });
  const codes = (q: ReturnType<typeof written>, text: string) => assessQuestions([q], ctx(text)).issues.map((i) => i.code);

  it('flags a situation that is the slide’s own setup with a request to describe it', () => {
    const restated = written({ prompt: 'You are designing a machine D to show that L is not decidable. Suppose you have a machine H that decides L. Describe the construction of D and state three outcomes of its execution.' });
    expect(codes(restated, construction)).toContain('SCENARIO_ADDS_NOTHING');
    expect(scenarioAddsNothing(restated.prompt, new Set(keyWords(construction)))).toBe(true);
  });

  it('leaves alone a situation that brings something new, or asks the student to decide', () => {
    const novel = written({ prompt: 'A student claims that machine K, which loops forever on the string 0110, decides L. Describe what the argument in the lecture says about such a claim and state three outcomes.' });
    expect(codes(novel, construction)).not.toContain('SCENARIO_ADDS_NOTHING');
    const decides = written({ prompt: 'You are designing a machine D from a machine H that decides L. Decide whether D can exist and justify your answer in three steps.' });
    expect(codes(decides, construction)).not.toContain('SCENARIO_ADDS_NOTHING');
    // only a scenario or a case is held to it
    expect(codes(written({ type: 'short', prompt: 'You are designing a machine D to show that L is not decidable. Suppose you have a machine H that decides L. Describe the construction of D.' }), construction)).not.toContain('SCENARIO_ADDS_NOTHING');
  });

  const algorithm = (points: string[]) => written({
    type: 'algorithm',
    prompt: `Explain how T decides A. State ${points.length} steps.`,
    marks: points.length,
    rubric: points.map((text) => ({ text, marks: 1 })),
    modelAnswer: points.join(' '),
  });

  it('flags two marking points that rest on one step of the slide, and not points that each have a step of their own', () => {
    const padded = algorithm(['Let P1 recognize A and P2 recognize the complement of A', 'T runs P1 and P2 on x together', 'T continues until one accepts', 'If P1 accepts then T accepts', 'If P2 accepts then T rejects']);
    const found = assessQuestions([padded], ctx(parallel)).issues.filter((i) => i.code === 'POINTS_SAME_STEP');
    expect(found).toHaveLength(1);
    expect(found[0]!.point).toBe(3);
    expect(found[0]!.message).toContain('Marking points 2 and 3 both rest on the same single step of the slides ("Run P1 and P2 on x together until one accepts.")');
    const honest = algorithm(['Let P1 recognize A and P2 recognize the complement of A', 'T runs P1 and P2 on x together until one accepts', 'If P1 accepts then T accepts', 'If P2 accepts then T rejects']);
    expect(codes(honest, parallel)).not.toContain('POINTS_SAME_STEP');
  });

  it('asks the question writer for steps, not "steps or outcomes", never to split a step, and for a new case in a scenario', () => {
    expect(QUESTION_RULES).toMatch(/Never split one step into two points and never add a point for a set-up sentence to reach the number of marks/);
    expect(QUESTION_RULES).toMatch(/Ask for "the steps" \(or "the transitions"\), not "steps or outcomes"/);
    expect(QUESTION_RULES).toMatch(/A situation must bring something the slides do not say/);
    expect(QUESTION_RULES).toMatch(/a claim or a short argument to judge/);
  });
});
