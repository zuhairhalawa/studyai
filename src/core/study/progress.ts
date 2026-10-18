import type { CourseRow, LectureRow, StudyDB } from '../db/db';
import { weakTopics, type TopicScore } from './exam';
import { startOfDay } from './queue';
import type { ActivityRow, AttemptRow, CardRow, ExamRow, QuestionRow, ReviewLogRow } from './types';

const MIN = 60_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Recording what you actually studied
// ---------------------------------------------------------------------------

export const viewedKey = (lectureId: string): string => `viewed:${lectureId}`;

/**
 * Record that a slide was looked at long enough to count (the lecture page waits a few seconds
 * first, so flicking through slides does not count as reading them). Slides are stored as a sorted
 * list per lecture, and nearby views are merged into one activity row so "recent sessions" stays compact.
 */
export async function recordSlideView(db: StudyDB, courseId: string, lectureId: string, slide: number, now = Date.now()): Promise<void> {
  await db.transaction('rw', [db.settings, db.activity], async () => {
    const key = viewedKey(lectureId);
    const row = await db.settings.get(key);
    const seen = new Set<number>(Array.isArray(row?.value) ? (row!.value as number[]) : []);
    const isNew = !seen.has(slide);
    if (isNew) {
      seen.add(slide);
      await db.settings.put({ key, value: [...seen].sort((a, b) => a - b) });
    }
    const recent = (await db.activity.where('courseId').equals(courseId).toArray()).filter((a) => a.kind === 'slides' && a.lectureId === lectureId && now - a.at < 10 * MIN).sort((a, b) => b.at - a.at)[0];
    if (recent?.id !== undefined) await db.activity.update(recent.id, { at: now, count: recent.count + 1 });
    else await db.activity.add({ at: now, kind: 'slides', courseId, lectureId, count: 1 });
  });
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface LectureProgress {
  viewed: number;
  total: number;
  percent: number;
}

export function lectureProgress(lecture: Pick<LectureRow, 'slideCount'>, viewed: number[] | undefined): LectureProgress {
  const total = lecture.slideCount;
  const v = new Set((viewed ?? []).filter((n) => n >= 1 && n <= total)).size;
  return { viewed: v, total, percent: total ? Math.round((v / total) * 100) : 0 };
}

export interface TopicProgress {
  id: string;
  title: string;
  startSlide: number;
  endSlide: number;
  viewed: number;
  total: number;
  done: boolean;
}

/** How much of each detected topic has been studied (a topic is "done" when every one of its slides was viewed). */
export function topicProgress(lecture: Pick<LectureRow, 'report'>, viewed: number[] | undefined): TopicProgress[] {
  const seen = new Set(viewed ?? []);
  return lecture.report.topics.map((t) => {
    let v = 0;
    for (let s = t.startSlide; s <= t.endSlide; s++) if (seen.has(s)) v += 1;
    const total = t.endSlide - t.startSlide + 1;
    return { id: t.id, title: t.title, startSlide: t.startSlide, endSlide: t.endSlide, viewed: v, total, done: v === total };
  });
}

// ---------------------------------------------------------------------------
// Study sessions (derived, never stored)
// ---------------------------------------------------------------------------

export interface StudySession {
  start: number;
  end: number;
  courseId: string;
  reviews: number;
  slides: number;
  exams: number;
}

/** Group activity into sessions: events of one course less than `gapMs` apart belong together. */
export function deriveSessions(input: { reviews: ReviewLogRow[]; activity: ActivityRow[]; attempts: AttemptRow[] }, gapMs = 30 * MIN): StudySession[] {
  type Ev = { at: number; courseId: string; reviews: number; slides: number; exams: number };
  const events: Ev[] = [
    ...input.reviews.map((r) => ({ at: r.at, courseId: r.courseId, reviews: 1, slides: 0, exams: 0 })),
    ...input.activity.filter((a) => a.kind === 'slides').map((a) => ({ at: a.at, courseId: a.courseId, reviews: 0, slides: a.count, exams: 0 })),
    ...input.attempts.filter((a) => a.status === 'submitted' && a.submittedAt).map((a) => ({ at: a.submittedAt!, courseId: a.courseId, reviews: 0, slides: 0, exams: 1 })),
  ].sort((a, b) => a.at - b.at);
  const sessions: StudySession[] = [];
  for (const e of events) {
    const last = [...sessions].reverse().find((s) => s.courseId === e.courseId);
    if (last && e.at - last.end <= gapMs) {
      last.end = e.at;
      last.reviews += e.reviews;
      last.slides += e.slides;
      last.exams += e.exams;
    } else sessions.push({ start: e.at, end: e.at, courseId: e.courseId, reviews: e.reviews, slides: e.slides, exams: e.exams });
  }
  return sessions.sort((a, b) => b.end - a.end);
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

export interface Recommendation {
  kind: 'resume-exam' | 'review-cards' | 'practice-exam' | 'approve-items' | 'revise-topic' | 'read-lecture' | 'add-material' | 'all-clear';
  courseId?: string;
  title: string;
  reason: string;
  href: string;
}

export interface RecommendInput {
  now: number;
  courses: CourseRow[];
  lectures: LectureRow[];
  cards: CardRow[];
  questions: QuestionRow[];
  exams: ExamRow[];
  attempts: AttemptRow[];
  viewed: Map<string, number[]>;
  /** Where the student last had a slide open (saved at once, unlike `viewed`, which needs a few seconds on the slide). */
  last?: { lectureId: string; slide: number };
}

/**
 * One concrete next step, chosen by simple, explainable rules (and always with the reason):
 *   1. an exam you started and did not finish,
 *   2. an exam in the next 14 days with no practice exam in the last 3 days,
 *   3. cards that are due,
 *   4. imported cards/questions waiting for your approval,
 *   5. your weakest topic from submitted exams,
 *   6. the lecture you have read least,
 *   7. nothing to study yet → add material.
 */
export function recommendNext(i: RecommendInput): Recommendation {
  const active = i.courses.filter((c) => !c.archived);
  const course = (id: string) => active.find((c) => c.id === id);

  const open = i.attempts.filter((a) => a.status === 'in-progress' && course(a.courseId)).sort((a, b) => b.startedAt - a.startedAt)[0];
  if (open) {
    const exam = i.exams.find((e) => e.id === open.examId);
    return { kind: 'resume-exam', courseId: open.courseId, title: `Finish “${exam?.config.title ?? 'your exam'}”`, reason: 'You started this exam and have not submitted it.', href: `/exam/${open.id}` };
  }

  const soon = active
    .filter((c) => c.examDate && (new Date(`${c.examDate}T00:00:00`).getTime() - startOfDay(i.now)) / DAY >= 0 && (new Date(`${c.examDate}T00:00:00`).getTime() - startOfDay(i.now)) / DAY <= 14)
    .sort((a, b) => (a.examDate ?? '').localeCompare(b.examDate ?? ''))[0];
  if (soon) {
    const days = Math.round((new Date(`${soon.examDate}T00:00:00`).getTime() - startOfDay(i.now)) / DAY);
    const recent = i.attempts.some((a) => a.courseId === soon.id && a.status === 'submitted' && (a.submittedAt ?? 0) > i.now - 3 * DAY);
    const bank = i.questions.filter((q) => q.courseId === soon.id && q.status === 'approved').length;
    if (!recent && bank > 0) {
      return { kind: 'practice-exam', courseId: soon.id, title: `Do a practice exam for ${soon.name}`, reason: `Your exam is ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`} and you have not practised in the last 3 days.`, href: `/course/${soon.id}/practice` };
    }
  }

  const dueByCourse = active
    .map((c) => ({ c, n: i.cards.filter((k) => k.courseId === c.id && k.status === 'approved' && k.fsrs.state !== 0 && k.fsrs.due <= i.now).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)[0];
  if (dueByCourse) {
    return { kind: 'review-cards', courseId: dueByCourse.c.id, title: `Review ${dueByCourse.n} due card${dueByCourse.n === 1 ? '' : 's'} in ${dueByCourse.c.name}`, reason: 'Reviewing on schedule is the cheapest way to keep what you have learned.', href: `/course/${dueByCourse.c.id}/review` };
  }

  const pending = active
    .map((c) => ({ c, n: i.cards.filter((k) => k.courseId === c.id && k.status === 'pending').length + i.questions.filter((q) => q.courseId === c.id && q.status === 'pending').length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)[0];
  if (pending) {
    return { kind: 'approve-items', courseId: pending.c.id, title: `Check ${pending.n} imported item${pending.n === 1 ? '' : 's'} in ${pending.c.name}`, reason: 'Imported cards and questions are not used until you approve them.', href: `/course/${pending.c.id}/cards?status=pending` };
  }

  const qById = new Map(i.questions.map((q) => [q.id, q]));
  for (const c of active) {
    const w = weakTopics(i.attempts.filter((a) => a.courseId === c.id), qById, 2, 60)[0];
    if (w) return { kind: 'revise-topic', courseId: c.id, title: `Revise “${w.topic}” in ${c.name}`, reason: `You earned ${w.percent}% of the marks on this topic in your practice exams.`, href: `/course/${c.id}/practice` };
  }

  const unread = i.lectures
    .filter((l) => course(l.courseId))
    .map((l) => ({ l, p: lectureProgress(l, i.viewed.get(l.id)) }))
    .filter((x) => x.p.percent < 100)
    .sort((a, b) => a.p.percent - b.p.percent || a.l.order - b.l.order)[0];
  if (unread) {
    const { l, p } = unread;
    const seen = i.viewed.get(l.id) ?? [];
    // A lecture you have open at some slide was opened, even if you have not stayed on a slide long enough for it to count as viewed.
    const here = i.last?.lectureId === l.id ? Math.min(Math.max(1, i.last.slide), p.total) : undefined;
    const slide = here ?? Math.min(p.total, (seen.length ? Math.max(...seen) : 0) + 1);
    const reason = here
      ? `You left off at slide ${here} of ${p.total}${p.viewed > 0 ? `; ${p.viewed} viewed so far` : ''}.`
      : p.viewed === 0
        ? 'You have not opened this lecture yet.'
        : `You have viewed ${p.viewed} of ${p.total} slides.`;
    return { kind: 'read-lecture', courseId: l.courseId, title: `Study “${l.title}”`, reason, href: `/lecture/${l.id}?slide=${slide}` };
  }

  if (i.lectures.length === 0) {
    const first = active[0];
    return { kind: 'add-material', ...(first ? { courseId: first.id } : {}), title: first ? `Add lectures to ${first.name}` : 'Create your first course', reason: 'Everything starts from your PowerPoint lectures.', href: first ? `/course/${first.id}` : '/' };
  }
  return { kind: 'all-clear', title: 'You are up to date', reason: 'Nothing is due, nothing is waiting for approval, and you have viewed every slide.', href: '/' };
}

/** Topics where you did well across submitted attempts (needs enough marked questions to mean something). */
export function strongTopics(attempts: AttemptRow[], questionsById: Map<string, QuestionRow>, minQuestions = 2, threshold = 80): TopicScore[] {
  // weakTopics() keeps topics *below* a threshold; invert by asking for everything and filtering.
  return weakTopics(attempts, questionsById, minQuestions, 101)
    .filter((t) => t.percent >= threshold)
    .sort((a, b) => b.percent - a.percent);
}
