import { describe, expect, it } from 'vitest';
import type { PlannedSlot } from '../src/core/study/blueprint';
import { assessQuestions, keyWords, type QualityCode, type QualityContext, type QualityQuestion } from '../src/core/study/pack-quality';

/** Synthetic questions and slides only. */
const SLIDES: Record<number, string> = {
  1: 'Firewalls\nA firewall filters network traffic using rules. It blocks packets from untrusted addresses and logs every blocked attempt.',
  2: 'Encryption\nEncryption protects data in transit so that a listener on the network cannot read it. Symmetric encryption uses one shared key, asymmetric encryption uses a public key and a private key.',
  3: 'Authentication\nAuthentication proves who a user is. It is used to check a user before access is granted. A password is something you know, a token is something you have, a fingerprint is something you are.',
  4: 'Audits\nAn audit reviews logs and configuration to find policy violations. Regular audits catch misconfigured firewalls before attackers do.',
};
const ctx: QualityContext = { slideText: (_l, n) => SLIDES[n] };

function q(over: Partial<QualityQuestion> = {}): QualityQuestion {
  return {
    type: 'scenario',
    prompt: 'A small company lets staff reach its server from home. An attacker on a public network tries to read the traffic and to guess a password. State three controls from the lecture that reduce the risk and say what each one does.',
    marks: 3,
    difficulty: 3,
    topic: 'Defences',
    rubric: [
      { text: 'Encryption protects data in transit so a listener cannot read it', marks: 1 },
      { text: 'A firewall filters traffic using rules and blocks untrusted addresses', marks: 1 },
      { text: 'Authentication proves who the user is, for example with a token', marks: 1 },
    ],
    modelAnswer: 'Encryption protects the data in transit, so a listener on the network cannot read it. A firewall filters the traffic using rules and blocks packets from untrusted addresses. Authentication proves who the user is, for example with a token that they have.',
    sources: [{ lectureId: 'L', slide: 1 }, { lectureId: 'L', slide: 2 }, { lectureId: 'L', slide: 3 }],
    ...over,
  };
}
const codes = (qs: QualityQuestion[], opts = {}) => assessQuestions(qs, ctx, opts).issues.map((i) => i.code);
const has = (qs: QualityQuestion[], code: QualityCode, opts = {}) => codes(qs, opts).includes(code);

describe('words', () => {
  it('compares meaning rather than spelling: endings are ignored, filler words are dropped', () => {
    expect(keyWords('overwrites')).toEqual(keyWords('overwriting'));
    expect(keyWords('addresses')).toEqual(keyWords('address'));
    expect(keyWords('protects')).toEqual(keyWords('protected'));
    expect(keyWords('the')).toEqual([]);
    expect(keyWords('Students must state the answer')).toEqual([]); // all filler in a marking scheme
    expect(keyWords('Encryption protects data, data!')).toHaveLength(3); // no repeats
    expect(keyWords('Ünïcode WORDS 42')).toEqual(['ünïcode', 'word', '42']);
  });
});

describe('a good question set', () => {
  it('has nothing to report: no false alarms on questions that follow the rules', () => {
    const set: QualityQuestion[] = [
      q(),
      q({ type: 'define', difficulty: 1, marks: 2, prompt: 'Define authentication and say what it is for.', topic: 'Access', rubric: [{ text: 'Authentication proves who a user is', marks: 1 }, { text: 'It is used before access is granted to a user', marks: 1 }], modelAnswer: 'Authentication proves who a user is. It is used to check the user before access is granted.', sources: [{ lectureId: 'L', slide: 3 }] }),
      q({ type: 'compare', difficulty: 2, marks: 4, prompt: 'Compare symmetric and asymmetric encryption: the number of keys, who holds them, and one situation where each suits.', rubric: [{ text: 'Symmetric encryption uses one shared key', marks: 1 }, { text: 'Asymmetric encryption uses a public key and a private key', marks: 1 }, { text: 'The private key is held only by its owner while the public key is shared', marks: 1 }, { text: 'Symmetric suits a shared secret between two parties; asymmetric suits strangers who have not met', marks: 1 }], modelAnswer: 'Symmetric encryption uses one shared key that both sides hold. Asymmetric encryption uses a public key and a private key. The private key stays with its owner while the public key is shared. Symmetric suits two parties with a shared secret; asymmetric suits strangers who have not met before.', sources: [{ lectureId: 'L', slide: 2 }] }),
      q({ type: 'truefalse', difficulty: 1, marks: 1, prompt: 'A firewall filters network traffic using rules.', rubric: [], modelAnswer: undefined, options: [{ correct: true }, { correct: false }], sources: [{ lectureId: 'L', slide: 1 }] }),
    ];
    expect(assessQuestions(set, ctx).issues).toEqual([]);
  });
});

describe('marks and marking points', () => {
  it('wants about one marking point per mark', () => {
    expect(has([q({ marks: 6, rubric: q().rubric.slice(0, 2) })], 'POINTS_FEW')).toBe(true);
    expect(has([q({ marks: 1, rubric: [...q().rubric, { text: 'Audits find policy violations in the logs', marks: 1 }] })], 'POINTS_MANY')).toBe(true);
    expect(has([q()], 'POINTS_FEW')).toBe(false);
    expect(has([q({ type: 'mcq', marks: 1, rubric: [], options: [{ correct: true }, { correct: false }], modelAnswer: undefined })], 'POINTS_FEW')).toBe(false); // auto-marked
  });

  it('finds a marking point that is worth several marks (a bundle of ideas), except in proofs and calculations that carry steps', () => {
    const bundle = q({ marks: 4, rubric: [{ text: 'Encryption, firewalls and authentication each reduce the risk', marks: 3 }, { text: 'Audits find policy violations', marks: 1 }] });
    expect(has([bundle], 'POINT_BUNDLE')).toBe(true);
    expect(has([{ ...bundle, type: 'calculation', prompt: 'Compute 3 plus 4 and show each step of the working in full detail please.' }], 'POINT_BUNDLE')).toBe(false);
  });

  it('refuses points that cannot be earned alone: "any two of", "all four", "at least three", "one of the following"', () => {
    for (const text of ['Any two of the following controls', 'All four points are listed', 'At least three controls are named', 'One of the following: encryption, firewall', 'Lists any 2 controls']) {
      expect(has([q({ rubric: [{ text, marks: 1 }, ...q().rubric.slice(1)] })], 'POINTS_NOT_INDEPENDENT'), text).toBe(true);
    }
    expect(has([q()], 'POINTS_NOT_INDEPENDENT')).toBe(false);
    // a statement about the subject is not an instruction to the marker (found on a theory lecture: a proof step that says "at least one")
    for (const text of ['Because |xy| ≤ p, the part y contains only 0s, and |y| > 0 so it contains at least one.', 'The line through any two points of the set is also in the set', 'The pumping length p is at least 1']) {
      expect(has([q({ rubric: [{ text, marks: 1 }, ...q().rubric.slice(1)] })], 'POINTS_NOT_INDEPENDENT'), text).toBe(false);
    }
  });

  it('flags a mark-scheme line that lets either of two ideas earn the mark, but not an idea that is itself a pair', () => {
    expect(has([q({ rubric: [{ text: 'Mentions encryption or hashing', marks: 1 }, ...q().rubric.slice(1)] })], 'POINT_EITHER')).toBe(true);
    expect(has([q({ rubric: [{ text: 'The same value can be data or an instruction', marks: 1 }, ...q().rubric.slice(1)] })], 'POINT_EITHER')).toBe(false);
  });

  it('finds marking points that say the same thing, but not two points that share words and are different ideas', () => {
    const twice = q({ marks: 2, rubric: [{ text: 'Encryption protects data in transit', marks: 1 }, { text: 'Encryption protects the data in transit', marks: 1 }] });
    expect(has([twice], 'POINTS_OVERLAP')).toBe(true);
    // found on the real lecture: both share "grows", "high", "low", yet one is about the stack and the other about the heap
    const stackHeap = q({ marks: 2, rubric: [{ text: 'Stack grows from high to low', marks: 1 }, { text: 'Heap grows from low to high', marks: 1 }], modelAnswer: 'The stack grows from high to low and the heap grows from low to high.', sources: [] });
    expect(has([stackHeap], 'POINTS_OVERLAP')).toBe(false);
  });
});

describe('the model answer', () => {
  it('must exist, and must be about as long as the marks call for', () => {
    expect(has([q({ modelAnswer: undefined })], 'NO_MODEL_ANSWER')).toBe(true);
    expect(has([q({ marks: 6, rubric: q().rubric.concat(q().rubric), modelAnswer: 'Encryption, firewalls, authentication.' })], 'ANSWER_THIN')).toBe(true);
    expect(has([q({ marks: 1, type: 'short', difficulty: 1, rubric: [q().rubric[0]!], modelAnswer: 'word '.repeat(120) })], 'ANSWER_LONG')).toBe(true);
    expect(has([q()], 'ANSWER_THIN')).toBe(false);
    // a list of three short items that holds every marking point is a complete answer, not a thin one (found on a real 3-mark question)
    const list = q({ marks: 3, type: 'short', rubric: [{ text: 'It contains callable OS functions', marks: 1 }, { text: 'It contains command line arguments', marks: 1 }, { text: 'It contains environment variables', marks: 1 }], modelAnswer: 'Callable OS functions, command line arguments, environment variables.' });
    expect(has([list], 'ANSWER_THIN')).toBe(false);
    expect(has([list], 'ANSWER_MISSES_POINT')).toBe(false);
    expect(has([{ ...list, modelAnswer: 'Callable OS functions only.' }], 'ANSWER_THIN')).toBe(true); // short AND missing points
    expect(has([q({ marks: 1, type: 'short', difficulty: 1, rubric: [q().rubric[0]!], modelAnswer: 'Encryption protects data in transit.' })], 'ANSWER_THIN')).toBe(false); // one mark, one short sentence
  });

  it('must contain every marking point, or a perfect answer would not earn full marks', () => {
    const missing = q({ modelAnswer: 'Encryption protects the data in transit so that a listener cannot read it. A firewall filters the traffic using rules and blocks untrusted addresses.' });
    const issues = assessQuestions([missing], ctx).issues.filter((i) => i.code === 'ANSWER_MISSES_POINT');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('marking point 3');
    // keywords given with the point count as evidence
    const viaKeywords = q({ modelAnswer: missing.modelAnswer + ' Token.', rubric: [q().rubric[0]!, q().rubric[1]!, { ...q().rubric[2]!, keywords: ['token'] }] });
    expect(has([viaKeywords], 'ANSWER_MISSES_POINT')).toBe(false);
  });
});

describe('marking points and the slides', () => {
  it('flags a point whose words are not on the slides cited, but allows words from the question’s own situation', () => {
    const off = q({ rubric: [{ text: 'Quantum networking eliminates eavesdropping completely', marks: 1 }, ...q().rubric.slice(1)], modelAnswer: q().modelAnswer + ' Quantum networking eliminates eavesdropping completely.' });
    expect(has([off], 'POINT_NOT_ON_SLIDES')).toBe(true);
    expect(has([q()], 'POINT_NOT_ON_SLIDES')).toBe(false);
    // a scenario's point may use the words of the situation described in the question itself
    const situational = q({ prompt: q().prompt + ' The company uses a laptop called Orion at home.', rubric: [{ text: 'The Orion laptop traffic is protected by encryption in transit', marks: 1 }, ...q().rubric.slice(1)] });
    expect(has([situational], 'POINT_NOT_ON_SLIDES')).toBe(false);
    // nothing cited means nothing to compare with, so nothing is claimed
    expect(has([q({ sources: [] })], 'POINT_NOT_ON_SLIDES')).toBe(false);
  });
});

describe('the kind of question', () => {
  const t = (type: QualityQuestion['type'], prompt: string) => has([q({ type, prompt })], 'TYPE_MISMATCH');
  it('makes a scenario describe a situation, a comparison compare, a calculation give numbers, a proof ask to prove', () => {
    expect(t('scenario', 'What is a firewall?')).toBe(true);
    expect(t('scenario', q().prompt)).toBe(false);
    expect(t('compare', 'What is symmetric encryption?')).toBe(true);
    expect(t('compare', 'Compare symmetric and asymmetric encryption.')).toBe(false);
    expect(t('calculation', 'How many keys are needed for many users?')).toBe(true);
    expect(t('calculation', 'Ten users each need to talk privately to every other user. How many shared keys are needed?')).toBe(false);
    expect(t('proof', 'Describe asymmetric encryption.')).toBe(true);
    expect(t('proof', 'Show that a message encrypted with a public key cannot be read with the same key.')).toBe(false);
    expect(t('diagram', 'List three controls.')).toBe(true);
    expect(t('diagram', 'The figure shows a firewall between two networks. What does it block?')).toBe(false);
  });

  it('wants the difficulty and the marks to agree for written questions', () => {
    expect(has([q({ difficulty: 3, marks: 1, rubric: [q().rubric[0]!], modelAnswer: 'Encryption protects data in transit.' })], 'DIFFICULTY_MARKS')).toBe(true);
    expect(has([q({ difficulty: 1, marks: 6, rubric: q().rubric.concat(q().rubric) })], 'DIFFICULTY_MARKS')).toBe(true);
    expect(has([q()], 'DIFFICULTY_MARKS')).toBe(false);
    expect(has([q({ type: 'mcq', difficulty: 3, marks: 1, rubric: [], options: [{ correct: true }, { correct: false }], modelAnswer: undefined })], 'DIFFICULTY_MARKS')).toBe(false);
  });
});

describe('the whole set', () => {
  const recall = (prompt: string, d = 1): QualityQuestion => q({ type: 'define', difficulty: d, marks: 2, prompt, rubric: q().rubric.slice(0, 2), modelAnswer: q().modelAnswer, sources: [{ lectureId: 'L', slide: 1 }, { lectureId: 'L', slide: 2 }] });

  it('finds duplicates inside the set and against questions that already exist', () => {
    expect(codes([q(), q({ prompt: q().prompt.replace('small company', 'small firm') })])).toContain('DUPLICATE');
    expect(codes([q(), recall('Define authentication and say what it is for.')])).not.toContain('DUPLICATE');
    expect(codes([recall('Define a firewall and say what it does for a network.')], { existingPrompts: ['Define a firewall and say what it does for a network?'] })).toContain('DUPLICATE');
    expect(codes([recall('Define authentication.')], { existingPrompts: ['Explain what a firewall does.'] })).not.toContain('DUPLICATE');
  });

  it('says so when a set of four or more is only recall, one kind, one difficulty or without a hard question', () => {
    const four = [recall('Define a firewall and what it does'), recall('Define encryption and what it protects', 1), recall('Define authentication and what it proves', 1), recall('Define an audit and what it finds', 1)];
    expect(codes(four)).toEqual(expect.arrayContaining(['ONLY_RECALL', 'ONE_TYPE', 'ONE_DIFFICULTY']));
    expect(codes(four.slice(0, 3))).not.toContain('ONLY_RECALL'); // too few to say
    const five = [...four, recall('Define a token and what it proves about a user', 2)];
    expect(codes(five)).toContain('NO_HARD');
    const mixed = [q(), q({ type: 'compare', difficulty: 2, prompt: 'Compare a firewall with an audit: what each looks at and when each acts.', marks: 4, rubric: q().rubric.concat([{ text: 'Audits find policy violations in logs', marks: 1 }]), modelAnswer: q().modelAnswer + ' Audits find policy violations in logs.' }), recall('Define authentication and what it proves'), recall('Define encryption and what it protects', 2)];
    expect(codes(mixed)).not.toEqual(expect.arrayContaining(['ONLY_RECALL']));
    expect(codes(mixed)).not.toContain('ONE_TYPE');
    expect(codes(mixed)).not.toContain('ONE_DIFFICULTY');
  });

  it('reports the shape of the set: kinds, difficulty, marks, recall share, slides cited', () => {
    const r = assessQuestions([q(), recall('Define authentication and what it proves')], ctx);
    expect(r.stats).toMatchObject({ questions: 2, byType: { scenario: 1, define: 1 }, byDifficulty: { 1: 1, 2: 0, 3: 1 }, totalMarks: 5, recallShare: 0.5 });
    expect(r.stats.slidesCited).toEqual(['L:1', 'L:2', 'L:3']);
    expect(assessQuestions([], ctx).stats).toMatchObject({ questions: 0, totalMarks: 0, recallShare: 0 });
  });
});

describe('the questions against the plan', () => {
  const plan: PlannedSlot[] = [
    { type: 'scenario', difficulty: 3, marks: 3, points: 3, topic: 'Defences', slides: [1, 2] },
    { type: 'define', difficulty: 1, marks: 2, points: 2, topic: 'Access', slides: [3] },
  ];
  const second = q({ type: 'define', difficulty: 1, marks: 2, prompt: 'Define authentication and say what it is for.', topic: 'Access', rubric: [{ text: 'Authentication proves who a user is', marks: 1 }, { text: 'It is used before access is granted to a user', marks: 1 }], modelAnswer: 'Authentication proves who a user is. It is used to check the user before access is granted.', sources: [{ lectureId: 'L', slide: 3 }] });

  it('counts the questions that came back as planned, and says what differs', () => {
    const ok = assessQuestions([q(), second], ctx, { expected: plan });
    expect(ok.issues.filter((i) => i.code.startsWith('PLAN_'))).toEqual([]);
    expect(ok.stats.asPlanned).toEqual({ met: 2, of: 2 });

    const off = assessQuestions([q({ type: 'short', marks: 6, topic: 'Something else', rubric: q().rubric.concat(q().rubric) }), second], ctx, { expected: plan });
    const planCodes = off.issues.filter((i) => i.code.startsWith('PLAN_')).map((i) => `${i.code}@${i.question}`);
    expect(planCodes).toEqual(['PLAN_TYPE@1', 'PLAN_MARKS@1', 'PLAN_TOPIC@1']);
    expect(off.stats.asPlanned).toEqual({ met: 1, of: 2 });
  });

  it('accepts the topic whatever its case or spacing, and a mark off by one', () => {
    const r = assessQuestions([q({ topic: '  defences ', marks: 4, rubric: q().rubric.concat([{ text: 'Audits find policy violations in the logs', marks: 1 }]) }), second], ctx, { expected: plan });
    expect(r.issues.filter((i) => i.code.startsWith('PLAN_'))).toEqual([]);
  });

  it('says when the number of questions is not the number planned', () => {
    expect(codes([q()], { expected: plan })).toContain('PLAN_COUNT');
    expect(codes([q(), second, q()], { expected: plan })).toContain('PLAN_COUNT');
  });
});

describe('robustness', () => {
  it('copes with empty text, no rubric and no sources without throwing', () => {
    const odd: QualityQuestion[] = [
      { type: 'short', prompt: '', marks: 1, difficulty: 2, rubric: [], sources: [] },
      { type: 'long', prompt: 'x', marks: 8, difficulty: 3, rubric: [{ text: '', marks: 8 }], modelAnswer: '', sources: [{ lectureId: 'nope', slide: 999 }] },
    ];
    expect(() => assessQuestions(odd, ctx)).not.toThrow();
    expect(codes(odd)).toEqual(expect.arrayContaining(['NO_RUBRIC', 'NO_MODEL_ANSWER']));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Every marking point must answer something the question explicitly asks. These are the questions the real model wrote in
// the first real-model check, with their faults: a sixth mark nobody asked for, marking points that answer a different
// question than the prompt, and a "scenario" whose story could be deleted without changing the answer.
// ---------------------------------------------------------------------------------------------------------------
describe('marking points answer what the question asks (failures found with the real model)', () => {
  const SEGMENTS_PROMPT =
    'A developer is writing a C program that uses global variables to store configuration, local variables for function logic, and dynamic memory for processing user input. Based on the general memory layout, identify which specific memory segments will store each of these three types of data, and describe the growth direction for the stack and heap segments.';
  const pts = (texts: string[], asks: number[]) => texts.map((text, i) => ({ text, marks: 1, ask: asks[i] }));
  const SEGMENT_POINTS = [
    'Global variables are stored in the data segment.',
    'Local variables are stored in the stack.',
    'Dynamic memory is stored in the heap.',
    'The stack grows downwards from high addresses.',
    'The heap grows upwards from low addresses.',
  ];
  const PADDED = 'Memory segments are separated for each running program.';
  const segments = (over: Partial<QualityQuestion> = {}): QualityQuestion => ({
    type: 'scenario',
    prompt: SEGMENTS_PROMPT,
    marks: 6,
    difficulty: 3,
    asks: [
      { quote: 'identify which specific memory segments will store each of these three types of data', count: 3 },
      { quote: 'describe the growth direction for the stack and heap segments', count: 2 },
    ],
    rubric: pts([...SEGMENT_POINTS, PADDED], [1, 1, 1, 2, 2, 2]),
    modelAnswer: 'Global variables are stored in the data segment. Local variables are stored in the stack. Dynamic memory is stored in the heap. The stack grows downwards from high addresses. The heap grows upwards from low addresses.',
    sources: [],
    ...over,
  });
  const alignment = (qs: QualityQuestion[], opts = {}) => assessQuestions(qs, ctx, opts).issues.filter((i) => ['NO_ASKS', 'ASK_NOT_IN_QUESTION', 'ASK_COUNT', 'POINT_NOT_ASKED', 'SCENARIO_NOT_NEEDED'].includes(i.code));

  it('finds the sixth mark that the question never asked for (a six-mark scenario that asks for five things)', () => {
    const found = alignment([segments()]);
    expect(found.map((i) => i.code)).toEqual(['ASK_COUNT']);
    expect(found[0]!.message).toMatch(/asks for 2 items in "describe the growth direction.*but 3 marking points answer it: the extra marks are not asked for/);
    // pointing the padded mark at an ask that does not exist does not hide it either
    const lost = alignment([segments({ rubric: pts([...SEGMENT_POINTS, PADDED], [1, 1, 1, 2, 2, 3]) })]);
    expect(lost.map((i) => i.code)).toEqual(['POINT_NOT_ASKED']);
    expect(lost[0]!.message).toMatch(/Marking point 6 \("Memory segments are separated/);
    // a point that does not say which ask it answers is reported too, even when the counts happen to add up
    const unsaid = segments({ marks: 5, rubric: pts(SEGMENT_POINTS, [1, 1, 1, 2, 2]).map((p, i) => (i === 4 ? { text: p.text, marks: 1 } : p)) });
    expect(alignment([unsaid]).map((i) => i.code)).toEqual(['ASK_COUNT', 'POINT_NOT_ASKED']);
    // honestly written: five asked things, five marks
    expect(alignment([segments({ marks: 5, rubric: pts(SEGMENT_POINTS, [1, 1, 1, 2, 2]) })])).toEqual([]);
  });

  it('asks the model to say what each marking point answers, and reports a question that does not', () => {
    const legacy = segments({ asks: undefined, rubric: SEGMENT_POINTS.concat(PADDED).map((text) => ({ text, marks: 1 })) });
    expect(alignment([legacy])).toEqual([]); // a pack from another AI that has no asks is not blamed
    expect(alignment([legacy], { requireAsks: true }).map((i) => i.code)).toEqual(['NO_ASKS']);
    expect(alignment([{ ...legacy, marks: 1, rubric: [legacy.rubric[0]!] }], { requireAsks: true })).toEqual([]); // a 1-mark question needs no list of asks
  });

  it('does not let a made-up ask or a wrong number pass', () => {
    const invented = segments({ asks: [{ quote: 'explain how memory protection separates running programs', count: 3 }, { quote: 'describe the growth direction for the stack and heap segments', count: 3 }], rubric: pts([...SEGMENT_POINTS, PADDED], [1, 1, 1, 2, 2, 2]) });
    expect(alignment([invented]).map((i) => i.code)).toEqual(['ASK_NOT_IN_QUESTION']);
    const wrongNumber = segments({ asks: [{ quote: 'identify which specific memory segments will store each of these three types of data', count: 4 }, { quote: 'describe the growth direction for the stack and heap segments', count: 2 }], rubric: pts([...SEGMENT_POINTS, PADDED], [1, 1, 1, 1, 2, 2]), marks: 6 });
    expect(alignment([wrongNumber]).map((i) => i.code)).toEqual(['ASK_COUNT']);
    expect(alignment([wrongNumber])[0]!.message).toMatch(/says 3 in .*but that ask is marked as wanting 4/);
  });

  it('finds something the question asks for that no marking point rewards', () => {
    const unrewarded = segments({ marks: 3, rubric: pts(SEGMENT_POINTS.slice(0, 3), [1, 1, 1]) });
    expect(alignment([unrewarded]).map((i) => i.message)).toEqual([expect.stringMatching(/asks for "describe the growth direction.*but no marking point rewards it/)]);
  });

  it('cannot see a point that is asked for in words but answers something else; that needs the AI check (see the audit tests)', () => {
    // The real six-mark "attack" question asked for three arguments AND three kinds of non-malicious error, but rewarded three
    // things an attacker can do. The counts and the words agree, so only a reader of the meaning can find it.
    const q5: QualityQuestion = {
      type: 'attack',
      prompt: 'A security analyst claims that software security is a greater concern than network security. Based on the provided lecture slides, identify three statistics or arguments supporting this view, and identify three specific types of non-malicious programming errors that can be exploited by an attacker.',
      marks: 6,
      difficulty: 3,
      asks: [{ quote: 'identify three statistics or arguments supporting this view', count: 3 }, { quote: 'identify three specific types of non-malicious programming errors', count: 3 }],
      rubric: pts(['72% of incidents start in client software.', '40% of those are old mistakes such as unchecked input.', 'Weak client software makes network defences harder.', 'Attacker can run their own commands.', 'Attacker can enter the machine.', 'Attacker can stop the program for everyone else.'], [1, 1, 1, 2, 2, 2]),
      modelAnswer: '72% of incidents start in client software. 40% of those are old mistakes. Weak client software makes network defences harder. Attackers can run their own commands. Attackers can enter the machine. Attackers can stop the program for everyone else.',
      sources: [],
    };
    expect(alignment([q5])).toEqual([]);
  });

  it('finds a scenario that is only a recall question with a story in front, and leaves real scenarios alone', () => {
    const recall: QualityQuestion = {
      type: 'scenario',
      prompt: 'A developer is writing a C program that uses dynamic memory allocation to manage user-provided data. They are concerned about how the system handles the memory segments. Based on the architecture of RAM, identify three characteristics of the heap segment.',
      marks: 3,
      difficulty: 2,
      rubric: [{ text: 'The heap serves allocations made while the program runs.', marks: 1 }, { text: 'The heap expands towards higher addresses as it is used.', marks: 1 }, { text: 'The heap can be reached by every loaded library.', marks: 1 }],
      modelAnswer: 'The heap serves allocations made while the program runs. It expands towards higher addresses as it is used. Additionally, it can be reached by every loaded library in a process.',
      sources: [],
    };
    expect(alignment([recall]).map((i) => i.code)).toEqual(['SCENARIO_NOT_NEEDED']);
    // the same story asking for a decision is an application question
    expect(alignment([{ ...recall, prompt: recall.prompt.replace('identify three characteristics of the heap segment', 'say which of her variables belong on the heap and why') }])).toEqual([]);
    // the other real scenarios, and a scenario that asks for advice, are not reported
    expect(alignment([segments({ marks: 5, rubric: pts(SEGMENT_POINTS, [1, 1, 1, 2, 2]) })])).toEqual([]);
    expect(alignment([{ ...recall, prompt: 'A hospital stores patient records on a server that staff reach from their own laptops. A nurse reports that a colleague read her records without permission. Which access control approach should the hospital adopt, and why?' }])).toEqual([]);
    // a case that only asks to state, whatever the story, is reported; kinds that are not situations are not examined
    expect(alignment([{ ...recall, type: 'case' }]).map((i) => i.code)).toEqual(['SCENARIO_NOT_NEEDED']);
    expect(alignment([{ ...recall, type: 'short' }])).toEqual([]);
  });
});

// Found with the real model on the second real run (new prompt rules): a count that was not one, and an "attack" question that is not.
describe('two more failures from the second real-model run', () => {
  const pts = (texts: string[], asks: number[]) => texts.map((text, i) => ({ text, marks: 1, ask: asks[i] }));
  const alignment = (qs: QualityQuestion[]) => assessQuestions(qs, ctx).issues.filter((i) => ['ASK_COUNT', 'ASK_NOT_IN_QUESTION', 'POINT_NOT_ASKED', 'NO_ASKS', 'TYPE_MISMATCH'].includes(i.code));

  it('does not take "these two segments" for two things asked: a number counts the items wanted, unless each one is asked about', () => {
    const layout: QualityQuestion = {
      type: 'diagram',
      prompt: 'Using the memory layout provided in the slides, describe the relative positions of the stack and heap in a BIG BLOCK of RAM. How do these two segments grow in relation to each other?',
      marks: 3,
      difficulty: 2,
      asks: [{ quote: 'describe the relative positions of the stack and heap', count: 2 }, { quote: 'How do these two segments grow in relation to each other?', count: 1 }],
      rubric: pts(['The stack sits in the upper part of the address space.', 'The heap sits beneath the stack.', 'The stack grows downwards while the heap grows upwards.'], [1, 1, 2]),
      modelAnswer: 'The stack sits in the upper part of the address space, with the heap beneath it. The stack grows downwards from high addresses towards low ones. The heap grows upwards from low addresses towards high ones.',
      sources: [],
    };
    expect(alignment([layout])).toEqual([]);
    // "for each of these three types" does ask for three things, and a wrong count is still found
    const each: QualityQuestion = { ...layout, type: 'short', prompt: 'Identify which segment stores each of these three types of data.', marks: 3, asks: [{ quote: 'which segment stores each of these three types of data', count: 4 }], rubric: pts(['Local variables are stored in the stack.', 'Global variables are stored in the data segment.', 'Dynamic memory is stored in the heap.'], [1, 1, 1]) };
    expect(alignment([each]).map((i) => i.code)).toEqual(['ASK_COUNT', 'ASK_COUNT']); // says 3 but marked 4; 3 points for an ask of 4
  });

  it('finds an "attack" question that only asks how the attack works, and accepts one that asks what stops it', () => {
    const mechanism: QualityQuestion = {
      type: 'attack',
      prompt: 'Describe the mechanism of a buffer overflow attack regarding the return address and explain how this allows an attacker to change the program flow.',
      marks: 6,
      difficulty: 3,
      rubric: pts(['Buffer overflow overwrites memory data including the return address.', 'The return address is critical for knowing where to go when a function ends.', 'The program uses a ret instruction to find the return address.', 'Overwriting the address changes the value stored there.', 'This changes the program counter to a different location.', 'The attacker can then make the program execute something else.'], [1, 1, 1, 2, 2, 2]),
      modelAnswer: 'A buffer overflow overwrites memory data, which can include the return address. This address is critical because it tells the application where to go when a function ends. The program looks for a ret instruction to find this address. By overwriting it, an attacker changes the value. This forces the program counter to a new location, effectively changing the program flow.',
      sources: [],
    };
    const found = assessQuestions([mechanism], ctx).issues.filter((i) => i.code === 'TYPE_MISMATCH');
    expect(found.map((i) => i.message)).toEqual(['An attack question should ask what weakens or stops the attack (a defence or countermeasure), not only how it works.']);
    const withDefence = { ...mechanism, prompt: mechanism.prompt.replace('change the program flow.', 'change the program flow, and say which defence stops it.') };
    expect(assessQuestions([withDefence], ctx).issues.filter((i) => i.code === 'TYPE_MISMATCH')).toEqual([]);
    expect(assessQuestions([{ ...mechanism, type: 'short' }], ctx).issues.filter((i) => i.code === 'TYPE_MISMATCH')).toEqual([]); // only an attack question is held to it
  });

  it('cannot tell that three marking points are one idea written three ways (that is left to the student)', () => {
    // the real model answered an invented extra ask with three paraphrases; their words differ too much for a word check, and the
    // same words separate "the stack grows down" from "the heap grows up", which are different ideas
    const q: QualityQuestion = {
      type: 'short',
      prompt: 'Explain how the address space of the program relates to other running programs on the same system.',
      marks: 3,
      difficulty: 2,
      asks: [{ quote: 'explain how the address space of the program relates to other running programs', count: 3 }],
      rubric: pts(['Every running program is given an address space of its own.', 'That address space is kept apart from other programs.', 'Programs do not share storage with each other.'], [1, 1, 1]),
      modelAnswer: 'Every running program is given an address space of its own. That address space is kept apart from other programs. Therefore storage is not shared between different running programs.',
      sources: [],
    };
    expect(assessQuestions([q], ctx).issues.filter((i) => i.code === 'POINTS_OVERLAP')).toEqual([]);
  });
});
