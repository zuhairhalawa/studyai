import { z } from 'zod';
import { newId } from '../id';
import { newSchedulerState } from './fsrs';
import type { PlannedSlot } from './blueprint';
import { normForMatch, normJoined } from './match';
import { assessQuestions, type QualityReport } from './pack-quality';
import { BASES, CARD_TYPES, NOTE_KINDS, QUESTION_TYPES, type Basis, type CardRow, type NoteRow, type QuestionRow, type SourceRefRow } from './types';

/**
 * Study packs: JSON that you generate *outside* this app (for example with the Claude or Gemini
 * subscription you already pay for) from an exported lecture, then import here.
 * Nothing in a pack is trusted:
 *  - the file is parsed leniently (code fences and chatter are stripped) but every item is validated on its own,
 *  - lecture references are resolved to lectures in this course (by file hash, then title, or by you),
 *  - every cited quote is checked against the real slide text, and the result is stored with the item,
 *  - nothing is approved automatically: everything lands in the review queue as "pending".
 */

export { PACK_FORMAT, PACK_VERSION } from './pack-format';
import { PACK_FORMAT, PACK_VERSION } from './pack-format';
export const MAX_PACK_ITEMS = 5_000;

const str = (max = 20_000) => z.string().max(max);
const num = z.number();
const int = z.number().int();

// ---------------------------------------------------------------------------
// Pack schema (item level: validated one by one, so one bad item never sinks the pack)
// ---------------------------------------------------------------------------

const packSource = z.object({ lecture: str(100), slide: int.min(1).max(100_000), quote: str(1_000).optional() });
const basis = z.enum(BASES);

const packCard = z.object({
  type: z.enum(CARD_TYPES),
  front: str().min(1),
  back: str().min(1),
  lecture: str(100).optional(),
  tags: z.array(str(60)).max(30).optional(),
  deck: str(100).optional(),
  basis: basis.optional(),
  sources: z.array(packSource).max(20).default([]),
});

const packNote = z.object({
  title: str(300).min(1),
  kind: z.enum(NOTE_KINDS).optional(),
  lecture: str(100).optional(),
  blocks: z.array(z.object({ text: str(200_000).min(1), basis: basis.optional(), sources: z.array(packSource).max(20).default([]) })).min(1).max(2_000),
});

const packQuestion = z.object({
  type: z.enum(QUESTION_TYPES),
  prompt: str().min(1),
  marks: num.min(0.5).max(1_000),
  difficulty: int.min(1).max(3).optional(),
  topic: str(300).optional(),
  lectures: z.array(str(100)).max(50).optional(),
  options: z.array(z.object({ text: str(2_000).min(1), correct: z.boolean() })).max(12).optional(),
  /** For true/false questions: the correct answer. */
  answer: z.boolean().optional(),
  modelAnswer: str().optional(),
  rubric: z
    .array(z.object({ text: str(2_000).min(1), marks: num.min(0).max(1_000), keywords: z.array(str(100)).max(20).optional(), /** The ask (1 = first) this point answers. A badly formed value is ignored, never a reason to drop the question. */ ask: int.min(1).max(12).optional().catch(undefined) }))
    .max(50)
    .default([]),
  /** What the prompt asks for: its words and how many items. Used only for the alignment check; not stored. */
  asks: z.array(z.object({ quote: str(2_000).min(1), count: int.min(1).max(30) })).max(12).optional().catch(undefined),
  expectedWords: z.tuple([int.min(0), int.min(0)]).optional(),
  hint: str(2_000).optional(),
  basis: basis.optional(),
  sources: z.array(packSource).max(20).default([]),
});

const packContainer = z.object({
  format: z.literal(PACK_FORMAT),
  version: int,
  generator: str(300).optional(),
  name: str(300).optional(),
  lectures: z
    .array(z.object({ ref: str(100), title: str(500).optional(), fileHash: str(100).optional(), slideCount: int.optional() }))
    .max(500)
    .default([]),
  notes: z.array(z.unknown()).max(MAX_PACK_ITEMS).default([]),
  cards: z.array(z.unknown()).max(MAX_PACK_ITEMS).default([]),
  questions: z.array(z.unknown()).max(MAX_PACK_ITEMS).default([]),
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Pull the JSON object out of text that may include markdown code fences or explanatory chatter. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found. Paste the JSON your AI produced (it should start with “{” and contain "format": "studyai-pack").');
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    throw new Error(`The JSON could not be parsed (${err instanceof Error ? err.message : 'syntax error'}). Ask the AI to return valid JSON only.`);
  }
}

/**
 * An AI answer that hit its length limit stops in the middle of the JSON. This keeps everything up to the last item that was
 * finished (a card, a note, a question or a lecture entry) and closes the brackets, so the complete items are not lost with the
 * unfinished one. Returns undefined when not even one item was finished. Nothing is invented: the unfinished item is dropped.
 */
export function recoverTruncatedJson(text: string): { value: unknown; items: number } | undefined {
  const body = text.includes('```') ? text.replace(/^[\s\S]*?```(?:json)?\s*/i, '') : text;
  const start = body.indexOf('{');
  if (start < 0) return undefined;
  const s = body.slice(start);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let cut = -1;
  let closers = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      stack.pop();
      // An element of one of the pack's lists is finished when we are back inside the list, directly under the top object.
      if (stack.length === 2 && stack[0] === '{' && stack[1] === '[') {
        cut = i + 1;
        closers = ']}';
      } else if (stack.length === 1 && stack[0] === '{') {
        cut = i + 1;
        closers = '}';
      }
    }
  }
  if (cut < 0) return undefined;
  try {
    const value = JSON.parse(s.slice(0, cut) + closers) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const o = value as Record<string, unknown>;
    const items = (['notes', 'cards', 'questions'] as const).reduce((n, k) => n + (Array.isArray(o[k]) ? (o[k] as unknown[]).length : 0), 0);
    return items > 0 ? { value, items } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Source checking
// ---------------------------------------------------------------------------

/** A lecture of the target course, with a way to read slide text (title, body, notes) for verification. */
export interface LectureContext {
  id: string;
  title: string;
  fileHash: string;
  revision: number;
  slideCount: number;
  /** Plain searchable text of a slide (1-based), or undefined if the slide does not exist. */
  slideText: (slide: number) => string | undefined;
}

export { normForMatch };

/** True when every ellipsis-separated fragment (≥ 3 words) of `quote` occurs in `haystack` (a subscript may be joined or not). */
export function quoteInText(quote: string, haystack: string): boolean | undefined {
  const raw = quote
    .split(/\.{3}|…/)
    // the lecture text reaches the model with & < > escaped, and a model may copy a quote with the escapes still in it
    .map((f) => f.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&amp;/gi, '&'));
  const check = (norm: (s: string) => string): boolean | undefined => {
    const frags = raw.map(norm).filter((f) => f.length > 0);
    if (frags.length === 0 || frags.every((f) => f.split(' ').length < 3)) return undefined; // too short to mean anything
    const hay = ` ${norm(haystack)} `;
    return frags.filter((f) => f.split(' ').length >= 3).every((f) => hay.includes(` ${f} `));
  };
  const plain = check(normForMatch);
  return plain === true ? true : (check(normJoined) ?? plain);
}

export type SourceStatus = 'verified' | 'slide-only' | 'unverified' | 'none';

/** Summarise how well an item's sources check out (used for the ✓ / ⚠ chips). */
export function sourceStatus(sources: SourceRefRow[]): SourceStatus {
  if (sources.length === 0) return 'none';
  if (sources.some((s) => s.verified === true)) return 'verified';
  if (sources.some((s) => s.verified === false)) return 'unverified';
  return 'slide-only';
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanIssue {
  severity: 'error' | 'warning';
  where: string;
  message: string;
  /** A marking point the finding is about: where the question sat in the list the AI wrote and which point (both 0-based). */
  fix?: { question: number; point: number };
}

export interface PlanLecture {
  ref: string;
  title: string;
  fileHash?: string;
  localId?: string;
  how?: 'hash' | 'title' | 'manual';
}

export interface PackPlan {
  fatal?: string;
  /** Shared by every row created from this plan, so the whole import can be reviewed or removed together. */
  packId: string;
  name: string;
  generator?: string;
  lectureMap: PlanLecture[];
  notes: NoteRow[];
  cards: CardRow[];
  questions: QuestionRow[];
  /** Where each kept question sat in the list the AI wrote (0-based), so a finding can be traced back to the pack. */
  questionAt: number[];
  issues: PlanIssue[];
  stats: { received: number; accepted: number; rejected: number; sources: number; verified: number; unverified: number };
  /** How good the exam questions are as a set (see pack-quality.ts). Its findings are also in `issues`, as warnings. */
  quality?: QualityReport;
}

export interface PlanOptions {
  /** The questions that were asked for (the exam blueprint): what came back is compared with it. */
  expected?: readonly PlannedSlot[];
  /** Prompts of questions that already exist, so a repeat is found. */
  existingPrompts?: readonly string[];
}

const sameTitle = (a: string, b: string) => normForMatch(a) === normForMatch(b);

/**
 * Validate a pack and turn it into rows ready to store. Never throws.
 * `mapping` lets the user choose a local lecture for a pack lecture that could not be matched.
 */
export function planPack(raw: unknown, courseId: string, lectures: LectureContext[], mapping: Record<string, string> = {}, now = Date.now(), options: PlanOptions = {}): PackPlan {
  const empty = (fatal: string): PackPlan => ({ fatal, packId: '', name: '', lectureMap: [], notes: [], cards: [], questions: [], questionAt: [], issues: [], stats: { received: 0, accepted: 0, rejected: 0, sources: 0, verified: 0, unverified: 0 } });
  const top = packContainer.safeParse(raw);
  if (!top.success) {
    const i = top.error.issues[0];
    return empty(`This is not a StudyAI pack (${i ? `${i.path.join('.') || 'root'}: ${i.message}` : 'invalid'}).`);
  }
  const pack = top.data;
  if (pack.version > PACK_VERSION) return empty(`This pack uses format version ${pack.version}; this app understands up to ${PACK_VERSION}.`);

  const issues: PlanIssue[] = [];
  const byId = new Map(lectures.map((l) => [l.id, l]));
  const lectureMap: PlanLecture[] = pack.lectures.map((p) => {
    const entry: PlanLecture = { ref: p.ref, title: p.title ?? p.ref };
    if (p.fileHash) entry.fileHash = p.fileHash;
    const manual = mapping[p.ref];
    const hit =
      (manual && byId.has(manual) ? { l: byId.get(manual)!, how: 'manual' as const } : undefined) ??
      (p.fileHash ? (lectures.find((l) => l.fileHash === p.fileHash) ? { l: lectures.find((l) => l.fileHash === p.fileHash)!, how: 'hash' as const } : undefined) : undefined) ??
      (p.title ? (lectures.find((l) => sameTitle(l.title, p.title!)) ? { l: lectures.find((l) => sameTitle(l.title, p.title!))!, how: 'title' as const } : undefined) : undefined);
    if (hit) {
      entry.localId = hit.l.id;
      entry.how = hit.how;
      if (hit.how !== 'hash' && p.slideCount !== undefined && p.slideCount !== hit.l.slideCount) {
        issues.push({ severity: 'warning', where: `lecture ${p.ref}`, message: `“${hit.l.title}” has ${hit.l.slideCount} slides but the pack was made from a version with ${p.slideCount}. Slide numbers may not line up; check the source badges.` });
      }
    } else {
      issues.push({ severity: 'warning', where: `lecture ${p.ref}`, message: `No lecture in this course matches “${p.title ?? p.ref}”. Choose one below, or its items will have no verified source.` });
    }
    return entry;
  });
  const localOf = (ref: string | undefined): LectureContext | undefined => {
    if (!ref) return undefined;
    const id = lectureMap.find((l) => l.ref === ref)?.localId;
    return id ? byId.get(id) : undefined;
  };

  const stats = { received: 0, accepted: 0, rejected: 0, sources: 0, verified: 0, unverified: 0 };

  const resolveSources = (where: string, sources: z.infer<typeof packSource>[], fallbackRef?: string): SourceRefRow[] => {
    const out: SourceRefRow[] = [];
    for (const s of sources) {
      stats.sources += 1;
      const lec = localOf(s.lecture) ?? localOf(fallbackRef);
      if (!lec) {
        stats.unverified += 1;
        issues.push({ severity: 'warning', where, message: `A source points to lecture “${s.lecture}”, which is not matched to a lecture here; it was dropped.` });
        continue;
      }
      const text = lec.slideText(s.slide);
      if (text === undefined) {
        stats.unverified += 1;
        issues.push({ severity: 'warning', where, message: `A source cites slide ${s.slide} of “${lec.title}”, which has only ${lec.slideCount} slides; it was dropped.` });
        continue;
      }
      const ref: SourceRefRow = { lectureId: lec.id, slide: s.slide, rev: lec.revision };
      if (s.quote) {
        ref.quote = s.quote.slice(0, 1_000);
        const ok = quoteInText(s.quote, text);
        if (ok !== undefined) {
          ref.verified = ok;
          if (ok) stats.verified += 1;
          else {
            stats.unverified += 1;
            issues.push({ severity: 'warning', where, message: `The quote “${s.quote.slice(0, 60)}…” was not found on slide ${s.slide} of “${lec.title}”.` });
          }
        }
      }
      out.push(ref);
    }
    return out;
  };

  const validated = <T>(kind: string, list: unknown[], schema: z.ZodType<T>, build: (item: T, where: string) => void) => {
    list.forEach((item, i) => {
      stats.received += 1;
      const where = `${kind} #${i + 1}`;
      const r = schema.safeParse(item);
      if (!r.success) {
        stats.rejected += 1;
        const issue = r.error.issues[0];
        issues.push({ severity: 'error', where, message: `Skipped: ${issue ? `${issue.path.join('.') || 'item'} ${issue.message}` : 'invalid'}.` });
        return;
      }
      try {
        build(r.data, where);
        stats.accepted += 1;
      } catch (err) {
        stats.rejected += 1;
        issues.push({ severity: 'error', where, message: `Skipped: ${err instanceof Error ? err.message : 'invalid'}.` });
      }
    });
  };

  const packId = newId();
  const notes: NoteRow[] = [];
  const cards: CardRow[] = [];
  const questions: QuestionRow[] = [];
  const bas = (b: Basis | undefined, hasVerified: boolean, where: string): Basis => {
    if (!b) {
      issues.push({ severity: 'warning', where, message: 'No “basis” given (on the slides / derived / outside knowledge / uncertain); marked uncertain.' });
      return 'uncertain';
    }
    if (b === 'lecture' && !hasVerified) issues.push({ severity: 'warning', where, message: 'Claims to be on the slides, but no cited quote could be verified.' });
    return b;
  };

  validated('Note', pack.notes, packNote, (n, where) => {
    const lec = localOf(n.lecture);
    const blocks = n.blocks.map((b) => {
      const sources = resolveSources(where, b.sources, n.lecture);
      return { id: newId(), text: b.text, origin: 'imported' as const, basis: bas(b.basis, sources.some((s) => s.verified), where), sources, updatedAt: now };
    });
    notes.push({ id: newId(), courseId, ...(lec ? { lectureId: lec.id } : {}), title: n.title, kind: n.kind ?? 'custom', blocks, createdAt: now, updatedAt: now, packId });
  });

  validated('Card', pack.cards, packCard, (c, where) => {
    const sources = resolveSources(where, c.sources, c.lecture);
    const lec = localOf(c.lecture) ?? lectures.find((l) => l.id === sources[0]?.lectureId);
    cards.push({
      id: newId(),
      courseId,
      ...(lec ? { lectureId: lec.id } : {}),
      type: c.type,
      front: c.front,
      back: c.back,
      tags: c.tags ?? [],
      ...(c.deck ? { deck: c.deck } : {}),
      basis: bas(c.basis, sources.some((s) => s.verified), where),
      sources,
      origin: 'imported',
      status: 'pending',
      // +index keeps the pack's own order when new cards are introduced (batch items share one timestamp).
      createdAt: now + cards.length,
      updatedAt: now,
      packId,
      fsrs: newSchedulerState(now),
    });
  });

  const questionWhere: string[] = [];
  /** What each kept question said about the parts it asks for, for the alignment check. */
  const questionAsks: { asks: { quote: string; count: number }[] | undefined; askOf: (number | undefined)[] }[] = [];
  /** Where each kept question sat in the list the AI wrote, so a skipped one does not shift the plan. */
  const questionAt: number[] = [];
  validated('Question', pack.questions, packQuestion, (q, where) => {
    const sources = resolveSources(where, q.sources, q.lectures?.[0]);
    questionWhere.push(where);
    questionAsks.push({ asks: q.asks, askOf: q.rubric.map((r) => r.ask) });
    questionAt.push(Number(/#(\d+)$/.exec(where)?.[1] ?? questionAt.length + 1) - 1);
    let options: QuestionRow['options'];
    if (q.type === 'mcq') {
      if (!q.options || q.options.length < 2) throw new Error('a multiple-choice question needs at least two options');
      if (!q.options.some((o) => o.correct)) throw new Error('no option is marked correct');
      options = q.options.map((o, i) => ({ id: `o${i + 1}`, text: o.text, correct: o.correct }));
    } else if (q.type === 'truefalse') {
      let correct = q.answer ?? q.options?.find((o) => o.correct)?.text.toLowerCase().startsWith('t');
      if (correct === undefined) {
        // A real model once wrote "modelAnswer": "True" and a one-point rubric "True" but forgot the "answer" field. That is still a clear answer.
        const said = /^\W*(true|false)\b/i.exec(q.modelAnswer ?? q.rubric[0]?.text ?? '');
        if (!said) throw new Error('a true/false question needs "answer": true or false');
        correct = said[1]!.toLowerCase() === 'true';
        issues.push({ severity: 'warning', where, message: `No "answer" field was given; read as ${correct ? 'true' : 'false'} from the model answer. Check that this is right.` });
      }
      options = [
        { id: 'o1', text: 'True', correct: correct === true },
        { id: 'o2', text: 'False', correct: correct === false },
      ];
    }
    const rubric = q.rubric.map((r, i) => ({ id: `r${i + 1}`, text: r.text, marks: r.marks, ...(r.keywords?.length ? { keywords: r.keywords } : {}) }));
    const sum = rubric.reduce((n, r) => n + r.marks, 0);
    if (rubric.length > 0 && Math.abs(sum - q.marks) > 0.01) {
      issues.push({ severity: 'warning', where, message: `The marking points add up to ${sum} but the question is worth ${q.marks}.` });
    }
    if (!options && rubric.length === 0 && !q.modelAnswer) throw new Error('a written question needs a model answer or marking points');
    const lectureIds = [...new Set([...(q.lectures ?? []).map((r) => localOf(r)?.id), ...sources.map((s) => s.lectureId)].filter((x): x is string => !!x))];
    questions.push({
      id: newId(),
      courseId,
      type: q.type,
      prompt: q.prompt,
      marks: q.marks,
      difficulty: q.difficulty ?? 2,
      ...(q.topic ? { topic: q.topic } : {}),
      lectureIds,
      ...(options ? { options } : {}),
      ...(q.modelAnswer ? { modelAnswer: q.modelAnswer } : {}),
      rubric,
      ...(q.expectedWords ? { expectedWords: q.expectedWords } : {}),
      ...(q.hint ? { hint: q.hint } : {}),
      basis: bas(q.basis, sources.some((s) => s.verified), where),
      sources,
      origin: 'imported',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      packId,
    });
  });

  if (stats.received === 0) issues.push({ severity: 'error', where: 'pack', message: 'The pack contains no notes, cards or questions.' });

  // Hold the questions to the rules they were written under. The findings are advice shown before approval; nothing is dropped.
  let quality: QualityReport | undefined;
  if (questions.length > 0) {
    const forQuality = questions.map((row, i) => ({ ...row, ...(questionAsks[i]?.asks ? { asks: questionAsks[i]!.asks } : {}), rubric: row.rubric.map((r, k) => ({ ...r, ask: questionAsks[i]?.askOf[k] })) }));
    quality = assessQuestions(forQuality, { slideText: (lectureId, slide) => byId.get(lectureId)?.slideText(slide) }, { expected: options.expected, existingPrompts: options.existingPrompts, positions: questionAt, requireAsks: !!options.expected && options.expected.length > 0 });
    for (const i of quality.issues) {
      const fix = i.question && i.point ? { question: questionAt[i.question - 1] ?? i.question - 1, point: i.point - 1 } : undefined;
      issues.push({ severity: 'warning', where: i.question ? (questionWhere[i.question - 1] ?? `Question #${i.question}`) : 'Question set', message: i.message, ...(fix ? { fix } : {}) });
    }
  }
  return { packId, name: pack.name ?? pack.generator ?? 'Imported study pack', ...(pack.generator ? { generator: pack.generator } : {}), lectureMap, notes, cards, questions, questionAt, issues, stats, ...(quality ? { quality } : {}) };
}

