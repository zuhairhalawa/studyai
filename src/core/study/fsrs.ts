import { createEmptyCard, fsrs, generatorParameters, type Card, type FSRS, type Grade, type State } from 'ts-fsrs';
import type { SchedulerState } from './types';

/**
 * Spaced repetition: FSRS (Free Spaced Repetition Scheduler), via the MIT-licensed `ts-fsrs`
 * reference implementation (FSRS-5 with its default, research-derived parameters).
 *
 *  - Each review answers "how well did I remember?" as 1 Again · 2 Hard · 3 Good · 4 Easy.
 *  - FSRS models memory with *stability* (days until recall probability drops to 90 %),
 *    *difficulty* and *retrievability* (current recall probability), and schedules the next
 *    review so that retrievability is about the requested retention (default 90 %).
 *  - New/lapsed cards pass through short learning steps (1 min, 10 min) first.
 * This wrapper stores state as plain numbers (epoch ms) so it round-trips through JSON backups.
 */

export type Rating = 1 | 2 | 3 | 4;
const DAY = 86_400_000;

export interface SchedulerOptions {
  /** Target probability of remembering when a card comes due. */
  retention?: number;
  /** Random ±spread on long intervals so cards learned together do not all fall due together. */
  fuzz?: boolean;
  maxIntervalDays?: number;
}

export function createScheduler(o: SchedulerOptions = {}): FSRS {
  return fsrs(generatorParameters({ request_retention: o.retention ?? 0.9, enable_fuzz: o.fuzz ?? true, maximum_interval: o.maxIntervalDays ?? 365 }));
}

const shared = createScheduler();

function toCard(s: SchedulerState): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.lastReview ? Math.max(0, Math.floor((s.due - s.lastReview) / DAY)) : 0,
    scheduled_days: s.scheduledDays,
    learning_steps: s.learningSteps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state as State,
    ...(s.lastReview ? { last_review: new Date(s.lastReview) } : {}),
  };
}

function fromCard(c: Card): SchedulerState {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as 0 | 1 | 2 | 3,
    ...(c.last_review ? { lastReview: c.last_review.getTime() } : {}),
  };
}

/** Scheduler state for a brand-new card (due immediately). */
export function newSchedulerState(now = Date.now()): SchedulerState {
  return fromCard(createEmptyCard(new Date(now)));
}

export function reviewCard(state: SchedulerState, rating: Rating, now = Date.now(), scheduler: FSRS = shared): SchedulerState {
  return fromCard(scheduler.next(toCard(state), new Date(now), rating as Grade).card);
}

/** What each answer button would do (next due time), for showing "Good · 3 days" on the buttons. */
export function previewReview(state: SchedulerState, now = Date.now(), scheduler: FSRS = shared): Record<Rating, { due: number; label: string }> {
  const rec = scheduler.repeat(toCard(state), new Date(now));
  const out = {} as Record<Rating, { due: number; label: string }>;
  for (const r of [1, 2, 3, 4] as const) {
    const due = rec[r as Grade].card.due.getTime();
    out[r] = { due, label: intervalLabel(due - now) };
  }
  return out;
}

/** Probability (0..1) of recalling the card right now; undefined for cards never reviewed. */
export function retrievability(state: SchedulerState, now = Date.now(), scheduler: FSRS = shared): number | undefined {
  if (state.state === 0 || !state.lastReview) return undefined;
  return scheduler.get_retrievability(toCard(state), new Date(now), false);
}

export function intervalLabel(ms: number): string {
  const m = ms / 60_000;
  if (m < 1) return '<1m';
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

/** A card counts as "difficult" when FSRS rates it hard to remember or it has lapsed repeatedly. */
export function isDifficult(s: SchedulerState): boolean {
  return s.state !== 0 && (s.difficulty >= 8 || s.lapses >= 3);
}
