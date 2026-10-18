# Quality bar

## Faithfulness first

- Quote the slide, then explain. Never put your own words inside a quote.
- If slides disagree with each other or look wrong (typo in a formula, inconsistent definition), say so in the item with `basis: "uncertain"`; do not silently correct them.
- If a slide is an image, SmartArt without text, or flagged in the extraction report, do not describe what it "probably shows".
- Do not write what "the professor wants" or "will ask". Use only exam-format instructions the user gave you.

## Notes

- Beginner-first: define each term the first time it appears, in plain language, then give the slide's own wording.
- One idea per block, 40–150 words. Use a small worked example where the slides have one.
- Keep lecture content and your additions in separate blocks (`lecture`/`derived` vs `outside`).
- Comparison notes: a Markdown table with the same dimensions for every item.

## Flashcards

- One fact or one proof step per card; the answer should fit in 1–3 short lines.
- Fronts are questions a student could answer from memory, not "Explain slide 5".
- No cards whose answer is "see slide". Avoid yes/no cards unless the reason is on the back.
- Formulas: front names the situation, back gives the formula in `$…$` with symbols defined.
- Code cards: short snippet in a fence; ask what it prints or what is wrong.
- Include the slide quote that supports the card.

## Questions by subject

| Subject | Good question shapes |
|---|---|
| Computability and complexity | reduction construction, "is L decidable? justify", undecidability proof skeleton, comparing complexity classes |
| Information security | attack/countermeasure scenario, threat-model case, "which property (C/I/A) is broken and why", protocol step analysis |
| Algorithms and data structures | trace on a given input, write/repair pseudocode, complexity derivation, choose a structure and justify |
| Software architecture | scenario with quality attributes, pattern trade-offs, diagram interpretation |
| Databases | write/repair SQL, normalisation to a given form, transaction schedule analysis |
| Networks | protocol/field calculation, layer reasoning, subnetting and addressing |
| Ethics / law | short case study with stakeholders, "apply principle X to this situation" |
| Mathematics | calculation with working shown, short proof, counter-example |

Mix: roughly 30 % recall (define/state), 50 % apply (scenario/problem), 20 % analyse (compare, prove, evaluate). Scale to the user's stated exam style.

## Marking rubrics and model answers

- 1 mark ≈ 1 key point ≈ 10–25 words of answer. A 5-mark question has about 5 rubric points.
- Rubric points are observable ("states that B must be decidable"), not vague ("good understanding").
- Add `keywords` only when a specific term is genuinely required.
- Model answers read like a knowledgeable student: plain language, every part of the question addressed, the right length for the marks, no introduction, no filler, no "In conclusion".
- Computation and proofs: show the intermediate steps the marks are for.

## Before you finish

- Rubric marks equal question marks for every written question.
- Every MCQ has exactly the options you intend marked correct.
- Topic names are consistent across questions.
- `validate` prints `OK`.
