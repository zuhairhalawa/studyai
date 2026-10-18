# StudyAI pack format (`studyai-pack` v1)

Authoritative field list and rules: `node dist-cli/lecture-cli.mjs prompt`. This page adds the details that matter when writing a pack by hand.

## Skeleton

```json
{
  "format": "studyai-pack",
  "version": 1,
  "generator": "Claude Code, 2026-10-16",
  "lectures": [
    { "ref": "L1", "title": "Lecture 7 Undecidability", "fileHash": "<sha256 from the Markdown header comment>", "slideCount": 24 }
  ],
  "notes": [],
  "cards": [],
  "questions": []
}
```

Every item points at lectures by `ref`. Items may be missing optional fields; items missing **required** fields are skipped (and reported) without affecting the others.

## Sources (on every item)

```json
"sources": [{ "lecture": "L1", "slide": 12, "quote": "exact words copied from slide 12" }]
```

- `slide` is the number in the heading `### Slide 12:`.
- `quote`: 3–25 words copied character for character from that slide (or its speaker notes / picture alt text). Use `...` to skip words. Markdown emphasis, LaTeX and punctuation differences are tolerated; changed or paraphrased words are not.
- A quote shorter than 3 words cannot be verified: use a longer one or omit it.
- Several sources are fine (e.g. a definition on slide 4 and an example on slide 9).

## `basis` (required)

| value | use when |
|---|---|
| `lecture` | stated on the slides (needs a verifiable quote) |
| `derived` | a reasonable explanation derived from what the slides say |
| `outside` | extra knowledge added for understanding, not on the slides |
| `uncertain` | unsure, or the slides may contain an error |

An item missing `basis` is imported as `uncertain`. An item claiming `lecture` whose quotes cannot be verified is flagged to the student.

## Cards

`type`: `definition` · `concept` · `formula` · `comparison` · `qa` · `scenario` · `code` · `proof`. Required: `type`, `front`, `back`. Markdown and `$LaTeX$` are rendered; fenced code is highlighted. Optional: `lecture`, `tags`, `deck`.

## Notes

`kind`: `lecture-notes` · `summary` · `revision-sheet` · `definitions` · `formulas` · `comparison` · `mistakes` · `worked-example` · `last-minute` · `custom`. Each note has `title` and `blocks: [{ text, basis, sources }]`. Keep blocks short (one idea) so students can edit them.

## Questions

`type`: `mcq` · `truefalse` · `short` · `long` · `scenario` · `case` · `compare` · `define` · `problem` · `calculation` · `algorithm` · `programming` · `proof` · `diagram` · `attack`.

- Always: `prompt`, `marks` (number > 0), `basis`.
- `mcq`: `options: [{ "text": "...", "correct": true|false }]`, at least two, at least one correct. Several correct is allowed ("select all that apply" is shown automatically).
- `truefalse`: `"answer": true` or `false`.
- Every other type: a `modelAnswer` and/or `rubric: [{ "text": "...", "marks": 1, "keywords": ["optional"] }]`. **Rubric marks must add up to `marks`.**
- Optional: `difficulty` (1 easy, 2 medium, 3 hard), `topic` (use the same spelling for questions in the same topic: it drives weak-topic tracking), `lectures` (refs), `expectedWords: [min, max]`, `hint`.

## What happens on import

Items are validated one by one; invalid ones are skipped and listed. Lectures are matched by hash, then title (the student can match the rest by hand). Every cited quote is checked against the real slide text. Everything is stored as **pending** until the student approves it; nothing is studied or used in exams before that.
