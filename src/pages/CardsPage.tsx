import { useMemo, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router';
import { Check, FilePen, Pencil, Plus, Play, Trash2, WandSparkles, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { loadSlides } from '@/core/db/library';
import { draftCardsFromLecture } from '@/core/study/drafts';
import { intervalLabel } from '@/core/study/fsrs';
import { buildQueue, cardStats } from '@/core/study/queue';
import { createCard, deleteCards, setCardStatus } from '@/core/study/store';
import { CARD_TYPES, CARD_TYPE_LABEL, type CardRow, type ReviewStatus } from '@/core/study/types';
import { useCards, useReviews, useSetting } from '@/app/data';
import { useToast } from '@/app/toast';
import { Menu } from '@/ui/Menu';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { CardEditor } from '@/ui/study/CardEditor';
import { BasisChip, SourceList, SourceStatusChip } from '@/ui/study/Sources';
import { Button, Dialog, EmptyState, Select, Spinner, TextInput } from '@/ui/primitives';
import type { CourseCtx } from './CourseLayout';

const db = getDb();
const DEFAULT_NEW_PER_DAY = 15;

function stateLabel(c: CardRow, now: number): string {
  const s = c.fsrs;
  if (s.state === 0) return 'New';
  const wait = s.due - now;
  if (wait <= 0) return 'Due now';
  return `${s.state === 2 ? 'Review' : 'Learning'}, due in ${intervalLabel(wait)}`;
}

export function CardsPage() {
  const { course, lectures } = useOutletContext<CourseCtx>();
  const cards = useCards(course.id);
  const reviews = useReviews(course.id);
  const [newPerDay, setNewPerDay] = useSetting<number>('newCardsPerDay');
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? 'all') as ReviewStatus | 'all';
  const [lectureFilter, setLectureFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<CardRow | undefined>();
  const [creating, setCreating] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [deleting, setDeleting] = useState<CardRow[] | undefined>();
  const now = Date.now();
  const perDay = newPerDay ?? DEFAULT_NEW_PER_DAY;

  const stats = useMemo(() => (cards && reviews ? cardStats(cards, reviews, now) : undefined), [cards, reviews, now]);
  const queue = useMemo(() => (cards && stats ? buildQueue(cards, { now, newPerDay: perDay, newToday: stats.newToday }) : []), [cards, stats, now, perDay]);

  if (!cards || !reviews || !stats) {
    return <Spinner />;
  }

  const pending = cards.filter((c) => c.status === 'pending');
  const lectureTitle = (id?: string) => lectures.find((l) => l.id === id)?.title;
  const q = text.trim().toLowerCase();
  const shown = cards
    .filter((c) => (status === 'all' ? true : c.status === status))
    .filter((c) => !lectureFilter || c.lectureId === lectureFilter)
    .filter((c) => !typeFilter || c.type === typeFilter)
    .filter((c) => !q || c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q) || c.tags.some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt - a.createdAt);

  const setStatus = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === 'all') next.delete('status');
    else next.set('status', v);
    setParams(next, { replace: true });
  };

  const statTile = (label: string, value: number | string, hint?: string) => (
    <div className="bg-surface px-4 py-3">
      <dt className="text-[13px] text-ink-3">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-ink-3">{hint}</dd>}
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="study-h">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="study-h" className="text-lg font-semibold">
              Study now
            </h2>
            <p className="text-sm text-ink-2">
              {queue.length > 0 ? `${queue.length} card${queue.length === 1 ? '' : 's'} ready: ${stats.dueNow} due and up to ${Math.max(0, perDay - stats.newToday)} new.` : stats.approved === 0 ? 'No approved cards yet.' : 'Nothing is due right now.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 whitespace-nowrap text-[13px] text-ink-2">
              New cards per day
              <Select value={String(perDay)} onChange={(e) => void setNewPerDay(Number(e.target.value))} className="min-h-9 w-20 text-[13px]">
                {[5, 10, 15, 20, 30, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
            {queue.length > 0 ? (
              <Link to={`/course/${course.id}/review`} className="inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] bg-accent px-4 text-sm font-medium text-accent-ink hover:brightness-110">
                <Play className="size-4" aria-hidden /> Start review
              </Link>
            ) : (
              <Button variant="primary" disabled>
                <Play className="size-4" aria-hidden /> Start review
              </Button>
            )}
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule sm:grid-cols-4 lg:grid-cols-7">
          {statTile('Due now', stats.dueNow)}
          {statTile('New', stats.newCards)}
          {statTile('Learning', stats.learning)}
          {statTile('Review', stats.review)}
          {statTile('Difficult', stats.difficult)}
          {statTile('Reviewed today', stats.reviewedToday)}
          {statTile('Accuracy', stats.accuracy30d === undefined ? 'No data' : `${Math.round(stats.accuracy30d * 100)}%`, stats.reviews30d ? `last 30 days, ${stats.reviews30d} reviews` : undefined)}
        </dl>
      </section>

      {pending.length > 0 && (
        <section aria-labelledby="pending-h" className="rounded-[var(--radius-panel)] border border-warn/40 bg-warn-soft/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="pending-h" className="text-lg font-semibold">
                {pending.length} card{pending.length === 1 ? '' : 's'} waiting for your decision
              </h2>
              <p className="text-sm text-ink-2">Cards from study packs and the slide scanner are never studied until you approve them. Check the source for anything you are unsure about.</p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  await setCardStatus(db, pending.filter((c) => c.sources.every((s) => s.verified !== false)).map((c) => c.id), 'approved');
                  toast.show('Approved every pending card whose quotes were not contradicted by the slides.', 'ok');
                }}
              >
                <Check className="size-4" aria-hidden /> Approve all with no source problems
              </Button>
            </div>
          </div>
          <ul className="mt-3 flex flex-col gap-3">
            {pending.slice(0, 20).map((c) => (
              <li key={c.id} className="rounded-[var(--radius-panel)] border border-rule bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                  <span className="font-medium text-ink-2">{CARD_TYPE_LABEL[c.type]}</span>
                  {lectureTitle(c.lectureId) && <span>{lectureTitle(c.lectureId)}</span>}
                  <BasisChip basis={c.basis} sources={c.sources} />
                  <SourceStatusChip sources={c.sources} />
                  {c.origin === 'auto' && <span className="rounded bg-sunken px-1.5">auto-extracted, check it</span>}
                </div>
                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-xs font-medium text-ink-3">Front</p>
                    <LazyMarkdown>{c.front}</LazyMarkdown>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-ink-3">Back</p>
                    <LazyMarkdown>{c.back}</LazyMarkdown>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <SourceList sources={c.sources} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => void setCardStatus(db, [c.id], 'approved')}>
                      <Check className="size-4" aria-hidden /> Approve
                    </Button>
                    <Button size="sm" onClick={() => setEditing(c)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void setCardStatus(db, [c.id], 'rejected')}>
                      <X className="size-4" aria-hidden /> Reject
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {pending.length > 20 && <p className="mt-2 text-sm text-ink-2">Showing the first 20. Approve or reject these and the rest will appear.</p>}
        </section>
      )}

      <section aria-labelledby="all-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="all-h" className="text-lg font-semibold">
            All cards ({cards.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> New card
            </Button>
            <Button size="sm" onClick={() => setDrafting(true)} disabled={lectures.length === 0}>
              <WandSparkles className="size-4" aria-hidden /> Draft from slides
            </Button>
          </div>
        </div>

        {cards.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No flashcards yet">
              Add cards by hand, let the app draft some from your slides (no AI needed), or import a study pack made with your own AI from the “Study packs” menu above.
            </EmptyState>
          </div>
        ) : (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <label className="sr-only" htmlFor="cf-q">
                Search cards
              </label>
              <TextInput id="cf-q" type="search" placeholder="Search cards" value={text} onChange={(e) => setText(e.target.value)} />
              <label className="sr-only" htmlFor="cf-status">
                Status
              </label>
              <Select id="cf-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="approved">Approved</option>
                <option value="pending">Waiting for review</option>
                <option value="rejected">Rejected</option>
              </Select>
              <label className="sr-only" htmlFor="cf-lecture">
                Lecture
              </label>
              <Select id="cf-lecture" value={lectureFilter} onChange={(e) => setLectureFilter(e.target.value)}>
                <option value="">All lectures</option>
                {lectures.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </Select>
              <label className="sr-only" htmlFor="cf-type">
                Kind
              </label>
              <Select id="cf-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="">All kinds</option>
                {CARD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CARD_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
            <p className="mt-2 text-sm text-ink-2" aria-live="polite">
              {shown.length} shown
              {status === 'rejected' && shown.length > 0 && (
                <>
                  {' '}
                  <button type="button" className="text-bad underline underline-offset-2" onClick={() => setDeleting(shown)}>
                    Delete these {shown.length}
                  </button>
                </>
              )}
            </p>
            <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
              {shown.slice(0, 200).map((c) => (
                <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="line-clamp-2 font-serif text-[1rem]">{c.front.replace(/[*_`$]/g, '')}</p>
                    <p className="mt-0.5 line-clamp-1 text-sm text-ink-2">{c.back.replace(/[*_`$]/g, '')}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                      <span>{CARD_TYPE_LABEL[c.type]}</span>
                      {lectureTitle(c.lectureId) && <span>{lectureTitle(c.lectureId)}</span>}
                      <span>{c.status === 'approved' ? stateLabel(c, now) : c.status === 'pending' ? 'Waiting for review' : 'Rejected'}</span>
                      {c.fsrs.lapses > 0 && <span>{c.fsrs.lapses} lapse{c.fsrs.lapses === 1 ? '' : 's'}</span>}
                      <BasisChip basis={c.basis} sources={c.sources} />
                    </p>
                  </div>
                  <Menu
                    label={`Actions for card: ${c.front.slice(0, 40)}`}
                    items={[
                      { label: 'Edit', icon: <FilePen className="size-4" aria-hidden />, onSelect: () => setEditing(c) },
                      ...(c.status !== 'approved' ? [{ label: 'Approve', icon: <Check className="size-4" aria-hidden />, onSelect: () => void setCardStatus(db, [c.id], 'approved') }] : []),
                      ...(c.status !== 'rejected' ? [{ label: 'Reject', icon: <X className="size-4" aria-hidden />, onSelect: () => void setCardStatus(db, [c.id], 'rejected') }] : []),
                      { label: 'Delete', icon: <Trash2 className="size-4" aria-hidden />, danger: true, onSelect: () => setDeleting([c]) },
                    ]}
                  />
                </li>
              ))}
            </ul>
            {shown.length > 200 && <p className="mt-2 text-sm text-ink-2">Showing the 200 newest. Use the filters to narrow the list.</p>}
          </>
        )}
      </section>

      <CardEditor open={creating || !!editing} onClose={() => { setCreating(false); setEditing(undefined); }} courseId={course.id} lectures={lectures} card={editing} />

      <DraftDialog open={drafting} onClose={() => setDrafting(false)} courseId={course.id} lectures={lectures} existing={cards} />

      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        title={`Delete ${deleting?.length ?? 0} card${deleting?.length === 1 ? '' : 's'}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleting) return;
                await deleteCards(db, deleting.map((c) => c.id));
                toast.show('Deleted.', 'ok');
                setDeleting(undefined);
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">The cards and their review history will be removed from this device. This cannot be undone.</p>
      </Dialog>
    </div>
  );
}

function DraftDialog({ open, onClose, courseId, lectures, existing }: { open: boolean; onClose: () => void; courseId: string; lectures: import('@/core/db/db').LectureRow[]; existing: CardRow[] }) {
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(false);
  if (open && !seen) {
    setSeen(true);
    setPicked(new Set(lectures.map((l) => l.id)));
  }
  if (!open && seen) setSeen(false);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Draft cards from your slides"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={picked.size === 0 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const have = new Set(existing.map((c) => `${c.front}\u0000${c.back}`));
                let added = 0;
                for (const l of lectures.filter((x) => picked.has(x.id))) {
                  const { cards } = draftCardsFromLecture(l, await loadSlides(db, l.id));
                  const base = Date.now();
                  for (const [i, card] of cards.entries()) {
                    if (have.has(`${card.front}\u0000${card.back}`)) continue;
                    await createCard(db, { ...card, courseId }, base + i);
                    added += 1;
                  }
                }
                toast.show(added ? `${added} draft card${added === 1 ? '' : 's'} added for your review.` : 'Nothing new was found. The scanner only recognises “bold term: explanation” lines and tables.', added ? 'ok' : 'info');
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            Scan slides
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-ink-2">
          This is a simple rule-based scanner, not AI. It looks for a bold term followed by its explanation (for example “<strong>Decidable language</strong>: a language for which…”) and for tables. Drafts are never studied until you approve them.
        </p>
        <ul className="max-h-52 overflow-y-auto rounded-[var(--radius-control)] border border-rule">
          {lectures.map((l) => (
            <li key={l.id}>
              <label className="flex min-h-10 cursor-pointer items-center gap-2.5 px-3 hover:bg-sunken">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={picked.has(l.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(l.id);
                    else next.delete(l.id);
                    setPicked(next);
                  }}
                />
                <span className="min-w-0 flex-1 truncate">{l.title}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
