import { parseFile } from '@/app/importer';
import type { StudyDB } from '@/core/db/db';
import { createCourse, deleteCourse, importLecture } from '@/core/db/library';
import { planPack, type LectureContext } from '@/core/study/pack';
import { slideVerificationText } from '@/core/study/slide-text';
import { applyPackPlan } from '@/core/study/store';
import { SAMPLE_COURSE, SAMPLE_PACK, sampleLectures } from './sample-content';
import { SAMPLE_COURSE_SETTING } from './setting';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export interface LoadedSample {
  courseId: string;
  /** False when the course was already there. */
  created: boolean;
}

/**
 * Builds the invented lectures, reads them with the real PowerPoint engine (in the same worker a visitor's own file would use),
 * stores them, then imports the study material through the normal pack check, so every quote is looked up on its slide. The
 * demo approves the material up front: a real pack waits for the student's approval. Nothing leaves the browser.
 */
export async function loadSampleCourse(db: StudyDB): Promise<LoadedSample> {
  const known = (await db.settings.get(SAMPLE_COURSE_SETTING))?.value;
  if (typeof known === 'string' && (await db.courses.get(known))) return { courseId: known, created: false };

  const course = await createCourse(db, SAMPLE_COURSE);
  try {
    const contexts: LectureContext[] = [];
    for (const { fileName, bytes: built } of sampleLectures()) {
      const { deck, bytes } = await parseFile(new File([built as BlobPart], fileName, { type: PPTX_MIME }));
      const lecture = await importLecture(db, { courseId: course.id, fileName, bytes, deck });
      contexts.push({
        id: lecture.id,
        title: lecture.title,
        fileHash: lecture.fileHash,
        revision: lecture.revision,
        slideCount: lecture.slideCount,
        slideText: (n) => {
          const slide = deck.slides[n - 1];
          return slide ? slideVerificationText(slide) : undefined;
        },
      });
    }
    const plan = planPack(SAMPLE_PACK, course.id, contexts);
    if (plan.fatal || plan.stats.rejected > 0 || plan.stats.unverified > 0) throw new Error(plan.fatal ?? 'The sample study material did not pass its own checks.');
    await applyPackPlan(db, course.id, { ...plan, cards: plan.cards.map((c) => ({ ...c, status: 'approved' })), questions: plan.questions.map((q) => ({ ...q, status: 'approved' })) });
    await db.settings.put({ key: SAMPLE_COURSE_SETTING, value: course.id });
    return { courseId: course.id, created: true };
  } catch (err) {
    await deleteCourse(db, course.id); // never leave half a sample course behind
    throw err;
  }
}
