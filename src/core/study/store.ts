import { newId } from '../id';
import type { StudyDB } from '../db/db';
import { newSchedulerState, reviewCard, type Rating } from './fsrs';
import type { PackPlan } from './pack';
import type { Basis, CardRow, CardType, NoteBlock, NoteKind, NoteRow, Origin, QuestionRow, ReviewStatus, SourceRefRow } from './types';

// ---------------------------------------------------------------------------
// Study packs
// ---------------------------------------------------------------------------

/** Store everything a validated pack plan produced. Items arrive as "pending" for review. */
export async function applyPackPlan(db: StudyDB, courseId: string, plan: PackPlan, now = Date.now()): Promise<{ notes: number; cards: number; questions: number }> {
  if (plan.fatal) throw new Error(plan.fatal);
  await db.transaction('rw', [db.notes, db.cards, db.questions, db.packs], async () => {
    await db.packs.add({ id: plan.packId, courseId, name: plan.name, ...(plan.generator ? { generator: plan.generator } : {}), importedAt: now, counts: { notes: plan.notes.length, cards: plan.cards.length, questions: plan.questions.length } });
    await db.notes.bulkAdd(plan.notes);
    await db.cards.bulkAdd(plan.cards);
    await db.questions.bulkAdd(plan.questions);
  });
  return { notes: plan.notes.length, cards: plan.cards.length, questions: plan.questions.length };
}

/** Remove everything that came from one pack (only items you have not edited since import are *kept*: edited items lose their pack link when edited). */
export async function removePack(db: StudyDB, packId: string): Promise<{ notes: number; cards: number; questions: number }> {
  return db.transaction('rw', [db.notes, db.cards, db.questions, db.packs, db.reviews], async () => {
    const cards = await db.cards.where('packId').equals(packId).toArray();
    for (const c of cards) await db.reviews.where('cardId').equals(c.id).delete();
    const n = await db.notes.where('packId').equals(packId).delete();
    const c = await db.cards.where('packId').equals(packId).delete();
    const q = await db.questions.where('packId').equals(packId).delete();
    await db.packs.delete(packId);
    return { notes: n, cards: c, questions: q };
  });
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export interface NewCard {
  courseId: string;
  lectureId?: string;
  type: CardType;
  front: string;
  back: string;
  tags?: string[];
  deck?: string;
  basis?: Basis;
  sources?: SourceRefRow[];
  origin?: Origin;
  status?: ReviewStatus;
  packId?: string;
}

export async function createCard(db: StudyDB, input: NewCard, now = Date.now()): Promise<CardRow> {
  const front = input.front.trim();
  const back = input.back.trim();
  if (!front || !back) throw new Error('A card needs both a front and a back.');
  const row: CardRow = {
    id: newId(),
    courseId: input.courseId,
    ...(input.lectureId ? { lectureId: input.lectureId } : {}),
    type: input.type,
    front,
    back,
    tags: input.tags ?? [],
    ...(input.deck ? { deck: input.deck } : {}),
    basis: input.basis ?? 'uncertain',
    sources: input.sources ?? [],
    origin: input.origin ?? 'user',
    status: input.status ?? 'approved',
    createdAt: now,
    updatedAt: now,
    ...(input.packId ? { packId: input.packId } : {}),
    fsrs: newSchedulerState(now),
  };
  await db.cards.add(row);
  return row;
}

/** Edit a card. Editing detaches it from its import pack so "remove pack" can never delete your work. */
export async function updateCard(db: StudyDB, id: string, patch: Partial<Pick<CardRow, 'type' | 'front' | 'back' | 'tags' | 'deck' | 'basis' | 'sources' | 'lectureId'>>, now = Date.now()): Promise<void> {
  const have = await db.cards.get(id);
  if (!have) throw new Error('Card not found.');
  const next: CardRow = { ...have, ...patch, updatedAt: now };
  if ((patch.front !== undefined && !patch.front.trim()) || (patch.back !== undefined && !patch.back.trim())) throw new Error('A card needs both a front and a back.');
  if (patch.front !== undefined || patch.back !== undefined) delete next.packId;
  await db.cards.put(next);
}

export async function setCardStatus(db: StudyDB, ids: string[], status: ReviewStatus, now = Date.now()): Promise<void> {
  await db.transaction('rw', db.cards, async () => {
    for (const id of ids) await db.cards.update(id, { status, updatedAt: now });
  });
}

export async function deleteCards(db: StudyDB, ids: string[]): Promise<void> {
  await db.transaction('rw', [db.cards, db.reviews], async () => {
    for (const id of ids) await db.reviews.where('cardId').equals(id).delete();
    await db.cards.bulkDelete(ids);
  });
}

/** Forget a card's schedule so it is learned again from scratch. */
export async function resetCardSchedule(db: StudyDB, id: string, now = Date.now()): Promise<void> {
  await db.cards.update(id, { fsrs: newSchedulerState(now), updatedAt: now });
}

/** Record an answer: advance the FSRS schedule and append a review log, atomically. */
export async function answerCard(db: StudyDB, cardId: string, rating: Rating, durationMs: number, now = Date.now()): Promise<CardRow> {
  return db.transaction('rw', [db.cards, db.reviews], async () => {
    const card = await db.cards.get(cardId);
    if (!card) throw new Error('Card not found.');
    if (card.status !== 'approved') throw new Error('Only approved cards can be reviewed.');
    const next: CardRow = { ...card, fsrs: reviewCard(card.fsrs, rating, now) };
    await db.cards.put(next);
    await db.reviews.add({ id: newId(), cardId, courseId: card.courseId, at: now, rating, stateBefore: card.fsrs.state, durationMs: Math.max(0, Math.round(durationMs)) });
    return next;
  });
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function createNote(db: StudyDB, input: { courseId: string; lectureId?: string; title: string; kind?: NoteKind; blocks?: Omit<NoteBlock, 'id' | 'updatedAt'>[] }, now = Date.now()): Promise<NoteRow> {
  const title = input.title.trim();
  if (!title) throw new Error('A note needs a title.');
  const row: NoteRow = {
    id: newId(),
    courseId: input.courseId,
    ...(input.lectureId ? { lectureId: input.lectureId } : {}),
    title,
    kind: input.kind ?? 'custom',
    blocks: (input.blocks ?? []).map((b) => ({ ...b, id: newId(), updatedAt: now })),
    createdAt: now,
    updatedAt: now,
  };
  await db.notes.add(row);
  return row;
}

/**
 * Replace a note's text blocks. A block whose text you changed becomes yours ('user');
 * untouched generated blocks keep their origin, so edits are never confused with generated material.
 */
export async function saveNoteBlocks(db: StudyDB, noteId: string, blocks: NoteBlock[], now = Date.now()): Promise<void> {
  const have = await db.notes.get(noteId);
  if (!have) throw new Error('Note not found.');
  const before = new Map(have.blocks.map((b) => [b.id, b]));
  const next = blocks.map((b) => {
    const old = before.get(b.id);
    if (!old) return { ...b, origin: b.origin ?? 'user', updatedAt: now };
    if (old.text === b.text) return old;
    return { ...old, text: b.text, origin: 'user' as const, updatedAt: now };
  });
  const row: NoteRow = { ...have, blocks: next, updatedAt: now };
  delete row.packId; // edited by you: no longer removable together with its pack
  await db.notes.put(row);
}

export async function renameNote(db: StudyDB, id: string, title: string, now = Date.now()): Promise<void> {
  if (!title.trim()) throw new Error('A note needs a title.');
  await db.notes.update(id, { title: title.trim(), updatedAt: now });
}

export async function deleteNote(db: StudyDB, id: string): Promise<void> {
  await db.notes.delete(id);
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export async function saveQuestion(db: StudyDB, q: QuestionRow, now = Date.now()): Promise<QuestionRow> {
  if (!q.prompt.trim()) throw new Error('A question needs a prompt.');
  if (q.options && !q.options.some((o) => o.correct)) throw new Error('Mark at least one option as correct.');
  const row: QuestionRow = { ...q, updatedAt: now };
  delete row.packId;
  await db.questions.put(row);
  return row;
}

export async function setQuestionStatus(db: StudyDB, ids: string[], status: ReviewStatus, now = Date.now()): Promise<void> {
  await db.transaction('rw', db.questions, async () => {
    for (const id of ids) await db.questions.update(id, { status, updatedAt: now });
  });
}

export async function deleteQuestions(db: StudyDB, ids: string[]): Promise<void> {
  await db.questions.bulkDelete(ids);
}
