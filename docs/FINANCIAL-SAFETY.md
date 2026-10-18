# Financial safety: designed to cost $0.00

StudyAI's AI features are optional, and they are built so that running them costs nothing: Gemini's free tier, Cloudflare's free plan, and a guard that stops AI whenever the budget is unclear. This document says what the code enforces (a test proves each rule) and what only the person who deploys it can check in a third-party dashboard. The app refuses to turn AI on until that person has confirmed those things, and it never describes a confirmation as "verified".

**Priority order, always:** preventing a charge comes before the AI tutor working. Every guard **fails closed**: if anything is missing, stale, unreadable or inconsistent, AI stops and the offline study features carry on.

## 1. What the application guarantees by construction

| Rule | How it is enforced |
|---|---|
| The app works with **no AI at all** | Upload, parsing, viewer, search, notes, flashcards, exams and backups are 100 % local (IndexedDB). Static tests (`tests/ai.isolation.test.ts`) prove that no offline module imports the AI code or contains a network call. |
| The browser never reaches an AI service | The Content-Security-Policy only allows `connect-src 'self'`; an end-to-end test scans every shipped file for provider hosts and key material. |
| No provider is enabled because a key exists | The gate (`evaluateGate`): the master switch **and** the dated owner confirmations **and** consistent budgets and limits must all hold. A key being present changes nothing. |
| No silent fallback to another model or provider | The owner lists the allowed models; each must have a known price. There is no "try the next one" code. |
| Lecture content is not sent without consent | Every AI request is a user action that shows what leaves the device first. |
| Keys never reach the browser | A key exists only as a Worker secret (or in a git-ignored `.dev.vars` locally); the adapter is the only file that writes the key header or the API host (tested). |

## 2. How the guard decides (every AI call, in this order)

1. **Gate.** The switch is on, the confirmations are present and at most 30 days old, budgets and limits are consistent and under the built-in ceilings, and every model has a known price. Otherwise AI is off.
2. **Request allowlist.** Plain text only. Tools, images, extended thinking, streaming, grounding, region routing and caching options are rejected, because they can change the price.
3. **Size.** The input is bounded by its UTF-8 bytes (a token is never less than a byte) and `max_tokens` is clamped.
4. **Reserve.** The worst-case cost is reserved inside one indivisible Durable Object transaction before any call. It is checked against today's and this month's remaining budget *minus everything already in flight*, plus the request caps, the concurrency cap, pauses and unresolved calls.
5. **Call.** A fixed API host and a timeout; a redirect is never followed.
6. **Settle.** The provider-reported usage is charged exactly. Only a definite refusal where the model did not run (400/401/403/404/413/422/429 with a readable error) is refunded. A timeout, a 5xx, a dropped connection or an unreadable answer stays charged at the full reservation until the owner reconciles it.
7. **Breakers.** The guard pauses AI until the owner looks when: a cost exceeds its own reservation, too many calls are unresolved, or the provider says a limit was reached or billing is involved.

Time is the server's UTC clock. Budgets reset at 00:00 UTC (daily) and on the 1st (monthly). If the remaining budget cannot be determined (store failure, damaged ledger, a clock that moves backwards, a missing price, unreadable usage), nothing is sent. Tests cover exhaustion with a tiny budget, timeouts, 5xx errors, refusals, overruns and store failures (`tests/ai.*.test.ts`).

## 3. The Gemini free tier

Facts to check on Google's own pages before you rely on them:

* Free-tier content **may be used to improve Google products** (paid tier: not).
* Moving from free to paid never happens by itself: it needs you to link a billing account. Exceeding a free limit returns an error.
* Quotas are **per project**; the per-day request quota resets at midnight Pacific, and the numeric free limits are shown only in AI Studio.
* Grounding with Google Search or Maps is billed per query, so the guard never enables any tool.

What the Gemini guard does:

| Protection | How |
|---|---|
| Free tier only, by confirmation | Four dated confirmations: the project has no billing account (AI Studio shows "Free tier" and "No billing account"); the models are free of charge; you accept free-tier data use; you have read the free quotas AI Studio shows. They go stale after 30 days. |
| Own limits below the free quotas | Requests per day at most half of the free daily quota (this app's day is UTC, Google's is Pacific); input tokens × concurrency at most half of the per-minute quota. |
| A shadow budget | Every call is priced at Google's *paid-tier* per-token rates and budgeted in "shadow dollars" with hard ceilings of $1 a day and $5 a month. On the free tier nothing is charged; if a billing account were ever linked by mistake, this app alone could cost at most the shadow budget. It is an estimate used as a limit, not permission to spend. |
| Only known models | A short allowlist of models with a known free tier and price; no Pro or preview models. |
| No tools, no extras | Plain text and an output cap only. |
| Quota errors | A daily quota pauses AI until Pacific midnight; a per-minute quota pauses it for one minute. |
| Billing signals | HTTP 402, or an error that mentions prepay, billing or depleted credit, pauses AI until you check AI Studio. "Free tier not available in your country" pauses it and says not to "fix" that by enabling billing. |
| Unknown outcomes | Timeouts and 5xx answers stay charged as shadow cost; five in a row pause AI. |
| Key handling | The `x-goog-api-key` header only (never in the URL), scrubbed from any error text. |

**What this cannot detect:** whether billing is linked to your Google project. The response does not reveal the tier. That is why the confirmations are required and why the shadow budget exists as an independent cap. Check AI Studio yourself.

## 4. Cloudflare

* Workers Free: 100,000 requests a day and 10 ms of CPU per request. Exceeding a limit returns an error; the documentation lists no overage charge on Free.
* Durable Objects: available on the free plan **only with the SQLite backend** (which this project uses); exceeding the free limits makes operations fail, it does not bill.
* Do **not** upgrade to Workers Paid, add R2, Workers AI, Images, Stream or any add-on, or add a payment method.

## 5. The optional Claude provider

An adapter for the Claude API exists and is tested with fake responses, but it is **not wired into the Worker**; a test checks the bundle. It would run behind the same guard and the same confirmations. Nothing in the default setup uses it.

## 6. Never do

Enable pay-as-you-go or extra usage; buy credits; enable auto-reload; add a payment method; attach billing to a Google API project used here; enable paid Cloudflare features; use unofficial proxies or extracted subscription tokens; run a paid operation "just to test".
