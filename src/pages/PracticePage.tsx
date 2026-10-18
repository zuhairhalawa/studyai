import { useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router';
import { Check, FilePen, ListChecks, Pencil, Plus, Trash2, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { createExam, startAttempt, deleteAttempt } from '@/core/study/attempts';
import { missedQuestionIds, scoreAttempt, weakTopics } from '@/core/study/exam';
import { deleteQuestions, setQuestionStatus } from '@/core/study/store';
import { QUESTION_TYPES, QUESTION_TYPE_LABEL, type AttemptRow, type ExamConfig, type QuestionRow } from '@/core/study/types';
import { useAttempts, useExams, useQuestions } from '@/app/data';
import { useToast } from '@/app/toast';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { Menu } from '@/ui/Menu';
import { ExamBuilder } from '@/ui/study/ExamBuilder';
import { QuestionEditor } from '@/ui/study/QuestionEditor';
import { BasisChip, SourceList, SourceStatusChip } from '@/ui/study/Sources';
import { Button, Dialog, EmptyState, Select, Spinner, TextInput } from '@/ui/primitives';
import type { CourseCtx } from './CourseLayout';

const db = getDb();

export function PracticePage() {
  const { course, lectures } = useOutletContext<CourseCtx>();
  const bank = useQuestions(course.id);
  const exams = useExams(course.id);
  const attempts = useAttempts(course.id);
  const toast = useToast();
  const navigate = useNavigate();
  const [building, setBuilding] = useState(false);
  const [preset, setPreset] = useState<Partial<ExamConfig> | undefined>();
  const [editing, setEditing] = useState<QuestionRow | undefined>();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<QuestionRow[] | undefined>();
  const [text, setText] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [lectureFilter, setLectureFilter] = useState('');

  const byId = useMemo(() => new Map((bank ?? []).map((q) => [q.id, q])), [bank]);
  const examById = useMemo(() => new Map((exams ?? []).map((e) => [e.id, e])), [exams]);
  const weak = useMemo(() => weakTopics(attempts ?? [], byId, 2, 60), [attempts, byId]);

  if (!bank || !exams || !attempts) return <Spinner />;

  const approved = bank.filter((q) => q.status === 'approved');
  const pending = bank.filter((q) => q.status === 'pending');
  const lectureTitle = (id: string) => lectures.find((l) => l.id === id)?.title;
  const q = text.trim().toLowerCase();
  const shown = bank
    .filter((x) => !typeFilter || x.type === typeFilter)
    .filter((x) => !statusFilter || x.status === statusFilter)
    .filter((x) => !lectureFilter || x.lectureIds.includes(lectureFilter))
    .filter((x) => !q || x.prompt.toLowerCase().includes(q) || (x.topic ?? '').toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);

  const open = (p?: Partial<ExamConfig>) => {
    setPreset(p);
    setBuilding(true);
  };

  const repeatMissed = async (a: AttemptRow) => {
    const exam = examById.get(a.examId);
    if (!exam) return;
    const score = scoreAttempt(exam.questionIds.map((id) => byId.get(id)).filter((x): x is QuestionRow => !!x), a);
    const ids = missedQuestionIds(score);
    if (ids.length === 0) {
      toast.show('You earned full marks on every question in that attempt.', 'ok');
      return;
    }
    const e = await createExam(db, course.id, { ...exam.config, title: `Repeat: ${exam.config.title}`, count: ids.length, totalMarks: undefined }, ids);
    navigate(`/exam/${(await startAttempt(db, e.id)).id}`);
  };

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="prac-h">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="prac-h" className="text-lg font-semibold">
              Practice and exams
            </h2>
            <p className="text-sm text-ink-2">
              {approved.length === 0 ? 'Add or import questions, then build an exam from them.' : `${approved.length} approved question${approved.length === 1 ? '' : 's'} in your bank.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => open()} disabled={approved.length === 0}>
              <ListChecks className="size-4" aria-hidden /> Build an exam
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> New question
            </Button>
          </div>
        </div>
      </section>

      {weak.length > 0 && (
        <section aria-labelledby="weak-h" className="rounded-[var(--radius-panel)] border border-rule bg-surface p-4">
          <h3 id="weak-h" className="font-semibold">
            Topics to revise
          </h3>
          <p className="text-sm text-ink-2">Marks you lost most across your submitted exams.</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {weak.slice(0, 6).map((w) => (
              <li key={w.topic} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
                <span className="truncate">{w.topic}</span>
                <span className="tabular-nums text-bad">
                  {w.percent}% <span className="text-ink-3">({w.earned}/{w.max} marks)</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button size="sm" onClick={() => open({ topics: weak.map((w) => w.topic), title: `${course.name}: weak topics` })}>
              Practise these topics
            </Button>
          </div>
        </section>
      )}

      {attempts.length > 0 && (
        <section aria-labelledby="hist-h">
          <h3 id="hist-h" className="text-base font-semibold">
            Your exams
          </h3>
          <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
            {attempts.map((a) => {
              const exam = examById.get(a.examId);
              const qs = (exam?.questionIds ?? []).map((id) => byId.get(id)).filter((x): x is QuestionRow => !!x);
              const score = a.status === 'submitted' ? scoreAttempt(qs, a) : undefined;
              return (
                <li key={a.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{exam?.config.title ?? 'Exam'}</p>
                    <p className="text-[13px] text-ink-3">
                      {new Date(a.startedAt).toLocaleString()}
                      {a.status === 'in-progress' ? ', in progress' : score ? `, ${score.earned} of ${score.max} marks (${score.percent}%)${score.complete ? '' : `, ${score.pending} to mark`}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.status === 'in-progress' ? (
                      <Link to={`/exam/${a.id}`} className="inline-flex min-h-9 items-center rounded-[var(--radius-control)] bg-accent px-3 text-sm font-medium text-accent-ink hover:brightness-110">
                        Resume
                      </Link>
                    ) : (
                      <>
                        <Link to={`/exam/${a.id}/results`} className="inline-flex min-h-9 items-center rounded-[var(--radius-control)] border border-rule-strong bg-surface px-3 text-sm font-medium hover:bg-sunken">
                          {score && !score.complete ? 'Mark and review' : 'Review'}
                        </Link>
                        <Button size="sm" variant="ghost" onClick={() => void repeatMissed(a)}>
                          Repeat missed
                        </Button>
                      </>
                    )}
                    <Menu
                      label={`Actions for ${exam?.config.title ?? 'exam'}`}
                      items={[
                        ...(exam ? [{ label: 'Printable paper', onSelect: () => navigate(`/exam/${exam.id}/paper`) }] : []),
                        { label: 'Delete this attempt', icon: <Trash2 className="size-4" aria-hidden />, danger: true, onSelect: () => void deleteAttempt(db, a.id) },
                      ]}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {pending.length > 0 && (
        <section aria-labelledby="qpend-h" className="rounded-[var(--radius-panel)] border border-warn/40 bg-warn-soft/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 id="qpend-h" className="text-base font-semibold">
                {pending.length} question{pending.length === 1 ? '' : 's'} waiting for your decision
              </h3>
              <p className="text-sm text-ink-2">Imported questions are never used in exams until you approve them. Check the model answer and source first.</p>
            </div>
            <Button size="sm" variant="primary" onClick={() => void setQuestionStatus(db, pending.filter((x) => x.sources.every((s) => s.verified !== false)).map((x) => x.id), 'approved')}>
              <Check className="size-4" aria-hidden /> Approve all with no source problems
            </Button>
          </div>
          <ul className="mt-3 flex flex-col gap-3">
            {pending.slice(0, 15).map((x) => (
              <li key={x.id} className="rounded-[var(--radius-panel)] border border-rule bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                  <span className="font-medium text-ink-2">{QUESTION_TYPE_LABEL[x.type]}</span>
                  <span>{x.marks} marks</span>
                  {x.topic && <span>{x.topic}</span>}
                  <BasisChip basis={x.basis} sources={x.sources} />
                  <SourceStatusChip sources={x.sources} />
                </div>
                <div className="mt-2">
                  <LazyMarkdown>{x.prompt}</LazyMarkdown>
                </div>
                {x.modelAnswer && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-accent">Model answer and marking points</summary>
                    <div className="mt-2 rounded-[var(--radius-control)] bg-sunken/50 p-3 text-sm">
                      <LazyMarkdown>{x.modelAnswer}</LazyMarkdown>
                      {x.rubric.length > 0 && (
                        <ul className="mt-2 list-disc pl-5 text-ink-2">
                          {x.rubric.map((r) => (
                            <li key={r.id}>
                              {r.text} ({r.marks})
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </details>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <SourceList sources={x.sources} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => void setQuestionStatus(db, [x.id], 'approved')}>
                      <Check className="size-4" aria-hidden /> Approve
                    </Button>
                    <Button size="sm" onClick={() => setEditing(x)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void setQuestionStatus(db, [x.id], 'rejected')}>
                      <X className="size-4" aria-hidden /> Reject
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="bank-h">
        <h3 id="bank-h" className="text-base font-semibold">
          Question bank ({bank.length})
        </h3>
        {bank.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No questions yet">Write your own questions, or create a study pack with your own AI (from the “Study packs” menu above) and import it. Every question keeps its model answer, marking points and the slides it comes from.</EmptyState>
          </div>
        ) : (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <label className="sr-only" htmlFor="qf-q">
                Search questions
              </label>
              <TextInput id="qf-q" type="search" placeholder="Search questions" value={text} onChange={(e) => setText(e.target.value)} />
              <label className="sr-only" htmlFor="qf-type">
                Kind
              </label>
              <Select id="qf-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="">All kinds</option>
                {QUESTION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {QUESTION_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
              <label className="sr-only" htmlFor="qf-status">
                Status
              </label>
              <Select id="qf-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="approved">Approved</option>
                <option value="pending">Waiting for review</option>
                <option value="rejected">Rejected</option>
              </Select>
              <label className="sr-only" htmlFor="qf-lec">
                Lecture
              </label>
              <Select id="qf-lec" value={lectureFilter} onChange={(e) => setLectureFilter(e.target.value)}>
                <option value="">All lectures</option>
                {lectures.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </Select>
            </div>
            <p className="mt-2 text-sm text-ink-2" aria-live="polite">
              {shown.length} shown
            </p>
            <ul className="mt-2 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
              {shown.slice(0, 200).map((x) => (
                <li key={x.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="line-clamp-2 font-serif text-[1rem]">{x.prompt.replace(/[*_`$]/g, '')}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                      <span>{QUESTION_TYPE_LABEL[x.type]}</span>
                      <span>{x.marks} marks</span>
                      <span>{['', 'Easy', 'Medium', 'Hard'][x.difficulty]}</span>
                      {x.topic && <span>{x.topic}</span>}
                      {x.lectureIds[0] && <span>{lectureTitle(x.lectureIds[0])}</span>}
                      <span>{x.status === 'approved' ? 'Approved' : x.status === 'pending' ? 'Waiting for review' : 'Rejected'}</span>
                      <BasisChip basis={x.basis} sources={x.sources} />
                    </p>
                  </div>
                  <Menu
                    label={`Actions for question: ${x.prompt.slice(0, 40)}`}
                    items={[
                      { label: 'Edit', icon: <FilePen className="size-4" aria-hidden />, onSelect: () => setEditing(x) },
                      ...(x.status !== 'approved' ? [{ label: 'Approve', icon: <Check className="size-4" aria-hidden />, onSelect: () => void setQuestionStatus(db, [x.id], 'approved') }] : []),
                      ...(x.status !== 'rejected' ? [{ label: 'Reject', icon: <X className="size-4" aria-hidden />, onSelect: () => void setQuestionStatus(db, [x.id], 'rejected') }] : []),
                      { label: 'Delete', icon: <Trash2 className="size-4" aria-hidden />, danger: true, onSelect: () => setDeleting([x]) },
                    ]}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <ExamBuilder open={building} onClose={() => setBuilding(false)} course={course} lectures={lectures} bank={bank} attempts={attempts} preset={preset} />
      <QuestionEditor open={creating || !!editing} onClose={() => { setCreating(false); setEditing(undefined); }} courseId={course.id} lectures={lectures} question={editing} />
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        title="Delete this question?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(undefined)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!deleting) return;
                await deleteQuestions(db, deleting.map((d) => d.id));
                toast.show('Question deleted.', 'ok');
                setDeleting(undefined);
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">Past exams that used it keep their results, but the question text will no longer be available to review.</p>
      </Dialog>
    </div>
  );
}
