import { joinScripts } from './match';
import { isQuestionText } from './slide-questions';
import type { PlannedSlot } from './blueprint';
import { QUESTION_TYPE_LABEL, type QuestionType } from './types';

/**
 * A check of generated exam questions that needs no AI: the same rules the model is given (pack-format.ts), applied to what
 * came back. It cannot judge whether a question is wise, but it finds the faults that make an exam bad or unfair to mark: marking
 * points that overlap or are not independent, marks that do not match the work, a model answer that would not earn full marks,
 * points that are not on the slides cited, duplicates, a set that is all recall, and questions that ignore the plan.
 *
 * Everything here is advice shown before the student approves anything; nothing is changed or dropped.
 */

export interface QualityQuestion {
  type: QuestionType;
  prompt: string;
  marks: number;
  difficulty: number;
  topic?: string | undefined;
  rubric: { text: string; marks: number; keywords?: string[] | undefined; /** The number (1 = first) of the ask this point answers. */ ask?: number | undefined }[];
  /** The separate things the prompt asks for, in the model's own listing: the words of the prompt and how many items each wants. */
  asks?: { quote: string; count: number }[] | undefined;
  modelAnswer?: string | undefined;
  options?: { correct: boolean }[] | undefined;
  sources: { lectureId: string; slide: number }[];
}

export type QualityCode =
  | 'NO_RUBRIC'
  | 'POINTS_FEW'
  | 'POINTS_MANY'
  | 'POINT_BUNDLE'
  | 'POINTS_OVERLAP'
  | 'POINTS_NOT_INDEPENDENT'
  | 'POINT_EITHER'
  | 'NO_MODEL_ANSWER'
  | 'ANSWER_MISSES_POINT'
  | 'ANSWER_THIN'
  | 'ANSWER_LONG'
  | 'POINT_NOT_ON_SLIDES'
  | 'SOURCE_IS_QUESTION'
  | 'NO_ASKS'
  | 'ASK_NOT_IN_QUESTION'
  | 'ASK_COUNT'
  | 'POINT_NOT_ASKED'
  | 'SCENARIO_NOT_NEEDED'
  | 'SCENARIO_ADDS_NOTHING'
  | 'POINTS_SAME_STEP'
  | 'TYPE_MISMATCH'
  | 'DIFFICULTY_MARKS'
  | 'DUPLICATE'
  | 'ONLY_RECALL'
  | 'ONE_DIFFICULTY'
  | 'NO_HARD'
  | 'ONE_TYPE'
  | 'PLAN_COUNT'
  | 'PLAN_TYPE'
  | 'PLAN_MARKS'
  | 'PLAN_TOPIC';

export interface QualityIssue {
  code: QualityCode;
  /** 1-based position of the question in the list; undefined for a fault of the whole set. */
  question?: number;
  /** 1-based marking point the finding is about, when it is about one (so the screen can offer to remove it). */
  point?: number;
  message: string;
}

export interface QualityStats {
  questions: number;
  byType: Partial<Record<QuestionType, number>>;
  byDifficulty: Record<1 | 2 | 3, number>;
  totalMarks: number;
  /** Share of questions that only ask to recall or state something (define, short, true/false, multiple choice). */
  recallShare: number;
  /** The slides the questions cite, as "lectureId:slide". */
  slidesCited: string[];
  /** How many of the plan's questions came back as planned (type, marks and topic), when there was a plan. */
  asPlanned?: { met: number; of: number };
}

export interface QualityReport {
  issues: QualityIssue[];
  stats: QualityStats;
}

export interface QualityContext {
  /** Plain text of a slide of a lecture (title and body), or undefined when it does not exist. */
  slideText(lectureId: string, slide: number): string | undefined;
}

export interface QualityOptions {
  expected?: readonly PlannedSlot[] | undefined;
  /** Prompts of questions that already exist, so a repeat is found. */
  existingPrompts?: readonly string[] | undefined;
  /**
   * Where each question sat in the list the AI wrote (0-based). Needed when some items were skipped as unusable: the plan is
   * matched to the position the AI wrote a question at, not to its place among the survivors.
   */
  positions?: readonly number[] | undefined;
  /** The questions were written under the rule that every marking point names the ask it answers: a question with no asks is reported. */
  requireAsks?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const STOP = new Set(
  'a an the and or of to in on at by for from with without as is are was were be been being it its this that these those their there then than so such not no nor but if when while which who whom whose what why how can could should would may might must will shall do does did done has have had having into onto over under about above below between among also only each both any all more most less least very much many some other another same own per via use used using student students answer answers write writes written question state states list lists explain explains describe describes give gives identify mention mentions point points'.split(' '),
);

/** Light stem so "overwrites" and "overwriting" match: lower case, plural and common endings removed. */
function stem(w: string): string {
  let s = w.toLowerCase();
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'edly', 'ed', 'ies', 'es', 'ly', 's']) {
    // "address" keeps its double s: only a plural s is taken off
    if (s.length > suffix.length + 3 && s.endsWith(suffix) && !(suffix === 's' && s.endsWith('ss'))) {
      s = s.slice(0, -suffix.length);
      break;
    }
  }
  return s;
}

/** The meaningful words of a text, stemmed, without repeats. */
export function keyWords(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    // numbers count even when short: "42" is the whole point of a calculation step
    if ((w.length < 3 && !/^\d+$/.test(w)) || STOP.has(w)) continue;
    out.add(stem(w));
  }
  return [...out];
}

const wordCount = (s: string): number => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;

/** Whether the words of `quote` are (almost all) in `text`: a quote the AI gave really is in the question. */
export function quoteIsIn(quote: string, text: string): boolean {
  const kw = keyWords(quote);
  return kw.length >= 2 && coverage(kw, new Set(keyWords(text))) >= 0.75;
}

/** Whether `word` (stemmed) is in `haystack` (stemmed words), allowing the same first five letters. */
function has(word: string, haystack: ReadonlySet<string>): boolean {
  if (haystack.has(word)) return true;
  if (word.length < 5) return false;
  const p = word.slice(0, 5);
  for (const h of haystack) if (h.length >= 5 && h.startsWith(p)) return true;
  return false;
}

function coverage(words: readonly string[], haystack: ReadonlySet<string>): number {
  if (words.length === 0) return 1;
  return words.filter((w) => has(w, haystack)).length / words.length;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

const containment = (small: readonly string[], big: readonly string[]): number => {
  const sb = new Set(big);
  return small.length === 0 ? 0 : small.filter((x) => sb.has(x)).length / small.length;
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const OBJECTIVE = new Set<QuestionType>(['mcq', 'truefalse']);
export const RECALL_TYPES = new Set<QuestionType>(['define', 'short', 'truefalse', 'mcq']);

/** A marking point that says "any two of …", "all four …" or "at least …" cannot be earned on its own. */
// Mark-scheme phrasing only: at the start ("Any two of…"), after the verb that lists ("Lists any 2 controls"), or followed by "of". A
// statement of the subject ("the string contains at least one 0", "through any two points") is not an instruction to the marker.
const COUNT = 'one|two|three|four|five|six|\\d+';
const CONDITIONAL = new RegExp(
  `^\\s*(?:any|at least|up to)\\s+(?:${COUNT})\\b|\\b(?:lists?|names?|gives?|states?|identif(?:y|ies)|mentions?|includes?|describes?|outlines?|any)\\s+(?:any|at least|up to)\\s+(?:${COUNT})\\b|\\b(?:any|at least|up to)\\s+(?:${COUNT})\\s+of\\b|\\ball\\s+(?:of\\s+)?(?:the\\s+)?(?:two|three|four|five|six|\\d+|above|following)\\b|\\bone of the following\\b`,
  'i',
);

/**
 * "Mentions A or B": a mark-scheme instruction that lets either alone earn the mark. Only this phrasing is reported: an idea
 * that is itself a pair ("the same value can be data or an instruction") is not a choice of answers.
 */
const EITHER = /^\s*(?:mentions?|identifies?|states?|names?|gives?|lists?|notes?|includes?|refers? to|says?|describes?)\b[^.]*\b(?:or|and\/or)\b/i;

/** A number written in digits or in words ("10 users", "ten users"). */
const hasNumber = (s: string): boolean => /\d/.test(s) || /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|half|double|triple)\b/i.test(s);

const TYPE_CHECKS: Partial<Record<QuestionType, { test: (q: QualityQuestion) => boolean; message: string }>> = {
  scenario: { test: (q) => wordCount(q.prompt) >= 25, message: 'A scenario question should describe a situation (a few sentences) before it asks the question.' },
  case: { test: (q) => wordCount(q.prompt) >= 30, message: 'A case-study question should describe a case (several sentences) before it asks the parts.' },
  compare: { test: (q) => /compar|contrast|differ|similar|versus|\bvs\b|distinguish|both|whereas/i.test(q.prompt), message: 'A compare question should ask to compare or contrast.' },
  calculation: { test: (q) => hasNumber(q.prompt), message: 'A calculation question should give the numbers in the question.' },
  problem: { test: (q) => hasNumber(q.prompt) || wordCount(q.prompt) >= 20, message: 'A problem should state the problem with what is given.' },
  proof: { test: (q) => /prove|\bproofs?\b|proving|show that|justify|derive|demonstrate|argue|why/i.test(q.prompt), message: 'A proof question should ask to prove, show or justify something.' },
  diagram: { test: (q) => /diagram|figure|picture|shown|illustrat|layout|drawing|chart|map/i.test(q.prompt), message: 'A diagram question should refer to the diagram or figure it is about.' },
  attack: { test: (q) => /defen[cs]e|countermeasure|mitigat|prevent|protect|safeguard|stop(?:s|ped|ping)?\b|detect|guard against|reduce the (?:risk|impact)|secure|harden/i.test(q.prompt), message: 'An attack question should ask what weakens or stops the attack (a defence or countermeasure), not only how it works.' },
};

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** A number after one of these counts the things being talked about ("how do these two segments grow"), not the items the question wants, unless each of them is asked about ("for each of these three types"). */
const NOT_A_COUNT_AFTER = new Set(['the', 'these', 'those', 'both', 'of', 'between', 'its', 'their', 'this', 'that', 'all', 'any', 'to', 'with', 'for']);

/** The one number a phrase asks for ("three reasons" is 3). Undefined when it names none or several. */
function numberIn(text: string): number | undefined {
  const found = new Set<number>();
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  words.forEach((w, i) => {
    if (!(w in NUMBER_WORDS) && !/^\d{1,2}$/.test(w)) return;
    if (NOT_A_COUNT_AFTER.has(words[i - 1] ?? '') && !words.slice(Math.max(0, i - 4), i).some((x) => x === 'each' || x === 'every')) return;
    found.add(NUMBER_WORDS[w] ?? Number(w));
  });
  return found.size === 1 ? [...found][0] : undefined;
}

const sentencesOf = (s: string): string[] => s.replace(/\s+/g, ' ').split(/(?<=[.?!:])\s+(?=[A-Z("“])/).map((x) => x.trim()).filter(Boolean);
/** Verbs that only ask to state something. */
const STATE_VERB = /\b(identify|state|list|name|define|give|outline|mention|describe|write down)\b/i;
/** Verbs that ask the student to do something with a situation. */
const APPLY_VERB = /\b(apply|decide|recommend|advise|justify|predict|diagnose|propose|choose|evaluate|assess|suggest|design|prioriti[sz]e|what (would|should|will|might|could)|how (would|should|could|might)|which\b[^.?]*\b(should|would|is best)|why (did|would|might|should))\b/i;
/** Words that point back at the situation: "this", "these", "their", "they". */
const POINTS_BACK = /\b(this|these|that|those|their|they|them|its|he|she|his|her)\b/i;

/**
 * A scenario, case or attack question whose situation changes nothing: the question only asks to state facts and does not mention
 * the situation's actor or anything in it, so the story could be deleted without changing the answer. That is a recall question.
 */
export function scenarioNotNeeded(prompt: string): boolean {
  const sentences = sentencesOf(prompt);
  const asking = sentences.filter((s) => STATE_VERB.test(s) || APPLY_VERB.test(s) || s.endsWith('?'));
  const situation = sentences.filter((s) => !asking.includes(s));
  if (asking.length === 0 || situation.length === 0) return false;
  const ask = asking.join(' ');
  if (APPLY_VERB.test(ask) || POINTS_BACK.test(ask.replace(/^\W*based on\b[^,]*,/i, ''))) return false;
  // the actor of the situation ("A developer is …", "The hospital wants …") named again in the question
  const actor = /^(?:an?|the|one)\s+((?:[\p{L}-]+\s+){0,2}?[\p{L}-]+)\s+(?:is|are|was|were|has|have|had|wants?|claims?|runs?|manages?|needs?|receives?|writes?|notices?|finds?|works?|plans?|builds?|uses?|operates?)\b/iu.exec(situation[0]!);
  const actorWords = actor ? keyWords(actor[1]!) : [];
  const askWords = new Set(keyWords(ask));
  if (actorWords.some((w) => has(w, askWords))) return false;
  return STATE_VERB.test(ask);
}

/** Words that set a situation up without telling anything about it ("suppose you have…", "you are designing…"). */
const SETUP_WORDS = new Set(
  'you your we our us someone somebody suppose assume imagine consider given want wants wanted need needs try trying tries prove proving show showing demonstrate establish construct build building create design designing designed implement'.split(' ').map((w) => stem(w)),
);

/**
 * A scenario whose situation tells the student nothing the slides do not already say, and whose question only asks to state or
 * describe: "You are designing a machine D … Suppose you have a machine H … Describe the construction of D" is the slide's own
 * construction with a sentence in front. A real situation brings something new (a person, a language, a string, a number, a
 * claim) for the slides' ideas to be applied to.
 */
export function scenarioAddsNothing(prompt: string, slideWords: ReadonlySet<string>): boolean {
  const sentences = sentencesOf(prompt);
  const asking = sentences.filter((s) => STATE_VERB.test(s) || APPLY_VERB.test(s) || s.endsWith('?'));
  const situation = sentences.filter((s) => !asking.includes(s)).join(' ');
  if (asking.length === 0 || situation === '') return false;
  if (APPLY_VERB.test(asking.join(' ')) || asking.some((s) => s.endsWith('?'))) return false; // it asks the student to decide something
  const words = keyWords(joinScripts(situation)).filter((w) => !SETUP_WORDS.has(w));
  if (words.length < 2) return false; // too little to judge
  return words.every((w) => has(w, slideWords));
}

/** The meaningful words of a step, with a subscript joined and a name like "M1" or "q0" kept (two characters with a digit are a name, not a word). */
function stepKeys(text: string): string[] {
  const out = new Set<string>();
  for (const w of joinScripts(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if ((w.length < 3 && !/\d/.test(w)) || STOP.has(w)) continue;
    out.add(stem(w));
  }
  return [...out];
}

/** The separate steps of a slide's text: its lines and sentences without their numbers or bullets. */
export function stepsOf(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').split(/(?<=[.;])\s+/))
    .map((s) => s.trim())
    .filter((s) => stepKeys(s).length >= 2);
}

/** Faults of one question. `slideWords` are the words on the slides it cites (plus its own prompt); `slideOnly` and `steps` come from the slides alone. */
function checkQuestion(q: QualityQuestion, n: number, slideWords: ReadonlySet<string> | undefined, requireAsks: boolean, slideOnly?: ReadonlySet<string>, steps: readonly string[] = []): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const add = (code: QualityCode, message: string, point?: number) => issues.push({ code, question: n, ...(point ? { point } : {}), message });
  const written = !OBJECTIVE.has(q.type);

  const check = TYPE_CHECKS[q.type];
  if (check && !check.test(q)) add('TYPE_MISMATCH', check.message);
  if (written && ((q.difficulty >= 3 && q.marks <= 2) || (q.difficulty <= 1 && q.marks >= 5))) {
    add('DIFFICULTY_MARKS', `It is marked difficulty ${q.difficulty} but is worth ${q.marks} mark${q.marks === 1 ? '' : 's'}: the difficulty and the marks do not fit each other.`);
  }
  if (!written) return issues;

  const points = q.rubric;
  if (points.length === 0) add('NO_RUBRIC', 'It has no marking points, so it can only be marked by comparing with the model answer.');
  else {
    if (q.marks / points.length > 2) add('POINTS_FEW', `It is worth ${q.marks} marks but has only ${points.length} marking point${points.length === 1 ? '' : 's'}: each point should be about one mark, so list the separate ideas.`);
    if (points.length > 2 * q.marks + 1) add('POINTS_MANY', `It is worth ${q.marks} mark${q.marks === 1 ? '' : 's'} but has ${points.length} marking points: too many ideas for the marks.`);
    points.forEach((p, i) => {
      if (p.marks > 2 && q.type !== 'proof' && q.type !== 'calculation' && q.type !== 'problem') add('POINT_BUNDLE', `Marking point ${i + 1} carries ${p.marks} marks: it probably bundles several ideas. Split it so each idea is earned separately.`);
      if (CONDITIONAL.test(p.text)) add('POINTS_NOT_INDEPENDENT', `Marking point ${i + 1} is conditional ("${p.text.slice(0, 50)}…"): points should be independent ideas, not "any two of" or "all of".`);
      else if (EITHER.test(p.text) && wordCount(p.text) <= 16) add('POINT_EITHER', `Marking point ${i + 1} accepts either of two ideas ("${p.text.slice(0, 50)}…"): name the one idea that earns the mark, or make them two points.`);
    });
    const words = points.map((p) => keyWords(p.text));
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = words[i]!;
        const b = words[j]!;
        const small = a.length <= b.length ? a : b;
        const big = a.length <= b.length ? b : a;
        // Conservative on purpose: "stack grows high to low" and "heap grows low to high" share most of their words and are two
        // different ideas. Only near-identical points, or one wholly inside the other, are reported.
        if ((a.length >= 3 && b.length >= 3 && jaccard(a, b) >= 0.75) || (small.length >= 3 && containment(small, big) >= 0.99 && big.length <= small.length + 2)) {
          add('POINTS_OVERLAP', `Marking points ${i + 1} and ${j + 1} say nearly the same thing, so one idea could be marked twice.`);
        }
      }
    }
  }

  // What the question asks for against what the marking points reward: every point must answer something the question asks.
  const asks = q.asks ?? [];
  if (points.length > 0 && asks.length === 0) {
    if (requireAsks && q.marks >= 2) add('NO_ASKS', 'It does not say which part of the question each marking point answers, so a point that nobody asked for cannot be found.');
  } else if (asks.length > 0) {
    const promptWords = new Set(keyWords(q.prompt));
    asks.forEach((a, i) => {
      const quote = `"${a.quote.slice(0, 60)}${a.quote.length > 60 ? '…' : ''}"`;
      const kw = keyWords(a.quote);
      if (kw.length >= 2 && coverage(kw, promptWords) < 0.75) add('ASK_NOT_IN_QUESTION', `Ask ${i + 1} (${quote}) is not in the question's own words, so the question may not really ask for it.`);
      const said = numberIn(a.quote);
      if (said !== undefined && said !== a.count) add('ASK_COUNT', `The question says ${said} in ${quote}, but that ask is marked as wanting ${a.count}.`);
      const answering = points.filter((p) => p.ask === i + 1).length;
      if (answering === 0) add('ASK_COUNT', `The question asks for ${quote}, but no marking point rewards it.`);
      else if (answering !== a.count) add('ASK_COUNT', `The question asks for ${a.count} item${a.count === 1 ? '' : 's'} in ${quote}, but ${answering} marking point${answering === 1 ? '' : 's'} answer it: ${answering > a.count ? 'the extra marks are not asked for' : 'some of what it asks for earns nothing'}.`);
    });
    points.forEach((p, i) => {
      if (p.ask === undefined || !Number.isInteger(p.ask) || p.ask < 1 || p.ask > asks.length) add('POINT_NOT_ASKED', `Marking point ${i + 1} ("${p.text.slice(0, 50)}…") does not answer anything the question asks for: the question should ask for it, or the point should go.`, i + 1);
    });
  }
  if ((q.type === 'scenario' || q.type === 'case') && slideOnly && scenarioAddsNothing(q.prompt, slideOnly)) {
    add('SCENARIO_ADDS_NOTHING', 'The situation only repeats what the slides already say and the question only asks to state or describe it: this is a recall question with a sentence in front. Give the student a case the slides do not describe (a particular string, language, claim or person) and ask them to decide, judge or predict.');
  }
  // one marking point per step: two points resting on the same single step of the slides pay it twice
  if ((q.type === 'algorithm' || q.type === 'programming') && steps.length > 0 && points.length > 1) {
    const stepWords = steps.map((s) => new Set(stepKeys(s)));
    const owner = new Map<number, number>();
    points.forEach((p, i) => {
      const key = stepKeys(p.text);
      if (key.length < 2) return;
      let best = -1;
      let bestScore = 0;
      stepWords.forEach((words, k) => {
        const c = coverage(key, words);
        // the step whose words the point covers, and among equals the more specific step (fewer other words): "If M1 accepts then accept" over a long line that merely contains "M1" and "accepts"
        const score = c * 0.7 + 0.3 * ((c * key.length) / Math.max(1, words.size));
        if (c >= 0.6 && score > bestScore) {
          best = k;
          bestScore = score;
        }
      });
      if (best < 0) return;
      const first = owner.get(best);
      if (first === undefined) owner.set(best, i);
      else add('POINTS_SAME_STEP', `Marking points ${first + 1} and ${i + 1} both rest on the same single step of the slides ("${steps[best]!.slice(0, 60)}"): one step is paid twice. Ask for each step once, or ask for fewer things.`, i + 1);
    });
  }
  if ((q.type === 'scenario' || q.type === 'case' || q.type === 'attack') && scenarioNotNeeded(q.prompt)) {
    add('SCENARIO_NOT_NEEDED', 'The situation is not needed to answer: the question only asks to state facts from the slides, so it is a recall question with a story in front. Ask the student to decide, advise or predict in this situation.');
  }

  const answer = q.modelAnswer?.trim() ?? '';
  if (!answer) add('NO_MODEL_ANSWER', 'It has no model answer to compare with.');
  else {
    const len = wordCount(answer);
    const answerWords = new Set(keyWords(answer));
    const missed = points.map((p) => {
      const key = keyWords(p.text);
      const viaKeywords = (p.keywords ?? []).some((k) => keyWords(k).every((w) => has(w, answerWords)) && keyWords(k).length > 0);
      return key.length >= 2 && !viaKeywords && coverage(key, answerWords) < 0.5;
    });
    // A short answer that holds every marking point is a complete answer (a list of three short items); only a short answer that leaves something out is "thin".
    if (len < 6 * q.marks && q.marks >= 2 && (missed.some(Boolean) || len < 2 * q.marks)) add('ANSWER_THIN', `The model answer has ${len} words for ${q.marks} marks: too short to earn full marks.`);
    if (len > 45 * q.marks + 40) add('ANSWER_LONG', `The model answer has ${len} words for ${q.marks} mark${q.marks === 1 ? '' : 's'}: far more than the marks call for.`);
    points.forEach((p, i) => {
      if (missed[i]) add('ANSWER_MISSES_POINT', `The model answer does not clearly contain marking point ${i + 1} ("${p.text.slice(0, 50)}…"), so a perfect answer would not earn full marks.`);
    });
  }

  if (slideWords && points.length > 0) {
    points.forEach((p, i) => {
      const key = keyWords(p.text);
      if (key.length >= 3 && coverage(key, slideWords) < 0.34) add('POINT_NOT_ON_SLIDES', `Marking point ${i + 1} ("${p.text.slice(0, 50)}…") uses words that are not on the slides it cites: check that the slides really say it.`);
    });
  }
  return issues;
}

/** Faults of the whole set and between questions. */
function checkSet(qs: readonly QualityQuestion[], existing: readonly string[]): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const prompts = qs.map((q) => keyWords(q.prompt));
  for (let i = 0; i < qs.length; i++) {
    for (let j = i + 1; j < qs.length; j++) {
      if (prompts[i]!.length >= 3 && jaccard(prompts[i]!, prompts[j]!) >= 0.7) issues.push({ code: 'DUPLICATE', question: j + 1, message: `Question ${j + 1} is almost the same as question ${i + 1}.` });
    }
    existing.forEach((e) => {
      const w = keyWords(e);
      if (w.length >= 3 && prompts[i]!.length >= 3 && jaccard(prompts[i]!, w) >= 0.7) issues.push({ code: 'DUPLICATE', question: i + 1, message: `Question ${i + 1} repeats a question you already have: “${e.slice(0, 60)}”.` });
    });
  }
  if (qs.length >= 4) {
    const recall = qs.filter((q) => RECALL_TYPES.has(q.type)).length;
    if (recall / qs.length >= 0.7) issues.push({ code: 'ONLY_RECALL', message: `${recall} of ${qs.length} questions only ask to recall or state something (no scenario, comparison, problem or analysis). A real exam usually asks for more than that.` });
    if (new Set(qs.map((q) => q.type)).size === 1) issues.push({ code: 'ONE_TYPE', message: `Every question is the same kind (${QUESTION_TYPE_LABEL[qs[0]!.type].toLowerCase()}).` });
    if (new Set(qs.map((q) => q.difficulty)).size === 1) issues.push({ code: 'ONE_DIFFICULTY', message: `Every question has the same difficulty (${qs[0]!.difficulty}), so the difficulty tells you nothing.` });
    else if (qs.length >= 5 && !qs.some((q) => q.difficulty >= 3)) issues.push({ code: 'NO_HARD', message: 'There is no hard question (difficulty 3): nothing that combines several slides or steps.' });
  }
  return issues;
}

/** The plan against what came back: the model was asked for specific questions. */
function checkPlan(qs: readonly QualityQuestion[], expected: readonly PlannedSlot[], positions: readonly number[] | undefined): { issues: QualityIssue[]; met: number } {
  const issues: QualityIssue[] = [];
  let met = 0;
  const at = (i: number) => positions?.[i] ?? i;
  if (qs.length !== expected.length) {
    const back = new Set(qs.map((_, i) => at(i)));
    const missing = expected.map((_, k) => k + 1).filter((n) => !back.has(n - 1));
    const which = missing.length > 0 && missing.length < expected.length ? ` Planned question${missing.length === 1 ? '' : 's'} ${missing.join(', ')} did not come back usable.` : '';
    issues.push({ code: 'PLAN_COUNT', message: `${expected.length} questions were planned but ${qs.length} came back.${which}` });
  }
  const topicKey = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i]!;
    const e = expected[at(i)];
    if (!e) continue; // written beyond the plan
    let ok = true;
    if (q.type !== e.type) {
      ok = false;
      issues.push({ code: 'PLAN_TYPE', question: i + 1, message: `Planned as ${QUESTION_TYPE_LABEL[e.type].toLowerCase()} but it is ${QUESTION_TYPE_LABEL[q.type].toLowerCase()}.` });
    }
    if (Math.abs(q.marks - e.marks) > 1) {
      ok = false;
      issues.push({ code: 'PLAN_MARKS', question: i + 1, message: `Planned for ${e.marks} marks but it is worth ${q.marks}.` });
    }
    if (topicKey(q.topic) !== topicKey(e.topic)) {
      ok = false;
      issues.push({ code: 'PLAN_TOPIC', question: i + 1, message: `Planned for the topic “${e.topic}” but its topic is “${q.topic ?? 'none'}”, so the exam builder's topic filter will not find it.` });
    }
    if (ok) met += 1;
  }
  return { issues, met };
}

export function assessQuestions(questions: readonly QualityQuestion[], ctx: QualityContext, options: QualityOptions = {}): QualityReport {
  const issues: QualityIssue[] = [];
  const cited = new Set<string>();
  questions.forEach((q, i) => {
    const texts: string[] = [q.prompt];
    for (const s of q.sources) {
      cited.add(`${s.lectureId}:${s.slide}`);
      const t = ctx.slideText(s.lectureId, s.slide);
      if (t) texts.push(t);
    }
    // the words of a scenario's own situation count as "on the page": a marking point may refer to them
    const slideWords = texts.length > 1 ? new Set(keyWords(texts.join('\n'))) : undefined;
    const slideTexts = q.sources.map((s) => ctx.slideText(s.lectureId, s.slide)).filter((t): t is string => t !== undefined);
    const slideOnly = slideTexts.length > 0 ? new Set(keyWords(joinScripts(slideTexts.join('\n')))) : undefined;
    issues.push(...checkQuestion(q, i + 1, slideWords, options.requireAsks === true, slideOnly, slideTexts.flatMap(stepsOf)));
    // every slide it cites only asks a question (a check-in): the marking points cannot have come from the slides
    if (slideTexts.length > 0 && slideTexts.every(isQuestionText)) {
      issues.push({ code: 'SOURCE_IS_QUESTION', question: i + 1, message: 'Every slide this question cites is a check-in: it asks a question and does not give the answer, so the marking points cannot come from the slides. Base the question on the slides that explain the topic.' });
    }
  });
  issues.push(...checkSet(questions, options.existingPrompts ?? []));
  const stats: QualityStats = {
    questions: questions.length,
    byType: {},
    byDifficulty: { 1: 0, 2: 0, 3: 0 },
    totalMarks: questions.reduce((n, q) => n + q.marks, 0),
    recallShare: questions.length === 0 ? 0 : questions.filter((q) => RECALL_TYPES.has(q.type)).length / questions.length,
    slidesCited: [...cited].sort(),
  };
  for (const q of questions) {
    stats.byType[q.type] = (stats.byType[q.type] ?? 0) + 1;
    const d = Math.min(3, Math.max(1, Math.round(q.difficulty))) as 1 | 2 | 3;
    stats.byDifficulty[d] += 1;
  }
  if (options.expected && options.expected.length > 0) {
    const plan = checkPlan(questions, options.expected, options.positions);
    issues.push(...plan.issues);
    stats.asPlanned = { met: plan.met, of: options.expected.length };
  }
  return { issues, stats };
}
