import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, ClipboardCopy, Download } from 'lucide-react';
import { getDb, type CourseRow, type LectureRow } from '@/core/db/db';
import { loadSlides } from '@/core/db/library';
import type { PlannedSlot } from '@/core/study/blueprint';
import { lectureToMarkdown, studyPackPrompt, type PromptOptions } from '@/core/study/markdown';
import type { AuditQuestion } from '@/core/study/audit';
import { extractJson, planPack, recoverTruncatedJson, type LectureContext, type PackPlan } from '@/core/study/pack';
import { removeMarkingPoint } from '@/core/study/pack-edit';
import type { QualityStats } from '@/core/study/pack-quality';
import { QUESTION_TYPE_LABEL, type QuestionType } from '@/core/study/types';
import { slideVerificationText } from '@/core/study/slide-text';
import { applyPackPlan } from '@/core/study/store';
import { useQuestions } from '@/app/data';
import { useToast } from '@/app/toast';
import { AuditPanel } from '@/ui/ai/AuditPanel';
import { Button, Callout, Dialog, Field, Select, Spinner, TextArea } from '@/ui/primitives';

const db = getDb();

// ---------------------------------------------------------------------------
// Export: lecture text + prompt for the AI you already pay for
// ---------------------------------------------------------------------------

export function AiExportDialog({ open, onClose, course, lectures }: { open: boolean; onClose: () => void; course: CourseRow; lectures: LectureRow[] }) {
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [wants, setWants] = useState({ notes: true, cards: true, questions: true });
  const [amount, setAmount] = useState<PromptOptions['amount']>('normal');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPicked(new Set(lectures.map((l) => l.id)));
      setText('');
    }
  }, [open, lectures]);

  const chosen = lectures.filter((l) => picked.has(l.id));
  const slideTotal = chosen.reduce((n, l) => n + l.slideCount, 0);

  const build = async (): Promise<string> => {
    setBusy(true);
    try {
      const parts: string[] = [];
      let i = 1;
      for (const l of chosen) parts.push(lectureToMarkdown(l, await loadSlides(db, l.id), `L${i++}`));
      const prompt = studyPackPrompt({ examStyle: course.examStyle, wants, amount });
      const out = `${prompt}\n\n=====  LECTURES  =====\n\n${parts.join('\n\n=====\n\n')}\n`;
      setText(out);
      return out;
    } finally {
      setBusy(false);
    }
  };

  const approxTokens = text ? Math.round(text.length / 4) : Math.round(slideTotal * 450);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Create a study pack with your own AI"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={chosen.length === 0 || busy || (!wants.notes && !wants.cards && !wants.questions)}
            onClick={async () => {
              const out = text || (await build());
              const url = URL.createObjectURL(new Blob([out], { type: 'text/markdown' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = `${course.name.replace(/[^\w-]+/g, '-')}-lectures-for-ai.md`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }}
          >
            <Download className="size-4" aria-hidden /> Download .md file
          </Button>
          <Button
            variant="primary"
            disabled={chosen.length === 0 || busy || (!wants.notes && !wants.cards && !wants.questions)}
            onClick={async () => {
              const out = text || (await build());
              try {
                await navigator.clipboard.writeText(out);
                toast.show('Copied. Paste it into your AI chat, then import the JSON it returns.', 'ok');
              } catch {
                toast.show('Your browser blocked copying. Use “Download .md file” instead.', 'error');
              }
            }}
          >
            <ClipboardCopy className="size-4" aria-hidden /> {busy ? 'Preparing' : 'Copy prompt and lectures'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-ink-2">
          This does <span className="font-medium text-ink">not</span> call any AI. It prepares one block of text: instructions plus the extracted text of your lectures, with slide numbers. Paste it into Claude, Gemini or another AI you already use, then bring back the JSON it writes with “Import a study pack”. Every quote it cites is checked against your real slides.
        </p>
        <Callout tone="warn" title="Before you paste">
          Your lecture text will go to whichever AI service you paste it into. Free plans of some services may use your content to improve their products. Check that service’s terms first. Nothing is sent from this app.
        </Callout>
        <fieldset>
          <legend className="mb-1 font-medium">Lectures to include</legend>
          <ul className="max-h-44 overflow-y-auto rounded-[var(--radius-control)] border border-rule">
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
                      setText('');
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{l.title}</span>
                  <span className="text-ink-3">{l.slideCount} slides</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-1 font-medium">Ask for</legend>
            {(['notes', 'cards', 'questions'] as const).map((k) => (
              <label key={k} className="flex min-h-9 items-center gap-2.5">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={wants[k]} onChange={(e) => { setWants({ ...wants, [k]: e.target.checked }); setText(''); }} />
                {{ notes: 'Notes and summaries', cards: 'Flashcards', questions: 'Practice questions with marking points' }[k]}
              </label>
            ))}
          </fieldset>
          <Field label="How much" htmlFor="amount">
            <Select id="amount" value={amount} onChange={(e) => { setAmount(e.target.value as PromptOptions['amount']); setText(''); }}>
              <option value="few">A few of each (quick)</option>
              <option value="normal">A normal amount</option>
              <option value="many">As many as are useful</option>
            </Select>
          </Field>
        </div>
        {course.examStyle?.trim() ? (
          <p className="text-ink-2">
            Your saved exam instructions will be included: <span className="italic">“{course.examStyle.trim().slice(0, 140)}{course.examStyle.trim().length > 140 ? '…' : ''}”</span>
          </p>
        ) : (
          <p className="text-ink-3">Tip: add your professor’s exam style in Course details and it will be included here.</p>
        )}
        <p className="text-ink-3">
          About {approxTokens.toLocaleString()} tokens of text{approxTokens > 100_000 ? '. That is a lot; pick fewer lectures at a time so the AI can keep to the slides.' : '.'}
        </p>
      </div>
    </Dialog>
  );
}

/** The shape of a set of generated exam questions: kinds, difficulty, marks, and whether it came back as planned. */
function QuestionSetSummary({ stats }: { stats: QualityStats }) {
  const kinds = (Object.entries(stats.byType) as [QuestionType, number][]).map(([t, n]) => `${n} ${QUESTION_TYPE_LABEL[t].toLowerCase()}`).join(', ');
  return (
    <section aria-label="Exam questions in this pack" className="rounded-[var(--radius-control)] border border-rule px-3 py-2 text-ink-2">
      <h3 className="font-medium text-ink">
        Exam questions: {stats.questions} · {stats.totalMarks} mark{stats.totalMarks === 1 ? '' : 's'} in all
      </h3>
      <p>
        Kinds: {kinds}. Difficulty: {stats.byDifficulty[1]} easy, {stats.byDifficulty[2]} medium, {stats.byDifficulty[3]} hard.
        {stats.asPlanned ? ` ${stats.asPlanned.met} of ${stats.asPlanned.of} came back exactly as planned.` : ''} They cite {stats.slidesCited.length} slide{stats.slidesCited.length === 1 ? '' : 's'}.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Import: validate a pack, show exactly what will happen, then store it for review
// ---------------------------------------------------------------------------

export function PackImportDialog({ open, onClose, course, lectures, initialText, cutOff, expected }: { open: boolean; onClose: () => void; course: CourseRow; lectures: LectureRow[]; initialText?: string; cutOff?: boolean; expected?: PlannedSlot[] }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [raw, setRaw] = useState<unknown>();
  const [error, setError] = useState<string | undefined>();
  /** How many complete items were rescued from an answer that was cut off (undefined when the pack read normally). */
  const [rescued, setRescued] = useState<number | undefined>();
  const [contexts, setContexts] = useState<LectureContext[] | undefined>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText('');
    setRaw(undefined);
    setError(undefined);
    setRescued(undefined);
    setMapping({});
    let cancelled = false;
    void (async () => {
      const out: LectureContext[] = [];
      for (const l of lectures) {
        const slides = await loadSlides(db, l.id);
        out.push({
          id: l.id,
          title: l.title,
          fileHash: l.fileHash,
          revision: l.revision,
          slideCount: l.slideCount,
          slideText: (i) => {
            const s = slides[i - 1];
            return s ? slideVerificationText(s) : undefined;
          },
        });
      }
      if (!cancelled) setContexts(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, lectures]);

  // The questions the course already has: a question that repeats one of them is pointed out.
  const haveQuestions = useQuestions(course.id);
  const existingPrompts = useMemo(() => (haveQuestions ?? []).map((q) => q.prompt), [haveQuestions]);
  const plan: PackPlan | undefined = useMemo(
    () => (raw !== undefined && contexts ? planPack(raw, course.id, contexts, mapping, Date.now(), { ...(expected ? { expected } : {}), existingPrompts }) : undefined),
    [raw, contexts, course.id, mapping, expected, existingPrompts],
  );

  const check = (source: string) => {
    setError(undefined);
    setRescued(undefined);
    try {
      setRaw(extractJson(source));
      setMapping({});
    } catch (err) {
      // An answer that hit its length limit stops in the middle of the JSON: keep the items that were finished.
      const kept = recoverTruncatedJson(source);
      if (kept) {
        setRaw(kept.value);
        setRescued(kept.items);
        setMapping({});
        return;
      }
      setRaw(undefined);
      setError(cutOff ? 'The AI reached its answer limit before it finished even one item, so nothing could be kept. Ask for fewer items or fewer slides.' : err instanceof Error ? err.message : 'Could not read the pack.');
    }
  };

  // A pack written by the AI tutor arrives already pasted, so the checking screen opens straight away.
  useEffect(() => {
    if (open && initialText) {
      setText(initialText);
      check(initialText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check only sets state
  }, [open, initialText]);

  /** The written questions as the AI check reads them; `n` is the place the AI wrote each at, so a finding finds its way back to the pack. */
  const auditQs: AuditQuestion[] = useMemo(
    () => (plan?.questions ?? []).map((q, i) => ({ n: (plan?.questionAt[i] ?? i) + 1, type: q.type, prompt: q.prompt, marks: q.marks, rubric: q.rubric.map((r) => ({ text: r.text, marks: r.marks })), ...(q.modelAnswer ? { modelAnswer: q.modelAnswer } : {}) })),
    [plan],
  );
  /** Takes a marking point out of the pack (and its marks off the question); the whole pack is checked again. */
  const removePoint = (question: number, point: number) => setRaw((r: unknown) => removeMarkingPoint(r, question, point));

  const count = plan ? plan.cards.length + plan.notes.length + plan.questions.length : 0;
  const warnings = plan?.issues.filter((i) => i.severity === 'warning') ?? [];
  const errors = plan?.issues.filter((i) => i.severity === 'error') ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="Import a study pack"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!plan || !!plan.fatal || count === 0 || busy}
            onClick={async () => {
              if (!plan) return;
              setBusy(true);
              try {
                const r = await applyPackPlan(db, course.id, plan);
                toast.show(`Imported ${r.cards} cards, ${r.notes} notes and ${r.questions} questions for you to review.`, 'ok');
                onClose();
                navigate(`/course/${course.id}/cards?status=pending`);
              } catch (err) {
                toast.show(err instanceof Error ? err.message : 'Import failed.', 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            {count > 0 ? `Import ${count} item${count === 1 ? '' : 's'} for review` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-ink-2">
          Paste the JSON your AI produced, or choose the file. Nothing is saved until you press Import, and imported items always wait for your approval before they are used for studying.
        </p>
        <Field label="Pack JSON" htmlFor="pack-text">
          <TextArea id="pack-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'{ "format": "studyai-pack", … }'} className="font-mono text-[13px]" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" disabled={!text.trim() || !contexts} onClick={() => check(text)}>
            Check this pack
          </Button>
          <label className="inline-flex min-h-10 cursor-pointer items-center rounded-[var(--radius-control)] border border-rule-strong bg-surface px-3.5 text-sm font-medium hover:bg-sunken">
            Choose a file
            <input
              type="file"
              accept=".json,.txt,application/json,text/plain"
              className="sr-only"
              aria-label="Choose a pack file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (f.size > 20 * 1024 * 1024) {
                  setError('That file is larger than 20 MB, which is far more than a study pack needs.');
                  return;
                }
                const t = await f.text();
                setText(t);
                check(t);
              }}
            />
          </label>
          {!contexts && <Spinner label="Reading your lectures" />}
        </div>

        {error && <Callout tone="bad" title="That could not be read">{error}</Callout>}
        {rescued !== undefined && (
          <Callout tone="warn" title="The AI’s answer was cut off">
            It stopped at its length limit before it finished, so only the {rescued} complete item{rescued === 1 ? '' : 's'} before the cut {rescued === 1 ? 'is' : 'are'} shown here. Whatever came after is missing. You can import these now and ask for more from other slides.
          </Callout>
        )}
        {plan?.fatal && <Callout tone="bad" title="Not a usable pack">{plan.fatal}</Callout>}

        {plan && !plan.fatal && (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule sm:grid-cols-4">
              {(
                [
                  ['Flashcards', plan.cards.length],
                  ['Notes', plan.notes.length],
                  ['Questions', plan.questions.length],
                  ['Skipped', plan.stats.rejected],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="bg-surface px-3 py-2">
                  <dt className="text-xs text-ink-3">{k}</dt>
                  <dd className={`text-lg font-semibold tabular-nums ${k === 'Skipped' && v > 0 ? 'text-bad' : ''}`}>{v}</dd>
                </div>
              ))}
            </dl>
            {plan.quality && <QuestionSetSummary stats={plan.quality.stats} />}
            {plan.questions.length > 0 && <AuditPanel questions={auditQs} onRemove={(n, point) => removePoint(n - 1, point)} />}
            <p className="text-ink-2">
              Sources: {plan.stats.verified} of {plan.stats.sources} cited quotes were found on the slide{plan.stats.unverified > 0 ? ` (${plan.stats.unverified} were not)` : ''}. Items without a verified quote are marked so you can check them.
            </p>

            {plan.lectureMap.length > 0 && (
              <div>
                <h3 className="mb-1 font-medium">Which lecture is which</h3>
                <ul className="divide-y divide-rule rounded-[var(--radius-control)] border border-rule">
                  {plan.lectureMap.map((l) => (
                    <li key={l.ref} className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <span className="min-w-0 truncate">
                        <span className="font-mono text-[13px] text-ink-3">{l.ref}</span> {l.title}
                      </span>
                      <span className="flex items-center gap-2">
                        <label className="sr-only" htmlFor={`map-${l.ref}`}>
                          Local lecture for {l.title}
                        </label>
                        <Select id={`map-${l.ref}`} value={l.localId ?? ''} onChange={(e) => setMapping({ ...mapping, [l.ref]: e.target.value })} className="min-h-9 text-[13px]">
                          <option value="">Not matched</option>
                          {lectures.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.title}
                            </option>
                          ))}
                        </Select>
                        {l.how && <span className="shrink-0 text-xs text-ink-3">{l.how === 'hash' ? 'exact file' : l.how === 'title' ? 'same title' : 'chosen'}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(errors.length > 0 || warnings.length > 0) && (
              <details className="rounded-[var(--radius-control)] border border-rule p-3" open={errors.length > 0}>
                <summary className="flex cursor-pointer items-center gap-2 font-medium">
                  <AlertTriangle className="size-4 text-warn" aria-hidden /> {errors.length} skipped item{errors.length === 1 ? '' : 's'}, {warnings.length} warning{warnings.length === 1 ? '' : 's'}
                </summary>
                <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-[13px] text-ink-2">
                  {[...errors, ...warnings].slice(0, 80).map((i, k) => (
                    <li key={k} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                      <span className="min-w-0">
                        <span className="font-medium text-ink">{i.where}:</span> {i.message}
                      </span>
                      {i.fix && (
                        <Button size="sm" variant="secondary" onClick={() => removePoint(i.fix!.question, i.fix!.point)} aria-label={`Remove marking point ${i.fix.point + 1} of ${i.where.toLowerCase()}`}>
                          Remove this point
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
