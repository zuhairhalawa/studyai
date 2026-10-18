import { useMemo } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Plus, TriangleAlert } from 'lucide-react';
import { useActivity, useAllAttempts, useAllCards, useAllExams, useAllLectures, useAllQuestions, useAllReviews, useAllViewed, useCourses, useSetting, type LastViewed } from '@/app/data';
import { COURSE_COLORS, useShell } from '@/app/Shell';
import { scoreAttempt, weakTopics } from '@/core/study/exam';
import { deriveSessions, lectureProgress, recommendNext, strongTopics } from '@/core/study/progress';
import { startOfDay } from '@/core/study/queue';
import type { QuestionRow } from '@/core/study/types';
import { Button, EmptyState, Spinner } from '@/ui/primitives';
import { daysUntil, examLabel } from './CourseLayout';

const DAY = 86_400_000;

export function Dashboard() {
  const courses = useCourses();
  const lectures = useAllLectures();
  const cards = useAllCards();
  const questions = useAllQuestions();
  const exams = useAllExams();
  const attempts = useAllAttempts();
  const reviews = useAllReviews();
  const viewed = useAllViewed();
  const since = useMemo(() => startOfDay(Date.now()) - 30 * DAY, []);
  const activity = useActivity(since);
  const [last] = useSetting<LastViewed>('lastViewed');
  const { openNewCourse } = useShell();

  const now = Date.now();
  const ready = courses && lectures && cards && questions && exams && attempts && reviews && viewed && activity;

  const derived = useMemo(() => {
    if (!ready) return undefined;
    const qById = new Map<string, QuestionRow>(questions.map((q) => [q.id, q]));
    const examById = new Map(exams.map((e) => [e.id, e]));
    const active = courses.filter((c) => !c.archived);
    const rec = recommendNext({ now, courses, lectures, cards, questions, exams, attempts, viewed, ...(last ? { last: { lectureId: last.lectureId, slide: last.slide } } : {}) });
    const today = startOfDay(now);
    const perCourse = active.map((c) => {
      const ls = lectures.filter((l) => l.courseId === c.id);
      const total = ls.reduce((n, l) => n + l.slideCount, 0);
      const seen = ls.reduce((n, l) => n + lectureProgress(l, viewed.get(l.id)).viewed, 0);
      const due = cards.filter((k) => k.courseId === c.id && k.status === 'approved' && k.fsrs.state !== 0 && k.fsrs.due <= now).length;
      const submitted = attempts.filter((a) => a.courseId === c.id && a.status === 'submitted').sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
      const lastAttempt = submitted[0];
      const score = lastAttempt ? scoreAttempt((examById.get(lastAttempt.examId)?.questionIds ?? []).map((id) => qById.get(id)).filter((q): q is QuestionRow => !!q), lastAttempt) : undefined;
      return { c, ls, total, seen, due, score, attention: ls.reduce((n, l) => n + l.report.slidesRequiringAttention.length, 0) };
    });
    const submitted = attempts.filter((a) => active.some((c) => c.id === a.courseId));
    return {
      rec,
      perCourse,
      weak: weakTopics(submitted, qById, 2, 60).slice(0, 5),
      strong: strongTopics(submitted, qById, 2, 80).slice(0, 5),
      sessions: deriveSessions({ reviews, activity, attempts }).slice(0, 5),
      reviewedToday: reviews.filter((r) => r.at >= today).length,
      slidesToday: activity.filter((a) => a.kind === 'slides' && a.at >= today).reduce((n, a) => n + a.count, 0),
      dueTotal: perCourse.reduce((n, p) => n + p.due, 0),
    };
  }, [ready, courses, lectures, cards, questions, exams, attempts, reviews, viewed, activity, last, now]);

  if (!ready || !derived) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }

  const active = courses.filter((c) => !c.archived);
  const byCourse = new Map(courses.map((c) => [c.id, c]));
  const resume = last ? lectures.find((l) => l.id === last.lectureId) : undefined;
  const needsLook = lectures
    .filter((l) => l.report.slidesRequiringAttention.length > 0 && !byCourse.get(l.courseId)?.archived)
    .sort((a, b) => b.report.slidesRequiringAttention.length - a.report.slidesRequiringAttention.length)
    .slice(0, 5);
  const exams14 = active.filter((c) => c.examDate && (daysUntil(c.examDate) ?? -1) >= 0).sort((a, b) => (a.examDate ?? '').localeCompare(b.examDate ?? ''));
  const { rec } = derived;
  // When the suggested step is simply "go back to the lecture you have open", one card says so instead of two cards pointing at the same slide.
  const resumesHere = rec.kind === 'read-lecture' && !!resume && rec.href.startsWith(`/lecture/${resume.id}?`);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      {active.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="Start with a course"
            action={
              <Button variant="primary" onClick={openNewCourse}>
                <Plus className="size-4" aria-hidden /> Create a course
              </Button>
            }
          >
            Create a course for each subject, then add the PowerPoint lectures your professor gave you. Everything stays on this device.
          </EmptyState>
        </div>
      ) : (
        <>
          <section className="mt-6" aria-labelledby="next-h">
            <h2 id="next-h" className="sr-only">
              Next step
            </h2>
            {rec.kind !== 'all-clear' ? (
              <Link to={rec.href} className="group flex items-center justify-between gap-4 rounded-[var(--radius-panel)] border border-accent/50 bg-accent-soft/50 px-5 py-4 hover:border-accent">
                <span className="min-w-0">
                  <span className="block text-[13px] text-ink-3">{resumesHere ? 'Continue where you left off' : 'Next step'}</span>
                  <span className="block text-lg font-semibold">{rec.title}</span>
                  <span className="block text-sm text-ink-2">{rec.reason}</span>
                </span>
                <ArrowRight className="size-5 shrink-0 text-ink-3 group-hover:text-accent" aria-hidden />
              </Link>
            ) : (
              <div className="rounded-[var(--radius-panel)] border border-rule bg-surface px-5 py-4">
                <p className="text-lg font-semibold">{rec.title}</p>
                <p className="text-sm text-ink-2">{rec.reason}</p>
              </div>
            )}
            {resume && last && !resumesHere && (
              <Link to={`/lecture/${resume.id}?slide=${last.slide}`} className="mt-3 flex items-center justify-between gap-4 rounded-[var(--radius-panel)] border border-rule bg-surface px-4 py-3 text-sm hover:border-accent">
                <span className="min-w-0">
                  <span className="block text-[13px] text-ink-3">Continue where you left off</span>
                  <span className="block truncate font-medium">{resume.title}</span>
                  <span className="block text-ink-2">
                    Slide {Math.min(last.slide, resume.slideCount)} of {resume.slideCount}, {byCourse.get(resume.courseId)?.name}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-ink-3" aria-hidden />
              </Link>
            )}
          </section>

          <section className="mt-6" aria-labelledby="today-h">
            <h2 id="today-h" className="sr-only">
              Today
            </h2>
            <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule">
              {(
                [
                  ['Cards due', derived.dueTotal],
                  ['Cards reviewed today', derived.reviewedToday],
                  ['Slides studied today', derived.slidesToday],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="bg-surface px-4 py-3">
                  <dt className="text-[13px] text-ink-3">{k}</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="mt-8" aria-labelledby="courses-h">
            <div className="flex items-center justify-between">
              <h2 id="courses-h" className="text-lg font-semibold">
                Courses
              </h2>
              <Button size="sm" onClick={openNewCourse}>
                <Plus className="size-4" aria-hidden /> New course
              </Button>
            </div>
            <ul className="mt-3 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
              {derived.perCourse.map(({ c, ls, total, seen, due, score, attention }) => {
                const pct = total ? Math.round((seen / total) * 100) : 0;
                const exam = examLabel(c.examDate);
                return (
                  <li key={c.id}>
                    <Link to={`/course/${c.id}`} className="grid gap-x-4 gap-y-1 px-4 py-3.5 hover:bg-sunken md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_8rem_8rem]">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: COURSE_COLORS[c.color % COURSE_COLORS.length] }} aria-hidden />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{c.name}</span>
                          <span className="block truncate text-[13px] text-ink-3">
                            {ls.length} lecture{ls.length === 1 ? '' : 's'}, {total} slides{c.code ? `, ${c.code}` : ''}
                          </span>
                          {c.goal && <span className="block truncate text-[13px] text-ink-2">Goal: {c.goal}</span>}
                        </span>
                      </span>
                      <span className="flex items-center gap-3 text-sm" aria-label={`${pct}% of slides studied`}>
                        <span className="h-2 w-full max-w-40 overflow-hidden rounded-full bg-sunken" role="presentation">
                          <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
                        </span>
                        <span className="shrink-0 tabular-nums text-ink-2">{total ? `${pct}% studied` : 'No slides'}</span>
                      </span>
                      <span className="text-sm text-ink-2 md:text-right">
                        {due > 0 ? <span className="font-medium text-ink">{due} card{due === 1 ? '' : 's'} due</span> : 'No cards due'}
                        {score && (
                          <span className="block text-[13px] text-ink-3">
                            Last exam {score.percent}%{score.complete ? '' : ' (provisional)'}
                          </span>
                        )}
                      </span>
                      <span className="text-sm md:text-right">
                        {exam ? <span className="font-medium text-ink">{exam}</span> : <span className="text-ink-3">{attention > 0 ? `${attention} slides to check` : 'No exam date'}</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>

          {(derived.weak.length > 0 || derived.strong.length > 0) && (
            <section className="mt-8 grid gap-6 md:grid-cols-2" aria-label="Topic performance">
              <div>
                <h2 className="text-lg font-semibold">Weak topics</h2>
                <p className="text-sm text-ink-2">From your submitted practice exams.</p>
                {derived.weak.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-3">None below 60%.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
                    {derived.weak.map((t) => (
                      <li key={t.topic} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                        <span className="truncate">{t.topic}</span>
                        <span className="tabular-nums text-bad">{t.percent}%</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h2 className="text-lg font-semibold">Strong topics</h2>
                <p className="text-sm text-ink-2">80% or more, with at least two questions.</p>
                {derived.strong.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-3">Not enough marked questions yet.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
                    {derived.strong.map((t) => (
                      <li key={t.topic} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                        <span className="truncate">{t.topic}</span>
                        <span className="tabular-nums text-ok">{t.percent}%</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {exams14.length > 0 && (
            <section className="mt-8" aria-labelledby="exams-h">
              <h2 id="exams-h" className="text-lg font-semibold">
                Upcoming exams
              </h2>
              <ul className="mt-3 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
                {exams14.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-ink-2">
                      {new Date(`${c.examDate}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, {examLabel(c.examDate)?.replace('Exam ', '')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {derived.sessions.length > 0 && (
            <section className="mt-8" aria-labelledby="sess-h">
              <h2 id="sess-h" className="text-lg font-semibold">
                Recent study sessions
              </h2>
              <ul className="mt-3 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
                {derived.sessions.map((s) => (
                  <li key={`${s.courseId}-${s.start}`} className="grid gap-x-4 px-4 py-2.5 text-sm md:grid-cols-[minmax(0,1fr)_12rem_minmax(0,1.2fr)]">
                    <span className="truncate font-medium">{byCourse.get(s.courseId)?.name ?? 'Course'}</span>
                    <span className="text-ink-3">
                      {new Date(s.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, {new Date(s.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      {s.end - s.start >= 60_000 ? `, ${Math.round((s.end - s.start) / 60_000)} min` : ''}
                    </span>
                    <span className="text-ink-2">
                      {[s.slides > 0 && `${s.slides} slide${s.slides === 1 ? '' : 's'} viewed`, s.reviews > 0 && `${s.reviews} card${s.reviews === 1 ? '' : 's'} reviewed`, s.exams > 0 && `${s.exams} exam${s.exams === 1 ? '' : 's'}`].filter(Boolean).join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {needsLook.length > 0 && (
            <section className="mt-8" aria-labelledby="look-h">
              <h2 id="look-h" className="text-lg font-semibold">
                Lectures with slides to check
              </h2>
              <p className="mt-1 text-sm text-ink-2">Some content in these lectures could not be read reliably (for example text inside pictures). Review them before relying on the extracted text.</p>
              <ul className="mt-3 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
                {needsLook.map((l) => (
                  <li key={l.id}>
                    <Link to={`/lecture/${l.id}/report`} className="flex items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-sunken">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{l.title}</span>
                        <span className="block text-[13px] text-ink-3">{byCourse.get(l.courseId)?.name}</span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-bad">
                        <TriangleAlert className="size-4" aria-hidden /> {l.report.slidesRequiringAttention.length} of {l.slideCount}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
