import { z } from 'zod';
import { QUESTION_TYPES, TUTOR_MODES } from '../study/types';

/**
 * The only requests the AI endpoints accept. The browser sends structured data; the SERVER turns it into the prompt
 * (prompts.ts), picks the model and the output cap, and applies the budget guard. The browser can never supply a system
 * prompt, a model, a tool or an output length.
 */

export { TUTOR_MODES };
export type TutorMode = (typeof TUTOR_MODES)[number];

export const TUTOR_MODE_LABEL: Record<TutorMode, string> = {
  explain: 'Explain simply',
  steps: 'Step by step',
  exam: 'How to answer in an exam',
  socratic: 'Guide me with questions',
  quiz: 'Quiz me',
  summary: 'Summarise',
  compare: 'Compare and contrast',
  mistakes: 'Common mistakes',
};

/** Hard limits (characters). They keep one request well inside the guard's input limit and the free tokens-per-minute quota. */
export const LIMITS = {
  question: 4_000,
  excerptText: 8_000,
  excerpts: 30,
  excerptsTotal: 60_000,
  historyMessage: 6_000,
  historyMessages: 10,
  historyTotal: 24_000,
  examStyle: 2_000,
  name: 200,
  answer: 20_000,
  lectureMarkdown: 80_000,
} as const;

const short = (max: number) => z.string().max(max);

export const ExcerptSchema = z
  .object({
    /** "S1", "S2", … — the label the model must cite. The browser maps it back to a lecture and slide. */
    ref: z.string().regex(/^S\d{1,3}$/),
    lectureTitle: short(LIMITS.name),
    /** Slide number; 0 for a note (see `kind`). */
    slide: z.number().int().min(0).max(10_000),
    /** "note" = one of the student's own notes (not the professor's material). */
    kind: z.enum(['slide', 'note']).optional(),
    title: short(LIMITS.name),
    text: short(LIMITS.excerptText),
  })
  .strict();
export type Excerpt = z.infer<typeof ExcerptSchema>;

const Turn = z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(LIMITS.historyMessage) }).strict();

export const TutorRequestSchema = z
  .object({
    task: z.literal('tutor'),
    mode: z.enum(TUTOR_MODES),
    question: z.string().min(1).max(LIMITS.question),
    excerpts: z.array(ExcerptSchema).min(1).max(LIMITS.excerpts),
    history: z.array(Turn).max(LIMITS.historyMessages),
    courseName: short(LIMITS.name).optional(),
    examStyle: short(LIMITS.examStyle).optional(),
    /** Facts the app found about the slides being sent (see gaps.ts): a heading with no content, an unread picture, … */
    gaps: z.array(short(300)).max(12).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const total = v.excerpts.reduce((n, e) => n + e.text.length, 0);
    if (total > LIMITS.excerptsTotal) ctx.addIssue({ code: 'custom', message: 'The selected slides contain too much text for one question.' });
    if (v.history.reduce((n, h) => n + h.text.length, 0) > LIMITS.historyTotal) ctx.addIssue({ code: 'custom', message: 'The conversation is too long; start a new chat.' });
    const refs = new Set(v.excerpts.map((e) => e.ref));
    if (refs.size !== v.excerpts.length) ctx.addIssue({ code: 'custom', message: 'Duplicate slide labels.' });
  });
export type TutorRequest = z.infer<typeof TutorRequestSchema>;

/** One planned question (see blueprint.ts). The browser sends the plan as data; the server turns it into the prompt. */
export const PlannedQuestionSchema = z
  .object({
    type: z.enum(QUESTION_TYPES),
    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    marks: z.number().min(0.5).max(20),
    points: z.number().int().min(1).max(8),
    topic: short(LIMITS.name),
    slides: z.array(z.number().int().min(1).max(10_000)).min(1).max(8),
  })
  .strict();

export const GenerateRequestSchema = z
  .object({
    task: z.literal('generate'),
    /** `lectureToMarkdown()` output for the chosen lectures (slide numbers kept so the model can cite them). */
    lectureMarkdown: z.string().min(20).max(LIMITS.lectureMarkdown),
    wants: z.object({ notes: z.boolean(), cards: z.boolean(), questions: z.boolean() }).strict(),
    amount: z.enum(['few', 'normal', 'many']),
    examStyle: short(LIMITS.examStyle).optional(),
    /** The questions to write, planned on the device: type, difficulty, marks, marking points, topic and slides for each. */
    blueprint: z.array(PlannedQuestionSchema).min(1).max(12).optional(),
    /** Questions that already exist, so the model does not repeat them. */
    alreadyAsked: z.array(short(240)).max(40).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.blueprint && !v.wants.questions) ctx.addIssue({ code: 'custom', message: 'A question plan needs questions to be wanted.' });
  });
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export const GradeRequestSchema = z
  .object({
    task: z.literal('grade'),
    question: z
      .object({
        type: z.enum(QUESTION_TYPES),
        prompt: short(10_000),
        marks: z.number().min(0.5).max(1_000),
        modelAnswer: short(10_000).optional(),
        rubric: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, 'A marking point id may only use letters, digits, - and _.'), text: short(2_000), marks: z.number().min(0).max(1_000) }).strict()).min(1).max(30),
      })
      .strict(),
    answer: z.string().max(LIMITS.answer),
    /** Slide text the question came from (optional; helps the grader stay faithful to the lecture). */
    excerpts: z.array(ExcerptSchema).max(6).optional(),
  })
  .strict();
export type GradeRequest = z.infer<typeof GradeRequestSchema>;

/** Questions whose marking points are to be checked against what each question asks (see study/audit.ts). */
export const AuditRequestSchema = z
  .object({
    task: z.literal('audit'),
    questions: z
      .array(
        z
          .object({
            n: z.number().int().min(1).max(5_000),
            type: z.enum(QUESTION_TYPES),
            prompt: short(4_000),
            marks: z.number().min(0.5).max(1_000),
            rubric: z.array(z.object({ text: short(600), marks: z.number().min(0).max(1_000) }).strict()).min(1).max(12),
            modelAnswer: short(3_000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export type AuditRequest = z.infer<typeof AuditRequestSchema>;

export const AiTaskSchema = z.discriminatedUnion('task', [TutorRequestSchema, GenerateRequestSchema, GradeRequestSchema, AuditRequestSchema]);
export type AiTask = z.infer<typeof AiTaskSchema>;

/** What every AI endpoint answers with (also used for refusals). */
export type AiReply =
  | { ok: true; text: string; costIsEstimate: boolean; shadowCostUsd: number; remainingDayUsd: number; remainingMonthUsd: number; /** The model hit its output cap: the text is cut off. */ truncated?: boolean }
  | { ok: false; code: string; message: string; reasons?: string[] };

/** Owner-facing status shown in Settings. Billing facts are attestations, never verification. */
export const ATTEST_NAMES = ['projectHasNoBilling', 'modelsFreeOfCharge', 'acceptsFreeTierDataUse', 'observedFreeLimits', 'firstRequestApproved'] as const;
export type AttestName = (typeof ATTEST_NAMES)[number];

export interface OwnerStatus {
  /** off · ready · low · paused · unknown (see AiStatus) */
  state: 'off' | 'ready' | 'low' | 'paused' | 'unknown';
  reasons: string[];
  enabled: boolean;
  keyPresent: boolean;
  model: string;
  models: string[];
  budgets: { dailyUsd: number; monthlyUsd: number };
  limits: { maxInputTokens: number; maxOutputTokens: number; maxRequestsPerDay: number; maxRequestsPerMonth: number; maxConcurrent: number; requestTimeoutMs: number; maxUnresolved: number };
  attestations: Partial<Record<AttestName, { confirmedAt: string }>>;
  observedFreeLimits?: { requestsPerDay: number; requestsPerMinute: number; tokensPerMinute: number };
  spentDayUsd?: number;
  spentMonthUsd?: number;
  remainingDayUsd?: number;
  remainingMonthUsd?: number;
  requestsToday?: number;
  unresolved?: { id: string; amountUsd: number; reason: string }[];
  billing: 'owner-attestation-required' | 'owner-attested-not-verified';
}
