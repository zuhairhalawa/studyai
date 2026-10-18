import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { BackupError, BACKUP_VERSION, applyBackup, exportBackup, readBackup } from '../src/core/backup/backup';
import { StudyDB } from '../src/core/db/db';
import { createCourse, importLecture, loadMedia, loadSlides, replaceLecture } from '../src/core/db/library';
import { parsePptx } from '../src/core/pptx';
import { PNG_1X1, buildPptx, picture, simpleSlide, titleSp, type DeckSpec } from './fixtures/pptx-builder';
import { craftZip, deflatedEntry } from './helpers/zipcraft';

let db: StudyDB;
let n = 0;
beforeEach(() => {
  db = new StudyDB(`bk-${Date.now()}-${n++}`);
});

const withImage: DeckSpec = {
  slides: [
    simpleSlide('Intro', ['hello'], 'a note'),
    {
      shapes: titleSp(2, 'Diagram') + picture(4, 'rIdImg1', 500000, 1500000, 3000000, 2000000, 'A diagram'),
      rels: { rIdImg1: ['image', '../media/image1.png'] },
      parts: { 'ppt/media/image1.png': PNG_1X1 },
    },
  ],
};

async function seed(target: StudyDB) {
  const course = await createCourse(target, { name: 'Security', code: 'CS450' });
  const bytes = buildPptx(withImage);
  const deck = await parsePptx(bytes);
  const lecture = await importLecture(target, { courseId: course.id, fileName: 'lec1.pptx', bytes, deck });
  await target.settings.put({ key: 'theme', value: 'dark' });
  return { course, lecture, bytes };
}

async function exportBytes(source: StudyDB): Promise<Uint8Array> {
  return new Uint8Array(await (await exportBackup(source)).arrayBuffer());
}

describe('backup export / import', () => {
  it('round-trips the entire library byte-for-byte', async () => {
    const { course, lecture, bytes } = await seed(db);
    const zipBytes = await exportBytes(db);
    const names = Object.keys(unzipSync(zipBytes));
    expect(names).toEqual(
      expect.arrayContaining(['manifest.json', 'data/courses.json', 'data/lectures.json', 'data/settings.json', `data/slides/${lecture.id}.json`, `files/${lecture.id}.pptx`, `media/${lecture.id}/0.bin`]),
    );

    const parsed = readBackup(zipBytes);
    expect(parsed.manifest).toMatchObject({ format: 'studyai-backup', version: BACKUP_VERSION, counts: { courses: 1, lectures: 1, slides: 2, media: 1 } });
    expect(parsed.warnings).toEqual([]);

    const fresh = new StudyDB(`bk-restore-${Date.now()}-${n++}`);
    const summary = await applyBackup(fresh, parsed, 'replace');
    expect(summary).toMatchObject({ coursesAdded: 1, lecturesAdded: 1, slides: 2, media: 1 });

    expect(await fresh.courses.toArray()).toEqual(await db.courses.toArray());
    expect(await fresh.lectures.toArray()).toEqual(await db.lectures.toArray());
    expect(await loadSlides(fresh, lecture.id)).toEqual(await loadSlides(db, lecture.id));
    expect(await fresh.settings.toArray()).toEqual([{ key: 'theme', value: 'dark' }]);
    const media = await loadMedia(fresh, lecture.id);
    expect(new Uint8Array(await media.get('ppt/media/image1.png')!.blob.arrayBuffer())).toEqual(PNG_1X1);
    expect(media.get('ppt/media/image1.png')!.mime).toBe('image/png');
    expect(new Uint8Array(await (await fresh.files.get(lecture.id))!.blob.arrayBuffer())).toEqual(bytes);
    expect(course.name).toBe('Security');
  });

  it('never carries the consent to send text to an AI service, even in a doctored backup', async () => {
    await seed(db);
    await db.settings.put({ key: 'aiConsentAt', value: '2026-10-16T10:00:00.000Z' });
    const zipBytes = await exportBytes(db);
    const files = unzipSync(zipBytes);
    expect(JSON.parse(strFromU8(files['data/settings.json']!))).toEqual([{ key: 'theme', value: 'dark' }]); // not exported
    // someone adds a pre-made consent to the backup file: it is ignored on restore
    const doctored = { ...files, 'data/settings.json': strToU8(JSON.stringify([{ key: 'theme', value: 'dark' }, { key: 'aiConsentAt', value: '2026-10-16T10:00:00.000Z' }])) };
    const parsed = readBackup(zipSync(doctored));
    expect(parsed.settings).toEqual([{ key: 'theme', value: 'dark' }]);
    const fresh = new StudyDB(`bk-consent-${n++}`);
    await applyBackup(fresh, parsed, 'replace');
    expect(await fresh.settings.get('aiConsentAt')).toBeUndefined();
  });

  it('survives an empty library', async () => {
    const parsed = readBackup(await exportBytes(db));
    expect(parsed.manifest.counts).toMatchObject({ courses: 0, lectures: 0 });
    expect(await applyBackup(new StudyDB(`bk-e-${n++}`), parsed, 'replace')).toMatchObject({ coursesAdded: 0, lecturesAdded: 0 });
  });

  it('merge keeps newer local data, upgrades older data and adds new items', async () => {
    const { course, lecture } = await seed(db);
    const backup = readBackup(await exportBytes(db));

    // Local library has since moved on: lecture re-imported (revision 2), a second course added.
    const edited = await parsePptx(buildPptx({ slides: [simpleSlide('Edited locally', ['x'])] }));
    await replaceLecture(db, lecture.id, { fileName: 'lec1.pptx', bytes: buildPptx({ slides: [simpleSlide('Edited locally', ['x'])] }), deck: edited });
    const extra = await createCourse(db, { name: 'Extra' });

    const merged = await applyBackup(db, backup, 'merge');
    expect(merged).toMatchObject({ coursesAdded: 0, lecturesAdded: 0, lecturesSkipped: 1, lecturesReplaced: 0 });
    expect((await loadSlides(db, lecture.id)).map((s) => s.title)).toEqual(['Edited locally']); // newer local version kept
    expect(await db.courses.get(extra.id)).toBeDefined();

    // Now the reverse: restore an *older* local state from a newer backup.
    const newer = readBackup(await exportBytes(db));
    const older = new StudyDB(`bk-old-${n++}`);
    await applyBackup(older, backup, 'replace'); // revision 1
    const upgraded = await applyBackup(older, newer, 'merge');
    expect(upgraded).toMatchObject({ lecturesReplaced: 1, coursesAdded: 1 });
    expect((await loadSlides(older, lecture.id)).map((s) => s.title)).toEqual(['Edited locally']);
    expect(await older.courses.get(course.id)).toBeDefined();
  });

  it('replace mode discards existing data only after the backup validated', async () => {
    await seed(db);
    const before = await db.lectures.count();
    const bad = zipSync({ 'manifest.json': strToU8('{"format":"nope"}') });
    expect(() => readBackup(bad)).toThrow(BackupError);
    expect(await db.lectures.count()).toBe(before);
    expect(await db.courses.count()).toBe(1);
  });
});

describe('backup validation (untrusted input)', () => {
  const rewrite = async (edit: (files: Record<string, Uint8Array>, ids: { lectureId: string }) => void) => {
    const { lecture } = await seed(db);
    const files = unzipSync(await exportBytes(db));
    edit(files, { lectureId: lecture.id });
    return zipSync(files);
  };
  const expectRejected = (bytes: Uint8Array, message: RegExp) => {
    try {
      readBackup(bytes);
    } catch (e) {
      expect(e).toBeInstanceOf(BackupError);
      expect((e as Error).message).toMatch(message);
      return;
    }
    throw new Error('backup was accepted');
  };

  it('rejects things that are not backups', () => {
    expectRejected(strToU8('definitely not a zip file, but long enough to look at'), /not a readable StudyAI backup/);
    expectRejected(zipSync({ 'hello.txt': strToU8('hi') }), /missing "manifest.json"/);
    expectRejected(zipSync({ 'manifest.json': strToU8('{ broken json') }), /damaged/);
  });

  it('rejects backups from a newer format version', async () => {
    const bytes = await rewrite((f) => {
      const m = JSON.parse(strFromU8(f['manifest.json']!));
      m.version = BACKUP_VERSION + 1;
      f['manifest.json'] = strToU8(JSON.stringify(m));
    });
    expectRejected(bytes, /newer version/);
  });

  it('rejects structurally invalid records', async () => {
    const bytes = await rewrite((f) => {
      const c = JSON.parse(strFromU8(f['data/courses.json']!));
      c[0].color = 999;
      f['data/courses.json'] = strToU8(JSON.stringify(c));
    });
    expectRejected(bytes, /invalid courses/);
  });

  it('rejects ids that could escape the archive layout', async () => {
    const bytes = await rewrite((f) => {
      const c = JSON.parse(strFromU8(f['data/courses.json']!));
      c[0].id = '../../evil';
      f['data/courses.json'] = strToU8(JSON.stringify(c));
    });
    expectRejected(bytes, /invalid courses/);
  });

  it('rejects slide content that could inject CSS or script-bearing links', async () => {
    const mutate = (edit: (slide: Record<string, any>) => void) =>
      rewrite((f, { lectureId }) => {
        const key = `data/slides/${lectureId}.json`;
        const slides = JSON.parse(strFromU8(f[key]!));
        edit(slides[0]);
        f[key] = strToU8(JSON.stringify(slides));
      });
    expectRejected(
      await mutate((s) => {
        s.elements[0].fill = 'red; background:url(https://evil.example/x)';
      }),
      /invalid slides/,
    );
    expectRejected(
      await mutate((s) => {
        s.elements[1].paragraphs[0].inlines[0].link = 'javascript:alert(1)';
      }),
      /invalid slides/,
    );
  });

  it('rejects references that do not exist in the archive', async () => {
    expectRejected(
      await rewrite((f, { lectureId }) => {
        delete f[`data/slides/${lectureId}.json`];
      }),
      /missing "data\/slides/,
    );
    expectRejected(
      await rewrite((f, { lectureId }) => {
        delete f[`media/${lectureId}/0.bin`];
      }),
      /image of .* is missing/,
    );
    expectRejected(
      await rewrite((f) => {
        const l = JSON.parse(strFromU8(f['data/lectures.json']!));
        l[0].courseId = 'ghost';
        f['data/lectures.json'] = strToU8(JSON.stringify(l));
      }),
      /course that is not in the backup/,
    );
  });

  it('warns (but still reads) when the original file is absent', async () => {
    const bytes = await rewrite((f, { lectureId }) => {
      delete f[`files/${lectureId}.pptx`];
    });
    expect(readBackup(bytes).warnings.join(' ')).toMatch(/original PowerPoint file/);
  });

  it('applies the same decompression-bomb protection as PPTX import', () => {
    const lying = craftZip([deflatedEntry('manifest.json', new Uint8Array(3 * 1024 * 1024).fill(32), { size: 10 })]);
    expectRejected(lying, /damaged|expands beyond|size/i);
  });
});
