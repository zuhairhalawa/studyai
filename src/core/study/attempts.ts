import { newId } from '../id';
import type { StudyDB } from '../db/db';
import { autoGrade } from './exam';
import type { AnswerState, AttemptRow, ExamConfig, ExamRow, Grade, QuestionRow } from './types';

export async function createExam(db: StudyDB, courseId: string, config: ExamConfig, questionIds: string[], now = Date.now()): Promise<ExamRow> {
  if (questionIds.length === 0) throw new Error('An exam needs at least one question.');
  const row: ExamRow = { id: newId(), courseId, config, questionIds, createdAt: now };
  await db.exams.add(row);
  return row;
}

export async function startAttempt(db: StudyDB, examId: string, now = Date.now()): Promise<AttemptRow> {
  const exam = await db.exams.get(examId);
  if (!exam) throw new Error('Exam not found.');
  const row: AttemptRow = { id: newId(), examId, courseId: exam.courseId, startedAt: now, elapsedMs: 0, status: 'in-progress', answers: {}, grades: {}, flagged: [] };
  await db.attempts.add(row);
  return row;
}

async function mutate(db: StudyDB, attemptId: string, fn: (a: AttemptRow) => void): Promise<AttemptRow> {
  return db.transaction('rw', db.attempts, async () => {
    const a = await db.attempts.get(attemptId);
    if (!a) throw new Error('Attempt not found.');
    if (a.status === 'submitted') throw new Error('This attempt has already been submitted.');
    fn(a);
    await db.attempts.put(a);
    return a;
  });
}

/** Autosave an answer (called on every change, debounced by the UI). */
export function saveAnswer(db: StudyDB, attemptId: string, questionId: string, patch: Partial<AnswerState>): Promise<AttemptRow> {
  return mutate(db, attemptId, (a) => {
    a.answers[questionId] = { timeMs: 0, ...a.answers[questionId], ...patch };
  });
}

export function setElapsed(db: StudyDB, attemptId: string, elapsedMs: number): Promise<AttemptRow> {
  return mutate(db, attemptId, (a) => {
    a.elapsedMs = Math.max(a.elapsedMs, Math.round(elapsedMs));
  });
}

export function toggleFlag(db: StudyDB, attemptId: string, questionId: string): Promise<AttemptRow> {
  return mutate(db, attemptId, (a) => {
    a.flagged = a.flagged.includes(questionId) ? a.flagged.filter((x) => x !== questionId) : [...a.flagged, questionId];
  });
}

/** Submit: objective questions are marked immediately and exactly; written ones wait for marking. */
export async function submitAttempt(db: StudyDB, attemptId: string, questions: QuestionRow[], elapsedMs: number, now = Date.now()): Promise<AttemptRow> {
  const out = await mutate(db, attemptId, (a) => {
    a.status = 'submitted';
    a.submittedAt = now;
    a.elapsedMs = Math.max(a.elapsedMs, Math.round(elapsedMs));
    for (const q of questions) {
      const g = autoGrade(q, a.answers[q.id], now);
      if (g) a.grades[q.id] = g;
    }
  });
  return out;
}

/** Record a mark for one question after submission (self-marking). Allowed any time after submitting. */
export async function saveGrade(db: StudyDB, attemptId: string, questionId: string, grade: Grade): Promise<AttemptRow> {
  return db.transaction('rw', db.attempts, async () => {
    const a = await db.attempts.get(attemptId);
    if (!a) throw new Error('Attempt not found.');
    if (a.status !== 'submitted') throw new Error('Submit the exam before marking it.');
    a.grades[questionId] = grade;
    await db.attempts.put(a);
    return a;
  });
}

export async function deleteAttempt(db: StudyDB, attemptId: string): Promise<void> {
  await db.attempts.delete(attemptId);
}
