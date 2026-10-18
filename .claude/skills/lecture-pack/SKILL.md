---
name: lecture-pack
description: Turn university PowerPoint lectures (.pptx) into a verified StudyAI study pack (notes, flashcards, exam-style questions with marking points) using Claude Code itself, with no API calls. Use when the user has lecture slides and wants study material, flashcards, practice or exam questions, revision notes or a "study pack" for the StudyAI app, or wants a pack's slide references checked or fixed.
---

# Lecture to study pack

Produce study material from lecture slides **using this Claude Code session only** (the user's existing subscription), then check every claim against the real slides before the student imports it into StudyAI.

## Hard rules

- **Zero spend.** Never call an AI API, never ask for or use an API key, never run a paid or networked service. Everything here is local files plus your own writing. If asked to "use the API", refuse and explain this skill runs on the session.
- **The slides are the source of truth.** Do not invent lecture content, definitions, proof steps, exam rules or what the professor prefers. Extra knowledge is allowed only when labelled `"basis": "outside"`.
- **Lecture files stay on this machine.** Do not upload, paste into web tools, or send slides anywhere.
- **Never fake a quote to pass validation.** If a statement is not on a slide, give it no quote and mark it `derived`, `outside` or `uncertain`.
- Do not claim to predict the real exam. Say the questions are representative practice.

## Setup (once per checkout)

Run from the StudyAI project root. The tool is a small Node CLI built from the same engine the app uses:

```bash
bash .claude/skills/lecture-pack/scripts/ensure-cli.sh      # builds dist-cli/lecture-cli.mjs if missing
node dist-cli/lecture-cli.mjs help
```

## Workflow

Work in a folder such as `study-work/<course>/` (not committed; it contains lecture text).

1. **Ingest.** `node dist-cli/lecture-cli.mjs extract <lecture1.pptx> <lecture2.pptx> ... --out study-work/<course>/extract`
   Gives `L1-….md`, `L2-….md` (slide-numbered Markdown, maths as LaTeX) and a `*.report.json` per lecture.
2. **Inspect extraction completeness.** Read the printed summary and each report. List the slides that need attention (images, SmartArt, EMF, unreadable) and the "potentially missing" lines. Tell the user which slides they must check in the original. **Make no claims about content that was not extracted.**
3. **Identify topics and learning objectives.** Read the Markdown. Write `outline.md`: topics with slide ranges, and 2–5 learning objectives each, stated as "after this the student can …". Say they are inferred from the slides, not from a syllabus.
4. **Lecture-grounded explanations → notes.** One note per topic. Short blocks; each block cites slide(s) with a verbatim quote and has a `basis`. Explain in plain language assuming a beginner; put outside knowledge in separate blocks labelled `outside`.
5. **Practice questions.** Use the question types that fit the subject (see `reference/quality.md`). If the user has not told you the professor's exam style, ask once; otherwise reuse what they gave. Mix difficulty. Do not write trick questions.
6. **Marking rubrics.** Every written question gets `rubric` points whose marks **add up to the question's marks**, a student-style `modelAnswer`, and optional `expectedWords`. MCQ/true-false need options / `answer`.
7. **Revision notes.** Add notes of kind `definitions`, `formulas`, `comparison`, `mistakes`, `revision-sheet` or `last-minute` where the lecture supports them.
8. **Flashcards.** One fact or one step per card; see `reference/quality.md`. Use `definition`, `formula`, `comparison`, `qa`, `scenario`, `code`, `proof` types as appropriate.
9. **Validate the source references.** Write the pack to `study-work/<course>/pack.json`, then:
   ```bash
   node dist-cli/lecture-cli.mjs validate study-work/<course>/pack.json --lectures <lecture1.pptx> <lecture2.pptx> ...
   ```
   Exit code 0 means every item was accepted and every cited quote was found on its slide. Otherwise it prints each problem **and what the slide actually says**. Fix the pack (correct the quote, change the slide, or downgrade the `basis` and drop the quote) and run it again. Repeat until it prints `OK`.
10. **Export in the app's format.** The pack file *is* the export. Tell the user: open the course in StudyAI → **Study packs → Import a study pack…** → choose `pack.json`. Everything arrives as *pending*; they approve what they want. Keep one pack per lecture or topic group (aim for ≤ 60 items) so quality stays high.

## Pack format

Run `node dist-cli/lecture-cli.mjs prompt` for the authoritative field list and rules (it is the same text the app shows). Field details and examples: [reference/pack-format.md](reference/pack-format.md). Quality bar for notes, cards, questions and answers: [reference/quality.md](reference/quality.md).

Lecture references: the pack's `lectures` array maps `ref` (`L1`, `L2`, matching the extract output) to the lecture's `title` and `fileHash` (printed in the Markdown header comment). StudyAI matches by file hash first, then by title.

## What to tell the user at the end

- Counts per kind and per lecture; which file(s) you wrote.
- Slides with extraction problems (what could not be used).
- Items whose basis is `outside`, `derived` or `uncertain`, and any slide errors or contradictions you noticed.
- The validation result line verbatim.
- That nothing was sent anywhere and no API was used.
