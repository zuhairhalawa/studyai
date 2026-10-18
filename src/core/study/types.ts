import { z } from 'zod';
import { idStr } from '../db/schemas';

/**
 * Learning-engine data: notes, flashcards, questions, exams, attempts, activity.
 * The same schemas validate (a) rows read back from backups and (b) items imported from study packs.
 * Every item carries `sources` (lecture + slide + optional verbatim quote) and a `basis` that says
 * how well the lecture supports it — the four-way distinction required for trustworthy answers.
 */

const num = z.number();
const int = z.number().int();
const str = (max = 20_000) => z.string().max(max);

export const ORIGINS = ['user', 'imported', 'auto', 'ai'] as const;
/** Who/what produced an item: you, a study pack, a local rule-based extractor, or an AI call. */
export type Origin = (typeof ORIGINS)[number];

export const BASES = ['lecture', 'derived', 'outside', 'uncertain'] as const;
/**
 * lecture   = stated on the slides
 * derived   = a reasonable explanation derived from the slides
 * outside   = extra knowledge added for understanding (not on the slides)
 * uncertain = unsupported or unsure — treat with care
 */
export type Basis = (typeof BASES)[number];

export const BASIS_LABEL: Record<Basis, string> = {
  lecture: 'On the slides',
  derived: 'Derived from the slides',
  outside: 'Outside knowledge',
  uncertain: 'Uncertain',
};

export const STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof STATUSES)[number];

export const sourceRefSchema = z.object({
  lectureId: idStr,
  slide: int.min(1).max(100_000),
  elementId: str(200).optional(),
  /** Verbatim text from the slide that supports the item. */
  quote: str(1_000).optional(),
  /** Lecture revision the reference was made against (slides can move when a lecture is replaced). */
  rev: int.optional(),
  /** Result of checking `quote` against the slide text; undefined = not checked. */
  verified: z.boolean().optional(),
});
export type SourceRefRow = z.infer<typeof sourceRefSchema>;

// ---------------------------------------------------------------------------
// Flashcards
// ---------------------------------------------------------------------------

export const CARD_TYPES = ['definition', 'concept', 'formula', 'comparison', 'qa', 'scenario', 'code', 'proof'] as const;
export type CardType = (typeof CARD_TYPES)[number];
export const CARD_TYPE_LABEL: Record<CardType, string> = {
  definition: 'Definition',
  concept: 'Key concept',
  formula: 'Formula',
  comparison: 'Comparison',
  qa: 'Question and answer',
  scenario: 'Scenario',
  code: 'Code reading',
  proof: 'Proof step',
};

/** FSRS scheduling state (all dates as epoch milliseconds so it serialises cleanly). */
export const schedulerSchema = z.object({
  due: num,
  stability: num,
  difficulty: num,
  scheduledDays: num,
  learningSteps: int,
  reps: int,
  lapses: int,
  /** 0 New, 1 Learning, 2 Review, 3 Relearning */
  state: int.min(0).max(3),
  lastReview: num.optional(),
});
export type SchedulerState = z.infer<typeof schedulerSchema>;

export const cardSchema = z.object({
  id: idStr,
  courseId: idStr,
  lectureId: idStr.optional(),
  type: z.enum(CARD_TYPES),
  front: str(),
  back: str(),
  tags: z.array(str(60)).max(30),
  deck: str(100).optional(),
  basis: z.enum(BASES),
  sources: z.array(sourceRefSchema).max(20),
  origin: z.enum(ORIGINS),
  status: z.enum(STATUSES),
  createdAt: num,
  updatedAt: num,
  packId: idStr.optional(),
  fsrs: schedulerSchema,
});
export type CardRow = z.infer<typeof cardSchema>;

export const reviewLogSchema = z.object({
  id: idStr,
  cardId: idStr,
  courseId: idStr,
  at: num,
  /** 1 Again, 2 Hard, 3 Good, 4 Easy */
  rating: int.min(1).max(4),
  stateBefore: int.min(0).max(3),
  durationMs: num,
});
export type ReviewLogRow = z.infer<typeof reviewLogSchema>;

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const NOTE_KINDS = ['lecture-notes', 'summary', 'revision-sheet', 'definitions', 'formulas', 'comparison', 'mistakes', 'worked-example', 'last-minute', 'custom'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  'lecture-notes': 'Lecture notes',
  summary: 'Topic summary',
  'revision-sheet': 'Quick revision sheet',
  definitions: 'Important definitions',
  formulas: 'Formula sheet',
  comparison: 'Comparison table',
  mistakes: 'Common mistakes',
  'worked-example': 'Worked examples',
  'last-minute': 'Last-minute revision',
  custom: 'My notes',
};

export const noteBlockSchema = z.object({
  id: idStr,
  /** Markdown (with $…$ / $$…$$ maths). */
  text: str(200_000),
  /** Blocks keep their origin so your own edits are never confused with generated material. */
  origin: z.enum(ORIGINS),
  basis: z.enum(BASES),
  sources: z.array(sourceRefSchema).max(20),
  updatedAt: num,
});
export type NoteBlock = z.infer<typeof noteBlockSchema>;

export const noteSchema = z.object({
  id: idStr,
  courseId: idStr,
  lectureId: idStr.optional(),
  title: str(300),
  kind: z.enum(NOTE_KINDS),
  blocks: z.array(noteBlockSchema).max(2_000),
  createdAt: num,
  updatedAt: num,
  packId: idStr.optional(),
});
export type NoteRow = z.infer<typeof noteSchema>;

// ---------------------------------------------------------------------------
// Questions, exams, attempts
// ---------------------------------------------------------------------------

export const QUESTION_TYPES = [
  'mcq',
  'truefalse',
  'short',
  'long',
  'scenario',
  'case',
  'compare',
  'define',
  'problem',
  'calculation',
  'algorithm',
  'programming',
  'proof',
  'diagram',
  'attack',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  mcq: 'Multiple choice',
  truefalse: 'True or false',
  short: 'Short answer',
  long: 'Long answer',
  scenario: 'Scenario',
  case: 'Case study',
  compare: 'Compare and contrast',
  define: 'Define and explain',
  problem: 'Problem solving',
  calculation: 'Calculation',
  algorithm: 'Algorithm / pseudocode',
  programming: 'Programming',
  proof: 'Proof or reasoning',
  diagram: 'Diagram interpretation',
  attack: 'Attack and countermeasure',
};

/** Types that can be marked automatically. */
export const OBJECTIVE_TYPES: QuestionType[] = ['mcq', 'truefalse'];

/** Question types answered in code or pseudocode (shown in a monospace box). */
export const TYPE_NEEDS_CODE_LABELLED: QuestionType[] = ['programming', 'algorithm'];

export const rubricPointSchema = z.object({
  id: idStr,
  /** What a full-marks answer must contain. */
  text: str(2_000),
  marks: num.min(0).max(1_000),
  /** Optional words/phrases that suggest the point is covered (a hint for self-marking, never a verdict). */
  keywords: z.array(str(100)).max(20).optional(),
});
export type RubricPoint = z.infer<typeof rubricPointSchema>;

export const questionSchema = z.object({
  id: idStr,
  courseId: idStr,
  type: z.enum(QUESTION_TYPES),
  prompt: str(),
  marks: num.min(0.5).max(1_000),
  difficulty: int.min(1).max(3),
  topic: str(300).optional(),
  lectureIds: z.array(idStr).max(50),
  options: z.array(z.object({ id: idStr, text: str(2_000), correct: z.boolean() })).max(12).optional(),
  modelAnswer: str().optional(),
  rubric: z.array(rubricPointSchema).max(50),
  expectedWords: z.tuple([int.min(0), int.min(0)]).optional(),
  hint: str(2_000).optional(),
  basis: z.enum(BASES),
  sources: z.array(sourceRefSchema).max(20),
  origin: z.enum(ORIGINS),
  status: z.enum(STATUSES),
  createdAt: num,
  updatedAt: num,
  packId: idStr.optional(),
});
export type QuestionRow = z.infer<typeof questionSchema>;

export const examConfigSchema = z.object({
  title: str(300),
  lectureIds: z.array(idStr).max(200),
  topics: z.array(str(300)).max(200),
  count: int.min(1).max(200),
  types: z.array(z.enum(QUESTION_TYPES)).max(20),
  difficulty: z.union([z.literal('mixed'), z.literal(1), z.literal(2), z.literal(3)]),
  /** When set, questions are chosen to come as close as possible to this total. */
  totalMarks: num.min(1).max(10_000).optional(),
  minutes: num.min(1).max(1_000).optional(),
  hints: z.boolean(),
  /** Show correct answers straight after each question, or only after submission. */
  reveal: z.enum(['immediate', 'after']),
  layout: z.enum(['one', 'paper']),
  /** Exam conditions: no hints, no pausing, no peeking at answers. */
  conditions: z.boolean(),
});
export type ExamConfig = z.infer<typeof examConfigSchema>;

export const examSchema = z.object({
  id: idStr,
  courseId: idStr,
  config: examConfigSchema,
  questionIds: z.array(idStr).max(500),
  createdAt: num,
});
export type ExamRow = z.infer<typeof examSchema>;

export const answerSchema = z.object({
  text: str(200_000).optional(),
  optionIds: z.array(idStr).max(12).optional(),
  hintUsed: z.boolean().optional(),
  timeMs: num,
});
export type AnswerState = z.infer<typeof answerSchema>;

export const gradeSchema = z.object({
  marks: num,
  max: num,
  items: z.array(z.object({ pointId: idStr, awarded: num })).max(50),
  comment: str(5_000).optional(),
  by: z.enum(['auto', 'self', 'manual', 'ai']),
  /** Subjective marking is never exact; say so. */
  uncertain: z.boolean().optional(),
  gradedAt: num,
});
export type Grade = z.infer<typeof gradeSchema>;

export const attemptSchema = z.object({
  id: idStr,
  examId: idStr,
  courseId: idStr,
  startedAt: num,
  submittedAt: num.optional(),
  /** Time already spent, so a resumed attempt continues the clock. */
  elapsedMs: num,
  status: z.enum(['in-progress', 'submitted']),
  /** Keys are question ids. */
  answers: z.record(z.string(), answerSchema),
  grades: z.record(z.string(), gradeSchema),
  flagged: z.array(idStr).max(500),
});
export type AttemptRow = z.infer<typeof attemptSchema>;

// ---------------------------------------------------------------------------
// Activity and packs
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ['slides', 'review', 'exam', 'notes'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const activitySchema = z.object({
  id: int.optional(),
  at: num,
  kind: z.enum(ACTIVITY_KINDS),
  courseId: idStr,
  lectureId: idStr.optional(),
  count: int.min(0).max(100_000),
});
export type ActivityRow = z.infer<typeof activitySchema>;

export const packRowSchema = z.object({
  id: idStr,
  courseId: idStr,
  name: str(300),
  generator: str(300).optional(),
  importedAt: num,
  counts: z.object({ notes: int, cards: int, questions: int }),
});
export type PackRow = z.infer<typeof packRowSchema>;

/** Tables added in schema v2, with the schema that validates each row (used by backup/restore). */
// ---------------------------------------------------------------------------
// AI tutor chats (stored only on this device)
// ---------------------------------------------------------------------------

export const TUTOR_MODES = ['explain', 'steps', 'exam', 'socratic', 'quiz', 'summary', 'compare', 'mistakes'] as const;

export const tutorSessionSchema = z.object({
  id: idStr,
  courseId: idStr,
  title: str(300),
  mode: z.enum(TUTOR_MODES),
  createdAt: num,
  updatedAt: num,
});
export type TutorSessionRow = z.infer<typeof tutorSessionSchema>;

export const tutorMessageSchema = z.object({
  id: idStr,
  sessionId: idStr,
  courseId: idStr,
  role: z.enum(['user', 'assistant']),
  /** For the assistant: the answer without the machine-readable BASIS / FOLLOWUPS lines. */
  text: str(60_000),
  createdAt: num,
  /** Assistant only: how well the slides support the answer (checked against the citations, see parseTutorReply). */
  basis: z.enum(BASES).optional(),
  /** Assistant only: the slides the answer cites (only labels that were really sent). */
  sources: z.array(sourceRefSchema).max(40).optional(),
  followups: z.array(str(200)).max(3).optional(),
  /** Assistant only: the answer stopped at the length limit, so its end is missing. */
  truncated: z.boolean().optional(),
  /** Assistant only: wording the answer put in quotation marks that is on none of the slides that were sent. */
  quoteWarnings: z.array(str(300)).max(5).optional(),
  /** User only: what was sent along with the question, for the "what was sent" record. */
  sent: z.object({ slides: int.min(0).max(1_000), chars: int.min(0).max(1_000_000), mode: z.enum(TUTOR_MODES) }).optional(),
  /** Assistant only: the shadow cost the server reported (dollars), for the usage display. */
  shadowCostUsd: num.optional(),
  /** A failed request is kept in the thread with its plain-language reason. */
  error: str(500).optional(),
});
export type TutorMessageRow = z.infer<typeof tutorMessageSchema>;

export const STUDY_TABLE_SCHEMAS = {
  notes: noteSchema,
  cards: cardSchema,
  reviews: reviewLogSchema,
  questions: questionSchema,
  exams: examSchema,
  attempts: attemptSchema,
  activity: activitySchema,
  packs: packRowSchema,
  tutorSessions: tutorSessionSchema,
  tutorMessages: tutorMessageSchema,
} as const;
export type StudyTable = keyof typeof STUDY_TABLE_SCHEMAS;
export const STUDY_TABLES = Object.keys(STUDY_TABLE_SCHEMAS) as StudyTable[];
