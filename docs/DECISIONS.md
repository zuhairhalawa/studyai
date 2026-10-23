# Architecture decision records

Short, dated, and honest about trade-offs. Newest last.

## ADR-001 — Local-first single-page app; the backend only exists to hold AI keys
*2026-10-16 · accepted*
All lecture data lives in the browser (IndexedDB). The only server component is
a Cloudflare Worker that (a) serves the static build and (b) proxies AI calls so
keys never reach the browser. Everything except AI works with no network.
**Trade-off:** data is per-browser/per-device. Mitigated by one-click backup/restore
(ZIP) rather than a hosted database (a database would add attack surface and a possible billing path).

## ADR-002 — Parse PPTX in the browser with our own small engine, not a library
*2026-10-16 · accepted*
Existing PPTX libraries either only generate files (PptxGenJS) or are server-side and
trust ZIP headers. The study platform needs *extraction with provenance and honesty
flags* (what could not be read), plus defensive handling of untrusted files. So the
engine is ~2 k lines over three tiny dependencies (`fflate` inflate, `fast-xml-parser`,
nothing else): a defensive ZIP reader, DTD-rejecting XML parser, OPC relationships,
theme/placeholder inheritance, text/tables/charts/SmartArt/OMML-math extraction,
and a completeness invariant (every `<a:t>` in a slide must be captured or reported).
**Validated against:** synthetic fixtures for every construct, an independent
python-pptx oracle, and several university lecture decks.
**Limitation (accepted):** previews are reconstructed from XML, not pixel-perfect;
EMF/WMF images can’t be shown in browsers; no OCR.

## ADR-003 — Own ZIP reader instead of `unzipSync`
*2026-10-16 · accepted*
Libraries size buffers from the archive’s *declared* sizes. A hostile archive can lie.
Our reader decompresses in 16 KiB steps and aborts the moment actual output exceeds
the declared size, enforces per-entry/total/ratio/entry-count limits, rejects ZIP64,
encryption, duplicate names, path traversal and overlapping entries, and CRC-checks every entry.

## ADR-004 — XML: reject DTDs outright instead of configuring entity limits
*2026-10-16 · accepted*
OOXML never needs a DOCTYPE. Rejecting `<!DOCTYPE`/`<!ENTITY` removes billion-laughs and
external-entity attacks completely, rather than relying on parser limits.

## ADR-005 — Dexie (IndexedDB) + MiniSearch, no vector DB, no embeddings (yet)
*2026-10-16 · accepted*
Per-slide full-text search with prefix/fuzzy matching covers “find the slide about X”
and is the first retrieval step before any AI call. Embeddings would need either a paid
API or a large local model; revisit only if retrieval quality proves insufficient.

## ADR-006 — Backend auth is an in-Worker owner login, not Cloudflare Access
*2026-10-16 · accepted (Phase 3)*
Cloudflare’s own docs did not confirm that the Zero Trust Free plan can be created without
a card on file, and the brief forbids adding payment methods. The Worker will verify a
PBKDF2-hashed owner passphrase and issue a signed, HTTP-only, SameSite=Strict session
cookie; every API route checks it, plus Host and Origin allowlists. `workers_dev` and
preview URLs are disabled so the Worker is reachable only via the chosen custom domain.
*Superseded in part: the owner signs in with a random key, not a passphrase (ADR-020), and the first deployment uses a `*.workers.dev` address with the whole site behind the sign-in gate (ADR-025); preview URLs stay disabled.*

## ADR-007 — Rate/quota counters live in a SQLite-backed Durable Object
*2026-10-16 · accepted (Phase 3)*
Atomic counters (daily request cap, concurrency) need a single writer. Durable Objects
with SQLite are available on Workers Free and fail (not bill) when limits are exceeded.
KV is eventually consistent and unsuitable for hard caps.

## ADR-008 — Supply-chain hygiene
*2026-10-16 · accepted*
pnpm with `minimumReleaseAge` = 7 days (no brand-new releases), exact version pins
(`savePrefix: ""`), install scripts disabled except `esbuild`, lockfile committed.
Fonts are self-hosted (`@fontsource-variable/*`) so the app makes no third-party requests.

## ADR-009 — TypeScript 7 (native compiler) with strict flags
*2026-10-16 · accepted*
`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `verbatimModuleSyntax`.
The type-check runs clean and is part of `pnpm build`.

## ADR-010 — AI-written study material enters as an imported, verified "study pack"
*2026-10-16 · accepted (Phase 2)*
The learning engine must be useful before any AI service is wired in, and generating material must not need an API key. So the app never calls a model to create cards, notes or questions in Phase 2. Instead, the AI (Claude Code under the Max subscription, or any chat the student already uses) returns one JSON document (`studyai-pack` v1) that the app validates item by item. Items are stored as *pending* and are unused until the student approves them.
**Why not just trust the AI's output:** a card that confidently states something the lecture never said is worse than no card before an exam. Every item therefore carries a `basis` (lecture / derived / outside / uncertain) and quotes, and the app looks each quote up on the real slide.
**Trade-off:** one manual copy/import step per lecture. Phase 3 can automate the call, but the same pack format, validation and approval gate will apply to it.

## ADR-011 — Quote verification: found-on-slide, not correct
*2026-10-16 · accepted (Phase 2)*
A quote is "verified" when its normalised form (Markdown and LaTeX commands, punctuation, case and spacing stripped; "..." allowed) occurs in the normalised text of the cited slide. A "lecture" claim without a found quote is displayed as unverified.
**What this does not prove:** that the card is well written, complete, or that the quote supports the claim. It removes fabricated citations; it does not replace reading the card. The UI and docs say so.

## ADR-012 — FSRS (ts-fsrs) for flashcard scheduling
*2026-10-16 · accepted (Phase 2)*
FSRS is a maintained, open spaced-repetition algorithm with a small, pure TypeScript implementation that runs locally. Scheduling state is stored per card with a review log, so a future parameter fit stays possible. Intervals are previewed on the answer buttons.
*Correction, 2026-10-23: this record first said "FSRS-5". The pinned `ts-fsrs` 5.4.2 implements FSRS-6 (`FSRSVersion` reports "v5.4.2 using FSRS-6.0" and the default parameter set has 21 weights); the decision itself is unchanged.*

## ADR-013 — Written answers are self-marked in Phase 2; marks are always "uncertain"
*2026-10-16 · accepted (Phase 2)*
Auto-marking is exact only for MCQ and true/false. For written answers the app shows the model answer and rubric and the student awards the marks; keyword hits are hints, not scores. Every written mark is stored as uncertain, and the app never claims to match an examiner. AI marking (Phase 3) will be an optional second opinion, never the only mark.

## ADR-014 — "Viewed" means 3 seconds on a slide; "left off" is saved immediately
*2026-10-16 · accepted (Phase 2)*
Progress should not count slides the student flicked past, so a slide counts as viewed after 3 s on screen. The resume position is saved at once so the next visit returns to the right slide. The dashboard uses both: a lecture that is open at slide N reads "You left off at slide N" even when nothing counts as viewed yet (a bug found by the end-to-end suite, fixed with a unit test).

## ADR-015 — Lecture-pack skill and a bundled CLI instead of an in-app generator
*2026-10-16 · accepted (Phase 2)*
Claude Code can read files but not the browser's database, so the same extraction and validation code is bundled as a Node CLI (`extract`, `validate`, `prompt`). The skill drives it: extract locally → read the slides → write the pack → `validate` until every quote is found. The skill states the hard rules (no API, no key, no network, lecture files stay local, never fake a quote), and `tests/skill.test.ts` fails if the skill and the code drift apart.

## ADR-016 — Claude with included API credits is an optional provider (Gemini Free Tier comes first); everything fails closed
*2026-10-16 · accepted (Phase 3a)*
The design goal is $0.00 extra, and Anthropic's official docs say that some subscription plans include monthly API credits with no card needed and that requests simply stop when the balance reaches zero — unless purchased credits, auto-reload or invoiced billing sit behind it. The design therefore (a) keeps AI off until the owner has confirmed each of those conditions, dated and re-confirmed every 30 days, (b) enforces its own daily and monthly budgets below the credits, and (c) treats every uncertainty as "stop", never "continue". The owner later set the order: Gemini Free Tier is the immediate Phase 3 objective and Claude stays an optional provider; both ship disabled.
**Trade-off:** the tutor can stop while money would still have been available. Accepted: preventing a charge outranks availability.

## ADR-017 — Reserve worst case, settle to real usage; only a definite refusal is refunded
*2026-10-16 · accepted (Phase 3a)*
Budget checks happen *before* a call, against everything already in flight, inside one atomic store transaction. After the call the reservation is settled to the provider-reported usage. A timeout, 5xx, dropped connection or unreadable answer may still have been billed, so it stays charged at the full reservation until the owner reconciles it against the Console. This makes delayed or missing usage reports only ever make the app more cautious.
**Why not read the Console balance:** it needs an organization-wide Admin key (more risk than the problem), so the Console is attested by the owner and used as an independent backstop (credit balance and a workspace spend limit).

## ADR-018 — Prices and request shape are allowlists
*2026-10-16 · accepted (Phase 3a)*
A model with no entry in the price table cannot be called, and a request may only contain plain text, a model and an output cap. Tools (web search is billed per search), images, extended thinking, streaming, fast mode and region routing are rejected because each can change the price. The reservation uses a byte-based upper bound on prompt tokens so no token-counting call is needed.

## ADR-019 — Gemini Free Tier is guarded with a "shadow" dollar budget as well as quotas
*2026-10-16 · accepted (Phase 3a)*
The free tier has no balance to meter and Google does not reveal a key's tier in responses, so "I am on the free tier" cannot be checked by the app. The guard therefore (a) requires dated owner confirmations, (b) keeps its own limits under half the free quotas the owner reads in AI Studio, and (c) prices every call at the *paid-tier* rate and enforces daily/monthly budgets in those shadow dollars (hard ceilings $1/day, $5/month). If billing were ever linked by mistake, this app alone could then cost at most the shadow budget.
**Billing signals** (402, prepay/billing/depleted text) pause AI until the owner checks AI Studio. The ordinary quota error also says "check your plan and billing details", so classification looks at status and specific wording, and a test covers the trap. "Free tier not available in your region" pauses AI and warns against enabling billing.

## ADR-020 — The owner signs in with a 256-bit key, not a passphrase
*2026-10-16 · accepted (Phase 3b)*
Password stretching (PBKDF2/scrypt) would use more CPU than the free Workers plan allows per request, and it is unnecessary for a random 256-bit key. `pnpm owner:keygen` makes the key once; only its SHA-256 is stored (as a Cloudflare secret), so the key cannot be recovered from the server. The session is an HMAC-signed, expiring `__Host-` cookie (HttpOnly, Secure, SameSite=Strict). Wrong keys lock the sender's address (an IPv6 address counts by its /64) with growing delays, but the correct key is never refused and there is no global lock, so nobody can lock the owner out (see ADR-024); "sign out everywhere" bumps a counter in the Durable Object. This replaces the PBKDF2 idea in ADR-006.
**Trade-off:** the key is long and must live in a password manager; losing it means generating a new one and replacing the secret.

## ADR-021 — The guard runs inside a single Durable Object
*2026-10-16 · accepted (Phase 3b)*
Budget reservations must be atomic across requests. A SQLite-backed Durable Object is single-threaded and its storage is synchronous, so a reservation is one read-modify-write with no `await` in between: two requests cannot both see the same remaining budget. The whole guard (and the provider call) therefore runs in the Durable Object; the Worker only authenticates and forwards. Tested over HTTP: 12 simultaneous requests against a budget for two admit exactly two.
**Trade-off:** one DO instance serialises settings and accounting (fine for one owner); a DO storage failure means the budget is unknown, so AI refuses to run.

## ADR-022 — Prompts, model and output length are chosen by the server
*2026-10-16 · accepted (Phase 3b)*
The browser sends structured data (a question, selected slide text, a rubric); the server builds the prompt, picks the model and caps the output. Lecture text, answers and exam instructions are untrusted: they are escaped and placed inside delimited blocks that the fixed rules declare to be data. The endpoint therefore cannot be used as a general-purpose proxy, and model output is validated before it is used (citation labels, JSON against the real rubric, packs through the normal import check).

## ADR-023 — Confirmations and the first real request are explicit owner actions
*2026-10-16 · accepted (Phase 3b)*
Four dated confirmations (no billing on the Google project, model is free, free-tier data use accepted, free quotas entered) plus an explicit approval of the first real request are stored in the Durable Object, each expiring after 30 days. Withdrawing one switches AI off. Changing the model withdraws the quotas and the approval because quotas differ per model. The assistant that built this never turned any of it on and made no call to Google; the live key does not exist yet.


## ADR-024 — Fixes from an independent adversarial review of Phase 3
*2026-10-17 · accepted (Phase 3b)*
A reviewer who had not written the code tried to bypass the owner login, spend more than the budget, abuse the endpoint and leak data. It found no way past the login and no way to exceed a budget, and 11 weaker points that were fixed and each got a test:

* **Login lock-out:** the old design refused even the right key while a lock or the global failure counter was active, so an attacker could lock the owner out, and the check and the count were separate steps (a parallel burst could slip past). Now the key is checked first, every wrong key is counted atomically in the Durable Object, the right key is never refused (and clears that address's failures), there is no global lock, IPv6 is counted per /64, old records are forgotten after a quiet day and the table is kept small.
* **Spend ledger:** the day/month counters can no longer be moved backwards by a small clock step across midnight or a month end; a ledger row that disappears after it has existed is treated as an unknown budget, not as zero.
* **Prompt injection:** the exam instructions for question generation are now escaped inside their own data block (they used to sit in the rules); a reminder repeats after the data in the tutor prompt; only notes the student wrote themselves are offered as context (imported packs and AI text are not); the BASIS/FOLLOWUPS lines are taken from the end of the reply, with a length cap and a linear-time pattern; marking-point ids are restricted to plain tokens.
* **Requests:** the Origin must be exactly this site (not just any allowed host, no user info or path); session signatures must be exactly 32 bytes; provider calls never follow a redirect (a redirect would carry the key header elsewhere). **Correction found by the first live request:** this was first written as `redirect: 'error'`, which the Workers runtime does not implement ("must be follow or manual"), so the call threw before leaving the Worker; nothing was sent to Google or billed, and the app counted it as an unclear outcome. It is now `manual` (a redirect is returned, not followed, and counts as unclear), a unit test forbids the broken option, and an end-to-end test runs the **real** Gemini adapter inside workerd against a local stub of Google's endpoint, because the scripted fake never calls `fetch` and could not notice.
* **Accounting:** token counts that Google's total reports but no field explains are billed as output; changing the model also withdraws "the model is free of charge".
* **Backups** no longer carry the consent to send text to an AI service, so a restored or doctored backup cannot pre-approve anything.

## ADR-025 — The whole site is private, not only the API
*2026-10-17 · accepted (deployment)*
The deployment is private first. The app's files hold no private data (the library lives in the owner's browser), but a site that anyone can open can also be probed, and nobody else should see or use it. With `PRIVATE_SITE` on (the default; only an explicit `off` turns it off) and `run_worker_first: true`, every request passes through the Worker: without a valid owner session cookie it answers only a small sign-in page (plain HTML, one form, no script, one hashed inline style); with one it serves the files. The cookie is checked for signature and expiry only (no storage call per file); the API still checks the session fully, including "sign out everywhere". Static files are therefore counted against the free Worker request quota; for one person that is far below 100 000 a day.
* The form posts to `/api/auth/gate`, shares the login code (so the same atomic lock applies and the right key is never refused), and is protected by the same Origin/Fetch-Metadata checks. The sign-in page uses `Referrer-Policy: same-origin`: with `no-referrer` browsers send `Origin: null` on a form post (found by the browser test).
* The first deployment uses a `*.workers.dev` address (the only way in without a domain); the gate makes that address show nothing but the sign-in page. `ALLOWED_HOSTS` is a Cloudflare secret so no hostname is committed to a public repository. A unit test fails if the committed configuration stops being private.
* Alternatives rejected: Cloudflare Access (account card requirement not confirmed from Cloudflare's own documentation; see ADR-006) and leaving the files public.

## ADR-026 — The words in a picture are typed by the student, never guessed
*accepted*
Some slides are only a picture (a diagram, a memory layout). The extractor can say "a picture is here", but a tutor cannot teach from it. Options considered: OCR in the browser (it garbled diagram text and would add several megabytes and false confidence), sending pictures to a vision model (breaks "only slide text leaves the device" and costs money), and typing the words by hand.
* Each picture gets a "Words in this picture" box. What is typed is stored in the slide's own row, is marked as *typed by the student* in everything sent to an AI (so it can be cited as the slide but is known to possibly contain typing mistakes), carries over when the lecture is imported again, and is part of backups.
* Typing settles the "this picture may contain text" warning for that slide. A picture is flagged only when it covers a meaningful part of the slide, so logos and icons raise no alarm, and file names such as `image3.png` are never shown as if they were descriptions.
* The AI rules say: never describe or guess what an unreadable picture shows; say that it cannot be read and suggest typing its words.

## ADR-027 — Teach in order, and send only what the question needs
*accepted*
A **guided lesson** cuts a lecture's own topics, in slide order, into parts of at most four slides (small neighbouring topics are packed together, a long topic is cut evenly). Picking a part chooses those slides and writes the question; the student sees the exact slide text before it is sent. A slide range limits what a generation sends. The whole deck is never sent by default.

## ADR-028 — An answer that hit the length limit is never passed off as finished
*accepted*
A free-tier request is capped in output tokens, and a large generation can stop in the middle of its JSON.
* **Say so, end to end:** the provider's "max tokens" finish reason becomes a `truncated` flag that travels provider → budget guard → Worker reply → screen. The cost accounting is unchanged.
* **Ask for what fits:** the counts in a request are cut until the estimated size is at most 70 % of the cap, the Generate dialog shows the real numbers, and the prompt says "keep every field short; fewer items, never a longer one".
* **Keep what is finished:** the import screen rescues every complete item before the cut and warns; nothing is invented, and every rescued item still goes through the quote check and approval.
* A cut-off chat answer says so and offers "Ask it to continue"; a cut-off marking reply is never turned into marks.

## ADR-029 — The tutor's answers are checked by the app, not trusted
*accepted*
Reading answers against the slides showed problems that a prompt alone does not prevent, so rules and device-side checks are combined:
* **Citation labels mean something only inside one request.** Before an answer is stored the labels are replaced by the real slide ("[slide 11]"); a label that was never sent becomes "[source not found]".
* **Outside material has one place:** a paragraph that begins "Beyond the slides:". This includes the model's own examples, analogies, numbers and "because…" reasons. If the slides do not contain the answer, it begins "Not covered on these slides:", and the app never labels such an answer as coming from the slides.
* **Quoted wording is checked:** words in quotation marks are looked up in the slides that were sent; wording found nowhere lowers a "lecture" label to "derived".
* Hexadecimal values and addresses are plain text, never LaTeX; the closing lines are described in words, and the app strips angle brackets and drops copied placeholders.
* These are rules plus deterministic checks, not guarantees.

## ADR-030 — AI marking is evaluated against an independent reading, and its limits are stated
*accepted*
AI marking was tested with made-up student answers (strong, partial, wrong, an identical repeat, and one that tells the marker to award full marks), with the expected marks written down before any request. The marker is only an assistant: marks are always labelled uncertain, a student's text that tries to give instructions is data, a cut-off reply is never turned into marks, and the student decides.

## ADR-031 — Exam questions are planned on the device before the AI writes them
*accepted*
Asked for "a normal set", a model writes what is easiest: recall questions, none hard, a few slides covered. So the browser first makes a plan with no AI (`blueprint.ts`): for each question a kind, a difficulty, marks, the number of marking points, a topic and the slides it is based on.
* **Kinds follow the material.** Calculations and problems only where a slide has an equation, proofs where there is a theorem or proof, algorithm and code questions where there are steps (or a machine to run), diagram questions where there is a picture or its typed words, attack-and-countermeasure questions where the lecture is about attacks.
* **Difficulty means something:** about 30 % easy, 40 % medium, 30 % hard. Marks grow with difficulty, about one marking point per mark, and never more points than the chosen slides hold separate ideas.
* **The professor's instructions steer it** ("mostly scenarios", "short, complete answers", "proofs where appropriate", "no multiple choice", "only …", "answers are 1–3 sentences"), and the full text still goes to the model with the rule that the professor's style wins. With no instructions the plan says it is a sensible mix, not a prediction of the real exam.
* **Coverage and repeats:** topics with untouched slides come first, a kind is never planned twice on the same slides, and slides about the lecture itself (objectives, outline, credits, a title, a recap, a check-in) are never the basis of a question. A lecture made of proofs gets several proof questions.
* **Several requests:** one answer holds a limited number of tokens, so a plan of eight questions is two or three requests, each shown to the student and approved. The server builds the prompt from the structured plan (strict schema, titles and earlier questions escaped), so the browser cannot supply instructions.

## ADR-032 — Generated exam questions are held to the rules the model was given
*accepted*
The prompt says what each kind of question is, what difficulty and marks mean, that each marking point must be one idea that can be earned alone, that the model answer must earn full marks from the slides only, and that questions must not repeat (`QUESTION_RULES`). The import screen then checks the result with no AI (`pack-quality.ts`): marks and points, "any two of" points, overlapping points, a model answer that would not earn full marks, points that are not on the cited slides, copies, all-recall sets, and questions that ignore the plan. It is advice before approval; nothing is dropped. The wording comparison is conservative on purpose. It cannot judge whether a question is wise or an answer true.

## ADR-033 — Teaching: say what the slides do not say, and take care with formulas, tables, algorithms, proofs, machines and diagrams
*accepted*
* **Gaps are found on the device** (`gaps.ts`), shown to the student before sending, and sent with the slides as a list of facts: a slide that is only a heading, a picture whose words are not available, a reference to something that is not on the slide ("see figure 3"), a formula whose symbols the slide does not define, a diagram whose arrangement was inferred, a question the slide asks and does not answer, and labels and arrows whose meaning sits in their layout. The tutor says each one once, where the slide comes up, and does not fill it with a guess.
* **Content-aware teaching notes** are added to the prompt only for what is really on the slides: formulas (explain only with the symbols the slides define), tables (row by row, add nothing), algorithms and code (the slides' steps in order, no complexity or edge cases unless the slides give them), diagrams (labels only), derivations and proofs (the slide's steps, say which step is skipped instead of filling it in), machines (trace one step at a time, add no states or transitions), and questions on slides (a slide's question is not its answer).
* **Lesson memory:** a later lesson part names the parts that were really taught, so it connects to them even when early answers no longer fit the chat the server sees.

## ADR-034 — Every marking point must answer something the question asks
*accepted*
Questions can be well formed and still misaligned: a six-mark question that asks for five things, a marking scheme that rewards something nobody asked for, or a "scenario" whose story could be deleted without changing the answer.
* **The model commits to what it asks (prompt rule H).** After the prompt it lists `asks`: the exact words of the prompt that ask for something and how many items each wants. Every marking point says which ask it answers. A mark can only be added by first asking for it in the prompt.
* **The device checks it:** an ask whose words are not in the question, an ask with more or fewer points than it wants, a point that answers no ask, a number word that disagrees with the count, a scenario whose situation adds nothing the slides do not already say, and algorithm points that rest on one step of the slides.
* **The AI reads the meaning (optional, one request, task `audit`).** For each marking point it says whether the question itself asks for it (a "yes" needs the exact words, which the app verifies). It sees only the questions, marking points and model answers. One click removes a padded point and its marks.
* Limits: only a reader of the meaning can see a point that is asked for in words but answers something else, and that reader can be wrong, so it only advises.

## ADR-035 — Mathematical and theory lectures are read, taught and examined as such
*accepted*
Formulas, proofs, pseudocode, tables, matrices and machines need their own handling.
* **What is on a slide:** equations (OMML) are converted to LaTeX and drawn with KaTeX; typed formulas are recognised; a notation slide or a set such as "{1, 2, 3}" is not arithmetic or code; pseudocode is recognised from monospaced lines and procedure words, not from the word "algorithm"; a machine (an automaton, a Turing machine) is recognised from its vocabulary or a table of states.
* **The plan follows:** a proof question on a proof, the run of a machine on a machine, a calculation only where numbers are computed, no story where there is none unless the professor asks for scenarios.
* **Quotes with formulas:** a model may copy a formula as LaTeX, with escapes, or with a subscript written differently from the slide ("M_1", "M1"); quote verification accepts all of these and still rejects a changed formula.
* **Questions a slide puts to the class** (a check-in, "why is this a diagonalization?") are not answers: no question is based on a check-in slide, and the tutor and the question writer are told not to present their own answer as the slide's.

## ADR-036 — What testing on real lectures taught
*accepted*
Real lectures were used to test the app and are not part of this repository. The defects they showed, each fixed with a regression test on an invented slide of the same shape:
* Equations: a space stored inside an equation was dropped, and the three Unicode angle brackets were not all read.
* Drawing: blank lines, "space before/after" and line spacing were ignored, so text ran over the labels of a figure; a list marker wrapped onto its own line; a title with a subscript was listed with raw braces.
* Judging a slide: a title slide and a credits line were examined as content; set notation and "a 1-1 correspondence" were arithmetic; monospaced digits that label a table were code; a small photograph was a diagram.
* Judging a question: a quote was "not found" because of a subscript; a short verbatim quote was called unconfirmed by the AI check; a "scenario" that restated the slide and algorithm points that paid one step twice were not found.
The tests use invented decks (`tests/fixtures/`) and invented text; nothing from a real course is stored.

## ADR-037 — The public demo is a separate static build with no AI code, served by GitHub Pages
*2026-10-23 · accepted*
A tool that asks people to clone a repository and run `pnpm install` before they see anything is hard to adopt. The demo lets a visitor try the study features in ten seconds, in a browser, with invented content only (docs/DEMO.md).
* **A build mode, not a flag at run time.** `vite build --mode demo` (one config, `vite.config.ts`) sets the sub-path, writes to `dist-demo/`, swaps `src/app/ai.ts` for `src/app/ai.demo.ts`, mounts the banner and writes `404.html`. The regular build compiles none of it (a test builds both and checks). The AI client is swapped out of the bundle instead of being switched off at run time, so "the demo cannot call a Worker" is a fact about the files, not about a variable: the demo bundle has no `/api/` address and no `fetch` in the AI path, and a test reads every shipped file. The real Worker is never involved, so there is no key, no budget and no owner login to protect.
* **The policy travels in the page.** GitHub Pages sends no custom headers, so the demo's Content-Security-Policy is a `<meta http-equiv>` built from `config/headers.ts` (the same list, minus `frame-ancestors`, which a `<meta>` cannot carry). It is inserted straight after the charset, and the build fails if that marker is missing. The "no third-party requests" guarantee holds and is tested with the demo served with *no* headers, so the page's own policy is what is proven. **The differences, honestly:** the demo cannot set `frame-ancestors`/`X-Frame-Options` (another site can put it in a frame), `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy` or `nosniff`; whatever GitHub sends for its own domain (for example HSTS) applies instead. A `_headers` file is not written for the demo: GitHub would ignore it, and a file that looks like protection but is not would mislead. The demo holds no account, key or private data; the real, private deployment (ADR-025) keeps all of its headers and is unchanged.
* **The sample course is made in the browser, from the test builder.** The two invented lectures are built when the button is pressed with `tests/fixtures/pptx-builder.ts` (the only place production code reaches into `tests/`, and only in the demo's lazy chunk), read by the real engine in the real worker, and the cards, questions and notes enter through the normal study-pack import, so every quote is checked against its slide. Alternatives: shipping a `.pptx` and a JSON file as assets (one more fetch and one more failure mode, and nothing is gained for a two-slide-deck demo) and a hand-written database seed (it would skip the very code the demo is meant to show).
* **Approved up front.** The sample's cards and questions are stored as approved, unlike an imported pack, which waits for the student (ADR-010). A visitor should reach a flashcard in one click; the material is the project's own and every quote is verified by a test.
* **Published by hand.** `.github/workflows/demo.yml` runs only on `workflow_dispatch`, from the default branch, with read access in the build and Pages write plus `id-token` only in the deploy job, and every action pinned to a verified commit. It never enables Pages: the owner switches **Source: GitHub Actions** on once (docs/DEMO.md), so a merge cannot publish anything by itself.
* **Known costs.** All Pages sites of one account share an origin, so the demo's IndexedDB is visible to a second app hosted there (docs/DEMO.md); a reload on a deep link is answered with a 404 status whose body is the app; the demo's guarantees are weaker than the private deployment's in the ways listed above, and none of them protects anything the demo holds.
* **Rejected:** a public copy of the real Worker with AI on (spends free-tier quota for strangers and needs sign-in, which is what ADR-025 exists to avoid); Cloudflare Pages (needs an account step the owner has not taken); a hosted demo with a canned "AI" (it would show behaviour the app does not have).
