import { useEffect, useState } from 'react';
import { CircleCheck, Circle, ExternalLink } from 'lucide-react';
import { logoutOwner, ownerAction, refreshAi, useAiServer } from '@/app/ai';
import { useToast } from '@/app/toast';
import type { AttestName, OwnerStatus } from '@/core/tutor/contract';
import { Button, Callout, Field, Select, Spinner, TextInput } from '@/ui/primitives';
import { OwnerSignIn } from './OwnerSignIn';

const usd = (n: number | undefined, digits = 4) => (n === undefined ? '–' : `$${n.toFixed(n >= 0.01 ? 2 : digits)}`);

/** Models with a free tier and a known price, with the free daily quota this project showed in AI Studio on 2026-10-16. */
const MODELS: { id: string; label: string; note: string }[] = [
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', note: '500 requests/day on your project (recommended)' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', note: '500 requests/day on your project' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', note: 'only 20 requests/day on your project' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'only 20 requests/day on your project' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', note: 'only 20 requests/day on your project' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'only 20 requests/day on your project' },
];

const STATE_LABEL: Record<OwnerStatus['state'], { text: string; cls: string }> = {
  off: { text: 'Off', cls: 'bg-sunken text-ink-2' },
  ready: { text: 'Ready', cls: 'bg-ok-soft text-ok' },
  low: { text: 'Budget almost used', cls: 'bg-warn-soft text-warn' },
  paused: { text: 'Paused', cls: 'bg-bad-soft text-bad' },
  unknown: { text: 'Cannot check budget', cls: 'bg-bad-soft text-bad' },
};

/** Settings → AI. Everything the owner must do or decide, in order, with the facts only they can check. */
export function OwnerPanel() {
  const ai = useAiServer();
  useEffect(() => {
    void refreshAi();
  }, []);

  if (ai.phase === 'loading') return <Spinner label="Looking for the AI server" />;

  if (ai.phase === 'unavailable') {
    return (
      <Callout tone="info" title="AI is off here">
        <p>This copy of the app has no AI server, so nothing is ever sent anywhere. Reading, searching, flashcards, notes, practice exams and backups all work without it.</p>
        <p className="mt-2">The AI tutor runs on your own private Cloudflare site (see docs/DEPLOY.md). Nothing has been deployed yet.</p>
      </Callout>
    );
  }

  if (ai.phase === 'unconfigured') {
    return (
      <Callout tone="warn" title="The AI server is not set up yet">
        <p>It has no owner key. Run <code>pnpm owner:keygen</code>, store the two server values as secrets, and reload (docs/DEPLOY.md). Until then nobody can use the AI.</p>
      </Callout>
    );
  }

  if (ai.phase === 'signed-out' || !ai.status) {
    return (
      <div>
        <p className="mb-3 max-w-prose text-sm text-ink-2">The AI part of this site is private. Sign in with your owner key to use the tutor or to change these settings.</p>
        <OwnerSignIn />
      </div>
    );
  }
  return <SignedIn status={ai.status} />;
}

function SignedIn({ status }: { status: OwnerStatus }) {
  const label = STATE_LABEL[status.state];
  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium ${label.cls}`}>{label.text}</span>
          <span className="text-sm text-ink-2">
            {status.keyPresent ? `Model: ${status.model}` : 'The Gemini key is not set on the server yet.'}
          </span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => void logoutOwner(false)}>
              Sign out
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void logoutOwner(true)} title="Ends every signed-in session, on every device">
              Sign out everywhere
            </Button>
          </span>
        </div>
        {status.reasons.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-2">
            {status.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[13px] text-ink-3">
          {status.billing === 'owner-attested-not-verified' ? 'Billing safety: confirmed by you, not verified by this app. It cannot see your Google account.' : 'Billing safety: not confirmed yet. Nothing is ever sent until you confirm it.'}
        </p>
      </div>

      <Usage status={status} />
      <Checklist status={status} />
      <Controls status={status} />
      <Maintenance status={status} />
    </div>
  );
}

function Usage({ status }: { status: OwnerStatus }) {
  if (status.spentDayUsd === undefined) return null;
  const pct = (spent: number | undefined, cap: number) => Math.min(100, Math.round(((spent ?? 0) / cap) * 100));
  return (
    <section aria-labelledby="ai-usage-h">
      <h3 id="ai-usage-h" className="font-semibold">
        Usage
      </h3>
      <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-ink-3">Requests today</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {status.requestsToday ?? 0} <span className="text-sm font-normal text-ink-3">of {status.limits.maxRequestsPerDay}</span>
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Estimated cost today</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {usd(status.spentDayUsd)} <span className="text-sm font-normal text-ink-3">of {usd(status.budgets.dailyUsd, 2)}</span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${pct(status.spentDayUsd, status.budgets.dailyUsd)} percent of today's estimate used`}>
              <span className="block h-full bg-accent" style={{ width: `${pct(status.spentDayUsd, status.budgets.dailyUsd)}%` }} />
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Estimated cost this month</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {usd(status.spentMonthUsd)} <span className="text-sm font-normal text-ink-3">of {usd(status.budgets.monthlyUsd, 2)}</span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${pct(status.spentMonthUsd, status.budgets.monthlyUsd)} percent of this month's estimate used`}>
              <span className="block h-full bg-accent" style={{ width: `${pct(status.spentMonthUsd, status.budgets.monthlyUsd)}%` }} />
            </span>
          </dd>
        </div>
      </dl>
      <p className="mt-3 max-w-prose text-[13px] text-ink-3">
        These are <strong className="font-medium text-ink-2">estimates at Google’s paid prices</strong>, used as a safety limit. On the free tier nothing is charged. They are not permission to spend money and not a guarantee against billing; your real protection is that the Google project has no billing account.
      </p>
    </section>
  );
}

const ITEMS: { name: Exclude<AttestName, 'observedFreeLimits' | 'firstRequestApproved'>; title: string; body: string; link?: { href: string; text: string } }[] = [
  {
    name: 'projectHasNoBilling',
    title: 'The Google project has no billing account',
    body: 'In Google AI Studio → Projects, the project that owns your key shows Billing Tier “Free tier”, and the Billing page says “No billing account”. Never press “Set up billing”.',
    link: { href: 'https://aistudio.google.com/projects', text: 'Open AI Studio → Projects' },
  },
  {
    name: 'modelsFreeOfCharge',
    title: 'The chosen model is free of charge',
    body: 'On Google’s pricing page, the model below is listed “Free of charge” for input and output.',
    link: { href: 'https://ai.google.dev/gemini-api/docs/pricing', text: 'Open the pricing page' },
  },
  {
    name: 'acceptsFreeTierDataUse',
    title: 'You accept how the free tier uses your content',
    body: 'Google may use free-tier content to improve its products. Only send lecture text you are comfortable sharing; the tutor shows you exactly what is sent before each request.',
  },
];

function Row({ title, done, confirmedAt, onWithdraw, withdrawing, children }: { title: string; done: boolean; confirmedAt: string | undefined; onWithdraw: () => void; withdrawing: boolean; children: React.ReactNode }) {
  return (
    <li className="border-t border-rule py-4 first:border-t-0">
      <div className="flex items-start gap-3">
        {done ? <CircleCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden /> : <Circle className="mt-0.5 size-5 shrink-0 text-ink-3" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {title} <span className="sr-only">{done ? '(confirmed)' : '(not confirmed)'}</span>
          </p>
          {children}
          {done && (
            <p className="mt-2 text-sm text-ink-2">
              Confirmed {confirmedAt}.{' '}
              <button type="button" className="text-accent underline underline-offset-2" onClick={onWithdraw} disabled={withdrawing}>
                Withdraw
              </button>
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function Checklist({ status }: { status: OwnerStatus }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [ack, setAck] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState({ requestsPerDay: '500', requestsPerMinute: '15', tokensPerMinute: '250000' });
  const a = status.attestations;

  useEffect(() => {
    const f = status.observedFreeLimits;
    if (f) setLimits({ requestsPerDay: String(f.requestsPerDay), requestsPerMinute: String(f.requestsPerMinute), tokensPerMinute: String(f.tokensPerMinute) });
  }, [status.observedFreeLimits]);

  const run = async (key: string, fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) => {
    setBusy(key);
    setError(undefined);
    const r = await fn();
    setBusy(undefined);
    if (!r.ok) setError(r.error);
    else if (done) toast.show(done, 'ok');
  };
  const confirm = (name: AttestName, extra: object = {}) => run(name, () => ownerAction('attest', { name, acknowledged: true, ...extra }));
  const withdraw = (name: AttestName) => run(name, () => ownerAction('revoke', { name }), 'Withdrawn. AI is off until you confirm again.');

  const allFour = !!(a.projectHasNoBilling && a.modelsFreeOfCharge && a.acceptsFreeTierDataUse && a.observedFreeLimits);

  return (
    <section aria-labelledby="ai-check-h">
      <h3 id="ai-check-h" className="font-semibold">
        Before AI can run
      </h3>
      <p className="mt-1 max-w-prose text-sm text-ink-2">The app cannot see your Google account, so it relies on you. Check each item yourself, then confirm. Confirmations expire after 30 days and must be checked again.</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      )}
      <ol className="mt-3">
        {ITEMS.map((it) => (
          <Row key={it.name} title={it.title} done={!!a[it.name]} confirmedAt={a[it.name]?.confirmedAt} onWithdraw={() => void withdraw(it.name)} withdrawing={busy === it.name}>
            <p className="mt-1 max-w-prose text-sm text-ink-2">{it.body}</p>
            {it.link && (
              <a className="mt-1 inline-flex items-center gap-1 text-sm text-accent underline underline-offset-2" href={it.link.href} target="_blank" rel="noopener noreferrer">
                {it.link.text} <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
            {!a[it.name] && (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={!!ack[it.name]} onChange={(e) => setAck({ ...ack, [it.name]: e.target.checked })} /> I checked this myself
                </label>
                <Button size="sm" disabled={!ack[it.name] || busy === it.name} onClick={() => void confirm(it.name)}>
                  Confirm
                </Button>
              </div>
            )}
          </Row>
        ))}

        <Row title="The free quotas for the chosen model" done={!!a.observedFreeLimits} confirmedAt={a.observedFreeLimits?.confirmedAt} onWithdraw={() => void withdraw('observedFreeLimits')} withdrawing={busy === 'observedFreeLimits'}>
          <p className="mt-1 max-w-prose text-sm text-ink-2">
            In AI Studio → Rate Limit, find <strong className="font-medium">{status.model}</strong> and type its three limits. The app keeps its own limits well below them. (On 2026-10-16 your project showed 15 per minute, 250K tokens per minute and 500 per day for the recommended model.)
          </p>
          <a className="mt-1 inline-flex items-center gap-1 text-sm text-accent underline underline-offset-2" href="https://aistudio.google.com/rate-limit" target="_blank" rel="noopener noreferrer">
            Open AI Studio → Rate Limit <ExternalLink className="size-3.5" aria-hidden />
          </a>
          {!a.observedFreeLimits && (
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <Field label="Requests per minute" htmlFor="q-rpm">
                <TextInput id="q-rpm" inputMode="numeric" className="w-28" value={limits.requestsPerMinute} onChange={(e) => setLimits({ ...limits, requestsPerMinute: e.target.value })} />
              </Field>
              <Field label="Tokens per minute" htmlFor="q-tpm">
                <TextInput id="q-tpm" inputMode="numeric" className="w-32" value={limits.tokensPerMinute} onChange={(e) => setLimits({ ...limits, tokensPerMinute: e.target.value })} />
              </Field>
              <Field label="Requests per day" htmlFor="q-rpd">
                <TextInput id="q-rpd" inputMode="numeric" className="w-28" value={limits.requestsPerDay} onChange={(e) => setLimits({ ...limits, requestsPerDay: e.target.value })} />
              </Field>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={!!ack['observedFreeLimits']} onChange={(e) => setAck({ ...ack, observedFreeLimits: e.target.checked })} /> These match AI Studio
              </label>
              <Button size="sm" className="mb-2" disabled={!ack['observedFreeLimits'] || busy === 'observedFreeLimits'} onClick={() => void confirm('observedFreeLimits', { requestsPerDay: Number(limits.requestsPerDay), requestsPerMinute: Number(limits.requestsPerMinute), tokensPerMinute: Number(limits.tokensPerMinute) })}>
                Confirm
              </Button>
            </div>
          )}
        </Row>

        <Row title="Approve the first real request" done={!!a.firstRequestApproved} confirmedAt={a.firstRequestApproved?.confirmedAt} onWithdraw={() => void withdraw('firstRequestApproved')} withdrawing={busy === 'firstRequestApproved'}>
          <p className="mt-1 max-w-prose text-sm text-ink-2">
            Until you do this, nothing is ever sent to Google, even if everything above is confirmed and a key is set. After this, the tutor may send your question and the slides you choose to Google’s free Gemini service whenever <em>you</em> press send.
          </p>
          {!a.firstRequestApproved && (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={!!ack['firstRequestApproved']} disabled={!allFour || !status.keyPresent} onChange={(e) => setAck({ ...ack, firstRequestApproved: e.target.checked })} /> I approve sending real requests to Google’s free Gemini service
              </label>
              <Button size="sm" disabled={!ack['firstRequestApproved'] || !allFour || !status.keyPresent || busy === 'firstRequestApproved'} onClick={() => void confirm('firstRequestApproved')}>
                Approve
              </Button>
              {!allFour && <span className="text-sm text-ink-3">Confirm the four items above first.</span>}
              {allFour && !status.keyPresent && <span className="text-sm text-ink-3">The Gemini key is not set on the server yet.</span>}
            </div>
          )}
        </Row>
      </ol>
    </section>
  );
}

function Controls({ status }: { status: OwnerStatus }) {
  const toast = useToast();
  const [form, setForm] = useState({ dailyUsd: String(status.budgets.dailyUsd), monthlyUsd: String(status.budgets.monthlyUsd), maxRequestsPerDay: String(status.limits.maxRequestsPerDay), maxOutputTokens: String(status.limits.maxOutputTokens) });
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm({ dailyUsd: String(status.budgets.dailyUsd), monthlyUsd: String(status.budgets.monthlyUsd), maxRequestsPerDay: String(status.limits.maxRequestsPerDay), maxOutputTokens: String(status.limits.maxOutputTokens) });
  }, [status.budgets.dailyUsd, status.budgets.monthlyUsd, status.limits.maxRequestsPerDay, status.limits.maxOutputTokens]);

  const send = async (patch: object, done: string) => {
    setBusy(true);
    setError(undefined);
    const r = await ownerAction('config', patch);
    setBusy(false);
    if (!r.ok) setError(r.error);
    else toast.show(done, 'ok');
  };
  const ready = !!(status.attestations.projectHasNoBilling && status.attestations.modelsFreeOfCharge && status.attestations.acceptsFreeTierDataUse && status.attestations.observedFreeLimits && status.attestations.firstRequestApproved);

  return (
    <section aria-labelledby="ai-ctl-h">
      <h3 id="ai-ctl-h" className="font-semibold">
        Switch and limits
      </h3>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant={status.enabled ? 'secondary' : 'primary'} disabled={busy || (!status.enabled && !ready)} onClick={() => void send({ enabled: !status.enabled }, status.enabled ? 'AI is off.' : 'AI is on.')} aria-pressed={status.enabled}>
          {status.enabled ? 'Turn AI off' : 'Turn AI on'}
        </Button>
        {!ready && !status.enabled && <span className="text-sm text-ink-3">Finish the list above first.</span>}
      </div>

      <div className="mt-5 max-w-md">
        <Field label="Model" htmlFor="ai-model" hint="Changing the model switches AI off and asks you to confirm the free quotas again, because each model has its own.">
          <Select id="ai-model" value={status.model} disabled={busy} onChange={(e) => void send({ models: [e.target.value] }, 'Model changed. Confirm the quotas again.')}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}: {m.note}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <form
        className="mt-4 grid max-w-xl gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send({ budgets: { dailyUsd: Number(form.dailyUsd), monthlyUsd: Number(form.monthlyUsd) }, limits: { maxRequestsPerDay: Number(form.maxRequestsPerDay), maxOutputTokens: Number(form.maxOutputTokens) } }, 'Limits saved.');
        }}
      >
        <Field label="Daily estimate limit (dollars)" htmlFor="b-day" hint="At most $1.">
          <TextInput id="b-day" inputMode="decimal" value={form.dailyUsd} onChange={(e) => setForm({ ...form, dailyUsd: e.target.value })} />
        </Field>
        <Field label="Monthly estimate limit (dollars)" htmlFor="b-month" hint="At most $5.">
          <TextInput id="b-month" inputMode="decimal" value={form.monthlyUsd} onChange={(e) => setForm({ ...form, monthlyUsd: e.target.value })} />
        </Field>
        <Field label="Most requests per day" htmlFor="b-req" hint="At most half of the free daily quota you entered.">
          <TextInput id="b-req" inputMode="numeric" value={form.maxRequestsPerDay} onChange={(e) => setForm({ ...form, maxRequestsPerDay: e.target.value })} />
        </Field>
        <Field label="Longest answer (tokens)" htmlFor="b-out">
          <TextInput id="b-out" inputMode="numeric" value={form.maxOutputTokens} onChange={(e) => setForm({ ...form, maxOutputTokens: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy}>
            Save limits
          </Button>
          {error && (
            <p role="alert" className="mt-2 text-sm text-bad">
              {error}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

function Maintenance({ status }: { status: OwnerStatus }) {
  const toast = useToast();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | undefined>();
  const unresolved = status.unresolved ?? [];
  if (status.state !== 'paused' && unresolved.length === 0) return null;

  return (
    <section aria-labelledby="ai-fix-h">
      <h3 id="ai-fix-h" className="font-semibold">
        Paused or unclear requests
      </h3>
      {status.state === 'paused' && (
        <div className="mt-2">
          <p className="max-w-prose text-sm text-ink-2">AI stopped by itself. Read the reasons above, check AI Studio (and that the project still shows “Free tier”), then resume.</p>
          <Button className="mt-2" onClick={() => void ownerAction('reset-pause', {}).then((r) => (r.ok ? toast.show('Resumed.', 'ok') : setError(r.error)))}>
            I checked, resume AI
          </Button>
        </div>
      )}
      {unresolved.length > 0 && (
        <div className="mt-4">
          <p className="max-w-prose text-sm text-ink-2">These requests did not finish cleanly, so they are counted at their worst-case estimate until you say what they really cost. On the free tier, that is $0.</p>
          <ul className="mt-2 flex flex-col gap-2">
            {unresolved.map((u) => (
              <li key={u.id} className="flex flex-wrap items-end gap-3 border-t border-rule pt-2 text-sm">
                <span className="min-w-0 flex-1">
                  Counted as {usd(u.amountUsd)}. <span className="text-ink-3">{u.reason}</span>
                </span>
                <Field label="Real cost (dollars)" htmlFor={`rc-${u.id}`}>
                  <TextInput id={`rc-${u.id}`} inputMode="decimal" className="w-28" value={amounts[u.id] ?? '0'} onChange={(e) => setAmounts({ ...amounts, [u.id]: e.target.value })} />
                </Field>
                <Button size="sm" onClick={() => void ownerAction('reconcile', { id: u.id, usd: Number(amounts[u.id] ?? '0') }).then((r) => (r.ok ? toast.show('Updated.', 'ok') : setError(r.error)))}>
                  Update
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
