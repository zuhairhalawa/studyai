# StudyAI architecture

```
 ┌────────────────────────── Browser (all study data stays here) ──────────────────────────┐
 │  React UI ──► Library service (Dexie / IndexedDB)  ◄──► Backup ZIP (export / import)    │
 │     │              │  courses · lectures · slides · media(Blob) · original .pptx(Blob)    │
 │     │              └► Search (MiniSearch, rebuilt from slides)                            │
 │     └─ upload ─► Web Worker ─► PPTX engine (src/core/pptx) ─► ParsedDeck + report         │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │ only when the user asks AI & consents
                                   ┌─────────▼─────────┐   secrets: provider keys, owner hash
                                   │ Cloudflare Worker │   Durable Object (SQLite): counters
                                   │  auth · allowlist │──► Gemini Free Tier  (owner-attested)
                                   │  limits · logging │──► Claude API        (disabled by default)
                                   └───────────────────┘
```

## Source layout

| Path | Responsibility |
|---|---|
| `src/core/pptx/` | PPTX → `ParsedDeck` (see below). Pure TypeScript, runs in browser, worker and Node. |
| `src/core/db/` | Dexie schema, zod schemas, library operations (import / reimport / duplicate detection / delete / reorder). |
| `src/core/search/` | Per-slide full-text index with snippet generation. |
| `src/core/study/` | Learning engine: study-pack validation and quote verification (`pack.ts`), FSRS scheduling and queues, notes, question bank, exam selection/marking/attempts, progress and recommendations, Markdown export. |
| `src/core/backup/` | Export/import of the whole library (and study data) as one ZIP, with validation. |
| `src/cli/` | Node CLI (`extract`, `validate`, `prompt`) that reuses the same engine; bundled to `dist-cli/lecture-cli.mjs`. |
| `src/app/`, `src/ui/`, `src/pages/` | React app shell, components and pages. |
| `src/demo/`, `src/app/ai.demo.ts` | The public static demo only (`pnpm build:demo`, see [DEMO.md](DEMO.md)): banner, the invented sample course, and the stub that replaces the AI client. Not part of the regular build. |
| `.claude/skills/lecture-pack/` | Claude Code skill: lecture → study pack using the Claude Code subscription (no API). |
| `worker/` | Cloudflare Worker (owner login, routing, AI endpoints) and its Durable Object (spend ledger, settings, login throttle). |

## The PPTX engine (what it does and does not do)

Pipeline: `ZipArchive` (limits, CRC) → `parseXml` (no DTD, namespace-canonical) →
presentation → per slide: layout/master placeholder inheritance → shape tree walk →
`SlideData` → media sniffing → confidence scoring → topics → `ExtractionReport`.

Extracted per slide: title (placeholder, else largest top text), ordered text with bullet levels,
run formatting (bold/italic/sub/superscript/monospace/links), tables (with merges), chart data
(from chart cache), SmartArt text + inferred hierarchy + cached drawing, equations
(OMML → LaTeX + linear text), speaker notes, images (real MIME sniffed from bytes), alt text,
hidden slides/shapes, animation presence, layout/master decorations (kept for preview only).

Provenance: every element carries `{slide, id}`; `SourceRef` = `{lectureId, slide, elementId?, quote?}`
is the type all later features (notes, flashcards, questions, tutor answers) use to cite sources.

Honesty mechanisms:
* **Flags** (`info` / `warning` / `attention`) for everything not reliably extracted.
* **Completeness invariant:** every `<a:t>` in the slide XML must be captured by an element, otherwise the text is kept under “Unplaced text” and the slide is marked *low confidence*.
* **Confidence:** `high` = no warnings; `medium` = something to double-check (SmartArt, large picture…); `low` = content missing (image-only slide, unreadable chart, EMF, OLE, failed slide).
* The report lists “potentially missing content” by slide and a fixed list of engine limitations.

Known gaps (reported in-app, listed in the extraction report): EMF/WMF images are not displayable;
no OCR for text inside pictures; animation order not captured; SmartArt layout is not re-run
(cached drawing is used); vertical text is shown horizontally.

## Data model (IndexedDB)

v1: `courses`, `lectures` (metadata + report), `slides` (`[lectureId+index]`), `media`, `files`
(original .pptx for re-import), `settings`.
v2 (additive): `cards`, `reviews`, `notes`, `questions`, `exams`, `attempts`, `packs` (import history).
v3 (additive): `tutorSessions`, `tutorMessages` (chats; included in backups, backup format version 3).
The spend ledger and the AI usage log live in the Durable Object, not in the browser.
Slide-view progress is kept as `viewed:<lectureId>` settings; study sessions are *derived* from activity, not stored.

## Study packs and source checking

AI-generated material enters the app only as a `studyai-pack` v1 JSON document:

```
lecture export (Markdown, slide numbers kept) ─► AI (Claude Code skill or any chat) ─► pack JSON
pack JSON ─► extractJson ─► zod per item ─► lecture mapping (hash → title → manual)
          ─► quote lookup on the real slide text ─► items stored as `pending` ─► you approve
```

* A pack is untrusted input. Bad items are skipped and listed; good items still import.
* A quote counts as found when its normalised form (Markdown, LaTeX commands and punctuation stripped) occurs in the normalised text of the cited slide. "..." in a quote skips words.
* `basis` is one of `lecture | derived | outside | uncertain`. A `lecture` claim without a found quote is shown downgraded ("not verified"). Verification proves a quote exists, **not** that the item is well-made.
* The same `validate` logic runs in the CLI, so the skill can refuse a pack before you ever import it.

## AI budget guard (`src/core/ai`)

The only path any future AI call may take. Pure TypeScript with no DOM or app imports, so the Worker can reuse it unchanged.

```
ask(request) ─► gate ─► allowlist ─► size limits ─► RESERVE worst case ─► provider call ─► SETTLE
                 │          │             │              │ one atomic store transaction     │
                 └──────────┴─────────────┴──── any doubt: no call (fail closed) ◄─────────┘
```

* `config.ts` — the provider-neutral `Policy` (models, prices, budgets, limits) that every provider's gate must produce, plus the Claude gate (switch + six dated confirmations + consistent budgets/limits). `gemini-config.ts` is the Gemini gate (four confirmations, limits under half the free quotas, shadow-dollar budgets with hard ceilings).
* `gemini.ts` — Gemini adapter (fixed host, key in header, no tools, thinking billed as output, grounding flagged, quota vs billing-signal classification). `time.ts` — next Pacific midnight (daily quota reset), DST-safe.
* `pricing.ts`, `money.ts` — integer nano-dollar accounting; official per-token prices; worst-case reservation = (input bound at the dearest class + max output) × 5/4.
* `request.ts` — the only request shape allowed; input tokens bounded by UTF-8 bytes.
* `ledger.ts` — spend, in-flight reservations, unresolved calls, breaker, capped per-request usage log. Pure transitions.
* `store.ts` — `BudgetStore.transact()` is the atomicity contract; `MemoryBudgetStore` implements it for tests; the Worker implements it with a Durable Object.
* `guard.ts` — `GuardedAi.ask / status / reconcileUnresolved / resetPause`.
* `anthropic.ts` — adapter: fixed host, allowlisted body, error classification (refused vs unknown), key scrubbing.

See [FINANCIAL-SAFETY.md](FINANCIAL-SAFETY.md) for the rules this implements and what only the person who deploys it can verify.

## The private AI server (Worker + one Durable Object)

```
 Browser (study data stays here)                    Cloudflare (free plan)
 ───────────────────────────────                    ─────────────────────────────────────────────
 Tutor / generator / grader UI ── same-origin ──►  Worker  (/api/* only; the app is static assets)
   shows "what will be sent"                         │ Host allowlist · Origin/Fetch-Metadata CSRF check
   builds slide excerpts locally                     │ owner-key login → HMAC-signed cookie (12 h)
                                                     │ strict request contract (zod) · size limits
                                                     ▼
                                             Durable Object "owner" (SQLite, one instance)
                                               settings + dated confirmations · login throttle
                                               spend ledger · atomic reservations · breakers
                                               builds the PROMPT · picks model and output cap
                                                     │ GuardedAi → GeminiProvider
                                                     ▼
                                             Google Gemini API (free tier, key = Cloudflare secret)
```

* `worker/src/app.ts` — routing and every front-door check, with no Cloudflare imports so it is unit-tested in Node.
* `worker/src/auth.ts` — owner key (SHA-256 compared in constant time), signed sessions, cookie attributes, host/origin rules.
* `worker/src/do.ts` — the Durable Object: ledger (synchronous SQLite, atomic by construction), owner settings, confirmations, throttle, session epoch.
* `worker/src/throttle.ts` and `worker/src/ledger-storage.ts` — the login-lock rules and the "a ledger that existed must not vanish" rule, as plain functions so they are unit-tested without Cloudflare.
* `src/core/tutor/*` — the contract (what the browser may ask for), server-side prompts, and strict parsers for what comes back.
* `src/app/ai.ts` and `src/ui/ai/*`, `src/pages/TutorPage.tsx` — the browser side. Chats live in IndexedDB (schema v3) and in backups; the server keeps none.
* `worker/src/test-entry.ts` + `scripted-gemini.ts` — local test entry with a scripted fake model; the production entry never imports them (a test checks the bundle).

Routes: `GET /api/health` (public) · `POST /api/auth/login|logout|logout-all` · `GET /api/auth/session` · `GET /api/owner/status` ·
`POST /api/owner/config|attest|revoke|reconcile|reset-pause` · `POST /api/ai/ask` (tasks `tutor`, `generate`, `grade`).
Everything except health, session and login needs the owner. There is no route that proxies arbitrary requests.

The AI features never replace the local ones: an AI answer becomes a note or a *pending* flashcard only when you save it; generated
packs go through the normal pack check (quotes verified on the real slides, items approved by you); AI marks are saved as
"AI estimate" and you can change them.

## Exam engine

Selection is seeded (reproducible), filters by lecture/type/difficulty, and aims at the requested marks. MCQ and true/false are marked exactly. Written answers are **self-marked** against a rubric; keyword hits only suggest marks; every written mark is stored as `uncertain`. Attempts autosave on every change and resume after a reload; "exam conditions" removes hints and early answers and keeps the clock running.
