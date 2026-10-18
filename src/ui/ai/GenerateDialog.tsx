import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { askAi, refreshAi, useAiServer } from '@/app/ai';
import { useQuestions, useSetting } from '@/app/data';
import { getDb } from '@/core/db/db';
import { loadSlides } from '@/core/db/library';
import type { CourseRow, LectureRow } from '@/core/db/db';
import type { SlideData } from '@/core/pptx/model';
import { buildBlueprint, describeSlot, splitIntoRequests, type PlannedSlot } from '@/core/study/blueprint';
import { lectureToMarkdown } from '@/core/study/markdown';
import { packCounts } from '@/core/study/pack-format';
import { LIMITS } from '@/core/tutor/contract';
import { generateOutputTokens } from '@/core/tutor/prompts';
import { Button, Dialog, Select, TextInput } from '@/ui/primitives';

const db = getDb();

const MAX_QUESTIONS = 30;

/**
 * Asks the AI to write a study pack (cards, notes, questions) from chosen lectures. The result is NOT used directly: it goes
 * to the normal "Import a study pack" check, where every quote is verified against the real slides and every item waits for
 * your approval.
 *
 * Exam questions are planned here first, on the device (blueprint.ts): the mix of kinds, the difficulty, the marks and the
 * slides of each question, from the topics of the lecture, the professor's exam instructions and the questions you already
 * have. The AI only fills in the plan, and what it sends back is checked against the plan.
 */
export function GenerateDialog({
  open,
  onClose,
  course,
  lectures,
  onGenerated,
}: {
  open: boolean;
  onClose: () => void;
  course: CourseRow;
  lectures: LectureRow[];
  onGenerated: (json: string, cutOff: boolean, expected?: PlannedSlot[]) => void;
}) {
  const ai = useAiServer();
  const [consent, setConsent] = useSetting<string>('aiConsentAt');
  const existing = useQuestions(course.id);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Only the slides in these ranges are sent (default: all). Title and acknowledgement slides need not leave the device.
  const [ranges, setRanges] = useState<Record<string, { from: string; to: string }>>({});
  const rangeOf = (l: LectureRow): { from: number; to: number; ok: boolean } => {
    const r = ranges[l.id];
    const from = r?.from === undefined || r.from === '' ? 1 : Number(r.from);
    const to = r?.to === undefined || r.to === '' ? l.slideCount : Number(r.to);
    return { from, to, ok: Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to <= l.slideCount && from <= to };
  };
  /** Topics the student switched off (`lectureId:topicId`): their slides are neither sent nor asked about. */
  const [topicOff, setTopicOff] = useState<Set<string>>(new Set());
  const [wants, setWants] = useState({ notes: false, cards: true, questions: true });
  const [amount, setAmount] = useState<'few' | 'normal' | 'many'>('few');
  const [questionCount, setQuestionCount] = useState('8');
  const [loaded, setLoaded] = useState<Record<string, SlideData[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    void refreshAi();
    setError(undefined);
    setPicked(new Set(lectures.slice(0, 1).map((l) => l.id)));
    setRanges({});
    setTopicOff(new Set());
  }, [open, lectures]);

  // A lecture's slides are cached under its id AND its last change, so picture words typed since the last time are never missed.
  const cacheKey = (l: LectureRow) => `${l.id}:${l.updatedAt}`;

  // The slides of the chosen lectures, read from this device.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const next: Record<string, SlideData[]> = {};
      for (const l of lectures.filter((x) => picked.has(x.id))) if (!loaded[cacheKey(l)]) next[cacheKey(l)] = await loadSlides(db, l.id);
      if (!cancelled && Object.keys(next).length > 0) setLoaded((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loaded` is keyed by lecture version and only grows; it is read to skip what is already read
  }, [open, picked, lectures]);

  // Exam questions are planned for one lecture at a time (slide numbers belong to a lecture), so with questions wanted only the
  // first chosen lecture is used.
  const chosen = lectures.filter((l) => picked.has(l.id));
  const sending = wants.questions ? chosen.slice(0, 1) : chosen;
  const planLecture = wants.questions ? sending[0] : undefined;
  /** False until every lecture that would be sent has been read: nothing is offered for sending before then. */
  const ready = sending.length > 0 && sending.every((l) => !!loaded[cacheKey(l)]);

  /** The slides of a lecture that are sent: inside the range and not in a switched-off topic. */
  const slidesToSend = (l: LectureRow): SlideData[] => {
    const r = rangeOf(l);
    const off = l.report.topics.filter((t) => topicOff.has(`${l.id}:${t.id}`));
    return (loaded[cacheKey(l)] ?? []).filter((s) => r.ok && s.index >= r.from && s.index <= r.to && !off.some((t) => s.index >= t.startSlide && s.index <= t.endSlide));
  };
  const noSlides = ready && sending.some((l) => rangeOf(l).ok && slidesToSend(l).length === 0);

  // The exact text that would be sent. Slides keep their own numbers in the headings, so every answer can be checked against the right slide.
  const markdown = useMemo(
    () => (ready && !noSlides ? sending.map((l, i) => lectureToMarkdown(l, slidesToSend(l), `L${i + 1}`)).join('\n\n---\n\n') : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slidesToSend reads ranges, topicOff and loaded, all listed
    [ready, noSlides, sending.map(cacheKey).join(','), ranges, topicOff, loaded],
  );

  const usable = ai.phase === 'ready' && (ai.status?.state === 'ready' || ai.status?.state === 'low');
  const tooBig = markdown.length > LIMITS.lectureMarkdown;
  const none = !wants.notes && !wants.cards && !wants.questions;
  const badRange = lectures.some((l) => picked.has(l.id) && !rangeOf(l).ok);
  // One request can only hold so many items (the free AI writes at most this many tokens), so the real numbers are shown.
  const outputCap = generateOutputTokens(ai.status?.limits.maxOutputTokens ?? 4_000);

  // ---- the exam plan -------------------------------------------------------------------------
  const wanted = Number(questionCount);
  const countOk = Number.isInteger(wanted) && wanted >= 1 && wanted <= MAX_QUESTIONS;
  const lectureQuestions = useMemo(() => (planLecture && existing ? existing.filter((q) => q.lectureIds.includes(planLecture.id)) : []), [planLecture?.id, existing]);
  const plan = useMemo(() => {
    if (!planLecture || !countOk) return [];
    const slides = slidesToSend(planLecture);
    const off = planLecture.report.topics.filter((t) => !topicOff.has(`${planLecture.id}:${t.id}`));
    return buildBlueprint({
      slides,
      topics: off,
      count: wanted,
      examStyle: course.examStyle,
      existing: lectureQuestions.map((q) => ({ topic: q.topic, slides: q.sources.filter((s) => s.lectureId === planLecture.id).map((s) => s.slide), type: q.type })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slidesToSend reads ranges, topicOff and loaded, all listed
  }, [planLecture?.id, planLecture?.updatedAt, countOk, wanted, course.examStyle, lectureQuestions, ranges, topicOff, loaded]);
  const requests = useMemo(() => splitIntoRequests(plan, outputCap), [plan, outputCap]);
  const thisRequest = requests[0] ?? [];
  const planned: PlannedSlot[] = thisRequest.map(({ n: _n, ...rest }) => rest);
  /** Questions you already have for this lecture, newest first, so the AI does not write them again. */
  const alreadyAsked = useMemo(() => [...lectureQuestions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40).map((q) => q.prompt.replace(/\s+/g, ' ').trim().slice(0, 200)), [lectureQuestions]);

  const counts = packCounts({ wants, amount, outputTokens: outputCap, ...(planned.length > 0 ? { blueprint: planned } : {}) });
  const countText = [counts.questions > 0 && `${counts.questions} exam question${counts.questions === 1 ? '' : 's'}`, counts.cards > 0 && `${counts.cards} flashcard${counts.cards === 1 ? '' : 's'}`, counts.notes > 0 && `${counts.notes} note${counts.notes === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  const nothingToAsk = wants.questions && countOk && !!planLecture && ready && !noSlides && plan.length === 0;

  const go = async () => {
    setBusy(true);
    setError(undefined);
    const reply = await askAi({
      task: 'generate',
      lectureMarkdown: markdown,
      wants,
      amount,
      ...(course.examStyle?.trim() ? { examStyle: course.examStyle.trim().slice(0, LIMITS.examStyle) } : {}),
      ...(planned.length > 0 ? { blueprint: planned, ...(alreadyAsked.length > 0 ? { alreadyAsked } : {}) } : {}),
    });
    setBusy(false);
    if (!reply.ok) setError(reply.message);
    else {
      onGenerated(reply.text, reply.truncated === true, planned.length > 0 ? planned : undefined);
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      wide
      title="Generate study material with the AI tutor"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !usable || !consent || picked.size === 0 || tooBig || none || badRange || markdown.length < 20 || (wants.questions && !countOk)} onClick={() => void go()}>
            {busy ? 'Writing…' : 'Generate and check'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="max-w-prose text-ink-2">The AI drafts flashcards and exam questions from your slides. Nothing is saved yet: you see a checking screen first, where every quote it cites is looked up on your real slides and every item waits for your approval.</p>
        {!usable && (
          <p className="rounded-[var(--radius-control)] border border-warn/40 bg-warn-soft/40 px-3 py-2">
            {ai.phase === 'unavailable' ? 'AI is not available in this copy of the app.' : ai.phase === 'ready' ? (ai.status?.reasons[0] ?? 'AI is off.') : 'AI is not set up, or you are signed out.'}{' '}
            {ai.phase !== 'unavailable' && <Link to="/settings" className="text-accent underline underline-offset-2">Open Settings → AI</Link>}
          </p>
        )}
        <fieldset>
          <legend className="font-medium">Lectures</legend>
          <ul className="mt-1 flex flex-col gap-1">
            {lectures.map((l) => (
              <li key={l.id}>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={picked.has(l.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(l.id);
                      else next.delete(l.id);
                      setPicked(next);
                    }}
                  />
                  {l.title} <span className="text-ink-3">({l.slideCount} slides)</span>
                </label>
                {picked.has(l.id) && l.slideCount > 1 && (
                  <div className="ml-6 mt-1 flex flex-wrap items-center gap-2 text-ink-2">
                    <span>Only send slides</span>
                    <TextInput
                      inputMode="numeric"
                      aria-label={`First slide of ${l.title}`}
                      className="!w-16 !min-h-8 text-center"
                      value={ranges[l.id]?.from ?? '1'}
                      onChange={(e) => setRanges({ ...ranges, [l.id]: { from: e.target.value.replace(/\D/g, ''), to: ranges[l.id]?.to ?? String(l.slideCount) } })}
                    />
                    <span aria-hidden>to</span>
                    <TextInput
                      inputMode="numeric"
                      aria-label={`Last slide of ${l.title}`}
                      className="!w-16 !min-h-8 text-center"
                      value={ranges[l.id]?.to ?? String(l.slideCount)}
                      onChange={(e) => setRanges({ ...ranges, [l.id]: { from: ranges[l.id]?.from ?? '1', to: e.target.value.replace(/\D/g, '') } })}
                    />
                    {!rangeOf(l).ok && <span role="alert" className="text-bad">Use whole slide numbers from 1 to {l.slideCount}, first not after last.</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {wants.questions && chosen.length > 1 && <p className="mt-1 text-ink-2">Exam questions are planned one lecture at a time, so only “{sending[0]?.title}” is used for them.</p>}
        </fieldset>
        {planLecture && planLecture.report.topics.length > 1 && (
          <details className="rounded-[var(--radius-control)] border border-rule">
            <summary className="cursor-pointer px-3 py-2 font-medium">Topics to ask about ({planLecture.report.topics.filter((t) => !topicOff.has(`${planLecture.id}:${t.id}`)).length} of {planLecture.report.topics.length})</summary>
            <ul className="flex flex-col gap-1 border-t border-rule px-3 py-2">
              {planLecture.report.topics.map((t) => (
                <li key={t.id}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-[var(--accent)]"
                      checked={!topicOff.has(`${planLecture.id}:${t.id}`)}
                      onChange={(e) => {
                        const next = new Set(topicOff);
                        if (e.target.checked) next.delete(`${planLecture.id}:${t.id}`);
                        else next.add(`${planLecture.id}:${t.id}`);
                        setTopicOff(next);
                      }}
                    />
                    <span className="min-w-0 truncate">{t.title}</span>
                    <span className="shrink-0 text-ink-3">{t.startSlide === t.endSlide ? `slide ${t.startSlide}` : `slides ${t.startSlide}–${t.endSlide}`}</span>
                  </label>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {(['cards', 'questions', 'notes'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" className="accent-[var(--accent)]" checked={wants[k]} onChange={(e) => setWants({ ...wants, [k]: e.target.checked })} /> {k === 'cards' ? 'Flashcards' : k === 'questions' ? 'Exam questions' : 'Notes'}
            </label>
          ))}
          {(wants.cards || wants.notes) && (
            <label className="flex items-center gap-2">
              How many
              <Select value={amount} onChange={(e) => setAmount(e.target.value as typeof amount)} className="w-auto">
                <option value="few">A few</option>
                <option value="normal">A normal set</option>
                <option value="many">Many</option>
              </Select>
            </label>
          )}
          {wants.questions && (
            <label className="flex items-center gap-2">
              Exam questions to plan
              <TextInput inputMode="numeric" aria-label="Number of exam questions to plan" className="!w-16 !min-h-8 text-center" value={questionCount} onChange={(e) => setQuestionCount(e.target.value.replace(/\D/g, ''))} />
            </label>
          )}
        </div>
        {wants.questions && !countOk && <p role="alert" className="text-bad">Plan between 1 and {MAX_QUESTIONS} questions.</p>}
        {countText && (
          <p className="text-ink-2">
            This request asks for {countText}. The free AI writes at most about {outputCap.toLocaleString()} tokens per answer, so a bigger set needs several requests on different slides, each one shown to you first.
          </p>
        )}
        {wants.questions && plan.length > 0 && (
          <section aria-label="Exam plan" className="rounded-[var(--radius-control)] border border-rule bg-sunken/40 px-3 py-2">
            <h3 className="font-medium">
              Exam plan: {plan.length} question{plan.length === 1 ? '' : 's'}, {requests.length} request{requests.length === 1 ? '' : 's'}
            </h3>
            <p className="text-ink-2">A sensible mix for this material, made on your device. It is not a prediction of your real exam{course.examStyle?.trim() ? ', and it follows the exam instructions you saved' : ''}. This request writes the first {thisRequest.length}; after you import them, open this again for the next ones: it will skip what you already have.</p>
            <ol className="mt-2 flex list-decimal flex-col gap-0.5 pl-5 text-[13px] text-ink-2">
              {plan.map((s) => (
                <li key={s.n} className={thisRequest.some((x) => x.n === s.n) ? 'font-medium text-ink' : ''}>
                  {describeSlot(s)}
                  {thisRequest.some((x) => x.n === s.n) ? ' (this request)' : ''}
                </li>
              ))}
            </ol>
          </section>
        )}
        {nothingToAsk && <p className="text-ink-2">These slides have too little text to plan exam questions from, so the request will ask for a general set instead.</p>}
        <details className="rounded-[var(--radius-control)] border border-rule bg-sunken/40">
          <summary className="cursor-pointer px-3 py-2 font-medium">
            What will be sent to Google: the text of {sending.length} lecture{sending.length === 1 ? '' : 's'}
            {sending.map((l) => (rangeOf(l).ok && l.slideCount > 1 && (rangeOf(l).from !== 1 || rangeOf(l).to !== l.slideCount) ? `, slides ${rangeOf(l).from}–${rangeOf(l).to} of ${l.title}` : '')).join('')} (about {Math.round(markdown.length / 4).toLocaleString()} tokens)
          </summary>
          <div className="border-t border-rule px-3 py-3">
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-xs">{markdown || '(choose a lecture)'}</pre>
            {planned.length > 0 && <p className="mt-2 text-ink-2">Also sent: the plan above for this request ({planned.length} question{planned.length === 1 ? '' : 's'}: kind, difficulty, marks, topic and slides of each).</p>}
            {planned.length > 0 && alreadyAsked.length > 0 && (
              <div className="mt-2 text-ink-2">
                <p>Also sent, so they are not repeated: the wording of {alreadyAsked.length} question{alreadyAsked.length === 1 ? '' : 's'} you already have for this lecture.</p>
                <ul className="mt-1 max-h-24 list-disc overflow-y-auto pl-5 text-[13px]">
                  {alreadyAsked.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-2 text-ink-2">Plus fixed instructions for the format. Only slide text is sent, never pictures, files or account details.</p>
          </div>
        </details>
        {noSlides && <p role="alert" className="text-bad">No slides are left to send. Switch a topic back on or widen the slide range.</p>}
        {tooBig && <p role="alert" className="text-bad">That is too much text for one request. Choose fewer lectures.</p>}
        {!consent && usable && (
          <label className="flex items-start gap-2 rounded-[var(--radius-control)] border border-warn/40 bg-warn-soft/40 p-3">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" onChange={(e) => e.target.checked && void setConsent(new Date().toISOString().slice(0, 10))} />
            <span>I understand this text is sent to Google’s free Gemini service and may be used by Google to improve its products.</span>
          </label>
        )}
        {error && (
          <p role="alert" className="text-bad">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
