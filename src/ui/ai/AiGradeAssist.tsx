import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Sparkles } from 'lucide-react';
import { askAi, refreshAi, useAiServer } from '@/app/ai';
import { useSetting } from '@/app/data';
import { getDb } from '@/core/db/db';
import { displayTitle } from '@/core/pptx/topics';
import type { Grade, QuestionRow } from '@/core/study/types';
import { buildContext, slideContextText, type ContextSlide } from '@/core/tutor/context';
import { readGradeReply, type GradeProposal } from '@/core/tutor/parse';
import { MathText } from '@/ui/MathText';
import { Button } from '@/ui/primitives';

const db = getDb();

const OVERALL = (marks: number) => [{ id: 'overall', text: 'The answer is complete and correct compared with the model answer.', marks }];

/**
 * An optional second opinion on a written answer. It is an ESTIMATE against the marking points, labelled as the AI's, never
 * an examiner's mark, and it only becomes your mark when you accept it. What is sent is shown first.
 */
export function AiGradeAssist({ q, answerText, onAccept }: { q: QuestionRow; answerText: string; onAccept: (g: Grade) => Promise<void> }) {
  const ai = useAiServer();
  const [consent, setConsent] = useSetting<string>('aiConsentAt');
  useEffect(() => {
    void refreshAi(); // after a page reload the state starts empty; asking is cheap and shared between screens
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [proposal, setProposal] = useState<GradeProposal | undefined>();
  const usable = ai.phase === 'ready' && (ai.status?.state === 'ready' || ai.status?.state === 'low');
  const rubric = q.rubric.length > 0 ? q.rubric.map((p) => ({ id: p.id, text: p.text, marks: p.marks })) : OVERALL(q.marks);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    setProposal(undefined);
    try {
      // Up to three of the slides the question came from help the grader stay faithful to the lecture.
      const ctx: ContextSlide[] = [];
      for (const s of q.sources.slice(0, 3)) {
        const lec = await db.lectures.get(s.lectureId);
        const row = await db.slides.get([s.lectureId, s.slide]);
        if (lec && row) ctx.push({ lectureId: lec.id, lectureTitle: lec.title, revision: lec.revision, slide: s.slide, title: displayTitle(row), text: slideContextText(row, lec.meta.slideHeight) });
      }
      const excerpts = buildContext(ctx).excerpts;
      const reply = await askAi({
        task: 'grade',
        question: { type: q.type, prompt: q.prompt.slice(0, 10_000), marks: q.marks, ...(q.modelAnswer?.trim() ? { modelAnswer: q.modelAnswer.slice(0, 10_000) } : {}), rubric: rubric.map((r) => ({ ...r, id: r.id.slice(0, 80), text: r.text.slice(0, 2_000) })) },
        answer: answerText.slice(0, 20_000),
        ...(excerpts.length > 0 ? { excerpts: excerpts.slice(0, 6) } : {}),
      });
      if (!reply.ok) setError(reply.message);
      else {
        const read = readGradeReply(reply, rubric);
        if (read.ok) setProposal(read.proposal);
        else setError(read.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The grader’s answer could not be read.');
    } finally {
      setBusy(false);
    }
  };

  const accept = async (p: GradeProposal) => {
    const items = q.rubric.length > 0 ? p.points.map((x) => ({ pointId: x.id, awarded: x.awarded })) : [];
    const comment = [p.feedback, p.missing.length > 0 ? `Missing: ${p.missing.join('; ')}` : ''].filter(Boolean).join(' ').slice(0, 5_000);
    await onAccept({ marks: Math.min(q.marks, p.total), max: q.marks, items, ...(comment ? { comment } : {}), by: 'ai', uncertain: true, gradedAt: Date.now() });
    setProposal(undefined);
  };

  return (
    <div className="rounded-[var(--radius-panel)] border border-rule bg-sunken/40 p-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4" aria-hidden /> Second opinion from the AI (optional)
      </h4>
      <p className="mt-1 max-w-prose text-[13px] text-ink-3">The AI reads your answer against the marking points and suggests marks. It is an estimate, not an examiner’s mark, and it can be wrong. It uses one request and sends your answer, the question, the marking points and up to three source slides to Google’s free Gemini service.</p>

      {!usable ? (
        <p className="mt-2 text-sm text-ink-2">
          {ai.phase === 'unavailable' ? 'AI is not available in this copy of the app.' : ai.phase === 'ready' ? (ai.status?.reasons[0] ?? 'AI is off.') : 'AI is not set up or you are signed out.'}{' '}
          {ai.phase !== 'unavailable' && <Link to="/settings" className="text-accent underline underline-offset-2">Open Settings → AI</Link>}
        </p>
      ) : (
        <div className="mt-3">
          {!consent && (
            <label className="mb-3 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" onChange={(e) => e.target.checked && void setConsent(new Date().toISOString().slice(0, 10))} />
              <span>I understand this text is sent to Google’s free Gemini service and may be used by Google to improve its products.</span>
            </label>
          )}
          <Button size="sm" disabled={busy || !consent || answerText.trim().length === 0} onClick={() => void run()}>
            {busy ? 'Asking…' : 'Ask the AI to mark this'}
          </Button>
          {answerText.trim().length === 0 && <span className="ml-3 text-sm text-ink-3">There is no answer to mark.</span>}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      )}

      {proposal && (
        <div className="mt-4 border-t border-rule pt-4" aria-label="AI's suggested marks">
          <p className="text-sm">
            Suggested: <span className="font-semibold tabular-nums">{proposal.total}</span> / {q.marks}{' '}
            <span className="text-ink-3">· the AI’s confidence is {proposal.confidence}. Treat this as a rough estimate.</span>
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {proposal.points.map((p) => {
              const r = rubric.find((x) => x.id === p.id);
              return (
                <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-rule pt-1 first:border-t-0">
                  <span>
                    {r ? <MathText>{r.text}</MathText> : null}
                    {p.reason && <span className="block text-ink-3">{p.reason}</span>}
                  </span>
                  <span className="tabular-nums">
                    {p.awarded} / {p.max}
                  </span>
                </li>
              );
            })}
          </ul>
          {proposal.feedback && <p className="mt-2 text-sm">{proposal.feedback}</p>}
          {proposal.missing.length > 0 && <p className="mt-1 text-sm text-ink-2">Possibly missing: {proposal.missing.join('; ')}.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => void accept(proposal)}>
              Use these marks
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProposal(undefined)}>
              Discard
            </Button>
          </div>
          <p className="mt-2 text-[13px] text-ink-3">If you use them they are saved as “AI estimate”. You can still change them below.</p>
        </div>
      )}
    </div>
  );
}
