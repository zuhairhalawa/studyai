import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { getDb, type LectureRow } from '@/core/db/db';
import { newId } from '@/core/id';
import { saveQuestion } from '@/core/study/store';
import { BASES, BASIS_LABEL, QUESTION_TYPES, QUESTION_TYPE_LABEL, type Basis, type QuestionRow, type QuestionType } from '@/core/study/types';
import { useToast } from '@/app/toast';
import { Button, Dialog, Field, Select, TextArea, TextInput } from '@/ui/primitives';
import { SourceList } from './Sources';

const db = getDb();

interface Opt {
  id: string;
  text: string;
  correct: boolean;
}
interface Pt {
  id: string;
  text: string;
  marks: number;
  keywords: string;
}

/** Create or edit a question: prompt, answer options, model answer and marking points. */
export function QuestionEditor({ open, onClose, courseId, lectures, question }: { open: boolean; onClose: () => void; courseId: string; lectures: LectureRow[]; question?: QuestionRow }) {
  const toast = useToast();
  const [type, setType] = useState<QuestionType>('short');
  const [prompt, setPrompt] = useState('');
  const [marks, setMarks] = useState(3);
  const [difficulty, setDifficulty] = useState<1 | 2 | 3>(2);
  const [topic, setTopic] = useState('');
  const [lectureIds, setLectureIds] = useState<string[]>([]);
  const [options, setOptions] = useState<Opt[]>([]);
  const [tf, setTf] = useState<'true' | 'false'>('true');
  const [modelAnswer, setModelAnswer] = useState('');
  const [points, setPoints] = useState<Pt[]>([]);
  const [minWords, setMinWords] = useState('');
  const [maxWords, setMaxWords] = useState('');
  const [hint, setHint] = useState('');
  const [basis, setBasis] = useState<Basis>('outside');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    const q = question;
    setType(q?.type ?? 'short');
    setPrompt(q?.prompt ?? '');
    setMarks(q?.marks ?? 3);
    setDifficulty((q?.difficulty ?? 2) as 1 | 2 | 3);
    setTopic(q?.topic ?? '');
    setLectureIds(q?.lectureIds ?? []);
    setOptions(q?.type === 'mcq' && q.options ? q.options.map((o) => ({ ...o })) : [{ id: newId(), text: '', correct: true }, { id: newId(), text: '', correct: false }]);
    setTf(q?.type === 'truefalse' ? (q.options?.find((o) => o.correct)?.text === 'False' ? 'false' : 'true') : 'true');
    setModelAnswer(q?.modelAnswer ?? '');
    setPoints(q?.rubric.map((r) => ({ id: r.id, text: r.text, marks: r.marks, keywords: r.keywords?.join(', ') ?? '' })) ?? []);
    setMinWords(q?.expectedWords?.[0]?.toString() ?? '');
    setMaxWords(q?.expectedWords?.[1]?.toString() ?? '');
    setHint(q?.hint ?? '');
    setBasis(q?.basis ?? 'outside');
    setError(undefined);
  }, [open, question]);

  const objective = type === 'mcq' || type === 'truefalse';
  const rubricSum = points.reduce((n, p) => n + (Number.isFinite(p.marks) ? p.marks : 0), 0);

  const save = async () => {
    setError(undefined);
    if (!prompt.trim()) return setError('Write the question first.');
    if (!(marks > 0)) return setError('The question needs marks greater than zero.');
    let opts: QuestionRow['options'];
    if (type === 'mcq') {
      const filled = options.filter((o) => o.text.trim());
      if (filled.length < 2) return setError('A multiple-choice question needs at least two options.');
      if (!filled.some((o) => o.correct)) return setError('Mark at least one option as correct.');
      opts = filled.map((o, i) => ({ id: `o${i + 1}`, text: o.text.trim(), correct: o.correct }));
    } else if (type === 'truefalse') {
      opts = [{ id: 'o1', text: 'True', correct: tf === 'true' }, { id: 'o2', text: 'False', correct: tf === 'false' }];
    }
    if (!objective && !modelAnswer.trim() && points.length === 0) return setError('Give a model answer or at least one marking point, so you can mark your answers later.');
    const now = Date.now();
    const lo = minWords.trim() ? Number(minWords) : undefined;
    const hi = maxWords.trim() ? Number(maxWords) : undefined;
    const row: QuestionRow = {
      id: question?.id ?? newId(),
      courseId,
      type,
      prompt: prompt.trim(),
      marks,
      difficulty,
      ...(topic.trim() ? { topic: topic.trim() } : {}),
      lectureIds,
      ...(opts ? { options: opts } : {}),
      ...(modelAnswer.trim() ? { modelAnswer: modelAnswer.trim() } : {}),
      rubric: objective ? [] : points.filter((p) => p.text.trim()).map((p, i) => ({ id: `r${i + 1}`, text: p.text.trim(), marks: Math.max(0, p.marks || 0), ...(p.keywords.trim() ? { keywords: p.keywords.split(',').map((k) => k.trim()).filter(Boolean) } : {}) })),
      ...(lo !== undefined && hi !== undefined && lo >= 0 && hi >= lo ? { expectedWords: [lo, hi] as [number, number] } : {}),
      ...(hint.trim() ? { hint: hint.trim() } : {}),
      basis,
      sources: question?.sources ?? [],
      origin: question?.origin ?? 'user',
      status: question?.status ?? 'approved',
      createdAt: question?.createdAt ?? now,
      updatedAt: now,
      ...(question?.packId ? { packId: question.packId } : {}),
    };
    try {
      await saveQuestion(db, row, now);
      toast.show(question ? 'Question saved.' : 'Question added.', 'ok');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={question ? 'Edit question' : 'New question'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="question-form">
            {question ? 'Save question' : 'Add question'}
          </Button>
        </>
      }
    >
      <form
        id="question-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Kind of question" htmlFor="q-type">
            <Select id="q-type" value={type} onChange={(e) => setType(e.target.value as QuestionType)}>
              {QUESTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {QUESTION_TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Marks" htmlFor="q-marks">
            <TextInput id="q-marks" type="number" min={0.5} step={0.5} value={marks} onChange={(e) => setMarks(Number(e.target.value))} />
          </Field>
          <Field label="Difficulty" htmlFor="q-diff">
            <Select id="q-diff" value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value) as 1 | 2 | 3)}>
              <option value={1}>Easy</option>
              <option value={2}>Medium</option>
              <option value={3}>Hard</option>
            </Select>
          </Field>
          <Field label="Topic" htmlFor="q-topic">
            <TextInput id="q-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Reductions" />
          </Field>
        </div>
        <Field label="Question" htmlFor="q-prompt" hint="Markdown works. Write maths as $x^2$ and code in ``` fences.">
          <TextArea id="q-prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>

        {type === 'mcq' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Options (tick every correct one)</legend>
            {options.map((o, i) => (
              <div key={o.id} className="flex items-center gap-2">
                <input type="checkbox" aria-label={`Option ${i + 1} is correct`} className="size-4 accent-[var(--accent)]" checked={o.correct} onChange={(e) => setOptions(options.map((x) => (x.id === o.id ? { ...x, correct: e.target.checked } : x)))} />
                <TextInput aria-label={`Option ${i + 1} text`} value={o.text} onChange={(e) => setOptions(options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)))} />
                <button type="button" aria-label={`Remove option ${i + 1}`} disabled={options.length <= 2} onClick={() => setOptions(options.filter((x) => x.id !== o.id))} className="inline-flex size-9 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-bad-soft hover:text-bad disabled:opacity-30">
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </div>
            ))}
            <div>
              <Button size="sm" onClick={() => setOptions([...options, { id: newId(), text: '', correct: false }])} disabled={options.length >= 8}>
                <Plus className="size-4" aria-hidden /> Add option
              </Button>
            </div>
          </fieldset>
        )}

        {type === 'truefalse' && (
          <Field label="The statement is" htmlFor="q-tf">
            <Select id="q-tf" value={tf} onChange={(e) => setTf(e.target.value as 'true' | 'false')} className="sm:max-w-40">
              <option value="true">True</option>
              <option value="false">False</option>
            </Select>
          </Field>
        )}

        {!objective && (
          <>
            <Field label="Model answer" htmlFor="q-model" hint="What a full-marks answer says, in plain student language, from the slides.">
              <TextArea id="q-model" rows={5} value={modelAnswer} onChange={(e) => setModelAnswer(e.target.value)} />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Marking points</legend>
              {points.map((p, i) => (
                <div key={p.id} className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_5rem_auto]">
                  <TextInput aria-label={`Point ${i + 1}: what the answer must contain`} placeholder="What the answer must contain" value={p.text} onChange={(e) => setPoints(points.map((x) => (x.id === p.id ? { ...x, text: e.target.value } : x)))} />
                  <TextInput aria-label={`Point ${i + 1}: keywords (optional)`} placeholder="Keywords (optional)" value={p.keywords} onChange={(e) => setPoints(points.map((x) => (x.id === p.id ? { ...x, keywords: e.target.value } : x)))} />
                  <TextInput aria-label={`Point ${i + 1}: marks`} type="number" min={0} step={0.5} value={p.marks} onChange={(e) => setPoints(points.map((x) => (x.id === p.id ? { ...x, marks: Number(e.target.value) } : x)))} />
                  <button type="button" aria-label={`Remove point ${i + 1}`} onClick={() => setPoints(points.filter((x) => x.id !== p.id))} className="inline-flex size-9 items-center justify-center rounded text-ink-3 hover:bg-bad-soft hover:text-bad">
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={() => setPoints([...points, { id: newId(), text: '', marks: 1, keywords: '' }])}>
                  <Plus className="size-4" aria-hidden /> Add marking point
                </Button>
                {points.length > 0 && (
                  <span className={`text-sm ${Math.abs(rubricSum - marks) > 0.01 ? 'text-warn' : 'text-ink-3'}`}>
                    Points add up to {rubricSum} of {marks} marks
                  </span>
                )}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Expected words (from)" htmlFor="q-min">
                <TextInput id="q-min" type="number" min={0} value={minWords} onChange={(e) => setMinWords(e.target.value)} />
              </Field>
              <Field label="Expected words (to)" htmlFor="q-max">
                <TextInput id="q-max" type="number" min={0} value={maxWords} onChange={(e) => setMaxWords(e.target.value)} />
              </Field>
              <Field label="Hint (optional)" htmlFor="q-hint">
                <TextInput id="q-hint" value={hint} onChange={(e) => setHint(e.target.value)} />
              </Field>
            </div>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Where does the answer come from?" htmlFor="q-basis">
            <Select id="q-basis" value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {BASIS_LABEL[b]}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Lectures it covers</legend>
            <ul className="max-h-28 overflow-y-auto rounded-[var(--radius-control)] border border-rule">
              {lectures.map((l) => (
                <li key={l.id}>
                  <label className="flex min-h-9 cursor-pointer items-center gap-2 px-3 text-sm hover:bg-sunken">
                    <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={lectureIds.includes(l.id)} onChange={(e) => setLectureIds(e.target.checked ? [...lectureIds, l.id] : lectureIds.filter((x) => x !== l.id))} />
                    <span className="truncate">{l.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        </div>
        {question && question.sources.length > 0 && <SourceList sources={question.sources} />}
        {error && (
          <p className="rounded bg-bad-soft px-3 py-2 text-sm text-bad" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
