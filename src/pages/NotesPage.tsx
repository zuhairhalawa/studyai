import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router';
import { FilePlus2, ScrollText, WandSparkles } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { loadSlides } from '@/core/db/library';
import { lectureNotesFromSlides, notesFromCards } from '@/core/study/notes';
import { createNote } from '@/core/study/store';
import { NOTE_KINDS, NOTE_KIND_LABEL, type NoteKind } from '@/core/study/types';
import { useCards, useNotes } from '@/app/data';
import { useToast } from '@/app/toast';
import { Button, Dialog, EmptyState, Field, Select, Spinner, TextInput } from '@/ui/primitives';
import type { CourseCtx } from './CourseLayout';

const db = getDb();

export function NotesPage() {
  const { course, lectures } = useOutletContext<CourseCtx>();
  const notes = useNotes(course.id);
  const cards = useCards(course.id);
  const toast = useToast();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sheeting, setSheeting] = useState(false);

  if (!notes || !cards) return <Spinner />;

  const lectureTitle = (id?: string) => lectures.find((l) => l.id === id)?.title;
  const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Notes</h2>
          <p className="text-sm text-ink-2">Your notes stay available offline. Every block shows where it came from, and anything you edit becomes yours.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setCreating(true)}>
            <FilePlus2 className="size-4" aria-hidden /> New note
          </Button>
          <Button onClick={() => setGenerating(true)} disabled={lectures.length === 0}>
            <WandSparkles className="size-4" aria-hidden /> Notes from slides
          </Button>
          <Button onClick={() => setSheeting(true)} disabled={cards.filter((c) => c.status === 'approved').length === 0}>
            <ScrollText className="size-4" aria-hidden /> Revision sheet from flashcards
          </Button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="No notes yet">Start from your slides: “Notes from slides” builds complete, editable lecture notes in lecture order, with every block linked to its slide. You can also write your own or import notes in a study pack.</EmptyState>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
          {sorted.map((n) => {
            const mine = n.blocks.filter((b) => b.origin === 'user').length;
            return (
              <li key={n.id}>
                <Link to={`/course/${course.id}/notes/${n.id}`} className="grid gap-x-4 gap-y-0.5 px-4 py-3 hover:bg-sunken md:grid-cols-[minmax(0,1fr)_13rem_8rem]">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{n.title}</span>
                    <span className="block truncate text-[13px] text-ink-3">
                      {NOTE_KIND_LABEL[n.kind]}
                      {lectureTitle(n.lectureId) ? `, ${lectureTitle(n.lectureId)}` : ''}
                    </span>
                  </span>
                  <span className="text-sm text-ink-2">
                    {n.blocks.length} block{n.blocks.length === 1 ? '' : 's'}
                    {mine > 0 ? `, ${mine} written by you` : ''}
                  </span>
                  <span className="text-sm text-ink-3 md:text-right">{new Date(n.updatedAt).toLocaleDateString()}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <NewNoteDialog
        open={creating}
        onClose={() => setCreating(false)}
        lectures={lectures}
        onCreate={async (title, kind, lectureId) => {
          const n = await createNote(db, { courseId: course.id, title, kind, ...(lectureId ? { lectureId } : {}), blocks: [{ text: '', origin: 'user', basis: 'outside', sources: [] }] });
          setCreating(false);
          navigate(`/course/${course.id}/notes/${n.id}`);
        }}
      />

      <PickLecturesDialog
        open={generating}
        onClose={() => setGenerating(false)}
        title="Notes from your slides"
        action="Create notes"
        lectures={lectures}
        description="Creates one editable note per lecture, with a block for every visible slide in lecture order. The text is exactly what was extracted from the slide, and each block links back to it. This is not AI-written."
        onConfirm={async (ids) => {
          let made = 0;
          for (const l of lectures.filter((x) => ids.has(x.id))) {
            const blocks = lectureNotesFromSlides(l, await loadSlides(db, l.id));
            await createNote(db, { courseId: course.id, lectureId: l.id, title: `${l.title}: lecture notes`, kind: 'lecture-notes', blocks });
            made += 1;
          }
          toast.show(`Created ${made} note${made === 1 ? '' : 's'}.`, 'ok');
        }}
      />

      <SheetDialog
        open={sheeting}
        onClose={() => setSheeting(false)}
        onCreate={async (kind) => {
          const blocks = notesFromCards(cards, kind);
          if (blocks.length === 0) {
            toast.show(`None of your approved flashcards are ${NOTE_KIND_LABEL[kind].toLowerCase()} cards yet.`, 'info');
            return;
          }
          const n = await createNote(db, { courseId: course.id, title: `${course.name}: ${NOTE_KIND_LABEL[kind].toLowerCase()}`, kind, blocks });
          setSheeting(false);
          navigate(`/course/${course.id}/notes/${n.id}`);
        }}
      />
    </div>
  );
}

function NewNoteDialog({ open, onClose, lectures, onCreate }: { open: boolean; onClose: () => void; lectures: { id: string; title: string }[]; onCreate: (title: string, kind: NoteKind, lectureId?: string) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<NoteKind>('custom');
  const [lectureId, setLectureId] = useState('');
  const [seen, setSeen] = useState(false);
  if (open && !seen) {
    setSeen(true);
    setTitle('');
    setKind('custom');
    setLectureId('');
  }
  if (!open && seen) setSeen(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New note"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="note-form" disabled={!title.trim()}>
            Create note
          </Button>
        </>
      }
    >
      <form
        id="note-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void onCreate(title, kind, lectureId || undefined);
        }}
      >
        <Field label="Title" htmlFor="note-title">
          <TextInput id="note-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Kind" htmlFor="note-kind">
          <Select id="note-kind" value={kind} onChange={(e) => setKind(e.target.value as NoteKind)}>
            {NOTE_KINDS.map((k) => (
              <option key={k} value={k}>
                {NOTE_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="About which lecture?" htmlFor="note-lecture">
          <Select id="note-lecture" value={lectureId} onChange={(e) => setLectureId(e.target.value)}>
            <option value="">The whole course</option>
            {lectures.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}

function PickLecturesDialog({ open, onClose, title, action, description, lectures, onConfirm }: { open: boolean; onClose: () => void; title: string; action: string; description: string; lectures: { id: string; title: string }[]; onConfirm: (ids: Set<string>) => Promise<void> }) {
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
      title={title}
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
                await onConfirm(picked);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Working' : action}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-ink-2">{description}</p>
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

function SheetDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (kind: NoteKind) => Promise<void> }) {
  const [kind, setKind] = useState<NoteKind>('definitions');
  const options: NoteKind[] = ['definitions', 'formulas', 'comparison', 'revision-sheet'];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Revision sheet from flashcards"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onCreate(kind)}>
            Create sheet
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-ink-2">Collects your approved flashcards into one printable page. Each entry keeps its source and where it came from.</p>
        <Field label="Which sheet?" htmlFor="sheet-kind">
          <Select id="sheet-kind" value={kind} onChange={(e) => setKind(e.target.value as NoteKind)}>
            {options.map((k) => (
              <option key={k} value={k}>
                {NOTE_KIND_LABEL[k]}
                {k === 'revision-sheet' ? ' (definitions, concepts, formulas and comparisons)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
