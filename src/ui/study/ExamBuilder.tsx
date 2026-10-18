import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { getDb, type CourseRow, type LectureRow } from '@/core/db/db';
import { filterBank, selectQuestions, weakTopics } from '@/core/study/exam';
import { createExam, startAttempt } from '@/core/study/attempts';
import { QUESTION_TYPES, QUESTION_TYPE_LABEL, type AttemptRow, type ExamConfig, type QuestionRow, type QuestionType } from '@/core/study/types';
import { useToast } from '@/app/toast';
import { Button, Callout, Dialog, Field, Select, TextInput } from '@/ui/primitives';

const db = getDb();

/** Configure an exam from the question bank. Nothing is invented: only approved questions are used. */
export function ExamBuilder({ open, onClose, course, lectures, bank, attempts, preset }: { open: boolean; onClose: () => void; course: CourseRow; lectures: LectureRow[]; bank: QuestionRow[]; attempts: AttemptRow[]; preset?: Partial<ExamConfig> }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [lectureIds, setLectureIds] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [types, setTypes] = useState<QuestionType[]>([]);
  const [count, setCount] = useState(10);
  const [difficulty, setDifficulty] = useState<'mixed' | 1 | 2 | 3>('mixed');
  const [totalMarks, setTotalMarks] = useState('');
  const [minutes, setMinutes] = useState('');
  const [hints, setHints] = useState(true);
  const [reveal, setReveal] = useState<'immediate' | 'after'>('after');
  const [layout, setLayout] = useState<'one' | 'paper'>('one');
  const [conditions, setConditions] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(preset?.title ?? `${course.name} practice, ${new Date().toLocaleDateString()}`);
    setLectureIds(preset?.lectureIds ?? []);
    setTopics(preset?.topics ?? []);
    setTypes(preset?.types ?? []);
    setCount(preset?.count ?? 10);
    setDifficulty(preset?.difficulty ?? 'mixed');
    setTotalMarks(preset?.totalMarks ? String(preset.totalMarks) : '');
    setMinutes(preset?.minutes ? String(preset.minutes) : '');
    setHints(preset?.hints ?? true);
    setReveal(preset?.reveal ?? 'after');
    setLayout(preset?.layout ?? 'one');
    setConditions(preset?.conditions ?? false);
  }, [open, course.name, preset]);

  const allTopics = useMemo(() => [...new Set(bank.filter((q) => q.status === 'approved' && q.topic).map((q) => q.topic!))].sort(), [bank]);
  const weak = useMemo(() => weakTopics(attempts, new Map(bank.map((q) => [q.id, q])), 2, 60), [attempts, bank]);
  const config: ExamConfig = {
    title: title.trim() || 'Practice exam',
    lectureIds,
    topics,
    count: Math.max(1, Math.min(200, Math.round(count) || 1)),
    types,
    difficulty,
    ...(totalMarks && Number(totalMarks) > 0 ? { totalMarks: Number(totalMarks) } : {}),
    ...(minutes && Number(minutes) > 0 ? { minutes: Number(minutes) } : {}),
    hints: conditions ? false : hints,
    reveal: conditions ? 'after' : reveal,
    layout,
    conditions,
  };
  const matching = filterBank(bank, config).length;
  const typeCounts = useMemo(() => {
    const m = new Map<QuestionType, number>();
    for (const q of filterBank(bank, { ...config, types: [] })) m.set(q.type, (m.get(q.type) ?? 0) + 1);
    return m;
  }, [bank, lectureIds, topics, difficulty]);

  const make = async (go: 'take' | 'paper') => {
    setBusy(true);
    try {
      const sel = selectQuestions(bank, config);
      if (sel.ids.length === 0) {
        toast.show('No approved questions match these settings. Loosen the filters or add questions.', 'error');
        return;
      }
      const exam = await createExam(db, course.id, config, sel.ids);
      onClose();
      if (sel.notes.length > 0) toast.show(sel.notes.join(' '), 'info');
      if (go === 'paper') navigate(`/exam/${exam.id}/paper`);
      else navigate(`/exam/${(await startAttempt(db, exam.id)).id}`);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not create the exam.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Build a practice exam"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || matching === 0} onClick={() => void make('paper')}>
            Printable paper
          </Button>
          <Button variant="primary" disabled={busy || matching === 0} onClick={() => void make('take')}>
            Start exam
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5 text-sm">
        {course.examStyle?.trim() ? (
          <Callout tone="info" title="Your professor’s exam style (saved for this course)">
            {course.examStyle.trim()}
            <p className="mt-1 text-[13px] text-ink-3">Practice questions are only as close to this as the questions in your bank. Practice is representative, not a prediction of the real exam.</p>
          </Callout>
        ) : (
          <p className="text-ink-3">Tip: save your professor’s exam instructions in Course details so you can keep your questions in that style. Practice is representative, not a prediction of the real exam.</p>
        )}

        <Field label="Exam name" htmlFor="x-title">
          <TextInput id="x-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        <fieldset>
          <legend className="mb-1 font-medium">Lectures included</legend>
          <ul className="max-h-36 overflow-y-auto rounded-[var(--radius-control)] border border-rule">
            {lectures.map((l) => (
              <li key={l.id}>
                <label className="flex min-h-9 cursor-pointer items-center gap-2.5 px-3 hover:bg-sunken">
                  <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={lectureIds.includes(l.id)} onChange={() => setLectureIds(toggle(lectureIds, l.id))} />
                  <span className="truncate">{l.title}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[13px] text-ink-3">{lectureIds.length === 0 ? 'None ticked means every lecture.' : `${lectureIds.length} selected.`}</p>
        </fieldset>

        {allTopics.length > 0 && (
          <fieldset>
            <legend className="mb-1 font-medium">Topics</legend>
            <div className="flex flex-wrap gap-2">
              {allTopics.map((t) => (
                <label key={t} className={`inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${topics.includes(t) ? 'border-accent bg-accent-soft text-ink' : 'border-rule-strong text-ink-2 hover:bg-sunken'}`}>
                  <input type="checkbox" className="sr-only" checked={topics.includes(t)} onChange={() => setTopics(toggle(topics, t))} />
                  {t}
                </label>
              ))}
            </div>
            {weak.length > 0 && (
              <p className="mt-2 text-[13px]">
                <button type="button" className="text-accent underline underline-offset-2" onClick={() => setTopics(weak.map((w) => w.topic))}>
                  Focus on my weak topics
                </button>{' '}
                <span className="text-ink-3">({weak.map((w) => `${w.topic} ${w.percent}%`).join(', ')})</span>
              </p>
            )}
          </fieldset>
        )}

        <fieldset>
          <legend className="mb-1 font-medium">Question types</legend>
          <div className="flex flex-wrap gap-2">
            {QUESTION_TYPES.map((t) => {
              const n = typeCounts.get(t) ?? 0;
              return (
                <label key={t} className={`inline-flex min-h-9 items-center rounded-full border px-3 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${n === 0 ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'} ${types.includes(t) ? 'border-accent bg-accent-soft text-ink' : 'border-rule-strong text-ink-2 hover:bg-sunken'}`}>
                  <input type="checkbox" className="sr-only" disabled={n === 0} checked={types.includes(t)} onChange={() => setTypes(toggle(types, t))} />
                  {QUESTION_TYPE_LABEL[t]} <span className="ml-1.5 text-ink-3">{n}</span>
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-[13px] text-ink-3">None ticked means every type that has questions.</p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Number of questions" htmlFor="x-count">
            <TextInput id="x-count" type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </Field>
          <Field label="Difficulty" htmlFor="x-diff">
            <Select id="x-diff" value={String(difficulty)} onChange={(e) => setDifficulty(e.target.value === 'mixed' ? 'mixed' : (Number(e.target.value) as 1 | 2 | 3))}>
              <option value="mixed">Mixed</option>
              <option value="1">Easy</option>
              <option value="2">Medium</option>
              <option value="3">Hard</option>
            </Select>
          </Field>
          <Field label="Total marks (optional)" htmlFor="x-marks">
            <TextInput id="x-marks" type="number" min={1} value={totalMarks} onChange={(e) => setTotalMarks(e.target.value)} placeholder="e.g. 50" />
          </Field>
          <Field label="Time limit, minutes (optional)" htmlFor="x-min">
            <TextInput id="x-min" type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="e.g. 90" />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-1 font-medium">Layout</legend>
            {(
              [
                ['one', 'One question at a time'],
                ['paper', 'Full paper on one page'],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="flex min-h-9 items-center gap-2.5">
                <input type="radio" name="layout" className="accent-[var(--accent)]" checked={layout === v} onChange={() => setLayout(v)} /> {label}
              </label>
            ))}
          </fieldset>
          <fieldset disabled={conditions}>
            <legend className="mb-1 font-medium">Answers and hints</legend>
            <label className="flex min-h-9 items-center gap-2.5">
              <input type="radio" name="reveal" className="accent-[var(--accent)]" checked={(conditions ? 'after' : reveal) === 'after'} onChange={() => setReveal('after')} /> Show answers after I submit
            </label>
            <label className="flex min-h-9 items-center gap-2.5">
              <input type="radio" name="reveal" className="accent-[var(--accent)]" checked={!conditions && reveal === 'immediate'} onChange={() => setReveal('immediate')} /> Show the answer after each question
            </label>
            <label className="flex min-h-9 items-center gap-2.5">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={conditions ? false : hints} onChange={(e) => setHints(e.target.checked)} /> Allow hints
            </label>
          </fieldset>
        </div>
        <label className="flex items-start gap-2.5">
          <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={conditions} onChange={(e) => setConditions(e.target.checked)} />
          <span>
            <span className="font-medium">Exam conditions</span>
            <span className="block text-ink-3">No hints, no answers until you submit, and the clock keeps running even if you leave the page.</span>
          </span>
        </label>

        <p className="rounded bg-sunken px-3 py-2" aria-live="polite">
          {matching === 0 ? 'No approved questions match these settings.' : `${matching} approved question${matching === 1 ? '' : 's'} match; ${Math.min(config.count, matching)} will be used.`}
        </p>
      </div>
    </Dialog>
  );
}
