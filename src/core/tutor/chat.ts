import type { StudyDB } from '../db/db';
import { newId } from '../id';
import type { TutorMessageRow, TutorSessionRow } from '../study/types';
import { LIMITS, type TutorMode } from './contract';

/** Tutor conversations are stored only in this browser (and in your backups). The server keeps no chat history. */

export async function createSession(db: StudyDB, input: { courseId: string; title: string; mode: TutorMode }, now = Date.now()): Promise<TutorSessionRow> {
  const row: TutorSessionRow = { id: newId(), courseId: input.courseId, title: input.title.trim().slice(0, 300) || 'New chat', mode: input.mode, createdAt: now, updatedAt: now };
  await db.tutorSessions.add(row);
  return row;
}

export async function appendMessage(db: StudyDB, msg: Omit<TutorMessageRow, 'id' | 'createdAt'>, now = Date.now()): Promise<TutorMessageRow> {
  const row: TutorMessageRow = { ...msg, id: newId(), createdAt: now };
  await db.transaction('rw', [db.tutorMessages, db.tutorSessions], async () => {
    await db.tutorMessages.add(row);
    await db.tutorSessions.update(msg.sessionId, { updatedAt: now });
  });
  return row;
}

export async function deleteSession(db: StudyDB, id: string): Promise<void> {
  await db.transaction('rw', [db.tutorMessages, db.tutorSessions], async () => {
    await db.tutorMessages.where('sessionId').equals(id).delete();
    await db.tutorSessions.delete(id);
  });
}

export async function renameSession(db: StudyDB, id: string, title: string): Promise<void> {
  const t = title.trim().slice(0, 300);
  if (t) await db.tutorSessions.update(id, { title: t, updatedAt: Date.now() });
}

/** The most recent turns that fit the request limits, oldest first. Failed requests are not part of the conversation. */
export function toHistory(messages: readonly TutorMessageRow[]): { role: 'user' | 'assistant'; text: string }[] {
  const turns = messages.filter((m) => !m.error && m.text.trim()).map((m) => ({ role: m.role, text: m.text.slice(0, LIMITS.historyMessage) }));
  const picked: { role: 'user' | 'assistant'; text: string }[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0 && picked.length < LIMITS.historyMessages; i--) {
    const t = turns[i]!;
    if (total + t.text.length > LIMITS.historyTotal) break;
    total += t.text.length;
    picked.unshift(t);
  }
  return picked;
}
