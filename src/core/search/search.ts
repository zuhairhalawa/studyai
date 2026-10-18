import MiniSearch, { type SearchResult } from 'minisearch';
import type { StudyDB } from '../db/db';
import { displayTitle } from '../pptx/topics';
import type { SlideData } from '../pptx/model';

/**
 * Per-slide full-text search (title, body, tables, chart/diagram text, speaker notes)
 * with prefix and light fuzzy matching. This is also the first retrieval step before
 * any AI call: it picks the few relevant slides so whole decks are never sent.
 */

export interface SearchDoc {
  id: string;
  lectureId: string;
  courseId: string;
  slide: number;
  title: string;
  text: string;
  notes: string;
  lectureTitle: string;
  courseName: string;
}

export interface SnippetPart {
  text: string;
  hit: boolean;
}

export interface SearchHit {
  id: string;
  lectureId: string;
  courseId: string;
  slide: number;
  title: string;
  lectureTitle: string;
  courseName: string;
  score: number;
  /** Where the best match is found. */
  inNotes: boolean;
  snippet: SnippetPart[];
  terms: string[];
}

export interface SearchFilter {
  courseId?: string;
  lectureId?: string;
}

const norm = (t: string) => t.toLowerCase().normalize('NFKC');

export function makeSnippet(source: string, terms: string[], length = 200): SnippetPart[] {
  const flat = source.replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const lower = norm(flat);
  const needles = terms.map(norm).filter(Boolean);
  let first = -1;
  for (const n of needles) {
    const i = lower.indexOf(n);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  const start = first < 0 ? 0 : Math.max(0, first - Math.floor(length / 3));
  const end = Math.min(flat.length, start + length);
  const window = flat.slice(start, end);
  const lw = norm(window);
  if (lw.length !== window.length) return [{ text: window, hit: false }]; // normalisation changed offsets: skip highlighting
  const marks: [number, number][] = [];
  for (const n of needles) {
    let from = 0;
    for (;;) {
      const i = lw.indexOf(n, from);
      if (i < 0) break;
      marks.push([i, i + n.length]);
      from = i + n.length;
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([...m]);
  }
  const parts: SnippetPart[] = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) parts.push({ text: window.slice(pos, a), hit: false });
    parts.push({ text: window.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < window.length) parts.push({ text: window.slice(pos), hit: false });
  if (start > 0) parts.unshift({ text: '… ', hit: false });
  if (end < flat.length) parts.push({ text: ' …', hit: false });
  return parts;
}

export class SearchIndex {
  private ms = this.create();
  private idsByLecture = new Map<string, string[]>();
  private docs = new Map<string, SearchDoc>();

  private create(): MiniSearch<SearchDoc> {
    return new MiniSearch<SearchDoc>({
      fields: ['title', 'text', 'notes'],
      storeFields: ['lectureId', 'courseId'],
      processTerm: (term) => norm(term),
      searchOptions: { boost: { title: 3, notes: 0.7 }, prefix: true, fuzzy: (term) => (term.length > 5 ? 0.2 : false) },
    });
  }

  get size(): number {
    return this.docs.size;
  }

  addLecture(lecture: { id: string; courseId: string; title: string }, courseName: string, slides: SlideData[]): void {
    this.removeLecture(lecture.id);
    const docs: SearchDoc[] = slides.map((s) => ({
      id: `${lecture.id}:${s.index}`,
      lectureId: lecture.id,
      courseId: lecture.courseId,
      slide: s.index,
      title: displayTitle(s),
      text: s.text,
      notes: s.notes,
      lectureTitle: lecture.title,
      courseName,
    }));
    this.ms.addAll(docs);
    this.idsByLecture.set(lecture.id, docs.map((d) => d.id));
    for (const d of docs) this.docs.set(d.id, d);
  }

  removeLecture(lectureId: string): void {
    const ids = this.idsByLecture.get(lectureId);
    if (!ids) return;
    for (const id of ids) {
      if (this.ms.has(id)) this.ms.discard(id);
      this.docs.delete(id);
    }
    this.idsByLecture.delete(lectureId);
    this.ms.vacuum().catch(() => undefined);
  }

  clear(): void {
    this.ms = this.create();
    this.idsByLecture.clear();
    this.docs.clear();
  }

  /** (Re)build the whole index from the database. */
  async rebuild(db: StudyDB): Promise<void> {
    this.clear();
    const courses = new Map((await db.courses.toArray()).map((c) => [c.id, c.name]));
    for (const lecture of await db.lectures.toArray()) {
      const slides = await db.slides.where('lectureId').equals(lecture.id).toArray();
      this.addLecture(lecture, courses.get(lecture.courseId) ?? '', slides);
    }
  }

  search(query: string, filter: SearchFilter = {}, limit = 50): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const opts = {
      filter: (r: SearchResult) =>
        (!filter.courseId || r['courseId'] === filter.courseId) && (!filter.lectureId || r['lectureId'] === filter.lectureId),
    };
    let results = this.ms.search(q, { ...opts, combineWith: 'AND' });
    if (results.length < 3) results = this.ms.search(q, { ...opts, combineWith: 'OR' });
    return results.slice(0, limit).flatMap((r) => {
      const doc = this.docs.get(String(r.id));
      if (!doc) return [];
      const terms = r.queryTerms.length > 0 ? r.queryTerms : q.split(/\s+/);
      const matchedFields = new Set(Object.values(r.match).flat());
      const inNotes = matchedFields.has('notes') && !matchedFields.has('text') && !matchedFields.has('title');
      return [
        {
          id: doc.id,
          lectureId: doc.lectureId,
          courseId: doc.courseId,
          slide: doc.slide,
          title: doc.title,
          lectureTitle: doc.lectureTitle,
          courseName: doc.courseName,
          score: r.score,
          inNotes,
          snippet: makeSnippet(inNotes ? doc.notes : doc.text || doc.title, terms),
          terms,
        },
      ];
    });
  }
}
