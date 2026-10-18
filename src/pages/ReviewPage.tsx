import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Pencil, Sparkles } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { intervalLabel, previewReview, type Rating } from '@/core/study/fsrs';
import { buildQueue, cardStats, nextDueAt } from '@/core/study/queue';
import { answerCard } from '@/core/study/store';
import { useCards, useCourse, useLectures, useReviews, useSetting } from '@/app/data';
import { useToast } from '@/app/toast';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { CardEditor } from '@/ui/study/CardEditor';
import { BasisChip, SourceList, SourceStatusChip } from '@/ui/study/Sources';
import { Button, Spinner } from '@/ui/primitives';
import { NotFound } from './NotFound';

const db = getDb();

const BUTTONS: { rating: Rating; label: string; key: string; cls: string }[] = [
  { rating: 1, label: 'Again', key: '1', cls: 'border-bad/60 text-bad hover:bg-bad-soft' },
  { rating: 2, label: 'Hard', key: '2', cls: 'border-warn/60 text-warn hover:bg-warn-soft' },
  { rating: 3, label: 'Good', key: '3', cls: 'border-ok/60 text-ok hover:bg-ok-soft' },
  { rating: 4, label: 'Easy', key: '4', cls: 'border-info/60 text-info hover:bg-sunken' },
];

export function ReviewPage() {
  const { courseId } = useParams();
  const [params] = useSearchParams();
  const lectureFilter = params.get('lecture') ?? '';
  const course = useCourse(courseId);
  const lectures = useLectures(courseId);
  const allCards = useCards(courseId);
  const reviews = useReviews(courseId);
  const [newPerDay] = useSetting<number>('newCardsPerDay');
  const toast = useToast();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const shownAt = useRef(Date.now());
  const session = useRef({ total: undefined as number | undefined, done: 0, good: 0 });
  const [, bump] = useState(0);

  // Learning cards come back after minutes: re-evaluate the queue regularly.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  const cards = useMemo(() => (allCards ?? []).filter((c) => !lectureFilter || c.lectureId === lectureFilter), [allCards, lectureFilter]);
  const stats = useMemo(() => (reviews ? cardStats(allCards ?? [], reviews, now) : undefined), [allCards, reviews, now]);
  const queue = useMemo(() => (stats ? buildQueue(cards, { now, newPerDay: newPerDay ?? 15, newToday: stats.newToday }) : []), [cards, stats, now, newPerDay]);
  const card = queue[0];

  if (session.current.total === undefined && stats) session.current.total = queue.length;

  // A new card is on screen: hide the answer and restart the timer.
  const cardId = card?.id;
  useEffect(() => {
    setRevealed(false);
    shownAt.current = Date.now();
  }, [cardId]);

  const rate = useCallback(
    async (rating: Rating) => {
      if (!card || busy) return;
      setBusy(true);
      try {
        await answerCard(db, card.id, rating, Date.now() - shownAt.current);
        session.current.done += 1;
        if (rating >= 3) session.current.good += 1;
        setNow(Date.now());
        bump((n) => n + 1);
      } catch (err) {
        toast.show(err instanceof Error ? err.message : 'Could not save that answer.', 'error');
      } finally {
        setBusy(false);
      }
    },
    [card, busy, toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (editing || (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'))) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (!card) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        void rate(Number(e.key) as Rating);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, revealed, rate, editing]);

  if (course === null) return <NotFound what="course" />;
  if (!course || !allCards || !stats || !lectures) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }

  const preview = card ? previewReview(card.fsrs, Date.now()) : undefined;
  const total = session.current.total ?? 0;
  const next = !card ? nextDueAt(cards, now) : undefined;

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-3rem)] w-full max-w-2xl flex-col px-4 py-6 md:px-6 md:py-10">
      <header className="flex items-center justify-between gap-3">
        <Link to={`/course/${course.id}/cards`} className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden /> {course.name}
        </Link>
        <p className="text-sm tabular-nums text-ink-2" aria-live="polite">
          {card ? `${queue.length} left` : 'Finished'}
          {session.current.done > 0 && `, ${session.current.done} answered`}
        </p>
      </header>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label="Session progress" aria-valuemin={0} aria-valuemax={Math.max(1, total)} aria-valuenow={Math.min(session.current.done, Math.max(1, total))}>
        <div className="h-full bg-accent transition-[width]" style={{ width: `${total ? Math.min(100, (session.current.done / total) * 100) : 100}%` }} />
      </div>

      {card && preview ? (
        <main className="mt-8 flex flex-col" aria-label="Flashcard">
          <p className="sr-only" aria-live="polite">
            Card {Math.min(session.current.done + 1, Math.max(total, 1))}
          </p>
          <div className="min-h-72 rounded-[var(--radius-panel)] border border-rule bg-surface p-6 md:p-8">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
              <span>{card.fsrs.state === 0 ? 'New card' : card.fsrs.state === 2 ? 'Review' : 'Learning'}</span>
              {card.lectureId && <span>{lectures.find((l) => l.id === card.lectureId)?.title}</span>}
            </div>
            <div className="mt-4 text-[1.15rem]">
              <LazyMarkdown>{card.front}</LazyMarkdown>
            </div>
            {revealed && (
              <div className="mt-6 border-t border-rule pt-6">
                <LazyMarkdown>{card.back}</LazyMarkdown>
                <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <BasisChip basis={card.basis} sources={card.sources} />
                  <SourceStatusChip sources={card.sources} />
                </div>
                <div className="mt-2">
                  <SourceList sources={card.sources} />
                </div>
              </div>
            )}
          </div>

          <div className="mt-5">
            {!revealed ? (
              <Button variant="primary" className="w-full" onClick={() => setRevealed(true)}>
                Show answer <span className="ml-2 rounded bg-black/15 px-1.5 text-xs">Space</span>
              </Button>
            ) : (
              <div role="group" aria-label="How well did you remember?" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {BUTTONS.map((b) => (
                  <button
                    key={b.rating}
                    type="button"
                    disabled={busy}
                    onClick={() => void rate(b.rating)}
                    className={`flex min-h-14 flex-col items-center justify-center rounded-[var(--radius-control)] border bg-surface px-2 py-2 text-sm font-medium disabled:opacity-50 ${b.cls}`}
                  >
                    <span>{b.label}</span>
                    <span className="text-xs font-normal text-ink-3">
                      {preview[b.rating].label} <span className="ml-1 rounded bg-sunken px-1">{b.key}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-3 flex justify-between text-sm">
              <span className="flex items-center gap-4">
                <button type="button" className="inline-flex items-center gap-1.5 text-ink-2 hover:text-ink" onClick={() => setEditing(true)}>
                  <Pencil className="size-4" aria-hidden /> Edit this card
                </button>
                {revealed && (
                  <Link
                    to={`/course/${course.id}/tutor${card.sources[0] ? `?lecture=${card.sources[0].lectureId}&slide=${card.sources[0].slide}` : card.lectureId ? `?lecture=${card.lectureId}` : ''}`}
                    state={{ question: `Explain this flashcard to me: ${card.front.slice(0, 600)}` }}
                    className="inline-flex items-center gap-1.5 text-ink-2 hover:text-ink"
                  >
                    <Sparkles className="size-4" aria-hidden /> Ask the tutor
                  </Link>
                )}
              </span>
              <span className="text-ink-3">Keys: Space to reveal, 1–4 to answer</span>
            </div>
          </div>
        </main>
      ) : (
        <main className="mt-12 flex flex-1 flex-col items-center text-center" aria-label="Session finished">
          <h1 className="text-2xl font-semibold tracking-tight">{session.current.done > 0 ? 'Session finished' : stats.approved === 0 ? 'No approved cards yet' : 'Nothing to review right now'}</h1>
          {session.current.done > 0 && (
            <p className="mt-3 text-ink-2">
              You answered {session.current.done} card{session.current.done === 1 ? '' : 's'}; {session.current.good} of them Good or Easy ({Math.round((session.current.good / session.current.done) * 100)}%).
            </p>
          )}
          {next && <p className="mt-2 text-ink-2">The next card is due in {intervalLabel(next - now)}.</p>}
          {!next && stats.approved > 0 && <p className="mt-2 text-ink-2">You have seen every card for now. New ones appear tomorrow, or add more in the Flashcards tab.</p>}
          {stats.approved === 0 && <p className="mt-2 max-w-prose text-ink-2">Approve cards in the Flashcards tab (or add your own) before studying.</p>}
          <Link to={`/course/${course.id}/cards`} className="mt-6 inline-flex min-h-10 items-center rounded-[var(--radius-control)] border border-rule-strong bg-surface px-4 text-sm font-medium hover:bg-sunken">
            Back to flashcards
          </Link>
        </main>
      )}

      <CardEditor open={editing} onClose={() => setEditing(false)} courseId={course.id} lectures={lectures} card={card} />
    </div>
  );
}
