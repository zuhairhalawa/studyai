import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronLeft, ChevronRight, Flag, Lightbulb, Send } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { saveAnswer, setElapsed, submitAttempt, toggleFlag } from '@/core/study/attempts';
import { hasAnswer } from '@/core/study/exam';
import type { AnswerState, QuestionRow } from '@/core/study/types';
import { useToast } from '@/app/toast';
import { AnswerInput, QuestionPrompt, Solution } from '@/ui/study/exam-ui';
import { Button, Callout, Dialog, Spinner } from '@/ui/primitives';
import { NotFound } from './NotFound';

const db = getDb();

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function ExamPage() {
  const { attemptId } = useParams();
  const attempt = useLiveQuery(async () => (attemptId ? ((await db.attempts.get(attemptId)) ?? null) : null), [attemptId]);
  const exam = useLiveQuery(async () => (attempt ? ((await db.exams.get(attempt.examId)) ?? null) : undefined), [attempt?.examId]);
  const questionsRaw = useLiveQuery(async () => (exam ? await db.questions.bulkGet(exam.questionIds) : undefined), [exam?.id]);
  const course = useLiveQuery(async () => (exam ? await db.courses.get(exam.courseId) : undefined), [exam?.courseId]);
  const toast = useToast();
  const navigate = useNavigate();

  const questions = useMemo(() => (questionsRaw ?? []).filter((q): q is QuestionRow => !!q), [questionsRaw]);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [loadedFor, setLoadedFor] = useState<string | undefined>();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [hintShown, setHintShown] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef<Record<string, Partial<AnswerState>>>({});
  const timer = useRef<number | undefined>(undefined);
  const base = useRef({ elapsed: 0, at: 0 });
  const submitted = useRef(false);

  // Load saved answers once (resume after reload).
  if (attempt && loadedFor !== attempt.id) {
    setLoadedFor(attempt.id);
    setAnswers(attempt.answers);
    base.current = { elapsed: attempt.elapsedMs, at: Date.now() };
  }

  const cfg = exam?.config;
  const conditions = !!cfg?.conditions;
  const elapsed = !attempt ? 0 : conditions ? now - attempt.startedAt : base.current.elapsed + (now - base.current.at);
  const limit = cfg?.minutes ? cfg.minutes * 60_000 : undefined;
  const remaining = limit !== undefined ? limit - elapsed : undefined;

  const flush = useCallback(async () => {
    const p = pending.current;
    pending.current = {};
    if (!attemptId) return;
    try {
      for (const [qid, patch] of Object.entries(p)) await saveAnswer(db, attemptId, qid, patch);
    } catch {
      /* the attempt may have been submitted in the meantime; nothing to save */
    }
  }, [attemptId]);

  const change = useCallback(
    (qid: string, patch: Partial<AnswerState>) => {
      setAnswers((a) => ({ ...a, [qid]: { timeMs: 0, ...a[qid], ...patch } }));
      pending.current[qid] = { ...pending.current[qid], ...patch };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 400);
    },
    [flush],
  );

  const doSubmit = useCallback(
    async (auto = false) => {
      if (!attempt || submitted.current) return;
      submitted.current = true;
      setSubmitting(true);
      try {
        window.clearTimeout(timer.current);
        await flush();
        await submitAttempt(db, attempt.id, questions, conditions ? Date.now() - attempt.startedAt : base.current.elapsed + (Date.now() - base.current.at));
        if (auto) toast.show('Time is up. Your exam was submitted.', 'info');
        navigate(`/exam/${attempt.id}/results`, { replace: true });
      } catch (err) {
        submitted.current = false;
        setSubmitting(false);
        toast.show(err instanceof Error ? err.message : 'Could not submit.', 'error');
      }
    },
    [attempt, questions, conditions, flush, navigate, toast],
  );

  // Clock, elapsed-time persistence, and automatic submission when time runs out.
  useEffect(() => {
    if (!attempt || attempt.status === 'submitted') return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const persist = window.setInterval(() => {
      if (!conditions) void setElapsed(db, attempt.id, base.current.elapsed + (Date.now() - base.current.at)).catch(() => undefined);
    }, 5000);
    const leave = () => {
      void flush();
      if (!conditions) void setElapsed(db, attempt.id, base.current.elapsed + (Date.now() - base.current.at)).catch(() => undefined);
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(persist);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [attempt?.id, attempt?.status, conditions, flush]);

  useEffect(() => {
    if (remaining !== undefined && remaining <= 0 && attempt?.status === 'in-progress' && questions.length > 0) void doSubmit(true);
  }, [remaining, attempt?.status, questions.length, doSubmit]);

  // Arrow keys move between questions (not while typing).
  useEffect(() => {
    if (cfg?.layout !== 'one') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(questions.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cfg?.layout, questions.length]);

  if (attempt === null || exam === null) return <NotFound what="exam" />;
  if (!attempt || !exam || !cfg || !questionsRaw || !course) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }
  if (attempt.status === 'submitted') return <Navigate to={`/exam/${attempt.id}/results`} replace />;
  if (questions.length === 0) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <Callout tone="bad" title="The questions for this exam are no longer available">
          They were deleted from your question bank. <Link className="underline" to={`/course/${course.id}/practice`}>Back to practice</Link>
        </Callout>
      </div>
    );
  }

  const answeredCount = questions.filter((q) => hasAnswer(answers[q.id])).length;
  const flagged = new Set(attempt.flagged);
  const canHint = cfg.hints && !conditions;
  const immediate = cfg.reveal === 'immediate' && !conditions;

  const questionCard = (q: QuestionRow, i: number) => {
    const a = answers[q.id];
    const showSolution = immediate && revealed.has(q.id);
    return (
      <article key={q.id} className="rounded-[var(--radius-panel)] border border-rule bg-surface p-5 md:p-6" aria-labelledby={`qh-${q.id}`}>
        <h2 id={`qh-${q.id}`} className="sr-only">
          Question {i + 1} of {questions.length}
        </h2>
        <QuestionPrompt q={q} index={i + 1} />
        <AnswerInput q={q} answer={a} onChange={(p) => change(q.id, p)} id={`ans-${q.id}`} />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" variant={flagged.has(q.id) ? 'secondary' : 'ghost'} aria-pressed={flagged.has(q.id)} onClick={() => void toggleFlag(db, attempt.id, q.id)}>
            <Flag className="size-4" aria-hidden /> {flagged.has(q.id) ? 'Flagged for review' : 'Flag for review'}
          </Button>
          {canHint && q.hint && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setHintShown(new Set(hintShown).add(q.id));
                change(q.id, { hintUsed: true });
              }}
            >
              <Lightbulb className="size-4" aria-hidden /> Show hint
            </Button>
          )}
          {immediate && !showSolution && (
            <Button size="sm" onClick={() => setRevealed(new Set(revealed).add(q.id))} disabled={!hasAnswer(a)}>
              Check my answer
            </Button>
          )}
        </div>
        {canHint && q.hint && hintShown.has(q.id) && <p className="mt-3 rounded bg-warn-soft px-3 py-2 text-sm text-ink">Hint: {q.hint}</p>}
        {showSolution && (
          <div className="mt-4 border-t border-rule pt-4">
            <Solution q={q} chosen={a?.optionIds} />
            <p className="mt-3 text-[13px] text-ink-3">Written answers are marked when you submit the exam.</p>
          </div>
        )}
      </article>
    );
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4 md:px-6 md:py-6">
      <header className="sticky top-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-paper/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <div className="min-w-0">
          <p className="truncate text-[13px] text-ink-3">{course.name}</p>
          <h1 className="truncate text-lg font-semibold tracking-tight">{cfg.title}</h1>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm tabular-nums text-ink-2" aria-live="off">
            {answeredCount} of {questions.length} answered
          </p>
          <p className={`rounded-full px-3 py-1 text-sm font-medium tabular-nums ${remaining !== undefined && remaining < 300_000 ? 'bg-bad-soft text-bad' : 'bg-sunken text-ink'}`} role="timer" aria-label={remaining !== undefined ? `Time left ${clock(remaining)}` : `Time spent ${clock(elapsed)}`}>
            {remaining !== undefined ? `${clock(remaining)} left` : clock(elapsed)}
          </p>
          <Button variant="primary" onClick={() => setConfirming(true)} disabled={submitting}>
            <Send className="size-4" aria-hidden /> Submit
          </Button>
        </div>
      </header>
      <p className="sr-only" aria-live="polite">
        {remaining !== undefined && remaining <= 60_000 && remaining > 55_000 ? 'One minute left.' : remaining !== undefined && remaining <= 300_000 && remaining > 295_000 ? 'Five minutes left.' : ''}
      </p>

      {conditions && (
        <p className="mt-4 rounded bg-sunken px-3 py-2 text-sm text-ink-2">
          Exam conditions: no hints, no answers until you submit, and the clock keeps running even if you leave this page.
        </p>
      )}

      {cfg.layout === 'one' ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_11rem]">
          <main aria-label="Question">
            {questionCard(questions[index]!, index)}
            <div className="mt-4 flex items-center justify-between">
              <Button onClick={() => setIndex(Math.max(0, index - 1))} disabled={index === 0}>
                <ChevronLeft className="size-4" aria-hidden /> Previous
              </Button>
              <Button onClick={() => setIndex(Math.min(questions.length - 1, index + 1))} disabled={index === questions.length - 1}>
                Next <ChevronRight className="size-4" aria-hidden />
              </Button>
            </div>
          </main>
          <nav aria-label="Question navigator" className="lg:sticky lg:top-24 lg:self-start">
            <ol className="grid grid-cols-6 gap-1.5 sm:grid-cols-10 lg:grid-cols-4">
              {questions.map((q, i) => (
                <li key={q.id}>
                  <button
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-current={i === index ? 'step' : undefined}
                    aria-label={`Question ${i + 1}${hasAnswer(answers[q.id]) ? ', answered' : ', not answered'}${flagged.has(q.id) ? ', flagged' : ''}`}
                    className={`relative flex size-10 items-center justify-center rounded-[var(--radius-control)] border text-sm tabular-nums ${i === index ? 'border-accent bg-accent text-accent-ink' : hasAnswer(answers[q.id]) ? 'border-accent/50 bg-accent-soft text-ink' : 'border-rule-strong bg-surface text-ink-2 hover:bg-sunken'}`}
                  >
                    {i + 1}
                    {flagged.has(q.id) && <Flag className="absolute -right-1 -top-1 size-3.5 fill-warn text-warn" aria-hidden />}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      ) : (
        <main className="mt-5 flex flex-col gap-5" aria-label="Exam paper">
          {questions.map((q, i) => questionCard(q, i))}
        </main>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Submit your exam?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep working
            </Button>
            <Button variant="primary" disabled={submitting} onClick={() => void doSubmit(false)}>
              Submit now
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>
            You answered {answeredCount} of {questions.length} questions.
          </p>
          {questions.length - answeredCount > 0 && <p className="text-warn">{questions.length - answeredCount} question{questions.length - answeredCount === 1 ? ' has' : 's have'} no answer and will score zero.</p>}
          {flagged.size > 0 && <p className="text-ink-2">{flagged.size} flagged for review.</p>}
          <p className="text-ink-2">After submitting you cannot change your answers. Multiple-choice and true/false are marked straight away; for written answers you compare with the model answer and mark yourself.</p>
        </div>
      </Dialog>
    </div>
  );
}
