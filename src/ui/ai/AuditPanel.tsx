import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Sparkles } from 'lucide-react';
import { askAi, refreshAi, useAiServer } from '@/app/ai';
import { useSetting } from '@/app/data';
import { AUDIT_MAX_QUESTIONS, auditFindings, auditQuestions, findingText, parseAudit, type AuditFinding, type AuditQuestion } from '@/core/study/audit';
import { Button } from '@/ui/primitives';

interface Checked {
  /** What was sent, so a finding can still be matched to its marking point after other points were removed. */
  sent: AuditQuestion[];
  findings: AuditFinding[];
}

/**
 * An optional check, by the AI, that every marking point answers something the question explicitly asks. The device has already
 * counted what each question asks for; this reads the meaning. What is sent (questions, marking points and model answers, never
 * your slides) is shown first, it costs one request, and a point it flags can be removed here (the question then loses those marks).
 */
export function AuditPanel({ questions, onRemove }: { questions: AuditQuestion[]; onRemove: (n: number, point: number) => void }) {
  const ai = useAiServer();
  const [consent, setConsent] = useSetting<string>('aiConsentAt');
  useEffect(() => {
    void refreshAi();
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [checked, setChecked] = useState<Checked | undefined>();
  const usable = ai.phase === 'ready' && (ai.status?.state === 'ready' || ai.status?.state === 'low');

  const toSend = useMemo(() => auditQuestions(questions), [questions]);
  const writtenCount = useMemo(() => questions.filter((q) => q.rubric.length > 0 && q.type !== 'mcq' && q.type !== 'truefalse').length, [questions]);

  // A new pack, or a question that was edited, starts a fresh check.
  const signature = useMemo(() => JSON.stringify(questions.map((q) => [q.n, q.prompt])), [questions]);
  useEffect(() => {
    setChecked(undefined);
    setError(undefined);
  }, [signature]);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    setChecked(undefined);
    try {
      const reply = await askAi({ task: 'audit', questions: toSend });
      if (!reply.ok) setError(reply.message);
      else if (reply.truncated) setError('The AI’s answer was cut off, so it could not be read. Try again with fewer questions.');
      else {
        const verdicts = parseAudit(reply.text);
        if (!verdicts) setError('The AI’s answer could not be read.');
        else setChecked({ sent: toSend, findings: auditFindings(verdicts, toSend) });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The check failed.');
    } finally {
      setBusy(false);
    }
  };

  // The findings that still apply: a point that was removed has no finding left, and the others keep their place by wording.
  const shown = useMemo(() => {
    if (!checked) return [];
    const now = new Map(questions.map((q) => [q.n, q]));
    return checked.findings.flatMap((f) => {
      const q = now.get(f.n);
      if (!q) return [];
      if (f.point === undefined) return [{ f, point: undefined as number | undefined, removable: false }];
      const at = q.rubric.findIndex((r) => r.text === f.pointText);
      return at < 0 ? [] : [{ f, point: at + 1, removable: q.rubric.length > 1 }];
    });
  }, [checked, questions]);
  const checkedCount = checked?.sent.length ?? 0;

  if (writtenCount === 0) return null;
  return (
    <section aria-label="AI check of the marking points" className="rounded-[var(--radius-panel)] border border-rule bg-sunken/40 p-4">
      <h3 className="flex items-center gap-2 font-medium">
        <Sparkles className="size-4" aria-hidden /> Check the marking points with the AI (optional)
      </h3>
      <p className="mt-1 max-w-prose text-[13px] text-ink-3">
        The checks above count what each question asks for. The AI reads the meaning: does the question itself ask for every marking point? A point it cannot find in the question is padding or a different question. It uses one request, and
        {writtenCount > AUDIT_MAX_QUESTIONS ? ` looks at the first ${AUDIT_MAX_QUESTIONS} written questions` : ' looks at the written questions'}.
      </p>
      <details className="mt-2 text-[13px] text-ink-2">
        <summary className="cursor-pointer">What will be sent to Google</summary>
        <div className="mt-1 max-h-40 overflow-y-auto rounded-[var(--radius-control)] border border-rule bg-surface p-2">
          <p>Only the text below: each question, its marking points and its model answer. No slides, files or account details.</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            {toSend.map((q) => (
              <li key={q.n}>
                {q.prompt.slice(0, 200)}
                {q.prompt.length > 200 ? '…' : ''} <span className="text-ink-3">({q.rubric.length} marking points)</span>
              </li>
            ))}
          </ol>
        </div>
      </details>

      {!usable ? (
        <p className="mt-2 text-sm text-ink-2">
          {ai.phase === 'unavailable' ? 'AI is not available in this copy of the app.' : ai.phase === 'ready' ? (ai.status?.reasons[0] ?? 'AI is off.') : 'AI is not set up, or you are signed out.'}{' '}
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
          <Button size="sm" disabled={busy || !consent || toSend.length === 0} onClick={() => void run()}>
            {busy ? 'Checking…' : 'Check with the AI'}
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      )}

      {checked && (
        <div className="mt-4 border-t border-rule pt-3" aria-label="What the AI found">
          <p className="text-sm">
            {checked.findings.length === 0 ? `The AI found nothing to report in the ${checkedCount} question${checkedCount === 1 ? '' : 's'} it read: every marking point is asked for.` : shown.length === 0 ? 'Everything the AI flagged has been dealt with.' : `The AI read ${checkedCount} question${checkedCount === 1 ? '' : 's'} and found ${shown.length} thing${shown.length === 1 ? '' : 's'} to look at. It can be wrong: you decide.`}
          </p>
          {shown.length > 0 && (
            <ul className="mt-2 flex flex-col gap-2 text-[13px]">
              {shown.map(({ f, point, removable }, i) => (
                <li key={`${f.n}-${f.point ?? 'q'}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                  <span>
                    <span className="font-medium text-ink">Question #{f.n}:</span> {findingText(f, point)}
                  </span>
                  {point !== undefined && (
                    <Button size="sm" variant="secondary" disabled={!removable} onClick={() => onRemove(f.n, point - 1)} aria-label={`Remove marking point ${point} of question ${f.n}`}>
                      Remove this point
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {shown.some((s) => s.point !== undefined) && <p className="mt-2 text-[13px] text-ink-3">Removing a point also takes its marks off the question, so the marks stay what the question really asks for.</p>}
        </div>
      )}
    </section>
  );
}
