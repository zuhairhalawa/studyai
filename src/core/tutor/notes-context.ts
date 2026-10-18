import type { NoteRow } from '../study/types';

/**
 * Chooses which of the student's OWN notes to offer the tutor as extra context. Notes are the student's words, not the
 * professor's slides, and are labelled that way to the model. Only blocks the student wrote themselves are offered: imported
 * packs, generated material and AI answers are left out, so the tutor never reads other text back as if it were the student's.
 */
export interface NoteContext {
  noteId: string;
  title: string;
  text: string;
}

const MAX_NOTE_CHARS = 3_000;

const words = (s: string): string[] => [...new Set(s.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))];

export function pickNotes(notes: readonly NoteRow[], question: string, limit = 3): NoteContext[] {
  const terms = words(question);
  if (terms.length === 0) return [];
  const scored: { n: NoteContext; score: number }[] = [];
  for (const note of notes) {
    const text = note.blocks
      .filter((b) => b.origin === 'user' && b.text.trim())
      .map((b) => b.text.trim())
      .join('\n\n');
    if (!text) continue;
    const title = note.title.toLowerCase();
    const body = text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 2;
      if (body.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ n: { noteId: note.id, title: note.title, text: text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS)}\n[…shortened]` : text }, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.n);
}
