import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { liveQuery } from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDb, type CourseRow, type LectureRow, type MediaRow, type SlideRow } from '@/core/db/db';
import { loadMedia, loadSlides } from '@/core/db/library';
import { SearchIndex, type SearchFilter, type SearchHit } from '@/core/search/search';

const db = getDb();

// ---------------------------------------------------------------------------
// Live data hooks (undefined while loading)
// ---------------------------------------------------------------------------

export const useCourses = (): CourseRow[] | undefined => useLiveQuery(() => db.courses.orderBy('order').toArray(), []);
export const useCourse = (id: string | undefined): CourseRow | null | undefined =>
  useLiveQuery(async () => (id ? ((await db.courses.get(id)) ?? null) : null), [id]);
export const useAllLectures = (): LectureRow[] | undefined => useLiveQuery(() => db.lectures.toArray(), []);
export const useLectures = (courseId: string | undefined): LectureRow[] | undefined =>
  useLiveQuery(async () => (courseId ? (await db.lectures.where('courseId').equals(courseId).toArray()).sort((a, b) => a.order - b.order) : []), [courseId]);
export const useLecture = (id: string | undefined): LectureRow | null | undefined =>
  useLiveQuery(async () => (id ? ((await db.lectures.get(id)) ?? null) : null), [id]);
export const useSlides = (lectureId: string | undefined, revision?: number): SlideRow[] | undefined =>
  useLiveQuery(async () => (lectureId ? loadSlides(db, lectureId) : []), [lectureId, revision]);

/** Object URLs for a lecture's images; revoked automatically. */
export function useMediaUrls(lectureId: string | undefined, revision?: number): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!lectureId) return;
    let cancelled = false;
    let created: string[] = [];
    void loadMedia(db, lectureId).then((rows: Map<string, MediaRow>) => {
      if (cancelled) return;
      const m = new Map<string, string>();
      for (const [key, row] of rows) {
        if (!/^image\/(png|jpeg|gif|bmp|webp|svg\+xml)$/.test(row.mime)) continue;
        const url = URL.createObjectURL(row.blob);
        created.push(url);
        m.set(key, url);
      }
      setUrls(m);
    });
    return () => {
      cancelled = true;
      for (const u of created) URL.revokeObjectURL(u);
      created = [];
      setUrls(new Map());
    };
  }, [lectureId, revision]);
  return urls;
}

// ---------------------------------------------------------------------------
// Settings stored in IndexedDB
// ---------------------------------------------------------------------------

export function useSetting<T>(key: string): [T | undefined, (v: T) => Promise<void>] {
  const row = useLiveQuery(() => db.settings.get(key), [key]);
  return [row?.value as T | undefined, async (v: T) => void (await db.settings.put({ key, value: v }))];
}

export interface LastViewed {
  lectureId: string;
  slide: number;
  at: number;
}

// ---------------------------------------------------------------------------
// Search provider: keeps the in-memory index in sync with the database
// ---------------------------------------------------------------------------

interface SearchApi {
  ready: boolean;
  /** Increments whenever the index changes (use to re-run searches). */
  version: number;
  search: (query: string, filter?: SearchFilter, limit?: number) => SearchHit[];
}

const SearchCtx = createContext<SearchApi>({ ready: false, version: 0, search: () => [] });
export const useSearch = (): SearchApi => useContext(SearchCtx);

export function SearchProvider({ children }: { children: ReactNode }) {
  const index = useMemo(() => new SearchIndex(), []);
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const signatures = useRef(new Map<string, string>());
  const chain = useRef(Promise.resolve());

  useEffect(() => {
    const sub = liveQuery(async () => ({ courses: await db.courses.toArray(), lectures: await db.lectures.toArray() })).subscribe({
      next: ({ courses, lectures }) => {
        // Serialise syncs so rapid changes cannot interleave.
        chain.current = chain.current.then(async () => {
          const names = new Map(courses.map((c) => [c.id, c.name]));
          const live = new Set(lectures.map((l) => l.id));
          let changed = false;
          for (const id of [...signatures.current.keys()]) {
            if (!live.has(id)) {
              index.removeLecture(id);
              signatures.current.delete(id);
              changed = true;
            }
          }
          for (const l of lectures) {
            const sig = `${l.revision}|${l.updatedAt}|${l.title}|${names.get(l.courseId) ?? ''}`;
            if (signatures.current.get(l.id) === sig) continue;
            const slides = await db.slides.where('lectureId').equals(l.id).toArray();
            index.addLecture(l, names.get(l.courseId) ?? '', slides);
            signatures.current.set(l.id, sig);
            changed = true;
          }
          if (changed) setVersion((v) => v + 1);
          setReady(true);
        });
      },
      error: () => setReady(true),
    });
    return () => sub.unsubscribe();
  }, [index]);

  const api = useMemo<SearchApi>(() => ({ ready, version, search: (q, f, n) => index.search(q, f, n) }), [index, ready, version]);
  return <SearchCtx.Provider value={api}>{children}</SearchCtx.Provider>;
}

// ---------------------------------------------------------------------------
// Learning-engine hooks
// ---------------------------------------------------------------------------

import type { ActivityRow, AttemptRow, CardRow, ExamRow, NoteRow, PackRow, QuestionRow, ReviewLogRow } from '@/core/study/types';

export const useCards = (courseId: string | undefined): CardRow[] | undefined => useLiveQuery(async () => (courseId ? db.cards.where('courseId').equals(courseId).toArray() : []), [courseId]);
export const useReviews = (courseId: string | undefined): ReviewLogRow[] | undefined => useLiveQuery(async () => (courseId ? db.reviews.where('courseId').equals(courseId).toArray() : []), [courseId]);
export const useNotes = (courseId: string | undefined): NoteRow[] | undefined => useLiveQuery(async () => (courseId ? db.notes.where('courseId').equals(courseId).toArray() : []), [courseId]);
export const useNote = (id: string | undefined): NoteRow | null | undefined => useLiveQuery(async () => (id ? ((await db.notes.get(id)) ?? null) : null), [id]);
export const useQuestions = (courseId: string | undefined): QuestionRow[] | undefined => useLiveQuery(async () => (courseId ? db.questions.where('courseId').equals(courseId).toArray() : []), [courseId]);
export const useExams = (courseId: string | undefined): ExamRow[] | undefined => useLiveQuery(async () => (courseId ? (await db.exams.where('courseId').equals(courseId).toArray()).sort((a, b) => b.createdAt - a.createdAt) : []), [courseId]);
export const useAttempts = (courseId: string | undefined): AttemptRow[] | undefined => useLiveQuery(async () => (courseId ? (await db.attempts.where('courseId').equals(courseId).toArray()).sort((a, b) => b.startedAt - a.startedAt) : []), [courseId]);
export const usePacks = (courseId: string | undefined): PackRow[] | undefined => useLiveQuery(async () => (courseId ? (await db.packs.where('courseId').equals(courseId).toArray()).sort((a, b) => b.importedAt - a.importedAt) : []), [courseId]);
export const useAllCards = (): CardRow[] | undefined => useLiveQuery(() => db.cards.toArray(), []);
export const useAllAttempts = (): AttemptRow[] | undefined => useLiveQuery(() => db.attempts.toArray(), []);
export const useAllReviews = (): ReviewLogRow[] | undefined => useLiveQuery(() => db.reviews.toArray(), []);
export const useActivity = (sinceMs: number): ActivityRow[] | undefined => useLiveQuery(() => db.activity.where('at').aboveOrEqual(sinceMs).toArray(), [sinceMs]);

export const useAllQuestions = (): QuestionRow[] | undefined => useLiveQuery(() => db.questions.toArray(), []);
export const useAllExams = (): ExamRow[] | undefined => useLiveQuery(() => db.exams.toArray(), []);

/** Slides viewed (long enough to count) per lecture, as a map lectureId → slide numbers. */
export const useAllViewed = (): Map<string, number[]> | undefined =>
  useLiveQuery(async () => {
    const rows = await db.settings.where('key').startsWith('viewed:').toArray();
    return new Map(rows.map((r) => [r.key.slice('viewed:'.length), Array.isArray(r.value) ? (r.value as number[]) : []]));
  }, []);

export const useViewed = (lectureId: string | undefined): number[] | undefined =>
  useLiveQuery(async () => {
    if (!lectureId) return [];
    const row = await db.settings.get(`viewed:${lectureId}`);
    return Array.isArray(row?.value) ? (row.value as number[]) : [];
  }, [lectureId]);
