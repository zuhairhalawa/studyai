# Contributing

StudyAI is a small project kept by one person. Issues and pull requests are welcome, answered when time allows, and
not guaranteed to be merged: the project has a narrow purpose (a private, local-first study tool that can never spend
money by accident), and a change that widens it may be declined with thanks.

## Before you start

* Open an issue first for anything bigger than a typo or a small bug fix, so the work is not wasted.
* **Security problems are not issues.** Follow [SECURITY.md](SECURITY.md) and report them privately.
* Do not include lecture slides, study packs, exports, API keys or anything personal in an issue, a pull request or a
  test. Tests use synthetic decks built by `tests/fixtures/pptx-builder.ts` (invented content only).

## Run it and check your change

```bash
pnpm install --frozen-lockfile   # exact, pinned versions; Node 22+ and pnpm 11
pnpm check                       # types, Worker types, unit tests and the browser tests (needs Chrome installed)
pnpm scan:secrets                # working tree and full git history
```

`pnpm check` takes a few minutes. The browser tests start the real local Worker and Durable Object with a scripted fake
Gemini; no network and no Google account are involved, and no real AI request is ever made by the test suite.

The browser tests use the local ports 4391, 4392, 8792, 8793 and 8795. If your system has reserved them (on Windows the tests
then stop with `listen EACCES`; `netsh int ipv4 show excludedportrange protocol=tcp` lists the reserved ranges), move all five with one
variable, for example `STUDYAI_E2E_PORT_BASE=24000 pnpm check` (it uses 24000 to 24004). The ports are defined in `tests/e2e/ports.ts`.

## What a good change looks like

* **A test that fails without it.** Fix a defect by first writing the test that shows it, using the real failing input
  (synthetic, if the real one is private). A new rule in the exam planner or the question checks needs a test for what it
  finds and for what it must leave alone.
* **Honest wording.** The app says what it knows and what it does not (an estimate is labelled an estimate; a slide that
  says nothing is said to say nothing). Keep it that way in the interface and in documentation.
* **The safety rules hold.** Nothing may send lecture text anywhere without the student seeing it first; the browser never
  supplies a prompt, a model or an output length; AI stays off and fails closed if a budget, a quota or a billing fact is
  unclear. Read [docs/FINANCIAL-SAFETY.md](docs/FINANCIAL-SAFETY.md) before touching `src/core/ai/` or `worker/`.
* **Small, readable commits** with a message that says why. Record a decision that is not obvious in
  [docs/DECISIONS.md](docs/DECISIONS.md).
* **No AI co-author trailers.** A commit message never names an AI tool as co-author or assistant (`Co-Authored-By: Claude`,
  "Generated with ..." footers and the like); human co-authors are welcome. CI runs `pnpm check:attribution` on every pull request.

## Style

TypeScript in strict mode, the existing naming and comment density, no new dependency without a reason (the project
resolves only package versions at least seven days old; see `pnpm-workspace.yaml`). `pnpm notices` regenerates
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) when dependencies change.
