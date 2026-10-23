import { useCallback, useRef, useState } from 'react';
import { describePptxError } from '@/core/pptx';
import { getDb } from '@/core/db/db';
import { findDuplicates, findSameNamed, importLecture, replaceLecture } from '@/core/db/library';
import { newId } from '@/core/id';
import { isAcceptedFileName, parseFile, rejectionMessage } from './importer';

const db = getDb();

export type Choice = 'skip' | 'add' | 'replace';

export type Decision =
  | { kind: 'duplicate'; where: { lectureId: string; title: string; courseName: string }[] }
  | { kind: 'sameName'; existing: { lectureId: string; title: string; slides: number }; incoming: { slides: number } }
  | { kind: 'confirmReplace'; existing: { lectureId: string; title: string; slides: number }; incoming: { slides: number } };

export interface ImportItem {
  id: string;
  name: string;
  size: number;
  status: 'queued' | 'parsing' | 'decision' | 'saving' | 'done' | 'skipped' | 'error';
  progress?: { done: number; total: number };
  error?: string;
  decision?: Decision;
  result?: { lectureId: string; title: string; slides: number; attention: number; replaced: boolean };
}

interface Job {
  item: ImportItem;
  file: File;
  /** When set, the file replaces this lecture (after confirmation). */
  replaceLectureId?: string;
}

/** Sequential, cancellable-by-decision import queue for one course. */
export function useImporter(courseId: string | undefined) {
  const [items, setItems] = useState<ImportItem[]>([]);
  const waiting = useRef(new Map<string, (c: Choice) => void>());
  const chain = useRef(Promise.resolve());

  const patch = useCallback((id: string, p: Partial<ImportItem>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x))), []);

  const ask = useCallback(
    (id: string, decision: Decision) =>
      new Promise<Choice>((resolve) => {
        waiting.current.set(id, resolve);
        patch(id, { status: 'decision', decision });
      }),
    [patch],
  );

  const run = useCallback(
    async (job: Job) => {
      if (!courseId) return;
      const { item, file } = job;
      try {
        patch(item.id, { status: 'parsing', progress: { done: 0, total: 0 } });
        const { deck, bytes } = await parseFile(file, (done, total) => patch(item.id, { progress: { done, total } }));
        const attention = deck.report.slidesRequiringAttention.length;

        let choice: Choice = 'add';
        let target = job.replaceLectureId;
        if (target) {
          const existing = await db.lectures.get(target);
          if (!existing) throw new Error('The lecture to replace no longer exists.');
          choice = await ask(item.id, { kind: 'confirmReplace', existing: { lectureId: existing.id, title: existing.title, slides: existing.slideCount }, incoming: { slides: deck.slides.length } });
        } else {
          const dups = await findDuplicates(db, deck.fileHash);
          if (dups.length > 0) {
            choice = await ask(item.id, { kind: 'duplicate', where: dups.map((d) => ({ lectureId: d.lecture.id, title: d.lecture.title, courseName: d.course?.name ?? 'another course' })) });
          } else {
            const same = await findSameNamed(db, courseId, file.name);
            if (same) {
              choice = await ask(item.id, { kind: 'sameName', existing: { lectureId: same.id, title: same.title, slides: same.slideCount }, incoming: { slides: deck.slides.length } });
              if (choice === 'replace') target = same.id;
            }
          }
        }

        if (choice === 'skip') {
          patch(item.id, { status: 'skipped', decision: undefined });
          return;
        }
        patch(item.id, { status: 'saving', decision: undefined });
        const lecture =
          choice === 'replace' && target
            ? await replaceLecture(db, target, { fileName: file.name, bytes, deck })
            : await importLecture(db, { courseId, fileName: file.name, bytes, deck });
        patch(item.id, { status: 'done', result: { lectureId: lecture.id, title: lecture.title, slides: deck.slides.length, attention, replaced: choice === 'replace' } });
        // Ask the browser not to evict the library under storage pressure (best effort, free).
        void navigator.storage?.persist?.();
      } catch (err) {
        patch(item.id, { status: 'error', error: describePptxError(err), decision: undefined });
      }
    },
    [ask, courseId, patch],
  );

  const enqueue = useCallback(
    (files: File[], replaceLectureId?: string) => {
      const jobs: Job[] = files.map((file) => {
        const rejected = !isAcceptedFileName(file.name);
        const item: ImportItem = { id: newId(), name: file.name, size: file.size, status: rejected ? 'error' : 'queued', error: rejected ? rejectionMessage(file.name) : undefined };
        return { item, file, replaceLectureId };
      });
      setItems((xs) => [...xs, ...jobs.map((j) => j.item)]);
      for (const job of jobs) {
        if (job.item.status === 'error') continue;
        chain.current = chain.current.then(() => run(job));
      }
    },
    [run],
  );

  const decide = useCallback((id: string, choice: Choice) => {
    waiting.current.get(id)?.(choice);
    waiting.current.delete(id);
  }, []);

  const clearFinished = useCallback(() => setItems((xs) => xs.filter((x) => x.status === 'queued' || x.status === 'parsing' || x.status === 'decision' || x.status === 'saving')), []);

  const busy = items.some((x) => x.status === 'queued' || x.status === 'parsing' || x.status === 'saving' || x.status === 'decision');
  return { items, enqueue, decide, clearFinished, busy };
}
