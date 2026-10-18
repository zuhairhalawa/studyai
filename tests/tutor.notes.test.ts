import { describe, expect, it } from 'vitest';
import { pickNotes } from '../src/core/tutor/notes-context';
import type { NoteRow } from '../src/core/study/types';

const note = (id: string, title: string, blocks: { text: string; origin?: 'user' | 'ai' | 'imported' | 'auto' }[]): NoteRow => ({
  id,
  courseId: 'c',
  title,
  kind: 'custom',
  blocks: blocks.map((b, i) => ({ id: `${id}-${i}`, text: b.text, origin: b.origin ?? 'user', basis: 'uncertain', sources: [], updatedAt: 0 })),
  createdAt: 0,
  updatedAt: 0,
});

describe('which of my notes the tutor may see', () => {
  const notes = [
    note('a', 'Turing machines', [{ text: 'The tape is infinite. The head moves left or right.' }]),
    note('b', 'Graphs', [{ text: 'Breadth-first search uses a queue.' }]),
    note('c', 'Tape tricks', [{ text: 'My trick for remembering the tape.' }]),
  ];

  it('picks the notes that match the question, best first, and nothing unrelated', () => {
    const picked = pickNotes(notes, 'How does the head move along the tape?');
    expect(picked.map((n) => n.noteId)).toEqual(['a', 'c']);
    expect(pickNotes(notes, 'photosynthesis')).toEqual([]);
    expect(pickNotes(notes, 'a b')).toEqual([]); // words shorter than three letters carry no meaning
    expect(pickNotes(notes, '')).toEqual([]);
  });

  it('weights a title match above a text match and honours the limit', () => {
    expect(pickNotes(notes, 'tape', 1).map((n) => n.noteId)).toEqual(['c']);
    expect(pickNotes(notes, 'tape head queue', 2)).toHaveLength(2);
  });

  it('leaves out AI-written blocks and empty notes, and shortens very long notes', () => {
    const mixed = [
      note('x', 'Mixed', [{ text: 'my own words about reductions' }, { text: 'AI answer about reductions', origin: 'ai' }]),
      note('y', 'AI only', [{ text: 'reductions from the AI', origin: 'ai' }]),
      note('w', 'Imported pack', [{ text: 'reductions explained in an imported pack', origin: 'imported' }, { text: 'reductions auto-made', origin: 'auto' }]),
      note('z', 'Long reductions', [{ text: 'reductions '.repeat(1000) }]),
    ];
    const picked = pickNotes(mixed, 'reductions');
    expect(picked.map((n) => n.noteId).sort()).toEqual(['x', 'z']); // 'w' (imported and auto-made blocks) is not the student's own words
    expect(picked.find((n) => n.noteId === 'x')!.text).toBe('my own words about reductions');
    expect(picked.find((n) => n.noteId === 'z')!.text.endsWith('[…shortened]')).toBe(true);
    expect(picked.find((n) => n.noteId === 'z')!.text.length).toBeLessThan(3_100);
  });
});
