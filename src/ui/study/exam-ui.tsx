import { useMemo, useState } from 'react';
import { CircleCheck, CircleHelp, CircleX } from 'lucide-react';
import { keywordHints, lengthAdvice, markManual, markWithRubric, type PointHint } from '@/core/study/exam';
import { QUESTION_TYPE_LABEL, TYPE_NEEDS_CODE_LABELLED, type AnswerState, type Grade, type QuestionRow } from '@/core/study/types';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { MathText } from '@/ui/MathText';
import { Button, TextInput } from '@/ui/primitives';
import { BasisChip, SourceList, SourceStatusChip } from './Sources';

const ROWS: Partial<Record<QuestionRow['type'], number>> = { short: 5, define: 5, long: 12, scenario: 8, case: 12, compare: 9, problem: 9, calculation: 8, algorithm: 12, programming: 14, proof: 12, diagram: 6, attack: 9 };

export function TypeLabel({ q }: { q: QuestionRow }) {
  return <span>{QUESTION_TYPE_LABEL[q.type]}</span>;
}

/** The question text (markdown, maths, code) and its marks. */
export function QuestionPrompt({ q, index }: { q: QuestionRow; index?: number }) {
  return (
    <div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3">
        {index !== undefined && <span className="font-medium text-ink">Question {index}</span>}
        <TypeLabel q={q} />
        <span>
          {q.marks} mark{q.marks === 1 ? '' : 's'}
        </span>
        {q.topic && <span>{q.topic}</span>}
      </p>
      <div className="mt-2 text-[1.075rem]">
        <LazyMarkdown>{q.prompt}</LazyMarkdown>
      </div>
    </div>
  );
}

/** The right input for each question type; every change is reported so it can be autosaved. */
export function AnswerInput({ q, answer, onChange, disabled = false, id }: { q: QuestionRow; answer: AnswerState | undefined; onChange: (patch: Partial<AnswerState>) => void; disabled?: boolean; id: string }) {
  if (q.options && q.options.length > 0) {
    const multi = q.options.filter((o) => o.correct).length > 1;
    const chosen = new Set(answer?.optionIds ?? []);
    return (
      <fieldset disabled={disabled} className="mt-3">
        <legend className="mb-2 text-sm text-ink-2">{multi ? 'Select all that apply.' : 'Choose one answer.'}</legend>
        <ul className="flex flex-col gap-2">
          {q.options.map((o) => (
            <li key={o.id}>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border border-rule bg-surface px-3 py-2.5 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:disabled]:cursor-default">
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={id}
                  className="mt-1 size-4 accent-[var(--accent)]"
                  checked={chosen.has(o.id)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (multi) {
                      if (e.target.checked) next.add(o.id);
                      else next.delete(o.id);
                    } else {
                      next.clear();
                      next.add(o.id);
                    }
                    onChange({ optionIds: [...next] });
                  }}
                />
                <span className="min-w-0 flex-1">
                  <LazyMarkdown>{o.text}</LazyMarkdown>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    );
  }
  const code = TYPE_NEEDS_CODE_LABELLED.includes(q.type);
  const advice = lengthAdvice(q, answer?.text);
  return (
    <div className="mt-3">
      <label htmlFor={id} className="sr-only">
        Your answer
      </label>
      <textarea
        id={id}
        value={answer?.text ?? ''}
        disabled={disabled}
        rows={ROWS[q.type] ?? 8}
        spellCheck={!code}
        onChange={(e) => onChange({ text: e.target.value })}
        placeholder={code ? 'Write your code or pseudocode here' : 'Write your answer here'}
        className={`w-full rounded-[var(--radius-control)] border border-rule-strong bg-surface px-3 py-2.5 leading-relaxed text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-70 ${code ? 'font-mono text-[14px]' : 'font-serif text-[1.05rem]'}`}
      />
      {advice && <p className={`mt-1 text-[13px] ${advice.ok ? 'text-ok' : 'text-ink-3'}`}>{advice.message}</p>}
    </div>
  );
}

/** Correct answer, model answer, marking points and sources for a question. */
export function Solution({ q, chosen, hints }: { q: QuestionRow; chosen?: string[]; hints?: PointHint[] }) {
  const hintOf = (id: string) => hints?.find((h) => h.pointId === id);
  return (
    <div className="flex flex-col gap-3 text-[0.95rem]">
      {q.options && (
        <ul className="flex flex-col gap-1.5">
          {q.options.map((o) => {
            const picked = chosen?.includes(o.id);
            return (
              <li key={o.id} className={`flex items-start gap-2 rounded px-2 py-1 ${o.correct ? 'bg-ok-soft' : picked ? 'bg-bad-soft' : ''}`}>
                {o.correct ? <CircleCheck className="mt-1 size-4 shrink-0 text-ok" aria-label="Correct answer" /> : picked ? <CircleX className="mt-1 size-4 shrink-0 text-bad" aria-label="Your wrong choice" /> : <span className="size-4 shrink-0" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <LazyMarkdown>{o.text}</LazyMarkdown>
                </span>
                <span className="shrink-0 text-xs text-ink-3">{o.correct ? (picked ? 'Correct, you chose this' : 'Correct answer') : picked ? 'You chose this' : ''}</span>
              </li>
            );
          })}
        </ul>
      )}
      {q.modelAnswer && (
        <div>
          <p className="mb-1 text-sm font-medium">Model answer</p>
          <div className="rounded-[var(--radius-control)] border border-rule bg-sunken/40 p-3">
            <LazyMarkdown>{q.modelAnswer}</LazyMarkdown>
          </div>
        </div>
      )}
      {q.rubric.length > 0 && (
        <div>
          <p className="mb-1 text-sm font-medium">What the marks are for</p>
          <ul className="divide-y divide-rule rounded-[var(--radius-control)] border border-rule">
            {q.rubric.map((p) => {
              const h = hintOf(p.id);
              return (
                <li key={p.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <MathText>{p.text}</MathText>
                    {h && (
                      <span className={`ml-2 text-xs ${h.status === 'likely' ? 'text-ok' : h.status === 'missing' ? 'text-ink-3' : 'text-warn'}`}>
                        {h.status === 'likely' ? 'looks covered in your answer' : h.status === 'missing' ? 'not found in your answer' : 'partly found in your answer'}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-2">{p.marks}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BasisChip basis={q.basis} sources={q.sources} />
        <SourceStatusChip sources={q.sources} />
      </div>
      <SourceList sources={q.sources} />
    </div>
  );
}

/**
 * Mark your own answer against the marking points. Keyword matches are shown as hints only;
 * the marks you enter are yours and are always labelled uncertain.
 */
export function SelfMarker({ q, answerText, existing, onSave }: { q: QuestionRow; answerText: string; existing?: Grade; onSave: (g: Grade) => Promise<void> }) {
  const hints = useMemo(() => keywordHints(q, answerText), [q, answerText]);
  const initial = useMemo(() => Object.fromEntries(q.rubric.map((p) => [p.id, existing?.items.find((i) => i.pointId === p.id)?.awarded ?? 0])), [q, existing]);
  const [awarded, setAwarded] = useState<Record<string, number>>(initial);
  const [manual, setManual] = useState<number>(existing?.marks ?? 0);
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [busy, setBusy] = useState(false);
  const total = q.rubric.length > 0 ? Math.min(q.marks, q.rubric.reduce((n, p) => n + Math.min(p.marks, Math.max(0, awarded[p.id] ?? 0)), 0)) : Math.min(q.marks, Math.max(0, manual));

  return (
    <div className="rounded-[var(--radius-panel)] border border-rule bg-surface p-4">
      <h4 className="text-sm font-semibold">Mark your answer</h4>
      <p className="mt-1 text-[13px] text-ink-3">Compare your answer with the model answer and give yourself marks honestly, point by point. This is your own estimate, not an examiner’s mark.</p>
      {q.rubric.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {q.rubric.map((p) => {
            const h = hints.find((x) => x.pointId === p.id);
            return (
              <li key={p.id} className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <span className="text-sm">
                  <MathText>{p.text}</MathText>
                  {h && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-ink-3">
                      {h.status === 'likely' ? <CircleCheck className="size-3.5 text-ok" aria-hidden /> : <CircleHelp className="size-3.5" aria-hidden />}
                      hint: {h.status === 'likely' ? 'probably covered' : h.status === 'missing' ? 'not found by keyword' : 'partly found'}
                    </span>
                  )}
                </span>
                <label className="flex items-center gap-2 whitespace-nowrap text-sm">
                  <span className="sr-only">Marks for: {p.text}</span>
                  <TextInput
                    type="number"
                    min={0}
                    max={p.marks}
                    step={0.5}
                    value={awarded[p.id] ?? 0}
                    onChange={(e) => setAwarded({ ...awarded, [p.id]: Number(e.target.value) })}
                    className="min-h-9 w-20 text-right"
                  />
                  <span className="text-ink-3">/ {p.marks}</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <label className="mt-3 flex items-center gap-2 whitespace-nowrap text-sm">
          Marks
          <TextInput type="number" min={0} max={q.marks} step={0.5} value={manual} onChange={(e) => setManual(Number(e.target.value))} className="min-h-9 w-24 text-right" />
          <span className="text-ink-3">/ {q.marks}</span>
        </label>
      )}
      <div className="mt-3">
        <label htmlFor={`cm-${q.id}`} className="text-sm font-medium">
          Note to yourself (what to fix)
        </label>
        <TextInput id={`cm-${q.id}`} value={comment} onChange={(e) => setComment(e.target.value)} className="mt-1" />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-sm" aria-live="polite">
          Total: <span className="font-semibold tabular-nums">{total}</span> / {q.marks}
        </p>
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(q.rubric.length > 0 ? markWithRubric(q, awarded, 'self', comment || undefined) : markManual(q, manual, comment || undefined));
            } finally {
              setBusy(false);
            }
          }}
        >
          {existing ? 'Update my mark' : 'Save my mark'}
        </Button>
      </div>
    </div>
  );
}
