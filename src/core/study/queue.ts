import { isDifficult } from './fsrs';
import type { CardRow, ReviewLogRow } from './types';

const DAY = 86_400_000;

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface QueueOptions {
  now: number;
  /** Maximum brand-new cards introduced per day. */
  newPerDay: number;
  /** New cards already introduced today (from the review log). */
  newToday: number;
  limit?: number;
}

/**
 * Cards to study right now, in this order:
 *   1. learning / relearning cards whose short step has elapsed (earliest first),
 *   2. review cards that are due (most overdue first),
 *   3. new cards, up to the remaining daily allowance (oldest first).
 * Only *approved* cards are ever studied: pending/rejected cards never enter the queue.
 */
export function buildQueue(cards: CardRow[], o: QueueOptions): CardRow[] {
  const ok = cards.filter((c) => c.status === 'approved');
  const learning = ok.filter((c) => (c.fsrs.state === 1 || c.fsrs.state === 3) && c.fsrs.due <= o.now).sort((a, b) => a.fsrs.due - b.fsrs.due);
  const review = ok.filter((c) => c.fsrs.state === 2 && c.fsrs.due <= o.now).sort((a, b) => a.fsrs.due - b.fsrs.due);
  const allowance = Math.max(0, o.newPerDay - o.newToday);
  const fresh = ok.filter((c) => c.fsrs.state === 0).sort((a, b) => a.createdAt - b.createdAt).slice(0, allowance);
  const all = [...learning, ...review, ...fresh];
  return o.limit ? all.slice(0, o.limit) : all;
}

/** When the next not-yet-due card will become available (for "come back in 8 minutes"). */
export function nextDueAt(cards: CardRow[], now: number): number | undefined {
  const upcoming = cards.filter((c) => c.status === 'approved' && c.fsrs.state !== 0 && c.fsrs.due > now).map((c) => c.fsrs.due);
  return upcoming.length ? Math.min(...upcoming) : undefined;
}

export interface CardStats {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
  newCards: number;
  learning: number;
  review: number;
  /** Cards that would be offered right now (ignoring the daily new-card limit). */
  dueNow: number;
  difficult: number;
  reviewedToday: number;
  newToday: number;
  /** Share of reviews in the last 30 days answered Good or Easy; undefined with no reviews. */
  accuracy30d: number | undefined;
  reviews30d: number;
}

export function cardStats(cards: CardRow[], reviews: ReviewLogRow[], now: number): CardStats {
  const approved = cards.filter((c) => c.status === 'approved');
  const today = startOfDay(now);
  const recent = reviews.filter((r) => r.at >= now - 30 * DAY);
  const correct = recent.filter((r) => r.rating >= 3).length;
  return {
    total: cards.length,
    approved: approved.length,
    pending: cards.filter((c) => c.status === 'pending').length,
    rejected: cards.filter((c) => c.status === 'rejected').length,
    newCards: approved.filter((c) => c.fsrs.state === 0).length,
    learning: approved.filter((c) => c.fsrs.state === 1 || c.fsrs.state === 3).length,
    review: approved.filter((c) => c.fsrs.state === 2).length,
    dueNow: approved.filter((c) => c.fsrs.state !== 0 && c.fsrs.due <= now).length,
    difficult: approved.filter((c) => isDifficult(c.fsrs)).length,
    reviewedToday: reviews.filter((r) => r.at >= today).length,
    newToday: reviews.filter((r) => r.at >= today && r.stateBefore === 0).length,
    accuracy30d: recent.length ? correct / recent.length : undefined,
    reviews30d: recent.length,
  };
}
