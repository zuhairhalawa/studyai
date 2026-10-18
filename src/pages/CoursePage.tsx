import { useRef, useState, type DragEvent } from 'react';
import { Link, useOutletContext } from 'react-router';
import { ArrowDown, ArrowUp, Download, FilePlus2, FileUp, Pencil, RefreshCw, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { getDb, type LectureRow } from '@/core/db/db';
import { deleteLecture, renameLecture, reorderLectures } from '@/core/db/library';
import { useToast } from '@/app/toast';
import { useImporter, type ImportItem } from '@/app/useImporter';
import { Button, Callout, ConfidencePill, Dialog, EmptyState, Field, formatBytes, Spinner, TextInput } from '@/ui/primitives';
import { Menu } from '@/ui/Menu';
import type { CourseCtx } from './CourseLayout';

const db = getDb();

export function CoursePage() {
  const { course, lectures } = useOutletContext<CourseCtx>();
  const importer = useImporter(course.id);
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState<LectureRow | undefined>();
  const [deleting, setDeleting] = useState<LectureRow | undefined>();

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) importer.enqueue(files);
  };

  const move = async (index: number, delta: number) => {
    const ids = lectures.map((l) => l.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    try {
      await reorderLectures(db, course.id, ids);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not reorder.', 'error');
    }
  };

  const download = async (l: LectureRow) => {
    const row = await db.files.get(l.id);
    if (!row) {
      toast.show('The original file is not stored for this lecture.', 'error');
      return;
    }
    const url = URL.createObjectURL(row.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = l.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => fileInput.current?.click()}>
          <FilePlus2 className="size-4" aria-hidden /> Add lectures
        </Button>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".pptx,.pptm,.ppsx,.potx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        className="sr-only"
        aria-label="Choose PowerPoint files"
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files?.length) importer.enqueue([...e.target.files]);
          e.target.value = '';
        }}
      />
      <input
        ref={replaceInput}
        type="file"
        accept=".pptx,.pptm,.ppsx,.potx"
        className="sr-only"
        aria-label="Choose the updated PowerPoint file"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && replaceTarget.current) importer.enqueue([f], replaceTarget.current);
          e.target.value = '';
        }}
      />

      <section
        aria-label="Upload"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`mt-6 rounded-[var(--radius-panel)] border-2 border-dashed px-5 py-6 text-center transition-colors ${dragging ? 'border-accent bg-accent-soft' : 'border-rule-strong'}`}
      >
        <Upload className="mx-auto size-5 text-ink-3" aria-hidden />
        <p className="mt-2 text-sm text-ink">
          Drop PowerPoint files here, or{' '}
          <button type="button" className="font-medium text-accent underline underline-offset-2" onClick={() => fileInput.current?.click()}>
            choose files
          </button>
        </p>
        <p className="mt-1 text-[13px] text-ink-3">Files are read on this device and never uploaded. You can add many at once.</p>
      </section>

      {importer.items.length > 0 && <ImportQueue items={importer.items} onDecide={importer.decide} onClear={importer.clearFinished} />}

      <section className="mt-8" aria-labelledby="lectures-h">
        <h2 id="lectures-h" className="text-lg font-semibold">
          Lectures
        </h2>
        {lectures.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No lectures yet" action={<Button variant="primary" onClick={() => fileInput.current?.click()}><FileUp className="size-4" aria-hidden /> Add your first lecture</Button>}>
              Add the PowerPoint files your professor gave you. They are split into slides you can read, search and study from.
            </EmptyState>
          </div>
        ) : (
          <ol className="mt-3 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
            {lectures.map((l, i) => {
              const attn = l.report.slidesRequiringAttention.length;
              return (
                <li key={l.id} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-3 lg:grid-cols-[2rem_minmax(0,1fr)_6rem_11rem_auto] lg:px-4">
                  <span className="text-sm tabular-nums text-ink-3" aria-label={`Lecture ${i + 1}`}>
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <Link to={`/lecture/${l.id}`} className="block truncate font-medium text-ink hover:text-accent">
                      {l.title}
                    </Link>
                    <p className="truncate text-[13px] text-ink-3">
                      {l.fileName} <span className="sr-only">,</span> {formatBytes(l.fileSize)}
                    </p>
                  </div>
                  <p className="col-start-2 text-sm text-ink-2 lg:col-start-auto">{l.slideCount} slides</p>
                  <div className="col-start-2 flex items-center gap-2 lg:col-start-auto">
                    <ConfidencePill value={l.report.confidenceLabel} />
                    {attn > 0 && (
                      <Link to={`/lecture/${l.id}/report`} className="inline-flex items-center gap-1 text-[13px] text-bad underline underline-offset-2">
                        <TriangleAlert className="size-3.5" aria-hidden /> {attn} to check
                      </Link>
                    )}
                  </div>
                  <div className="col-start-3 row-start-1 flex items-center lg:col-start-auto lg:row-start-auto">
                    <button type="button" aria-label={`Move ${l.title} up`} title="Move up" disabled={i === 0} onClick={() => void move(i, -1)} className="hidden size-9 items-center justify-center rounded text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-30 lg:inline-flex">
                      <ArrowUp className="size-4" aria-hidden />
                    </button>
                    <button type="button" aria-label={`Move ${l.title} down`} title="Move down" disabled={i === lectures.length - 1} onClick={() => void move(i, 1)} className="hidden size-9 items-center justify-center rounded text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-30 lg:inline-flex">
                      <ArrowDown className="size-4" aria-hidden />
                    </button>
                    <Menu
                      label={`Actions for ${l.title}`}
                      items={[
                        { label: 'Rename', icon: <Pencil className="size-4" aria-hidden />, onSelect: () => setRenaming(l) },
                        {
                          label: 'Replace with a newer file',
                          icon: <RefreshCw className="size-4" aria-hidden />,
                          onSelect: () => {
                            replaceTarget.current = l.id;
                            replaceInput.current?.click();
                          },
                        },
                        { label: 'Download original file', icon: <Download className="size-4" aria-hidden />, onSelect: () => void download(l) },
                        { label: 'Move up', icon: <ArrowUp className="size-4" aria-hidden />, onSelect: () => void move(i, -1), disabled: i === 0 },
                        { label: 'Move down', icon: <ArrowDown className="size-4" aria-hidden />, onSelect: () => void move(i, 1), disabled: i === lectures.length - 1 },
                        { label: 'Delete lecture', icon: <Trash2 className="size-4" aria-hidden />, onSelect: () => setDeleting(l), danger: true },
                      ]}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <RenameDialog lecture={renaming} onClose={() => setRenaming(undefined)} />
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        title="Delete this lecture?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleting) return;
                await deleteLecture(db, deleting.id);
                toast.show(`Deleted “${deleting.title}”.`, 'ok');
                setDeleting(undefined);
              }}
            >
              Delete lecture
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          “{deleting?.title}” and its slides, images and stored original file will be removed from this device. You cannot undo this; export a backup first if you might need it.
        </p>
      </Dialog>
    </div>
  );
}

function ImportQueue({ items, onDecide, onClear }: { items: ImportItem[]; onDecide: (id: string, c: 'skip' | 'add' | 'replace') => void; onClear: () => void }) {
  const finished = items.some((i) => ['done', 'skipped', 'error'].includes(i.status));
  return (
    <section className="mt-6" aria-labelledby="queue-h" aria-live="polite">
      <div className="flex items-center justify-between">
        <h2 id="queue-h" className="text-base font-semibold">
          Importing
        </h2>
        {finished && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            Clear finished
          </Button>
        )}
      </div>
      <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
        {items.map((it) => (
          <li key={it.id} className="px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 truncate font-medium">{it.name}</p>
              <p className="text-ink-2">
                {it.status === 'queued' && 'Waiting'}
                {it.status === 'parsing' && <Spinner label={it.progress && it.progress.total ? `Reading slide ${it.progress.done} of ${it.progress.total}` : 'Opening file'} />}
                {it.status === 'saving' && <Spinner label="Saving" />}
                {it.status === 'skipped' && 'Skipped'}
                {it.status === 'done' && it.result && (
                  <span>
                    {it.result.replaced ? 'Replaced' : 'Imported'}: {it.result.slides} slides
                    {it.result.attention > 0 ? (
                      <>
                        ,{' '}
                        <Link className="text-bad underline underline-offset-2" to={`/lecture/${it.result.lectureId}/report`}>
                          {it.result.attention} need attention
                        </Link>
                      </>
                    ) : (
                      <>
                        ,{' '}
                        <Link className="text-accent underline underline-offset-2" to={`/lecture/${it.result.lectureId}`}>
                          open
                        </Link>
                      </>
                    )}
                  </span>
                )}
              </p>
            </div>
            {it.status === 'error' && (
              <div className="mt-2">
                <Callout tone="bad" title="This file could not be imported">
                  {it.error}
                </Callout>
              </div>
            )}
            {it.status === 'decision' && it.decision && (
              <div className="mt-2 rounded-[var(--radius-control)] bg-warn-soft p-3">
                {it.decision.kind === 'duplicate' && (
                  <>
                    <p className="text-ink">
                      This exact file is already in your library: {it.decision.where.map((w) => `“${w.title}” (${w.courseName})`).join(', ')}.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => onDecide(it.id, 'skip')}>
                        Skip it
                      </Button>
                      <Button size="sm" onClick={() => onDecide(it.id, 'add')}>
                        Import anyway
                      </Button>
                    </div>
                  </>
                )}
                {it.decision.kind === 'sameName' && (
                  <>
                    <p className="text-ink">
                      A lecture from a file with this name already exists: “{it.decision.existing.title}” ({it.decision.existing.slides} slides). This file has {it.decision.incoming.slides} slides.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="primary" onClick={() => onDecide(it.id, 'replace')}>
                        Replace the existing lecture
                      </Button>
                      <Button size="sm" onClick={() => onDecide(it.id, 'add')}>
                        Add as a new lecture
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onDecide(it.id, 'skip')}>
                        Skip
                      </Button>
                    </div>
                  </>
                )}
                {it.decision.kind === 'confirmReplace' && (
                  <>
                    <p className="text-ink">
                      Replace “{it.decision.existing.title}” ({it.decision.existing.slides} slides) with this file ({it.decision.incoming.slides} slides)? The lecture keeps its place and title.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => onDecide(it.id, 'replace')}>
                        Replace lecture
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onDecide(it.id, 'skip')}>
                        Cancel
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RenameDialog({ lecture, onClose }: { lecture: LectureRow | undefined; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [last, setLast] = useState<string | undefined>();
  if (lecture && last !== lecture.id) {
    setLast(lecture.id);
    setTitle(lecture.title);
  }
  const save = async () => {
    if (!lecture || !title.trim()) return;
    await renameLecture(db, lecture.id, title);
    onClose();
  };
  return (
    <Dialog
      open={!!lecture}
      onClose={onClose}
      title="Rename lecture"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="rename-form" disabled={!title.trim()}>
            Save name
          </Button>
        </>
      }
    >
      <form
        id="rename-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Lecture title" htmlFor="lecture-title">
          <TextInput id="lecture-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
      </form>
    </Dialog>
  );
}

