import Dexie, { type EntityTable } from 'dexie';
import type { DeckMeta, ExtractionReport, SlideData } from '../pptx/model';
import type { ActivityRow, AttemptRow, CardRow, ExamRow, NoteRow, PackRow, QuestionRow, ReviewLogRow, TutorMessageRow, TutorSessionRow } from '../study/types';

export interface CourseRow {
  id: string;
  name: string;
  code?: string;
  /** Index into the UI accent palette. */
  color: number;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** ISO date (YYYY-MM-DD). */
  examDate?: string;
  goal?: string;
  /** Professor / exam-format instructions, e.g. "Answers must come strictly from the slides". */
  examStyle?: string;
  order: number;
}

export interface LectureRow {
  id: string;
  courseId: string;
  title: string;
  order: number;
  fileName: string;
  fileHash: string;
  fileSize: number;
  importedAt: number;
  updatedAt: number;
  /** Incremented on every re-import so dependent data can detect staleness. */
  revision: number;
  slideCount: number;
  meta: DeckMeta;
  report: ExtractionReport;
}

export type SlideRow = SlideData & { lectureId: string };

export interface MediaRow {
  /** `${lectureId}|${partName}` */
  id: string;
  lectureId: string;
  key: string;
  mime: string;
  blob: Blob;
}

export interface FileRow {
  lectureId: string;
  name: string;
  blob: Blob;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

export class StudyDB extends Dexie {
  courses!: EntityTable<CourseRow, 'id'>;
  lectures!: EntityTable<LectureRow, 'id'>;
  slides!: Dexie.Table<SlideRow, [string, number]>;
  media!: EntityTable<MediaRow, 'id'>;
  files!: Dexie.Table<FileRow, string>;
  settings!: EntityTable<SettingRow, 'key'>;
  // schema v2: learning engine
  notes!: EntityTable<NoteRow, 'id'>;
  cards!: EntityTable<CardRow, 'id'>;
  reviews!: EntityTable<ReviewLogRow, 'id'>;
  questions!: EntityTable<QuestionRow, 'id'>;
  exams!: EntityTable<ExamRow, 'id'>;
  attempts!: EntityTable<AttemptRow, 'id'>;
  activity!: Dexie.Table<ActivityRow, number>;
  packs!: EntityTable<PackRow, 'id'>;
  // schema v3: AI tutor chats
  tutorSessions!: EntityTable<TutorSessionRow, 'id'>;
  tutorMessages!: EntityTable<TutorMessageRow, 'id'>;

  constructor(name = 'studyai') {
    super(name);
    this.version(1).stores({
      courses: 'id, order, archived',
      lectures: 'id, courseId, [courseId+order], fileHash',
      slides: '[lectureId+index], lectureId',
      media: 'id, lectureId',
      files: 'lectureId',
      settings: 'key',
    });
    // v2 adds tables only (additive): existing data is untouched.
    this.version(2).stores({
      notes: 'id, courseId, lectureId, packId',
      cards: 'id, courseId, lectureId, status, packId, fsrs.due',
      reviews: 'id, cardId, courseId, at',
      questions: 'id, courseId, status, packId',
      exams: 'id, courseId, createdAt',
      attempts: 'id, examId, courseId, status',
      activity: '++id, courseId, at',
      packs: 'id, courseId',
    });
    // v3 adds the tutor chat tables (additive).
    this.version(3).stores({
      tutorSessions: 'id, courseId, updatedAt',
      tutorMessages: 'id, sessionId, courseId, createdAt',
    });
  }
}

/** Tables that make up the portable library, in dependency order (used by backup/restore). */
export const BACKUP_TABLES = ['courses', 'lectures', 'slides', 'settings'] as const;

let shared: StudyDB | undefined;

/** The application's single database instance. */
export function getDb(): StudyDB {
  shared ??= new StudyDB();
  return shared;
}
