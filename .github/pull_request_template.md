## What and why

<!-- What does this change, and why? Link the issue it follows from (anything bigger than a typo or a small fix should have one). -->

## How it was checked

<!-- Paste the commands you ran and what they reported. -->

- [ ] `pnpm check` (types, Worker types, unit tests, browser tests)
- [ ] `pnpm scan:secrets`

## Checklist

- [ ] A fix comes with a test that fails without it, using the real failing input (synthetic if the real one is private). A new planner or question-check rule is tested for what it finds and for what it must leave alone.
- [ ] Wording stays honest: an estimate is labelled an estimate, and a slide that says nothing is said to say nothing.
- [ ] The safety rules still hold: nothing sends lecture text anywhere without the student seeing it first, the browser never supplies a prompt, a model or an output length, and AI stays off and fails closed when a budget, quota or billing fact is unclear. If this touches `src/core/ai/` or `worker/`, I read [docs/FINANCIAL-SAFETY.md](https://github.com/zuhairhalawa/studyai/blob/main/docs/FINANCIAL-SAFETY.md).
- [ ] No lecture slides, study packs, exports, API keys or personal data are included.
- [ ] No new dependency, or the reason for it is stated above (and `pnpm notices` was run if dependencies changed).
- [ ] A decision that is not obvious is recorded in [docs/DECISIONS.md](https://github.com/zuhairhalawa/studyai/blob/main/docs/DECISIONS.md).
