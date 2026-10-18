import type { AnswerState, AttemptRow, ExamConfig, Grade, QuestionRow } from './types';
import { OBJECTIVE_TYPES } from './types';

/**
 * Exam logic: choosing questions, marking, scoring.
 *
 * What is marked automatically: multiple-choice and true/false (exact, reproducible).
 * Everything else is marked by *you* against the question's marking points, with keyword
 * suggestions as a hint only. Subjective marks are always labelled uncertain: this app does not
 * claim to grade like an official examiner. (AI marking, when it exists, fills the same Grade.)
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function shuffled<T>(xs: T[], rng: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Selecting questions
// ---------------------------------------------------------------------------

/** Approved questions that satisfy the exam's lecture/topic/type/difficulty filters. */
export function filterBank(bank: QuestionRow[], c: Pick<ExamConfig, 'lectureIds' | 'topics' | 'types' | 'difficulty'>): QuestionRow[] {
  const topics = new Set(c.topics.map((t) => t.trim().toLowerCase()));
  return bank.filter((q) => {
    if (q.status !== 'approved') return false;
    // A question tied to no lecture is general and always eligible.
    if (c.lectureIds.length > 0 && q.lectureIds.length > 0 && !q.lectureIds.some((id) => c.lectureIds.includes(id))) return false;
    if (topics.size > 0 && !(q.topic && topics.has(q.topic.trim().toLowerCase()))) return false;
    if (c.types.length > 0 && !c.types.includes(q.type)) return false;
    if (c.difficulty !== 'mixed' && q.difficulty !== c.difficulty) return false;
    return true;
  });
}

export interface Selection {
  ids: string[];
  totalMarks: number;
  available: number;
  notes: string[];
}

/** Pick questions for an exam. With `totalMarks`, the selection is steered towards that total (best effort). */
export function selectQuestions(bank: QuestionRow[], config: ExamConfig, rng: () => number = Math.random): Selection {
  const pool = shuffled(filterBank(bank, config), rng);
  const notes: string[] = [];
  let chosen: QuestionRow[];
  if (config.totalMarks) {
    const target = config.totalMarks;
    chosen = [];
    let sum = 0;
    for (const q of pool) {
      if (chosen.length >= config.count) break;
      if (sum + q.marks <= target * 1.05) {
        chosen.push(q);
        sum += q.marks;
      }
    }
    // Top up with the smallest remaining questions if we are well short of the target.
    for (const q of [...pool].sort((a, b) => a.marks - b.marks)) {
      if (sum >= target * 0.95 || chosen.length >= config.count) break;
      if (!chosen.includes(q) && sum + q.marks <= target * 1.05) {
        chosen.push(q);
        sum += q.marks;
      }
    }
    if (Math.abs(sum - target) > target * 0.1) notes.push(`The closest total available is ${round2(sum)} marks (you asked for ${target}).`);
  } else {
    chosen = pool.slice(0, config.count);
  }
  if (chosen.length < config.count) notes.push(`Only ${chosen.length} matching question${chosen.length === 1 ? '' : 's'} available (you asked for ${config.count}). Import or write more, or loosen the filters.`);
  return { ids: chosen.map((q) => q.id), totalMarks: round2(chosen.reduce((n, q) => n + q.marks, 0)), available: pool.length, notes };
}

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

export const isObjective = (q: Pick<QuestionRow, 'type' | 'options'>): boolean => OBJECTIVE_TYPES.includes(q.type) && !!q.options && q.options.length > 0;

/** Exact marking for multiple-choice / true-false. Returns undefined for questions that need a human. */
export function autoGrade(q: QuestionRow, a: AnswerState | undefined, now = Date.now()): Grade | undefined {
  if (!isObjective(q)) return undefined;
  const options = q.options!;
  const correct = options.filter((o) => o.correct).map((o) => o.id);
  const chosen = [...new Set(a?.optionIds ?? [])].filter((id) => options.some((o) => o.id === id));
  const mk = (marks: number, comment: string): Grade => ({ marks: round2(marks), max: q.marks, items: [], comment, by: 'auto', gradedAt: now });
  if (chosen.length === 0) return mk(0, 'No answer given.');
  if (correct.length === 1) {
    return chosen.length === 1 && chosen[0] === correct[0] ? mk(q.marks, 'Correct.') : mk(0, 'Incorrect.');
  }
  // Several correct options: credit for each right pick, deduct for each wrong pick, never below zero.
  const right = chosen.filter((id) => correct.includes(id)).length;
  const wrong = chosen.length - right;
  const fraction = Math.max(0, (right - wrong) / correct.length);
  return mk(q.marks * fraction, fraction === 1 ? 'Correct.' : fraction === 0 ? 'Incorrect.' : `Partly correct: ${right} of ${correct.length} right answers chosen${wrong ? `, ${wrong} wrong` : ''}.`);
}

/** Validate and build a self/manual mark from per-point awards. Marks are clamped to what each point is worth. */
export function markWithRubric(q: QuestionRow, awarded: Record<string, number>, by: Grade['by'] = 'self', comment?: string, now = Date.now()): Grade {
  const items = q.rubric.map((p) => ({ pointId: p.id, awarded: round2(Math.min(p.marks, Math.max(0, Number.isFinite(awarded[p.id]) ? awarded[p.id]! : 0))) }));
  const total = Math.min(q.marks, items.reduce((n, i) => n + i.awarded, 0));
  return { marks: round2(total), max: q.marks, items, ...(comment ? { comment } : {}), by, uncertain: true, gradedAt: now };
}

/** Mark a question that has no marking points by typing the marks directly. */
export function markManual(q: QuestionRow, marks: number, comment?: string, now = Date.now()): Grade {
  const m = Math.min(q.marks, Math.max(0, Number.isFinite(marks) ? marks : 0));
  return { marks: round2(m), max: q.marks, items: [], ...(comment ? { comment } : {}), by: 'manual', uncertain: true, gradedAt: now };
}

export interface PointHint {
  pointId: string;
  status: 'likely' | 'unclear' | 'missing';
  matched: string[];
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'which', 'their', 'there', 'about', 'would', 'should', 'could', 'where', 'when', 'what', 'into', 'than', 'then', 'also', 'such', 'these', 'those', 'being', 'because']);

/**
 * Suggestions for self-marking: does the answer mention each marking point's keywords (or, without
 * keywords, most of the point's own distinctive words)? This is a hint to speed up your marking,
 * never a mark: equivalent wording will be missed and lucky keywords will be over-credited.
 */
export function keywordHints(q: QuestionRow, answer: string): PointHint[] {
  const text = answer.toLowerCase();
  const answerWords = new Set((text.match(WORD) ?? []).map((w) => w.replace(/s$/, '')));
  return q.rubric.map((p) => {
    if (p.keywords && p.keywords.length > 0) {
      const matched = p.keywords.filter((k) => text.includes(k.toLowerCase()));
      return { pointId: p.id, matched, status: matched.length === p.keywords.length ? 'likely' : matched.length > 0 ? 'unclear' : 'missing' };
    }
    const words = [...new Set((p.text.toLowerCase().match(WORD) ?? []).filter((w) => w.length >= 5 && !STOP.has(w)))];
    if (words.length === 0) return { pointId: p.id, matched: [], status: 'unclear' };
    const matched = words.filter((w) => answerWords.has(w.replace(/s$/, '')));
    const share = matched.length / words.length;
    return { pointId: p.id, matched, status: share >= 0.6 ? 'likely' : share >= 0.3 ? 'unclear' : 'missing' };
  });
}

export function wordCount(text: string | undefined): number {
  return (text?.match(WORD) ?? []).length;
}

/** "Aim for 20–60 words; you have 12." (undefined when the question gives no expected length) */
export function lengthAdvice(q: Pick<QuestionRow, 'expectedWords'>, text: string | undefined): { words: number; message: string; ok: boolean } | undefined {
  if (!q.expectedWords) return undefined;
  const [lo, hi] = q.expectedWords;
  const words = wordCount(text);
  if (words === 0) return { words, ok: false, message: `Aim for ${lo}–${hi} words.` };
  if (words < lo) return { words, ok: false, message: `${words} words so far. Aim for ${lo}–${hi}.` };
  if (words > hi) return { words, ok: false, message: `${words} words. That is long; the expected length is ${lo}–${hi}.` };
  return { words, ok: true, message: `${words} words (expected ${lo}–${hi}).` };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type QuestionOutcome = 'full' | 'partial' | 'zero' | 'pending' | 'unanswered';

export interface QuestionResult {
  question: QuestionRow;
  grade?: Grade;
  earned: number;
  max: number;
  outcome: QuestionOutcome;
  answered: boolean;
}

export interface TopicScore {
  topic: string;
  earned: number;
  max: number;
  questions: number;
  percent: number;
}

export interface AttemptScore {
  results: QuestionResult[];
  earned: number;
  /** Marks available over all questions. */
  max: number;
  /** Marks available over questions that have been marked so far. */
  maxMarked: number;
  pending: number;
  /** True when every question has a mark, so the total is final (for this marker). */
  complete: boolean;
  /** Percentage of all available marks (pending questions count as zero until marked). */
  percent: number;
  topics: TopicScore[];
}

export function hasAnswer(a: AnswerState | undefined): boolean {
  return !!a && ((a.text?.trim().length ?? 0) > 0 || (a.optionIds?.length ?? 0) > 0);
}

export function scoreAttempt(questions: QuestionRow[], attempt: Pick<AttemptRow, 'answers' | 'grades'>): AttemptScore {
  const results: QuestionResult[] = questions.map((q) => {
    const grade = attempt.grades[q.id];
    const answered = hasAnswer(attempt.answers[q.id]);
    let outcome: QuestionOutcome;
    if (grade) outcome = grade.marks >= q.marks - 0.001 ? 'full' : grade.marks > 0 ? 'partial' : 'zero';
    else outcome = answered ? 'pending' : 'unanswered';
    return { question: q, ...(grade ? { grade } : {}), earned: grade?.marks ?? 0, max: q.marks, outcome, answered };
  });
  const earned = round2(results.reduce((n, r) => n + r.earned, 0));
  const max = round2(results.reduce((n, r) => n + r.max, 0));
  const marked = results.filter((r) => r.grade || r.outcome === 'unanswered');
  const pending = results.filter((r) => r.outcome === 'pending').length;
  const byTopic = new Map<string, TopicScore>();
  for (const r of results) {
    if (r.outcome === 'pending') continue;
    const topic = r.question.topic?.trim() || 'General';
    const t = byTopic.get(topic) ?? { topic, earned: 0, max: 0, questions: 0, percent: 0 };
    t.earned += r.earned;
    t.max += r.max;
    t.questions += 1;
    byTopic.set(topic, t);
  }
  const topics = [...byTopic.values()].map((t) => ({ ...t, earned: round2(t.earned), max: round2(t.max), percent: t.max ? Math.round((t.earned / t.max) * 100) : 0 })).sort((a, b) => a.percent - b.percent);
  return { results, earned, max, maxMarked: round2(marked.reduce((n, r) => n + r.max, 0)), pending, complete: pending === 0, percent: max ? Math.round((earned / max) * 100) : 0, topics };
}

/** Topics you keep losing marks on across all submitted attempts (needs at least `minQuestions` marked questions). */
export function weakTopics(attempts: AttemptRow[], questionsById: Map<string, QuestionRow>, minQuestions = 2, threshold = 60): TopicScore[] {
  const agg = new Map<string, TopicScore>();
  for (const a of attempts) {
    if (a.status !== 'submitted') continue;
    for (const [qid, g] of Object.entries(a.grades)) {
      const q = questionsById.get(qid);
      if (!q) continue;
      const topic = q.topic?.trim() || 'General';
      const t = agg.get(topic) ?? { topic, earned: 0, max: 0, questions: 0, percent: 0 };
      t.earned += g.marks;
      t.max += q.marks;
      t.questions += 1;
      agg.set(topic, t);
    }
  }
  return [...agg.values()]
    .filter((t) => t.questions >= minQuestions)
    .map((t) => ({ ...t, earned: round2(t.earned), max: round2(t.max), percent: t.max ? Math.round((t.earned / t.max) * 100) : 0 }))
    .filter((t) => t.percent < threshold)
    .sort((a, b) => a.percent - b.percent);
}

/** Ids of questions that did not earn full marks (for "repeat missed questions"). */
export function missedQuestionIds(score: AttemptScore): string[] {
  return score.results.filter((r) => r.outcome === 'zero' || r.outcome === 'partial' || r.outcome === 'unanswered').map((r) => r.question.id);
}

