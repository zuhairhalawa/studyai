import type { SlideData, TextRun, Topic } from '../pptx/model';
import { QUESTION_TYPE_LABEL, type QuestionType } from './types';
import { isQuestionSlide } from './slide-questions';

/**
 * The exam blueprint: a plan for which questions to ask, made on the device with no AI. Left alone, a model writes the
 * easiest questions (definitions, one slide each, mostly the same topic). The blueprint fixes what matters before the model is
 * asked: the question type, the difficulty, the marks, the number of marking points, the topic and the slides to base it on.
 * The model only fills the slots; the quality checker (pack-quality.ts) then checks that it did.
 *
 * It is a sensible mix for the material, never a prediction of a real exam.
 */

export type Difficulty = 1 | 2 | 3;

/** One planned question as it travels to the server: the position in the list is its number. */
export interface PlannedSlot {
  type: QuestionType;
  difficulty: Difficulty;
  marks: number;
  /** How many separate marking points the question should have (about one mark each). */
  points: number;
  /** The lecture topic's own title, copied exactly so the exam builder's topic filter works. */
  topic: string;
  /** 1-based slide numbers the question should be based on. */
  slides: number[];
}

export interface Slot extends PlannedSlot {
  n: number;
}

// ---------------------------------------------------------------------------
// What kind of material is it?
// ---------------------------------------------------------------------------

export interface Evidence {
  /** Slides that have equations, tables, code or algorithm steps, theorems/proofs, diagrams, attack vocabulary. */
  math: number;
  /** Slides with a formula that computes something (numbers or arithmetic), as against a definition written with symbols. */
  arith: number;
  /** Slides about a machine (an automaton, a Turing machine): states, transitions, configurations, what it accepts or halts on. */
  machine: number;
  tables: number;
  code: number;
  algorithm: number;
  proof: number;
  diagram: number;
  security: number;
  /** Slides with at least this much study text. */
  substantive: number;
}

/** Words that carry meaning: bullet markers and bare punctuation do not count. */
const WORDS = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const SECURITY = /\b(attack|attacker|vulnerab\w*|threat|exploit\w*|countermeasure|malicious|malware|breach|injection|overflow|authenticat\w*|encrypt\w*|privilege)\b/i;
// A proof is on the slide when its steps are, not when the word "theorem" or "prove" is (an objective, a summary or the statement of a
// theorem is not a proof to follow): at least two of these signals.
const PROOF_SIGNALS: RegExp[] = [/\bproof\b/i, /\bbase case\b/i, /\binduct(?:ive|ion) (?:step|hypothesis)\b/i, /\bby induction\b/i, /\bby contradiction\b/i, /\bsuppose\b/i, /\bassume\b/i, /\btherefore\b/i, /\bhence\b/i, /\bit follows\b/i, /\bwe (?:show|prove|have shown)\b/i, /\blemma\b/i, /∎|\bq\.?e\.?d\.?\b/i];
export const hasProof = (text: string): boolean => PROOF_SIGNALS.filter((r) => r.test(text)).length >= 2;
// Steps, not the word: "relying on secret algorithms" is a sentence about algorithms, not an algorithm to trace. A complexity
// ("O(n log n)", "time complexity") is a result about an algorithm, not a procedure.
const ALGORITHM = /\b(?:pseudo-?code|step\s*\d+|for each|repeat until|iterate over)\b|^\s*[-*]?\s*algorithm\s*[:\-–]/im;
/** A line of pseudocode: the keyword a procedure's lines start with. */
const PSEUDO_LINE = /^\s*(?:if|else|elif|elsif|for|foreach|while|repeat|until|return|do|then|procedure|function|def|begin|end)\b/i;

const OPERATORS = ['=', '+', '-', '−', '×', '÷', '/', '*', '^', '√', '∑', '∫', '≤', '≥', '≈', '≠', '→', '⇒', '∈', '⊆'];
/**
 * Lines of ordinary text that are formulas typed as text ("T(n) = 2T(n/2) + n", "x² + y² = z²"), for the many courses that never
 * used the equation editor. Two different operators and a letter: "sum = 7178" (one operator) and a sentence are not formulas, and
 * code (monospaced) is not counted here.
 */
function typedFormulaLines(s: SlideData): { formulas: number; arith: number } {
  let n = 0;
  let arith = 0;
  for (const e of s.elements) {
    if (e.kind !== 'shape' || e.decorative || e.hidden) continue;
    for (const p of e.paragraphs) {
      const line = p.text.replace(/^\s*(?:[-*>]|\d+[.)])\s*/, '').trim();
      const runs = p.inlines.filter((i): i is TextRun => i.kind === 'text');
      if (!line || line.length > 120 || (runs.length > 0 && runs.every((r) => r.mono)) || !/\p{L}/u.test(line)) continue;
      if (OPERATORS.filter((o) => line.includes(o)).length >= 2 && WORDS(line) <= 14) {
        n += 1;
        // an operator next to a number: "2T(n/2) + n", "x² + y² = z²"; not "Σ = {0, 1}", "Σ*", "0^n 1^n" or "δ: Q × Σ → Q"
        // (a hyphen is a minus only with a space on each side: "a 1-1 correspondence" is a phrase)
        if (/[\d²³]\s*[+−×÷/]\s*[\w(]|[\w)]\s*[+−×÷/]\s*[\d²³]|[\d²³]\s+-\s+[\w(]|[\w)]\s+-\s+[\d²³]/.test(line)) arith += 1;
      }
    }
  }
  return { formulas: n, arith };
}

/**
 * Arithmetic in a formula: a fraction, a sum, a root, a product of numbers, or a plus, minus or times between two operands, at least one
 * of them a number or a lower-case name (n+1, ad−bc). "{1, 2, 3}", "0^n 1^n", "Q × Σ", "A − B" and words inside \text{} are not.
 */
const COMPUTES_COMMAND = /\\(?:frac|sum|prod|int|sqrt|cdot|div)\b/;
// an operator needs an operand on both sides, so a sign in front, a superscript star (Σ*) or a lone "+" does not count
const COMPUTES_OPERATOR = /[\da-z)}]\s*[+\-−*]\s*[\da-z({]|\d\s*\/|\/\s*\d|[\da-z]\s*\\times|\\times\s*[\da-z]/;
function computes(latex: string): boolean {
  const l = latex.replace(/\\(?:text|textbf|textit|mathrm|mathit|operatorname)\s*\{[^}]*\}/g, ' ');
  return COMPUTES_COMMAND.test(l) || COMPUTES_OPERATOR.test(l);
}

/** Whether a slide's formulas compute something (numbers, arithmetic, a fraction, a sum), as against defining a relation or a class. */
function equationsCompute(s: SlideData): boolean {
  for (const e of s.elements) {
    if (e.kind !== 'shape' || e.decorative || e.hidden) continue;
    for (const p of e.paragraphs) for (const i of p.inlines) if (i.kind === 'math' && computes(i.latex)) return true;
  }
  return /\$[^$\n]*\$/.test(s.text) && (s.text.match(/\$[^$\n]*\$/g) ?? []).some((m) => computes(m));
}

const MACHINE_WORDS = /\b(?:transition (?:function|table|diagram)|state diagram|automaton|automata|turing machines?|configurations?|accepts?|rejects?|halts?|start state|accept state|tape|DFA|NFA|PDA)\b/gi;
/** A slide about a machine: its words, or a table of states. */
function isMachineSlide(s: SlideData): boolean {
  if ((s.text.match(MACHINE_WORDS) ?? []).length >= 3) return true;
  return s.elements.some((e) => e.kind === 'table' && /^\s*(?:current )?state\b/i.test(e.rows[0]?.[0]?.text ?? ''));
}

/** The lines of a slide that are set in a monospaced font: a code or pseudocode block. */
function monoLines(s: SlideData): string[] {
  const out: string[] = [];
  for (const e of s.elements) {
    if (e.kind !== 'shape' || e.decorative || e.hidden) continue;
    for (const p of e.paragraphs) {
      const runs = p.inlines.filter((i): i is TextRun => i.kind === 'text');
      // a line of code has words in it: a lone digit or "≠7" set in a monospaced font (a label on a table) is not a line of code
      if (runs.length > 0 && runs.every((r) => r.mono) && p.text.trim().length >= 4 && /\p{L}/u.test(p.text)) out.push(p.text);
    }
  }
  return out;
}
// A line that ends in ; or { (a statement, a block), or a closing brace on its own: not a set written in braces, "{1, 2, 3}".
// A statement or a block: a keyword line that ends in ( { : or ; (so "For information about citing these materials, visit: …" is prose).
const CODE = /(^|\n)\s*(for|while|if|def|function|int|void|return|class|public)\b[^\n]*[({:;]\s*(\n|$)|[;{]\s*(\n|$)|(^|\n)\s*\}\s*(\n|$)|```/i;

/** Which kinds of content one slide carries. Cheap and local; used for the whole lecture and for choosing a question's slides. */
export function slideTraits(s: SlideData): { math: boolean; arith: boolean; machine: boolean; table: boolean; code: boolean; algorithm: boolean; proof: boolean; diagram: boolean; security: boolean } {
  const text = s.text;
  const mono = monoLines(s);
  return {
    // real equations only: a stray "=" in a typed diagram label ("sum = 7178") does not make a lecture mathematical
    math: s.counts.equations > 0 || /\$[^$\n]+\$/.test(text) || typedFormulaLines(s).formulas > 0,
    arith: equationsCompute(s) || typedFormulaLines(s).arith > 0,
    machine: isMachineSlide(s),
    table: s.counts.tables > 0,
    code: CODE.test(text) || mono.length >= 2,
    algorithm: ALGORITHM.test(text) || (mono.length >= 2 && mono.some((l) => PSEUDO_LINE.test(l))),
    proof: hasProof(text),
    // a figure worth a question: its words are typed, or it is a chart or SmartArt, or it is large enough that the app warned it may hold a diagram (a small photo is not)
    diagram: s.counts.charts > 0 || s.counts.smartArt > 0 || (s.pictureTexts?.length ?? 0) > 0 || (s.counts.pictures > 0 && s.flags.some((x) => x.code === 'LARGE_PICTURE' || x.code === 'UNRENDERABLE_IMAGE' || x.code === 'NO_EXTRACTABLE_TEXT')),
    security: SECURITY.test(text),
  };
}

/** Counts, per kind of content, how many slides carry it. */
export function gatherEvidence(slides: readonly SlideData[]): Evidence {
  const e: Evidence = { math: 0, arith: 0, machine: 0, tables: 0, code: 0, algorithm: 0, proof: 0, diagram: 0, security: 0, substantive: 0 };
  for (const s of slides) {
    if (WORDS(s.text) - WORDS(s.title) >= 8) e.substantive += 1;
    const t = slideTraits(s);
    if (t.math) e.math += 1;
    if (t.arith) e.arith += 1;
    if (t.machine) e.machine += 1;
    if (t.table) e.tables += 1;
    if (t.code) e.code += 1;
    if (t.algorithm) e.algorithm += 1;
    if (t.proof) e.proof += 1;
    if (t.diagram) e.diagram += 1;
    if (t.security) e.security += 1;
  }
  return e;
}

/**
 * A lecture whose material is formulas, proofs and procedures. Its questions are things to work out (a calculation, a proof, a
 * trace), not invented stories: a "scenario" about a notation slide is not an exam question there.
 */
export function isMathy(e: Evidence): boolean {
  return e.math + e.proof + e.algorithm + e.machine >= Math.max(2, 0.3 * e.substantive);
}

/** The slide property a type of question is built on, when it needs one (a diagram question needs a diagram). */
function needsOnSlide(type: QuestionType): ((s: SlideData) => boolean) | undefined {
  switch (type) {
    case 'diagram':
      return (s) => slideTraits(s).diagram;
    case 'calculation':
      return (s) => slideTraits(s).arith;
    case 'problem':
      return (s) => slideTraits(s).math;
    case 'proof':
      return (s) => slideTraits(s).proof;
    case 'algorithm':
      return (s) => slideTraits(s).algorithm || slideTraits(s).code || slideTraits(s).machine; // a machine's computation is traced like a procedure
    case 'programming':
      return (s) => slideTraits(s).algorithm || slideTraits(s).code;
    case 'attack':
      return (s) => slideTraits(s).security;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The professor's instructions
// ---------------------------------------------------------------------------

export interface StyleHints {
  /** Types the professor asks for, with a weight (6 = "most", 2 = mentioned). */
  prefer: Map<QuestionType, number>;
  /** Types the professor rules out ("no multiple choice"). */
  avoid: Set<QuestionType>;
  /** "Answers are 1–3 sentences": the most marks a written question should carry. */
  maxMarks?: number;
  /** "Only …": nothing but these types. */
  only?: Set<QuestionType>;
}

const STYLE_WORDS: [RegExp, QuestionType[]][] = [
  [/multiple[- ]choice|\bmcqs?\b/i, ['mcq']],
  [/true\s*(?:\/|or|-)\s*false|\bt\/f\b/i, ['truefalse']],
  [/scenario|real[- ]world|applied|application/i, ['scenario']],
  [/case[- ]stud(?:y|ies)/i, ['case']],
  [/\bproofs?\b|\bprove\b|\bderiv(?:e|ation)s?\b/i, ['proof']],
  [/calculat\w*|numerical|compute|computation/i, ['calculation', 'problem']],
  [/algorithm|pseudo-?code|trace/i, ['algorithm']],
  [/programming|coding|write (?:a )?(?:function|program|code)/i, ['programming']],
  [/compare|contrast|differences?\s+between/i, ['compare']],
  [/defin(?:e|ition)s?/i, ['define']],
  [/diagram|draw|figure|label/i, ['diagram']],
  // "theoretical" and "conceptual" questions ask for an explanation: what a thing is, how two things differ, why something holds
  [/\btheor(?:y|etical)\b|\bconceptual\b/i, ['short', 'define', 'compare']],
  [/\bessay|long[- ]answer|discuss|evaluate/i, ['long']],
  // "short answer", "short, complete answers", "brief", "1-3 sentences"
  [/\bshort\b[^.;]{0,30}\banswers?\b|\bbrief\b|\bsentences?\b/i, ['short']],
  [/problem[- ]solving|solve|worked (?:problem|example)/i, ['problem', 'calculation']],
  [/attack|threat|countermeasure|defen[cs]e/i, ['attack']],
];
const NEGATION = /\b(no|not|never|without|avoid|don'?t|do not|won'?t|except|excluding)\b/i;
const EMPHASIS = /\b(most|mostly|mainly|primarily|majority|predominantly|many|largely)\b/i;
const EXCLUSIVE = /\bonly\b/i;
/** Words that start something else in the same sentence: "mostly scenarios, including proofs" stresses the scenarios, not the proofs. */
const SCOPE_BREAK = /\b(?:including|includes?|requiring|requires?|where|with|plus|also|but|some|a few|a couple of)\b/gi;
function emphasised(clause: string, at: number): boolean {
  let start = 0;
  for (const m of clause.slice(0, at).matchAll(SCOPE_BREAK)) start = m.index + m[0].length;
  return EMPHASIS.test(clause.slice(start, at + 20));
}

/**
 * Reads the professor's exam instructions for the things that can be acted on locally: which kinds of question, which to leave
 * out, how long the answers are. The full text still goes to the model; this only steers the plan.
 */
export function parseExamStyle(text: string | undefined): StyleHints {
  const hints: StyleHints = { prefer: new Map(), avoid: new Set() };
  if (!text?.trim()) return hints;
  // sentence-like clauses, so "no multiple choice. Most are scenarios" is read as two statements
  const clauses = text.split(/[.;\n]+/).map((c) => c.trim()).filter(Boolean);
  const only = new Set<QuestionType>();
  for (const clause of clauses) {
    for (const [re, types] of STYLE_WORDS) {
      const m = re.exec(clause);
      if (!m) continue;
      const before = clause.slice(Math.max(0, m.index - 40), m.index);
      const negated = NEGATION.test(before.split(/[,]/).slice(-1)[0] ?? before);
      for (const t of types) {
        if (negated) {
          hints.avoid.add(t);
          hints.prefer.delete(t);
        } else if (!hints.avoid.has(t)) {
          hints.prefer.set(t, Math.max(hints.prefer.get(t) ?? 0, emphasised(clause, m.index) ? 6 : 2));
          if (EXCLUSIVE.test(before)) only.add(t);
        }
      }
    }
  }
  if (only.size > 0) hints.only = only;
  const sentences = /\b(\d+)\s*(?:-|–|to)\s*(\d+)\s*sentences?\b/i.exec(text) ?? /\b(?:at most|up to|max(?:imum)?(?: of)?)\s*(\d+)\s*sentences?\b/i.exec(text);
  if (sentences) hints.maxMarks = Math.max(1, Number(sentences[2] ?? sentences[1]));
  // short answers: no essay, and no written answer worth more than five points (a proof is not capped, see the plan)
  else if (hints.prefer.has('short') && !hints.avoid.has('short') && /\bshort\b[^.;]{0,30}\banswers?\b|\bbrief\b/i.test(text)) {
    hints.maxMarks = 5;
    if (!hints.prefer.has('long')) hints.avoid.add('long');
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Types, difficulty and marks
// ---------------------------------------------------------------------------

interface Menu {
  type: QuestionType;
  weight: number;
  /** Evidence needed on at least one of the slides in play. */
  needs?: (e: Evidence) => boolean;
  marks: number;
}

const TIERS: Record<Difficulty, Menu[]> = {
  // 1 = recall or restate one idea from one slide
  1: [
    { type: 'truefalse', weight: 1.5, marks: 1 },
    { type: 'mcq', weight: 1.5, marks: 1 },
    { type: 'define', weight: 2, marks: 2 },
    { type: 'short', weight: 2, marks: 2 },
  ],
  // 2 = explain, compare or apply an idea using one to three slides
  2: [
    { type: 'compare', weight: 2.5, marks: 4 },
    { type: 'short', weight: 2, marks: 3 },
    { type: 'diagram', weight: 2, needs: (e) => e.diagram > 0, marks: 3 },
    { type: 'calculation', weight: 3, needs: (e) => e.arith > 0, marks: 4 },
    { type: 'algorithm', weight: 2.5, needs: (e) => e.algorithm > 0 || e.code > 0 || e.machine > 0, marks: 4 },
    { type: 'scenario', weight: 1.5, marks: 4 },
  ],
  // 3 = a situation or problem that combines several slides or topics, several steps
  3: [
    { type: 'scenario', weight: 3, marks: 6 },
    { type: 'case', weight: 1, marks: 6 },
    { type: 'attack', weight: 3, needs: (e) => e.security > 1, marks: 6 },
    { type: 'proof', weight: 3, needs: (e) => e.proof > 0, marks: 6 },
    { type: 'problem', weight: 2.5, needs: (e) => e.math > 0, marks: 6 },
    { type: 'algorithm', weight: 2, needs: (e) => (e.algorithm > 0 && e.code + e.algorithm > 1) || e.machine > 1, marks: 6 },
    { type: 'programming', weight: 1.5, needs: (e) => e.code > 1, marks: 6 },
    { type: 'long', weight: 1, marks: 8 },
  ],
};

/** Roughly 30 % easy, 40 % medium, 30 % hard; the harder the question the more the slides must be combined. */
export function difficultyMix(count: number): Difficulty[] {
  if (count <= 0) return [];
  const hard = Math.max(count >= 3 ? 1 : 0, Math.round(count * 0.3));
  const easy = Math.max(count >= 2 ? 1 : 0, Math.round(count * 0.3));
  const medium = Math.max(0, count - hard - easy);
  // interleaved so that any prefix of the plan (one request's worth) already has a mix
  const out: Difficulty[] = [];
  const left: Record<Difficulty, number> = { 1: easy, 2: medium, 3: hard };
  const order: Difficulty[] = [2, 3, 1];
  while (out.length < count) {
    for (const d of order) {
      if (left[d] > 0 && out.length < count) {
        out.push(d);
        left[d] -= 1;
      }
    }
  }
  return out;
}

/** How many separate marking points a question of this many marks should have: about one per mark. */
export function pointsFor(type: QuestionType, marks: number): number {
  if (type === 'mcq' || type === 'truefalse') return 1;
  return Math.max(1, Math.min(8, Math.round(marks)));
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface BlueprintInput {
  slides: readonly SlideData[];
  topics: readonly Pick<Topic, 'title' | 'startSlide' | 'endSlide'>[];
  count: number;
  examStyle?: string | undefined;
  /** Questions that already exist for these slides: what they cover is covered less in the plan. */
  existing?: readonly { topic?: string | undefined; slides: readonly number[]; type?: QuestionType }[];
}

/** Slides that are about the lecture, not its content: nothing to examine there. */
const META_TITLE = /^\s*(?:objectives?|learning (?:objectives|outcomes|goals)|outline|agenda|contents|table of contents|acknowledge?ments?|references|bibliography|thank(?:s| you)\b.*|questions\??|q\s*&\s*a|further reading|credits|summary|recap|conclusions?|key (?:points|takeaways)|takeaways?|what we (?:have )?learned|wrap[- ]?up|(?:[^\n]{0,40}?\s)?(?:lecture|week|session)\s+\d+|(?:mit )?open\s?course\s?ware|(?:quick )?review(?: of (?:today|the lecture|this lecture))?)\s*$/i;

/** A short slide that only credits or licenses the course (some have no heading to say so). */
const META_BODY = /\b(?:citing these materials|terms of use|creative commons|all rights reserved|licensed under|copyright)\b/i;

/** A slide about the lecture, not its content: contents, objectives, a recap, credits. */
export function isMetaSlide(s: SlideData): boolean {
  return META_TITLE.test(s.title) || (WORDS(s.text) < 60 && s.counts.equations === 0 && META_BODY.test(s.text));
}

/**
 * Study text of a slide without its heading: how much there is to ask about. Slides about the lecture itself have none, and neither
 * has a check-in: it puts a question to the room and gives no answer, so there is nothing on it to base a marking scheme on.
 */
function substance(s: SlideData): number {
  if (isMetaSlide(s) || isQuestionSlide(s)) return 0;
  // A formula is one "word" to a word counter but says as much as a sentence, and a line of code as much as a few words.
  return Math.max(0, WORDS(s.text) - WORDS(s.title)) + 6 * s.counts.equations + 3 * monoLines(s).length;
}

/** How many separate things a slide says: its lines of content (bullets, table rows, typed picture words). A marking point needs one. */
function ideaUnits(s: SlideData): number {
  if (substance(s) === 0) return 0;
  const lines = s.text
    .split('\n')
    .slice(1) // the heading
    .map((l) => l.replace(/^\s*(?:[-*>]|\d+[.)])\s*/, '').trim())
    .filter((l) => l && !l.startsWith('[') && WORDS(l) >= 3).length;
  // Steps are ideas too: every line of a code block (however short) and every formula (what it says, how it is used).
  const code = monoLines(s).length;
  return lines + code + s.counts.equations;
}

interface Part {
  title: string;
  slides: SlideData[];
  /** Words of content: what the topic weighs. */
  words: number;
  /** Questions that already exist for it. */
  done: number;
  /** Slides of it that no existing question is based on yet. */
  fresh: number;
  /** Words of content counted less for each question that already covers the slide: what is still worth asking about. */
  eff: number;
}

/** A topic with less text than this (a thank-you slide, a heading) has nothing to ask about. */
const MIN_TOPIC_WORDS = 12;

/** Question share: a long topic gets more questions than a short one, but not in proportion, so short topics are not skipped. */
const weightOf = (p: Part): number => (p.words < MIN_TOPIC_WORDS ? 0 : Math.sqrt(p.eff) / (1 + p.done));

interface Parts {
  parts: Part[];
  topicOf: (slide: number) => string;
}

function partsOf(slides: readonly SlideData[], topics: BlueprintInput['topics'], existing: NonNullable<BlueprintInput['existing']>): Parts {
  const bySlide = new Map(slides.map((s) => [s.index, s]));
  const usable = topics.filter((t) => t.endSlide >= t.startSlide).sort((a, b) => a.startSlide - b.startSlide);
  const raw: { title: string; slides: SlideData[] }[] = [];
  const seen = new Set<number>();
  for (const t of usable) {
    const inTopic: SlideData[] = [];
    for (let i = t.startSlide; i <= t.endSlide; i++) {
      const s = bySlide.get(i);
      if (s && !seen.has(i)) {
        inTopic.push(s);
        seen.add(i);
      }
    }
    if (inTopic.length > 0) raw.push({ title: t.title, slides: inTopic });
  }
  const rest = slides.filter((s) => !seen.has(s.index));
  const restTitle = raw.length === 0 ? 'The lecture' : 'Other slides';
  if (rest.length > 0) raw.push({ title: restTitle, slides: rest });
  const titleOf = new Map<number, string>();
  for (const p of raw) for (const s of p.slides) titleOf.set(s.index, p.title);
  const used = new Map<number, number>();
  for (const q of existing) for (const n of q.slides) used.set(n, (used.get(n) ?? 0) + 1);
  const parts = raw
    .map((p): Part => {
      const done = existing.filter((q) => q.slides.some((n) => p.slides.some((s) => s.index === n)) || (q.topic && q.topic.trim().toLowerCase() === p.title.trim().toLowerCase())).length;
      return {
        ...p,
        words: p.slides.reduce((n, s) => n + substance(s), 0),
        done,
        fresh: p.slides.filter((s) => substance(s) >= 6 && !used.has(s.index)).length,
        eff: p.slides.reduce((n, s) => n + substance(s) / (1 + (used.get(s.index) ?? 0)), 0),
      };
    })
    .filter((p) => weightOf(p) > 0);
  return { parts, topicOf: (n) => titleOf.get(n) ?? restTitle };
}

/**
 * When there are more topics than questions (a lecture cut into one topic per slide), neighbouring small topics are taken
 * together, smallest first, so every question covers a stretch of the lecture and a big topic keeps its larger share.
 */
function mergeNeighbours(parts: Part[], target: number): Part[] {
  const out = [...parts];
  // Only topics whose slides follow each other directly are taken together. A slide in between that was left out (a heading that
  // starts a new section, a slide with nothing on it) is a break: what is on either side of it is not one stretch of the lecture.
  const touching = (i: number): boolean => out[i]!.slides[out[i]!.slides.length - 1]!.index + 1 === out[i + 1]!.slides[0]!.index;
  while (out.length > Math.max(1, target)) {
    let at = -1;
    let least = Infinity;
    for (let i = 0; i + 1 < out.length; i++) {
      if (!touching(i)) continue;
      const w = out[i]!.words + out[i + 1]!.words;
      if (w < least) {
        least = w;
        at = i;
      }
    }
    if (at < 0) break; // nothing left that belongs together
    const a = out[at]!;
    const b = out[at + 1]!;
    out.splice(at, 2, { title: `${a.title} · ${b.title}`, slides: [...a.slides, ...b.slides], words: a.words + b.words, done: a.done + b.done, fresh: a.fresh + b.fresh, eff: a.eff + b.eff });
  }
  return out;
}

/**
 * Largest-remainder split of `count` over the weights, every part with weight getting at least one while there is room. Parts
 * that still have slides nobody has asked about come first, so a second round reaches what the first one left.
 */
function allocate(weights: number[], count: number, fresh: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || count <= 0) return weights.map(() => 0);
  const out = weights.map(() => 0);
  const order = weights.map((w, i) => [w, i] as const).sort((a, b) => Number((fresh[b[1]] ?? 0) > 0) - Number((fresh[a[1]] ?? 0) > 0) || b[0] - a[0]);
  // One question per part first, strongest parts first, so coverage comes before depth. When some parts still have slides nobody
  // has asked about, only those come first: a part that is fully covered waits for the proportional share below.
  const anyFresh = fresh.some((f) => f > 0);
  for (const [, i] of anyFresh ? order.filter(([, j]) => (fresh[j] ?? 0) > 0) : order) {
    if (out.reduce((a, b) => a + b, 0) >= count) break;
    out[i] = 1;
  }
  let left = count - out.reduce((a, b) => a + b, 0);
  while (left > 0) {
    // give the next one to the part that is furthest below its fair share
    let best = 0;
    let bestGap = -Infinity;
    weights.forEach((w, i) => {
      const gap = (w / total) * count - out[i]!;
      if (gap > bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    out[best] = out[best]! + 1;
    left -= 1;
  }
  return out;
}

/** Kinds of question that a set should contain when the material supports them, strongest evidence first. */
const SPECIAL_ORDER: QuestionType[] = ['proof', 'calculation', 'algorithm', 'diagram', 'attack', 'problem', 'programming', 'scenario', 'compare'];

/** Whether a topic has what the kind of question is built on (a diagram question needs a diagram among its slides). */
function partSupports(part: Part, type: QuestionType): boolean {
  const has = needsOnSlide(type);
  return !has || part.slides.some(has);
}

function pickType(d: Difficulty, evidence: Evidence, part: Part, style: StyleHints, used: Map<QuestionType, number>, rng: () => number, exclude: ReadonlySet<QuestionType> = new Set()): Menu {
  // offered only when the lecture has enough of it AND this part of it has a slide to build the question on
  let menu = TIERS[d].filter((m) => (!m.needs || m.needs(evidence)) && partSupports(part, m.type) && !exclude.has(m.type));
  if (menu.length === 0) menu = TIERS[d].filter((m) => (!m.needs || m.needs(evidence)) && partSupports(part, m.type)); // nothing else fits: the exclusion is dropped
  if (style.only) menu = menu.filter((m) => style.only!.has(m.type));
  const allowed = menu.filter((m) => !style.avoid.has(m.type));
  if (style.only && allowed.length === 0) {
    // the professor's own kind of question, whatever tier it is normally in
    const t = [...style.only].find((x) => !style.avoid.has(x));
    if (t) return { type: t, weight: 1, marks: (Object.values(TIERS).flat().find((m) => m.type === t)?.marks ?? 3) };
  }
  const pool = allowed.length > 0 ? allowed : TIERS[d].filter((m) => !style.avoid.has(m.type));
  const usable = pool.length > 0 ? pool : TIERS[d];
  // what the professor asked for counts more; a type already used counts less, so the set stays varied
  const mathy = isMathy(evidence);
  const holds = (f: (s: SlideData) => boolean) => part.slides.some(f);
  // what the slides of this part hold counts too: a table invites a comparison, a formula a calculation, a proof a proof
  const fit = (t: QuestionType): number => {
    let w = 1;
    if (mathy && (t === 'scenario' || t === 'case' || t === 'long') && !style.prefer.has(t)) w *= 0.05; // a mathematical lecture gets problems to solve, not stories, unless the professor asks
    if (t === 'compare' && holds((s) => slideTraits(s).table)) w *= 3;
    if (t === 'calculation' && holds((s) => slideTraits(s).arith)) w *= 2;
    if (t === 'problem' && holds((s) => slideTraits(s).math)) w *= 2;
    if (t === 'algorithm' && holds((s) => slideTraits(s).algorithm || slideTraits(s).machine)) w *= 2;
    if (t === 'proof' && holds((s) => slideTraits(s).proof)) w *= 2;
    return w;
  };
  const weighted = usable.map((m) => ({ m, w: (m.weight * (style.prefer.get(m.type) ?? 1) * fit(m.type)) / (1 + (used.get(m.type) ?? 0)) }));
  const total = weighted.reduce((a, b) => a + b.w, 0);
  let r = rng() * total;
  for (const x of weighted) {
    r -= x.w;
    if (r <= 0) return x.m;
  }
  return weighted[weighted.length - 1]!.m;
}

/** A small deterministic generator: the same lecture and settings always give the same plan. */
function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * Picks the slides a question should be based on: the least covered ones of the topic first. A question type that needs something
 * on the slide (a diagram, an equation) starts from a slide that has it. A question that combines slides (medium and hard) may
 * also use the nearest slides outside the topic, until the slides hold enough separate ideas for its marking points.
 */
function focusSlides(part: Part, d: Difficulty, covered: Map<number, number>, type: QuestionType, all: readonly SlideData[], needPoints: number): { slides: SlideData[]; anchor: SlideData } {
  const want = d === 1 ? 1 : d === 2 ? 2 : Math.min(4, Math.max(2, Math.ceil(part.slides.length / 2)));
  const has = needsOnSlide(type);
  // a comparison is best built on a table of the things compared
  const likes = (s: SlideData): boolean => (has ? has(s) : type === 'compare' ? slideTraits(s).table : false);
  const ranked = [...part.slides]
    .filter((s) => substance(s) >= 6 || (has?.(s) ?? false))
    .sort((a, b) => Number(likes(b)) - Number(likes(a)) || (covered.get(a.index) ?? 0) - (covered.get(b.index) ?? 0) || a.index - b.index);
  const pool = ranked.length > 0 ? ranked : part.slides;
  const first = pool[0]!;
  const near = (a: SlideData, b: SlideData) => Math.abs(a.index - first.index) - Math.abs(b.index - first.index);
  // a question that combines slides uses neighbours of the first one, so the slides belong together; one that needs a formula, a
  // proof or code is only combined with slides that have it (a proof is not "hard" because it is joined to an unrelated slide)
  const chosen = [first];
  for (const s of pool.slice(1).filter((x) => !has || has(x)).sort(near)) {
    if (chosen.length >= want) break;
    chosen.push(s);
  }
  const capacity = () => chosen.reduce((n, s) => n + ideaUnits(s), 0);
  if (d >= 2) {
    // Only the slides right next to the ones chosen: they belong together. A slide further away may start another section
    // (a heading slide in between is a break), and a question that joins the two is not a question about one idea.
    for (;;) {
      if (chosen.length >= 4 || (chosen.length >= want && capacity() >= needPoints)) break;
      // a question that needs a formula, a proof or code is combined with a neighbour that has it; with none, the next slide is
      // joined only when the question would otherwise have fewer than three separate ideas to mark (a proof of five steps is five marks)
      const adjacent = all.filter((s) => !chosen.includes(s) && substance(s) >= 6 && chosen.some((c) => Math.abs(c.index - s.index) <= 1));
      const fitting = has ? adjacent.filter(has) : adjacent;
      const next = (fitting.length > 0 ? fitting : capacity() < Math.min(needPoints, 3) ? adjacent : []).sort((a, b) => (covered.get(a.index) ?? 0) - (covered.get(b.index) ?? 0) || near(a, b))[0];
      if (!next) break;
      chosen.push(next);
    }
  }
  // the question belongs to the topic it was built around, not to whichever neighbour has the lowest number
  return { slides: chosen.sort((a, b) => a.index - b.index), anchor: first };
}

/** Whether a question of this kind on these slides is already there: the same kind, on the same slides or on slides that hold or are held by them. */
function clashes(taken: readonly { type?: QuestionType | undefined; slides: readonly number[] }[], type: QuestionType, slides: readonly number[]): boolean {
  return taken.some((q) => q.type === type && q.slides.length > 0 && (slides.every((n) => q.slides.includes(n)) || q.slides.every((n) => slides.includes(n))));
}

export function buildBlueprint(input: BlueprintInput): Slot[] {
  const existing = input.existing ?? [];
  const style = parseExamStyle(input.examStyle);
  const made = partsOf(input.slides, input.topics, existing);
  if (made.parts.length === 0 || input.count <= 0) return [];
  const count = Math.min(input.count, 30);
  const all = made.parts.flatMap((p) => p.slides);
  const lecture = gatherEvidence(all);
  // fewer topics than questions are asked for when the lecture is cut into many tiny ones: neighbours are taken together
  const parts = mergeNeighbours(made.parts, Math.max(1, Math.round(count * 0.75)));
  const share = allocate(parts.map(weightOf), count, parts.map((p) => p.fresh));
  const difficulties = difficultyMix(count);
  const covered = new Map<number, number>();
  for (const q of existing) for (const n of q.slides) covered.set(n, (covered.get(n) ?? 0) + 1);
  const used = new Map<QuestionType, number>();
  for (const q of existing) if (q.type) used.set(q.type, (used.get(q.type) ?? 0) + 0.5);
  const rng = seeded(hash(`${input.slides.map((s) => s.index).join(',')}|${count}|${input.examStyle ?? ''}|${existing.length}`));

  // one entry per question, parts in lecture order with their share, then dealt out so neighbouring questions differ in topic
  const queue: Part[] = [];
  const left = [...share];
  while (left.some((n) => n > 0)) {
    parts.forEach((p, i) => {
      if (left[i]! > 0) {
        queue.push(p);
        left[i]! -= 1;
      }
    });
  }
  // Pass 1: the kinds that suit this material are guaranteed, not left to chance. A lecture with a theorem gets a proof question,
  // one with attack vocabulary an attack-and-countermeasure question, and any set of three or more gets a situation to apply the
  // ideas to. The kind is placed on a part that has a slide to build it on.
  const chosen: (Menu | undefined)[] = queue.map(() => undefined);
  let reserved = 0;
  /** Gives a kind of question a place on a part that can carry it, swapping planned difficulties when needed. */
  const place = (type: QuestionType, force = false): boolean => {
    // the tiers this kind of question belongs to (an algorithm question is medium or hard, never easy)
    const tiers = ([1, 2, 3] as Difficulty[]).filter((d) => TIERS[d].some((m) => m.type === type && (!m.needs || m.needs(lecture))));
    if (tiers.length === 0) return false;
    // a part of the lecture that can carry it, ideally one whose planned difficulty already fits
    const fits = (i: number) => !chosen[i] && partSupports(queue[i]!, type);
    // a comparison goes where there is a table of the things compared, and no kind goes twice to the same part while another part can carry it
    const preferred = (i: number) => (type !== 'compare' || queue[i]!.slides.some((s) => slideTraits(s).table)) && !chosen.some((m, j) => m?.type === type && queue[j] === queue[i]);
    let k = queue.findIndex((_, i) => fits(i) && preferred(i) && tiers.includes(difficulties[i] ?? 2));
    // the preferred place, even when its planned difficulty has to be swapped, beats another place that fits as planned
    const swapForPreferred = k < 0 && queue.some((_, i) => fits(i) && preferred(i));
    if (k < 0 && !swapForPreferred) k = queue.findIndex((_, i) => fits(i) && tiers.includes(difficulties[i] ?? 2));
    if (k < 0) {
      // None fits as planned: give the kind a place by swapping difficulties with another slot, which keeps the overall mix
      const host = swapForPreferred ? queue.findIndex((_, i) => fits(i) && preferred(i)) : queue.findIndex((_, i) => fits(i));
      const swap = queue.findIndex((_, j) => j !== host && !chosen[j] && tiers.includes(difficulties[j] ?? 2));
      if (host < 0) return false;
      if (swap >= 0) [difficulties[host], difficulties[swap]] = [difficulties[swap]!, difficulties[host]!];
      else if (force) difficulties[host] = tiers[0]!; // what the professor stresses may change the mix of difficulties
      else return false;
      k = host;
    }
    chosen[k] = TIERS[difficulties[k] ?? 2].find((m) => m.type === type)!;
    used.set(type, (used.get(type) ?? 0) + 1);
    return true;
  };
  // A lecture made of proofs gets several, placed first so that no other kind takes their slides: about a quarter of the exam, and
  // never more than it has proofs to ask about. Any other lecture with a theorem gets one.
  if (!style.avoid.has('proof') && (!style.only || style.only.has('proof'))) {
    const quota = lecture.proof >= 3 ? Math.min(lecture.proof, Math.max(1, Math.round(queue.length * Math.min(0.25, lecture.proof / Math.max(1, lecture.substantive))))) : 1;
    for (let i = 0; i < quota; i++) {
      if (!place('proof', i > 0)) break;
      reserved += 1;
    }
  }
  for (const type of SPECIAL_ORDER) {
    if (type === 'proof') continue;
    if (reserved >= Math.floor(queue.length * 0.6)) break;
    if (style.avoid.has(type) || (style.only && !style.only.has(type))) continue;
    if (type === 'scenario' && (queue.length < 3 || isMathy(lecture))) continue; // a mathematical lecture gets problems to solve, not stories
    if (type === 'compare' && queue.length < 5) continue;
    if (place(type)) reserved += 1;
  }
  // "Most questions are proofs and calculations": what the professor stresses fills most of the exam, as far as the slides can carry it
  const stressed = [...style.prefer].filter(([, w]) => w >= 6).map(([type]) => type).filter((type) => !style.avoid.has(type) && (!style.only || style.only.has(type)));
  if (stressed.length > 0) {
    const target = Math.ceil(queue.length * 0.6);
    let have = chosen.filter((m) => m && stressed.includes(m.type)).length;
    for (let round = 0, stuck = 0; have < target && round < queue.length * 3 && stuck < stressed.length; round++) {
      if (place(stressed[round % stressed.length]!, true)) {
        have += 1;
        stuck = 0;
      } else stuck += 1;
    }
  }

  const slots: Slot[] = [];
  const taken: { type?: QuestionType | undefined; slides: readonly number[] }[] = existing.map((q) => ({ type: q.type, slides: [...new Set(q.slides)] }));
  queue.forEach((part, k) => {
    const d = difficulties[k] ?? 2;
    let menu = chosen[k] ?? pickType(d, lecture, part, style, used, rng);
    // the same kind of question on the same slides as one that exists (or one planned just before) would be asked twice
    const tried = new Set<QuestionType>();
    let focus = focusSlides(part, d, covered, menu.type, all, pointsFor(menu.type, menu.marks));
    for (let attempt = 0; attempt < 4 && clashes(taken, menu.type, focus.slides.map((s) => s.index)); attempt++) {
      tried.add(menu.type);
      const next = pickType(d, lecture, part, style, used, rng, tried);
      if (tried.has(next.type)) break; // no other kind is possible here
      menu = next;
      focus = focusSlides(part, d, covered, menu.type, all, pointsFor(menu.type, menu.marks));
    }
    let marks = menu.marks;
    if (style.maxMarks !== undefined && menu.type !== 'mcq' && menu.type !== 'truefalse' && menu.type !== 'proof') marks = Math.max(1, Math.min(marks, style.maxMarks));
    const objective = menu.type === 'mcq' || menu.type === 'truefalse';
    const { slides: picked, anchor } = focus;
    used.set(menu.type, (used.get(menu.type) ?? 0) + 1);
    taken.push({ type: menu.type, slides: picked.map((s) => s.index) });
    for (const s of picked) covered.set(s.index, (covered.get(s.index) ?? 0) + 1);
    // A marking point needs a separate idea on the slides. A question is never worth more points than the slides can supply, so
    // a "hard six-mark scenario" is not planned from four bullet points.
    let points = pointsFor(menu.type, marks);
    if (!objective) {
      const capacity = picked.reduce((n, s) => n + ideaUnits(s), 0);
      points = Math.max(1, Math.min(points, capacity || 1));
      marks = Math.min(marks, points);
    }
    slots.push({ n: k + 1, type: menu.type, difficulty: d, marks, points, topic: made.topicOf(anchor.index), slides: picked.map((s) => s.index) });
  });
  return slots;
}

// ---------------------------------------------------------------------------
// Requests: how many questions fit in one answer
// ---------------------------------------------------------------------------

/** Tokens one question takes in the answer: the prompt, marking points with their wording, and a full-marks model answer. */
export function slotTokens(s: Pick<Slot, 'type' | 'marks' | 'points'>): number {
  if (s.type === 'mcq' || s.type === 'truefalse') return 170;
  // the prompt, the list of what it asks for, the marking points (each naming its ask) and a full-marks answer
  return 190 + 45 * s.points + 25 * s.marks;
}

/**
 * Splits the plan into requests that each fit the answer limit with room to spare (70 % of it, the same margin as for
 * flashcards), keeping the plan's order so every request has a mix of topics and difficulties.
 */
export function splitIntoRequests(slots: readonly Slot[], outputTokens: number): Slot[][] {
  const room = Math.max(300, Math.floor(outputTokens * 0.7) - 150);
  const out: Slot[][] = [];
  let current: Slot[] = [];
  let used = 0;
  for (const s of slots) {
    const cost = slotTokens(s);
    if (current.length > 0 && used + cost > room) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(s);
    used += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** One line per slot, as it appears in the prompt and on the screen. */
export function describeSlot(s: Slot): string {
  return `${QUESTION_TYPE_LABEL[s.type]} · ${['', 'easy', 'medium', 'hard'][s.difficulty]} · ${s.marks} mark${s.marks === 1 ? '' : 's'} · ${s.topic} · slide${s.slides.length === 1 ? '' : 's'} ${s.slides.join(', ')}`;
}
