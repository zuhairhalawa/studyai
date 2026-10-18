import { slotTokens, type PlannedSlot } from './blueprint';
import { BASES, CARD_TYPES, NOTE_KINDS, QUESTION_TYPES } from './types';

/**
 * The study-pack format identifiers and the instructions given to an AI that writes a pack. Kept apart from the Markdown
 * export (which needs the PowerPoint model) so the Worker can build prompts without bundling the PowerPoint engine.
 */
export const PACK_FORMAT = 'studyai-pack';
export const PACK_VERSION = 1;

/** The pack skeleton shown to the AI: precise, short, and including the provenance rules. */
const SCHEMA_EXAMPLE = {
  format: PACK_FORMAT,
  version: PACK_VERSION,
  generator: 'name of the AI and date',
  lectures: [{ ref: 'L1', title: 'exact lecture title from the export', fileHash: 'hash from the export comment', slideCount: 40 }],
  // Questions come first, then cards, then notes: if an answer is ever cut off, what is lost is the least valuable part.
  questions: [
    {
      type: 'scenario',
      prompt: 'REQUIRED, the question exactly as the student reads it: a short situation, then the question: state three things that ...',
      asks: [{ quote: 'words copied from the prompt that ask for something, such as: state three things', count: 3 }],
      marks: 3,
      difficulty: 3,
      topic: 'topic title, copied exactly',
      lectures: ['L1'],
      modelAnswer: 'what a student who earns full marks writes: all three points, once each, from the slides only',
      rubric: [{ text: 'first separate idea', marks: 1, ask: 1, keywords: ['optional', 'words'] }, { text: 'second separate idea', marks: 1, ask: 1 }, { text: 'third separate idea', marks: 1, ask: 1 }],
      expectedWords: [36, 60],
      hint: 'optional nudge that does not give the answer away',
      basis: 'lecture',
      sources: [{ lecture: 'L1', slide: 12, quote: 'exact words copied from slide 12' }],
    },
  ],
  cards: [{ type: 'definition', front: 'question side', back: 'answer side', lecture: 'L1', basis: 'lecture', tags: ['topic'], sources: [{ lecture: 'L1', slide: 12, quote: 'exact words copied from slide 12' }] }],
  notes: [{ title: 'Topic summary: …', kind: 'summary', lecture: 'L1', blocks: [{ text: 'markdown with $latex$', basis: 'lecture', sources: [{ lecture: 'L1', slide: 12, quote: 'exact words copied from slide 12' }] }] }],
};

export interface PromptOptions {
  /** Professor / exam-format instructions saved for the course. */
  examStyle?: string;
  wants: { notes: boolean; cards: boolean; questions: boolean };
  /** Roughly how many items of each kind to ask for. */
  amount: 'few' | 'normal' | 'many';
  /**
   * The most tokens the AI may write in its answer. When it is set the counts are cut down until the whole pack fits, and
   * the AI is told to keep every field short, because an answer that hits the cap is cut off in the middle of the JSON.
   */
  outputTokens?: number;
  /** The planned questions (see blueprint.ts). When given, they replace the generic "N questions" and fix type, marks and topic. */
  blueprint?: readonly PlannedSlot[];
  /** Applied to text that came from the student's lecture (topic titles) before it is placed in the prompt. */
  escape?: (text: string) => string;
}

export type PackKind = 'notes' | 'cards' | 'questions';

const BASE_COUNTS = { few: [5, 10, 6], normal: [10, 25, 12], many: [20, 50, 25] } as const;
/** Tokens of JSON one item takes with its sources and quotes (measured on real Gemini answers, rounded up; questions are estimated). */
const ITEM_TOKENS: Record<PackKind, number> = { notes: 220, cards: 130, questions: 330 };
const OVERHEAD_TOKENS = 150;
/** Leave a third of the cap unused: answers vary in length and a cut-off answer is worse than a short one. */
const FILL = 0.7;

/** How many items of each kind the request asks for. Zero for a kind that is not wanted. */
export function packCounts(o: Pick<PromptOptions, 'wants' | 'amount' | 'outputTokens' | 'blueprint'>): Record<PackKind, number> {
  if (o.blueprint && o.blueprint.length > 0) {
    // The planned questions are fixed (the plan was already cut to fit one answer); cards and notes only get what room is left.
    const room = o.outputTokens === undefined ? Infinity : Math.floor(o.outputTokens * FILL) - OVERHEAD_TOKENS - o.blueprint.reduce((n, s) => n + slotTokens(s), 0);
    const rest = packCounts({ wants: { ...o.wants, questions: false }, amount: o.amount, ...(room === Infinity ? {} : { outputTokens: Math.max(0, room) + OVERHEAD_TOKENS * 2 }) });
    return { notes: rest.notes, cards: rest.cards, questions: o.blueprint.length };
  }
  const [bn, bc, bq] = BASE_COUNTS[o.amount];
  const base: Record<PackKind, number> = { notes: o.wants.notes ? bn : 0, cards: o.wants.cards ? bc : 0, questions: o.wants.questions ? bq : 0 };
  if (o.outputTokens === undefined) return base;
  const cost = (c: Record<PackKind, number>) => c.notes * ITEM_TOKENS.notes + c.cards * ITEM_TOKENS.cards + c.questions * ITEM_TOKENS.questions;
  const room = Math.max(0, Math.floor(o.outputTokens * FILL) - OVERHEAD_TOKENS);
  const total = cost(base);
  if (total <= room) return base;
  const scale = room / total;
  const kinds: PackKind[] = ['questions', 'cards', 'notes'];
  const fit = { ...base };
  for (const k of kinds) fit[k] = base[k] === 0 ? 0 : Math.max(1, Math.floor(base[k] * scale));
  // Spend what is left, one item at a time, so a small pack does not waste its room.
  for (let added = true; added; ) {
    added = false;
    for (const k of kinds) {
      if (fit[k] > 0 && fit[k] < base[k] && cost(fit) + ITEM_TOKENS[k] <= room) {
        fit[k] += 1;
        added = true;
      }
    }
  }
  return fit;
}

/** What makes an exam question good, kind by kind. The checks in pack-quality.ts hold the answer to the same rules. */
export const QUESTION_RULES = `QUESTIONS: what makes a good exam question from these slides
A. Kind. Write each question as the "type" it has and make it really that kind:
   - define: a term from the slides, asked together with what it is for or how it behaves.
   - short: one focused question answered in a few sentences (why, how, what happens when).
   - compare: two or more things named on the slides, compared on aspects that the question names.
   - scenario: a short invented situation (2 to 4 sentences, concrete, new to the student) in which the student must apply ideas from the slides: ask them to decide, advise, predict, diagnose or justify IN THIS situation, so that the situation's details change the answer. The situation may be invented; every marking point must still be on the slides. If the question only asks to state facts the slides give, the story is decoration: write a short question instead. A situation must bring something the slides do not say (a particular string, language, machine, number, claim or person) for the slides' ideas to be applied to; "you are building the machine from the slides, describe it" is the slide with a sentence in front. On formal or mathematical material the situation can be a claim or a short argument to judge (a student's attempted step, a stated result, a machine described in two lines): the student says whether it holds and why, using only results the slides state.
   - case: a longer situation with two or three parts, (a), (b), (c).
   - attack: a threat and what weakens or stops it, only as the slides present them.
   - problem, calculation: a problem that the slides' own method solves. Give every number in the question; the model answer shows each step.
   - proof: a short argument or derivation that follows a method shown on the slides, one marking point per step. Use only the steps the slides show: never add a step, a lemma or a reason the slides leave out, and where a slide skips a step do not fill it in.
   - algorithm, programming: trace or write steps like the slides' own, one marking point per step. Never split one step into two points and never add a point for a set-up sentence to reach the number of marks: if the slides show fewer steps than marks, ask for fewer marks. Ask for "the steps" (or "the transitions"), not "steps or outcomes". For a machine or automaton on the slides: ask for its run on a given input (or for a machine that does a stated job), one marking point per transition or decision.
   - diagram: a figure whose words are on the slides: what it shows and why it matters.
   - mcq: one correct option and plausible wrong ones that reflect real misconceptions (always write "options"); truefalse: a statement that is clearly true or false on the slides (always write "answer": true or false).
   - long: a structured answer that links several ideas.
B. Difficulty. 1 = state or recognise one idea from one slide. 2 = explain, compare or apply ideas from one to three slides. 3 = a situation or problem that needs several slides or several steps, which a student who only memorised definitions cannot answer.
C. Marks. About one separate idea per mark: a 1-mark question asks for one fact, a 6-mark question for six distinct points. The wording says how much is wanted ("State two...", "Give three reasons...").
D. Marking points. Each one is ONE idea a student can earn on its own: a student who writes only that idea gets that mark and no other. No point repeats or contains another. Never write "any two of", "all of", "at least" or "A or B" as a point: list the ideas separately and ask for a fixed number. The points add up to the question's marks, and each one has a source quote.
E. Model answer. What a student who earns FULL marks writes: every marking point once, in plain language, in about 12 to 20 words per mark, using only what the slides say (for a scenario: the slides' ideas applied to the situation). Nothing in it may go beyond the slides. Set "expectedWords" to [12 x marks, 20 x marks], so a 3-mark question has [36, 60].
F. Variety. Each question tests a different idea or different slides. Do not repeat or reword any question listed in <already_asked>, if there is one. Copy "topic" exactly as given.
G. Prompt. Every question has a "prompt": the full text of the question as the student reads it, written before the answer and the marking points. A question without a "prompt" is thrown away, however good the rest is. Keep this even when every other field is short.
H. Asks. After the prompt, list in "asks" every separate thing it asks the student for: {"quote": the exact words of your prompt that ask for it, "count": how many separate items or ideas it wants}. Then every marking point says which ask it answers: "ask": 1 for the first ask. An ask with count 3 has exactly three marking points, a number in the quote ("three reasons") equals its count, and the counts add up to the marks. Never add a marking point or a mark for something the prompt does not ask for: to reward an idea, first ask for it in the prompt. Everything the prompt asks for has marking points.
I. Questions printed on slides. A question on a slide (a check-in, a poll, "Why is this ...?") is something the lecture put to the room, not something it answered. Do not use your own answer to it as a marking point or in the model answer as if the slide gave it. Base the marking points on what the slides state; if they do not answer it, write a different question that they do answer.`;

function blueprintBlock(slots: readonly PlannedSlot[], escape: (s: string) => string): string {
  const lines = slots.map((s, i) => {
    const slideText = s.slides.length === 1 ? `slide ${s.slides[0]}` : `slides ${s.slides.join(', ')}`;
    return `${i + 1}. type "${s.type}", difficulty ${s.difficulty}, ${s.marks} mark${s.marks === 1 ? '' : 's'}, ${s.points} marking point${s.points === 1 ? '' : 's'}, topic ${JSON.stringify(escape(s.topic))}, based on ${slideText}`;
  });
  return `THE QUESTIONS TO WRITE: exactly ${slots.length}, in this order, as the "questions" list
${lines.join('\n')}
Keep each question's type, difficulty, marks and number of marking points as given, and base it on the slides named. A question may also use other slides when it needs them. The lines above tell you what to write; they are not the questions. Write the text the student will read in each question's "prompt".`;
}

export function studyPackPrompt(o: PromptOptions): string {
  const n = packCounts(o);
  const escape = o.escape ?? ((s: string) => s);
  const planned = !!o.blueprint && o.blueprint.length > 0;
  const want = [
    n.notes > 0 && `${n.notes} notes (summaries, definitions, comparison tables, common mistakes)`,
    n.cards > 0 && `${n.cards} flashcards`,
    n.questions > 0 && (planned ? `${n.questions} exam questions (listed below) with marking points` : `${n.questions} exam-style questions with marking points`),
  ]
    .filter(Boolean)
    .join(', ');
  // The format example shows all three lists; a model fills in the ones it was not asked for unless told to leave them empty.
  const unwanted = (['notes', 'cards', 'questions'] as const).filter((k) => n[k] === 0);
  const emptyLists = unwanted.length > 0 && unwanted.length < 3 ? ` Write only what is asked for: leave ${unwanted.map((k) => `"${k}"`).join(' and ')} as empty lists ([]).` : '';
  const compact =
    o.outputTokens === undefined
      ? ''
      : `\n9. Your whole answer is limited to about ${Math.floor(o.outputTokens * 0.5).toLocaleString('en-US')} words and is thrown away if it is cut off, so it must be COMPLETE valid JSON. Keep every field short: a quote of 6 to 15 words, a note block of at most 80 words, one or two sources per item. If you cannot fit all the items, write fewer items, never a longer one.`;
  return `You are helping a university student study from lecture slides. The lecture text follows after this message.

TASK
Create ${want || 'study material'} from the lectures below and return them as ONE JSON object in the "${PACK_FORMAT}" format shown at the end. Return only the JSON (a single code block is fine).${emptyLists}

RULES — these matter more than quantity
1. The slides are the source of truth. Do not invent lecture content, definitions, proof steps, exam rules or what the professor prefers.
2. Every item needs "basis":
   - "lecture"   = the item is stated on the slides (you MUST give a quote);
   - "derived"   = a reasonable explanation derived from what the slides say;
   - "outside"   = extra knowledge added for understanding that is NOT on the slides;
   - "uncertain" = you are not sure or the slides do not support it.
3. Every item needs "sources": [{"lecture": "<ref>", "slide": <slide number>, "quote": "<exact words copied from that slide>"}]. Copy quotes character for character from the slide (3 to 25 words; use "..." to skip words). The student's app checks every quote against the real slide and flags the ones that do not match, so do not paraphrase inside quotes. A quote must support the WHOLE item: if any part of a card, note or answer is general knowledge that the quoted words do not say (even when it is true), the item's basis is "outside" or "derived", never "lecture"; where the slide's own wording differs from the textbook meaning, write what the slide says.
4. If a slide's text is marked as unreadable, an image, or has "Extraction caveats", do not make claims about what is in it.
5. If the slides contain an error or contradiction, say so in the item (basis "uncertain") instead of silently fixing it.
6. Question marks: the "rubric" marks must add up to the question's "marks". Follow the QUESTIONS guidance below for kinds, difficulty, marking points and model answers.
7. Use LaTeX in $...$ for mathematics. Do not use any other markup that needs rendering.
8. Allowed values — card "type": ${CARD_TYPES.join(', ')}. note "kind": ${NOTE_KINDS.join(', ')}. question "type": ${QUESTION_TYPES.join(', ')}. "basis": ${BASES.join(', ')}. For "mcq" give "options": [{"text":…, "correct":…}] with at least one correct; for "truefalse" give "answer": true|false.${compact}
${n.questions > 0 ? `\n${QUESTION_RULES}\n` : ''}${planned ? `\n${blueprintBlock(o.blueprint!, escape)}\n` : ''}${o.examStyle?.trim() ? `\nPROFESSOR'S EXAM STYLE (follow it when writing questions and answers; where it differs from the QUESTIONS guidance, the professor's style wins):\n${o.examStyle.trim()}\n` : ''}
FORMAT
${JSON.stringify(SCHEMA_EXAMPLE, null, 2)}`;
}

/** The questions that already exist, as a block of data for the prompt (the caller escapes each line). */
export function alreadyAskedBlock(lines: readonly string[]): string {
  const cleaned = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return cleaned.length === 0 ? '' : `<already_asked>\n${cleaned.map((l) => `- ${l}`).join('\n')}\n</already_asked>`;
}
