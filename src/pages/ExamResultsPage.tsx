import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen, Printer, RotateCcw } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { createExam, saveGrade, startAttempt } from '@/core/study/attempts';
import { keywordHints, missedQuestionIds, scoreAttempt, type QuestionOutcome } from '@/core/study/exam';
import type { QuestionRow } from '@/core/study/types';
import { useToast } from '@/app/toast';
import { AiGradeAssist } from '@/ui/ai/AiGradeAssist';
import { MathText } from '@/ui/MathText';
import { QuestionPrompt, SelfMarker, Solution } from '@/ui/study/exam-ui';
import { Button, Callout, Spinner } from '@/ui/primitives';
import { NotFound } from './NotFound';

const db = getDb();

const OUTCOME: Record<QuestionOutcome, { label: string; cls: string }> = {
  full: { label: 'Full marks', cls: 'bg-ok-soft text-ok' },
  partial: { label: 'Partial marks', cls: 'bg-warn-soft text-warn' },
  zero: { label: 'No marks', cls: 'bg-bad-soft text-bad' },
  pending: { label: 'Needs marking', cls: 'bg-accent-soft text-ink' },
  unanswered: { label: 'Not answered', cls: 'bg-sunken text-ink-2' },
};

function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'under a minute' : m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function ExamResultsPage() {
  const { attemptId } = useParams();
  const attempt = useLiveQuery(async () => (attemptId ? ((await db.attempts.get(attemptId)) ?? null) : null), [attemptId]);
  const exam = useLiveQuery(async () => (attempt ? ((await db.exams.get(attempt.examId)) ?? null) : undefined), [attempt?.examId]);
  const raw = useLiveQuery(async () => (exam ? await db.questions.bulkGet(exam.questionIds) : undefined), [exam?.id]);
  const course = useLiveQuery(async () => (exam ? await db.courses.get(exam.courseId) : undefined), [exam?.courseId]);
  const lectures = useLiveQuery(async () => (exam ? await db.lectures.where('courseId').equals(exam.courseId).toArray() : []), [exam?.courseId]);
  const toast = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'missed' | 'marking'>('all');

  const questions = useMemo(() => (raw ?? []).filter((q): q is QuestionRow => !!q), [raw]);
  const score = useMemo(() => (attempt ? scoreAttempt(questions, attempt) : undefined), [questions, attempt]);

  if (attempt === null || exam === null) return <NotFound what="result" />;
  if (!attempt || !exam || !raw || !score || !course) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }
  if (attempt.status === 'in-progress') return <Navigate to={`/exam/${attempt.id}`} replace />;

  const missed = missedQuestionIds(score);
  const shown = score.results.filter((r) => (filter === 'all' ? true : filter === 'missed' ? r.outcome !== 'full' : r.outcome === 'pending'));
  const lectureTitle = (id: string) => lectures?.find((l) => l.id === id)?.title;

  const repeat = async () => {
    if (missed.length === 0) return;
    const e = await createExam(db, course.id, { ...exam.config, title: `Repeat: ${exam.config.title}`, count: missed.length, totalMarks: undefined }, missed);
    navigate(`/exam/${(await startAttempt(db, e.id)).id}`);
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <nav aria-label="Breadcrumb" className="text-[13px] text-ink-3 print:hidden">
        <Link to={`/course/${course.id}/practice`} className="hover:underline">
          {course.name} / Practice and exams
        </Link>
      </nav>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{exam.config.title}</h1>
      <p className="text-sm text-ink-2">
        {new Date(attempt.startedAt).toLocaleString()}, {duration(attempt.elapsedMs)}
        {exam.config.minutes ? ` of ${exam.config.minutes} minutes allowed` : ''}
      </p>

      <section className="mt-5 grid gap-4 rounded-[var(--radius-panel)] border border-rule bg-surface p-5 sm:grid-cols-[auto_minmax(0,1fr)]" aria-labelledby="score-h">
        <div>
          <h2 id="score-h" className="text-[13px] text-ink-3">
            {score.complete ? 'Your score' : 'Provisional score'}
          </h2>
          <p className="text-4xl font-semibold tabular-nums">
            {score.earned}
            <span className="text-xl text-ink-3"> / {score.max}</span>
          </p>
          <p className="text-lg tabular-nums text-ink-2">{score.percent}%</p>
        </div>
        <div>
          {!score.complete && (
            <Callout tone="warn" title={`${score.pending} written answer${score.pending === 1 ? ' needs' : 's need'} marking`}>
              Marks for written answers are added when you mark them below. Until then they count as zero.
              <div className="mt-2">
                <Button size="sm" onClick={() => setFilter('marking')}>
                  Show the ones to mark
                </Button>
              </div>
            </Callout>
          )}
          {score.topics.length > 0 && (
            <div className={score.complete ? '' : 'mt-3'}>
              <h3 className="text-sm font-medium">By topic</h3>
              <ul className="mt-1 flex flex-col gap-1.5">
                {score.topics.map((t) => (
                  <li key={t.topic} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
                    <span className="truncate">{t.topic}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${t.percent}%`}>
                      <span className={`block h-full ${t.percent < 60 ? 'bg-bad' : t.percent < 80 ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${t.percent}%` }} />
                    </span>
                    <span className="w-24 text-right tabular-nums text-ink-2">
                      {t.percent}% <span className="text-ink-3">{t.earned}/{t.max}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div role="group" aria-label="Show questions" className="inline-flex overflow-hidden rounded-[var(--radius-control)] border border-rule-strong text-sm">
          {(
            [
              ['all', `All (${score.results.length})`],
              ['missed', `Not full marks (${score.results.filter((r) => r.outcome !== 'full').length})`],
              ['marking', `To mark (${score.pending})`],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={`min-h-9 px-3 ${filter === id ? 'bg-accent-soft font-medium' : 'bg-surface text-ink-2 hover:bg-sunken'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> Print
          </Button>
          <Button variant="primary" onClick={() => void repeat()} disabled={missed.length === 0}>
            <RotateCcw className="size-4" aria-hidden /> Repeat {missed.length} missed question{missed.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>

      <ol className="mt-4 flex flex-col gap-5">
        {shown.map((r) => {
          const q = r.question;
          const index = score.results.indexOf(r) + 1;
          const a = attempt.answers[q.id];
          const o = OUTCOME[r.outcome];
          const g = r.grade;
          const subjective = !q.options;
          const missing = g && q.rubric.length > 0 ? q.rubric.filter((p) => (g.items.find((i) => i.pointId === p.id)?.awarded ?? 0) < p.marks) : [];
          return (
            <li key={q.id} className="rounded-[var(--radius-panel)] border border-rule bg-surface p-5 print:break-inside-avoid">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <QuestionPrompt q={q} index={index} />
                <div className="text-right">
                  <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${o.cls}`}>{o.label}</span>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {r.earned}
                    <span className="text-sm font-normal text-ink-3"> / {r.max}</span>
                  </p>
                  {g && <p className="text-xs text-ink-3">{g.by === 'auto' ? 'Marked automatically' : g.by === 'ai' ? 'AI estimate (check it yourself)' : 'Marked by you'}{g.uncertain && g.by !== 'ai' ? ', an estimate' : ''}</p>}
                </div>
              </div>

              <div className="mt-3">
                <h3 className="text-sm font-medium">Your answer</h3>
                {q.options ? (
                  <p className="text-sm text-ink-2">{a?.optionIds?.length ? q.options.filter((x) => a.optionIds!.includes(x.id)).map((x) => x.text).join('; ') : 'No answer given.'}</p>
                ) : a?.text?.trim() ? (
                  <div className="mt-1 whitespace-pre-wrap rounded-[var(--radius-control)] border border-rule bg-sunken/40 p-3 font-serif text-[1rem]">{a.text}</div>
                ) : (
                  <p className="text-sm text-ink-2">No answer given.</p>
                )}
                {a?.hintUsed && <p className="mt-1 text-xs text-warn">You used the hint on this question.</p>}
              </div>

              {g?.comment && g.by !== 'auto' && <p className="mt-3 text-sm">Your note: {g.comment}</p>}
              {g && g.by === 'auto' && g.comment && <p className="mt-3 text-sm text-ink-2">{g.comment}</p>}

              {missing.length > 0 && g && (
                <div className="mt-3">
                  <h3 className="text-sm font-medium">Where marks were lost</h3>
                  <ul className="mt-1 list-disc pl-5 text-sm text-ink-2">
                    {missing.map((p) => (
                      <li key={p.id}>
                        <MathText>{p.text}</MathText>: {g.items.find((i) => i.pointId === p.id)?.awarded ?? 0} of {p.marks}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-4 border-t border-rule pt-4">
                <Solution q={q} chosen={a?.optionIds} hints={subjective && a?.text ? keywordHints(q, a.text) : undefined} />
                {q.sources.length > 0 && (
                  <p className="mt-3 flex items-center gap-2 text-sm print:hidden">
                    <BookOpen className="size-4 text-ink-3" aria-hidden />
                    Revise:{' '}
                    {q.sources.slice(0, 3).map((s, i) => (
                      <span key={i}>
                        <Link className="text-accent underline underline-offset-2" to={`/lecture/${s.lectureId}?slide=${s.slide}`}>
                          {lectureTitle(s.lectureId) ?? 'lecture'}, slide {s.slide}
                        </Link>
                        {i < Math.min(2, q.sources.length - 1) ? '; ' : ''}
                      </span>
                    ))}
                    <Link
                      className="ml-auto inline-flex items-center gap-1.5 text-accent underline underline-offset-2"
                      to={`/course/${attempt.courseId}/tutor?lecture=${q.sources[0]!.lectureId}&slide=${q.sources[0]!.slide}`}
                      state={{ question: `Explain how to answer this exam question and what a good answer needs: ${q.prompt.slice(0, 800)}` }}
                    >
                      Ask the tutor
                    </Link>
                  </p>
                )}
              </div>

              {subjective && (
                <div className="mt-4 flex flex-col gap-3 print:hidden">
                  <AiGradeAssist q={q} answerText={a?.text ?? ''} onAccept={async (grade) => { await saveGrade(db, attempt.id, q.id, grade); toast.show('AI estimate saved. It is marked as the AI’s.', 'ok'); }} />
                  <SelfMarker key={`${q.id}-${g?.gradedAt ?? 0}`} q={q} answerText={a?.text ?? ''} existing={g} onSave={async (grade) => { await saveGrade(db, attempt.id, q.id, grade); toast.show('Mark saved.', 'ok'); }} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {shown.length === 0 && <p className="mt-6 text-sm text-ink-2">Nothing to show with this filter.</p>}

      <p className="mt-8 border-t border-rule pt-4 text-[13px] text-ink-3">
        Scores for written answers are your own estimates against the marking points, not an examiner’s marks. Multiple-choice and true/false are marked exactly. Practice exams are representative of the material, not a prediction of the real paper.
      </p>
    </div>
  );
}
