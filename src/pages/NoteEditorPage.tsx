import { useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router';
import { ArrowDown, ArrowUp, Download, FilePen, Plus, Printer, Trash2 } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { newId } from '@/core/id';
import { noteToHtmlDocument, noteToMarkdown, originLabel } from '@/core/study/notes';
import { deleteNote, renameNote, saveNoteBlocks } from '@/core/study/store';
import { NOTE_KIND_LABEL, type NoteBlock } from '@/core/study/types';
import { useNote } from '@/app/data';
import { useToast } from '@/app/toast';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { Menu } from '@/ui/Menu';
import { BasisChip, SourceList, SourceStatusChip } from '@/ui/study/Sources';
import { Button, Dialog, Spinner, TextArea, TextInput } from '@/ui/primitives';
import type { CourseCtx } from './CourseLayout';
import { NotFound } from './NotFound';

const db = getDb();

function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function NoteEditorPage() {
  const { noteId } = useParams();
  const { course, lectures } = useOutletContext<CourseCtx>();
  const note = useNote(noteId);
  const toast = useToast();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [title, setTitle] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);

  if (note === null) return <NotFound what="note" />;
  if (!note) return <Spinner />;

  const lectureTitle = (id: string) => lectures.find((l) => l.id === id)?.title;
  const slug = note.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'note';

  const persist = async (blocks: NoteBlock[]) => {
    try {
      await saveNoteBlocks(db, note.id, blocks);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not save the note.', 'error');
    }
  };

  const startEdit = (b: NoteBlock) => {
    setEditing(b.id);
    setDraft(b.text);
  };

  const move = (i: number, d: number) => {
    const next = [...note.blocks];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    void persist(next);
  };

  return (
    <div>
      <nav aria-label="Breadcrumb" className="text-[13px] text-ink-3 print:hidden">
        <Link to={`/course/${course.id}/notes`} className="hover:underline">
          Notes
        </Link>
      </nav>
      <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <label htmlFor="note-title-input" className="sr-only">
            Note title
          </label>
          <TextInput
            id="note-title-input"
            value={title ?? note.title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={async () => {
              if (title !== undefined && title.trim() && title.trim() !== note.title) await renameNote(db, note.id, title);
              setTitle(undefined);
            }}
            className="min-h-11 border-transparent bg-transparent px-0 text-2xl font-semibold tracking-tight hover:border-rule focus-visible:border-rule print:border-0"
          />
          <p className="text-sm text-ink-3">
            {NOTE_KIND_LABEL[note.kind]}
            {note.lectureId && lectureTitle(note.lectureId) ? `, ${lectureTitle(note.lectureId)}` : ''}
          </p>
        </div>
        <div className="flex gap-2 print:hidden">
          <Menu
            label="Export this note"
            text="Export"
            icon={<Download className="size-4" aria-hidden />}
            items={[
              { label: 'Markdown (.md)', onSelect: () => download(`${slug}.md`, 'text/markdown', noteToMarkdown(note, lectureTitle)) },
              { label: 'Web page (.html)', onSelect: () => void noteToHtmlDocument(note, lectureTitle).then((h) => download(`${slug}.html`, 'text/html', h)) },
            ]}
          />
          <Button onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> Print or save as PDF
          </Button>
          <Button variant="danger" onClick={() => setDeleting(true)} aria-label="Delete note">
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      <ol className="mt-6 flex flex-col gap-4">
        {note.blocks.map((b, i) => (
          <li key={b.id} className="rounded-[var(--radius-panel)] border border-rule bg-surface p-4 print:break-inside-avoid print:border-0 print:p-0">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3 print:hidden">
              <span className={`font-medium ${b.origin === 'user' ? 'text-accent' : 'text-ink-2'}`}>{originLabel(b.origin)}</span>
              <BasisChip basis={b.basis} sources={b.sources} />
              {b.sources.length > 0 && <SourceStatusChip sources={b.sources} />}
            </div>
            {editing === b.id ? (
              <div className="grid gap-3 lg:grid-cols-2">
                <div>
                  <label htmlFor={`edit-${b.id}`} className="mb-1 block text-sm font-medium">
                    Edit (markdown; maths as $x^2$)
                  </label>
                  <TextArea id={`edit-${b.id}`} rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-mono text-[13px]" autoFocus />
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={async () => {
                        await persist(note.blocks.map((x) => (x.id === b.id ? { ...x, text: draft } : x)));
                        setEditing(undefined);
                      }}
                    >
                      Save block
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>
                      Cancel
                    </Button>
                  </div>
                  {b.origin !== 'user' && <p className="mt-2 text-[13px] text-ink-3">Saving changes marks this block as written by you. Its sources stay attached.</p>}
                </div>
                <div>
                  <p className="mb-1 text-sm font-medium">Preview</p>
                  <div className="rounded-[var(--radius-control)] border border-rule bg-sunken/40 p-3">{draft.trim() ? <LazyMarkdown>{draft}</LazyMarkdown> : <span className="text-sm text-ink-3">Nothing yet</span>}</div>
                </div>
              </div>
            ) : (
              <>
                {b.text.trim() ? <LazyMarkdown>{b.text}</LazyMarkdown> : <p className="text-sm text-ink-3">Empty block. Choose Edit to write something.</p>}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
                  <SourceList sources={b.sources} />
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(b)}>
                      <FilePen className="size-4" aria-hidden /> Edit
                    </Button>
                    <button type="button" aria-label="Move block up" title="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="inline-flex size-8 items-center justify-center rounded text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-30">
                      <ArrowUp className="size-4" aria-hidden />
                    </button>
                    <button type="button" aria-label="Move block down" title="Move down" disabled={i === note.blocks.length - 1} onClick={() => move(i, 1)} className="inline-flex size-8 items-center justify-center rounded text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-30">
                      <ArrowDown className="size-4" aria-hidden />
                    </button>
                    <button type="button" aria-label="Delete block" title="Delete block" onClick={() => void persist(note.blocks.filter((x) => x.id !== b.id))} className="inline-flex size-8 items-center justify-center rounded text-ink-3 hover:bg-bad-soft hover:text-bad">
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </div>
                </div>
              </>
            )}
          </li>
        ))}
      </ol>

      <div className="mt-4 print:hidden">
        <Button
          onClick={async () => {
            const nb: NoteBlock = { id: newId(), text: '', origin: 'user', basis: 'outside', sources: [], updatedAt: Date.now() };
            await persist([...note.blocks, nb]);
            startEdit(nb);
          }}
        >
          <Plus className="size-4" aria-hidden /> Add a block
        </Button>
      </div>

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete this note?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await deleteNote(db, note.id);
                toast.show('Note deleted.', 'ok');
                navigate(`/course/${course.id}/notes`);
              }}
            >
              Delete note
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">“{note.title}” and everything you wrote in it will be removed from this device.</p>
      </Dialog>
    </div>
  );
}
