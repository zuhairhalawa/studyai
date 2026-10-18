import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import { z } from 'zod';
import { BACKUP_TABLES, type CourseRow, type LectureRow, type SettingRow, type SlideRow, type StudyDB } from '../db/db';
import { courseSchema, lectureSchema, settingSchema, slideRowSchema } from '../db/schemas';
import { STUDY_TABLE_SCHEMAS, STUDY_TABLES, type StudyTable } from '../study/types';
import { withLimits } from '../pptx/limits';
import { ZipArchive } from '../pptx/zip';

/**
 * Whole-library backup as a single ZIP:
 *   manifest.json
 *   data/courses.json · data/lectures.json · data/settings.json
 *   data/slides/<lectureId>.json
 *   data/media/<lectureId>.json   (index: key, mime, entry name)
 *   media/<lectureId>/<n>.bin     (image bytes)
 *   files/<lectureId>.pptx        (original presentation)
 *
 * A backup is untrusted input. It is opened with the same hardened ZIP reader as
 * PPTX files, every JSON document is validated with zod, and *nothing is written
 * to the database until the entire archive has validated*.
 */

export const BACKUP_FORMAT = 'studyai-backup';
/**
 * Settings that belong to one device and are never exported or restored: the consent to send text to an AI service must be
 * given again on every device, so a restored (or doctored) backup can never pre-approve anything.
 */
const DEVICE_ONLY_SETTINGS: ReadonlySet<string> = new Set(['aiConsentAt']);

/** v1: courses/lectures/slides/media/files/settings. v2 adds the learning-engine tables (notes, cards, …). */
export const BACKUP_VERSION = 3;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int(),
  createdAt: z.string(),
  app: z.string().max(100),
  counts: z.object({ courses: z.number().int(), lectures: z.number().int(), slides: z.number().int(), media: z.number().int() }),
});
export type BackupManifest = z.infer<typeof manifestSchema>;

const mediaIndexSchema = z.array(z.object({ key: z.string().max(1_000), mime: z.string().max(100), entry: z.string().regex(/^media\/[A-Za-z0-9_-]{1,100}\/\d{1,6}\.bin$/) })).max(100_000);

/** Limits for opening a backup (larger than for a single PPTX: it holds many of them). */
const BACKUP_LIMITS = withLimits({
  maxFileBytes: 1536 * 1024 * 1024,
  maxEntries: 200_000,
  maxEntryBytes: 300 * 1024 * 1024,
  maxXmlBytes: 24 * 1024 * 1024,
  maxTotalBytes: 4096 * 1024 * 1024,
  maxCompressionRatio: 2_000,
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Collects ZIP output in Blobs so a large library never sits in one JS array. */
class BlobSink {
  private blobs: Blob[] = [];
  private buf: Uint8Array[] = [];
  private bufBytes = 0;

  push(chunk: Uint8Array): void {
    this.buf.push(chunk.slice());
    this.bufBytes += chunk.length;
    if (this.bufBytes >= 8 * 1024 * 1024) this.flush();
  }

  private flush(): void {
    if (this.buf.length === 0) return;
    this.blobs.push(new Blob(this.buf as unknown as BlobPart[]));
    this.buf = [];
    this.bufBytes = 0;
  }

  finish(): Blob {
    this.flush();
    return new Blob(this.blobs, { type: 'application/zip' });
  }
}

export interface ExportProgress {
  done: number;
  total: number;
  label: string;
}

export async function exportBackup(db: StudyDB, onProgress?: (p: ExportProgress) => void, appVersion = 'studyai'): Promise<Blob> {
  const [courses, lectures, allSettings] = await Promise.all([db.courses.toArray(), db.lectures.toArray(), db.settings.toArray()]);
  const settings = allSettings.filter((s) => !DEVICE_ONLY_SETTINGS.has(s.key));
  const sink = new BlobSink();
  let failure: unknown;
  let finished = false;
  const zip = new Zip((err, chunk, final) => {
    if (err) failure = err;
    else sink.push(chunk);
    if (final) finished = true;
  });

  const addJson = (name: string, value: unknown) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(strToU8(JSON.stringify(value)), true);
  };
  const addBlob = async (name: string, blob: Blob) => {
    const f = new ZipPassThrough(name);
    zip.add(f);
    const reader = blob.stream().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      f.push(value, false);
    }
    f.push(new Uint8Array(0), true);
  };

  const total = lectures.length + 1;
  let slideTotal = 0;
  let mediaTotal = 0;
  // Counts first (cheap) so the manifest can be written first.
  for (const l of lectures) {
    slideTotal += await db.slides.where('lectureId').equals(l.id).count();
    mediaTotal += await db.media.where('lectureId').equals(l.id).count();
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    app: appVersion,
    counts: { courses: courses.length, lectures: lectures.length, slides: slideTotal, media: mediaTotal },
  };
  addJson('manifest.json', manifest);
  addJson('data/courses.json', courses);
  addJson('data/lectures.json', lectures);
  addJson('data/settings.json', settings);
  for (const t of STUDY_TABLES) {
    const rows = await db.table(t).toArray();
    if (rows.length > 0) addJson(`data/${t}.json`, rows);
  }
  onProgress?.({ done: 1, total, label: 'Library index' });

  let n = 1;
  for (const l of lectures) {
    const slides = await db.slides.where('lectureId').equals(l.id).toArray();
    addJson(`data/slides/${l.id}.json`, slides);
    const media = await db.media.where('lectureId').equals(l.id).toArray();
    const index = media.map((m, i) => ({ key: m.key, mime: m.mime, entry: `media/${l.id}/${i}.bin` }));
    addJson(`data/media/${l.id}.json`, index);
    for (let i = 0; i < media.length; i++) await addBlob(index[i]!.entry, media[i]!.blob);
    const file = await db.files.get(l.id);
    if (file) await addBlob(`files/${l.id}.pptx`, file.blob);
    n += 1;
    onProgress?.({ done: n, total, label: l.title });
    if (failure) throw failure;
  }

  zip.end();
  if (failure) throw failure;
  if (!finished) throw new BackupError('Backup could not be finalised.');
  return sink.finish();
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ParsedBackup {
  manifest: BackupManifest;
  courses: CourseRow[];
  lectures: LectureRow[];
  settings: SettingRow[];
  /** Rows of the learning-engine tables (validated); absent tables are simply empty. */
  study: Partial<Record<StudyTable, Record<string, unknown>[]>>;
  slidesByLecture: Map<string, SlideRow[]>;
  mediaIndex: Map<string, z.infer<typeof mediaIndexSchema>>;
  filesPresent: Set<string>;
  zip: ZipArchive;
  warnings: string[];
}

function readJson(zip: ZipArchive, name: string): unknown {
  if (!zip.has(name)) throw new BackupError(`The backup is missing "${name}".`);
  try {
    return JSON.parse(new TextDecoder().decode(zip.read(name)));
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError(`"${name}" in the backup is damaged (${err instanceof Error ? err.message : 'unreadable'}).`);
  }
}

function validate<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new BackupError(`The backup contains invalid ${what}${issue ? ` (${issue.path.join('.') || 'root'}: ${issue.message})` : ''}.`);
  }
  return r.data;
}

/** Open and fully validate a backup. Throws BackupError on anything suspicious; touches no database. */
export function readBackup(bytes: Uint8Array): ParsedBackup {
  let zip: ZipArchive;
  try {
    zip = new ZipArchive(bytes, BACKUP_LIMITS);
  } catch (err) {
    throw new BackupError(`This is not a readable StudyAI backup (${err instanceof Error ? err.message : 'unknown error'}).`);
  }
  const manifest = validate(manifestSchema, readJson(zip, 'manifest.json'), 'manifest');
  if (manifest.version > BACKUP_VERSION) {
    throw new BackupError(`This backup was made by a newer version of StudyAI (format ${manifest.version}); update the app first.`);
  }
  const courses = validate(z.array(courseSchema).max(10_000), readJson(zip, 'data/courses.json'), 'courses') as CourseRow[];
  const lectures = validate(z.array(lectureSchema).max(100_000), readJson(zip, 'data/lectures.json'), 'lectures') as LectureRow[];
  const settings = (validate(z.array(settingSchema).max(10_000), readJson(zip, 'data/settings.json'), 'settings') as SettingRow[]).filter((s) => !DEVICE_ONLY_SETTINGS.has(s.key));

  const courseIds = new Set(courses.map((c) => c.id));
  if (courseIds.size !== courses.length) throw new BackupError('The backup contains duplicate course ids.');
  const lectureIds = new Set(lectures.map((l) => l.id));
  if (lectureIds.size !== lectures.length) throw new BackupError('The backup contains duplicate lecture ids.');

  const study: ParsedBackup['study'] = {};
  for (const t of STUDY_TABLES) {
    const name = `data/${t}.json`;
    if (!zip.has(name)) continue;
    const rows = validate(z.array(STUDY_TABLE_SCHEMAS[t]).max(500_000), readJson(zip, name), t) as Record<string, unknown>[];
    for (const r of rows) {
      const cid = r['courseId'];
      if (typeof cid === 'string' && !courseIds.has(cid)) throw new BackupError(`The backup's ${t} refer to a course that is not in the backup.`);
    }
    study[t] = rows;
  }

  const warnings: string[] = [];
  const slidesByLecture = new Map<string, SlideRow[]>();
  const mediaIndex = new Map<string, z.infer<typeof mediaIndexSchema>>();
  const filesPresent = new Set<string>();
  for (const l of lectures) {
    if (!courseIds.has(l.courseId)) throw new BackupError(`Lecture "${l.title}" refers to a course that is not in the backup.`);
    const slides = validate(z.array(slideRowSchema).max(5_000), readJson(zip, `data/slides/${l.id}.json`), `slides of "${l.title}"`) as SlideRow[];
    if (slides.some((s) => s.lectureId !== l.id)) throw new BackupError(`Slides of "${l.title}" belong to a different lecture.`);
    if (new Set(slides.map((s) => s.index)).size !== slides.length) throw new BackupError(`Slides of "${l.title}" contain duplicate positions.`);
    if (slides.length !== l.slideCount) warnings.push(`"${l.title}" lists ${l.slideCount} slides but the backup holds ${slides.length}.`);
    slidesByLecture.set(l.id, slides);
    const index = validate(mediaIndexSchema, readJson(zip, `data/media/${l.id}.json`), `media index of "${l.title}"`);
    for (const m of index) {
      if (!m.entry.startsWith(`media/${l.id}/`) || !zip.has(m.entry)) throw new BackupError(`An image of "${l.title}" is missing from the backup.`);
    }
    mediaIndex.set(l.id, index);
    if (zip.has(`files/${l.id}.pptx`)) filesPresent.add(l.id);
    else warnings.push(`The original PowerPoint file of "${l.title}" is not in the backup (re-import will not be possible).`);
  }
  return { manifest, courses, lectures, settings, study, slidesByLecture, mediaIndex, filesPresent, zip, warnings };
}

export type ImportMode = 'merge' | 'replace';

export interface ImportSummary {
  coursesAdded: number;
  coursesUpdated: number;
  lecturesAdded: number;
  lecturesReplaced: number;
  lecturesSkipped: number;
  slides: number;
  media: number;
  /** Learning-engine rows written (notes, cards, questions, …). */
  studyRows: number;
}

/** Write a validated backup into the database. */
export async function applyBackup(db: StudyDB, backup: ParsedBackup, mode: ImportMode): Promise<ImportSummary> {
  const summary: ImportSummary = { coursesAdded: 0, coursesUpdated: 0, lecturesAdded: 0, lecturesReplaced: 0, lecturesSkipped: 0, slides: 0, media: 0, studyRows: 0 };

  const writeLecture = async (l: LectureRow) => {
    const slides = backup.slidesByLecture.get(l.id) ?? [];
    await db.slides.where('lectureId').equals(l.id).delete();
    await db.media.where('lectureId').equals(l.id).delete();
    await db.slides.bulkAdd(slides);
    const media = (backup.mediaIndex.get(l.id) ?? []).map((m) => ({
      id: `${l.id}|${m.key}`,
      lectureId: l.id,
      key: m.key,
      mime: m.mime,
      blob: new Blob([backup.zip.read(m.entry) as unknown as BlobPart], { type: m.mime }),
    }));
    await db.media.bulkAdd(media);
    if (backup.filesPresent.has(l.id)) {
      await db.files.put({ lectureId: l.id, name: l.fileName, blob: new Blob([backup.zip.read(`files/${l.id}.pptx`) as unknown as BlobPart]) });
    }
    await db.lectures.put(l);
    summary.slides += slides.length;
    summary.media += media.length;
  };

  await db.transaction('rw', db.tables, async () => {
    if (mode === 'replace') {
      await Promise.all([...BACKUP_TABLES, ...STUDY_TABLES].map((t) => db.table(t).clear()));
      await db.media.clear();
      await db.files.clear();
    }
    const existingCourses = new Map((await db.courses.toArray()).map((c) => [c.id, c]));
    for (const c of backup.courses) {
      const have = existingCourses.get(c.id);
      if (!have) {
        await db.courses.put(c);
        summary.coursesAdded += 1;
      } else if (c.updatedAt > have.updatedAt) {
        await db.courses.put(c);
        summary.coursesUpdated += 1;
      }
    }
    const existingLectures = new Map((await db.lectures.toArray()).map((l) => [l.id, l]));
    for (const l of backup.lectures) {
      const have = existingLectures.get(l.id);
      if (!have) {
        await writeLecture(l);
        summary.lecturesAdded += 1;
      } else if (l.revision > have.revision || (l.revision === have.revision && l.updatedAt > have.updatedAt)) {
        await writeLecture(l);
        summary.lecturesReplaced += 1;
      } else {
        summary.lecturesSkipped += 1;
      }
    }
    for (const s of backup.settings) {
      if (mode === 'replace' || !(await db.settings.get(s.key))) await db.settings.put(s);
    }
    // Learning-engine rows. Items you can edit (notes, cards, questions) follow "newer wins";
    // sessions and history (reviews, exams, attempts, packs) are added when missing and never overwritten;
    // activity is only restored by "replace" (its ids are local counters).
    for (const t of STUDY_TABLES) {
      const rows = backup.study[t] ?? [];
      if (rows.length === 0) continue;
      const table = db.table(t);
      if (t === 'activity') {
        if (mode === 'replace') {
          await table.bulkAdd(rows);
          summary.studyRows += rows.length;
        }
        continue;
      }
      const editable = t === 'notes' || t === 'cards' || t === 'questions';
      for (const r of rows) {
        const have = (await table.get(r['id'] as string)) as { updatedAt?: number } | undefined;
        if (!have || (editable && (r['updatedAt'] as number) > (have.updatedAt ?? 0))) {
          await table.put(r);
          summary.studyRows += 1;
        }
      }
    }
  });
  return summary;
}
