import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Printer } from 'lucide-react';
import { getDb } from '@/core/db/db';
import type { QuestionRow } from '@/core/study/types';
import { QUESTION_TYPE_LABEL } from '@/core/study/types';
import { LazyMarkdown } from '@/ui/LazyMarkdown';
import { Solution } from '@/ui/study/exam-ui';
import { Button, Spinner } from '@/ui/primitives';
import { NotFound } from './NotFound';

const db = getDb();

/** Question paper for printing or saving as PDF (use the browser's print dialog). Optionally includes the marking scheme. */
export function ExamPaperPage() {
  const { examId } = useParams();
  const exam = useLiveQuery(async () => (examId ? ((await db.exams.get(examId)) ?? null) : null), [examId]);
  const raw = useLiveQuery(async () => (exam ? await db.questions.bulkGet(exam.questionIds) : undefined), [exam?.id]);
  const course = useLiveQuery(async () => (exam ? await db.courses.get(exam.courseId) : undefined), [exam?.courseId]);
  const [scheme, setScheme] = useState(false);
  const questions = useMemo(() => (raw ?? []).filter((q): q is QuestionRow => !!q), [raw]);

  if (exam === null) return <NotFound what="exam" />;
  if (!exam || !raw || !course) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }
  const total = questions.reduce((n, q) => n + q.marks, 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6 print:max-w-none print:p-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link to={`/course/${course.id}/practice`} className="text-sm text-ink-2 hover:text-ink">
          Back to practice
        </Link>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={scheme} onChange={(e) => setScheme(e.target.checked)} />
            Include marking scheme
          </label>
          <Button variant="primary" onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> Print or save as PDF
          </Button>
        </div>
      </div>

      <article className="bg-surface p-6 print:bg-white print:p-0 print:text-black">
        <header className="border-b border-rule pb-4">
          <p className="text-sm text-ink-3">{course.code ? `${course.code}, ` : ''}{course.name}</p>
          <h1 className="text-2xl font-semibold">{exam.config.title}</h1>
          <p className="mt-1 text-sm text-ink-2">
            Total marks: {total}
            {exam.config.minutes ? `. Time allowed: ${exam.config.minutes} minutes` : ''}. Answer all questions.
          </p>
          {scheme && <p className="mt-1 text-sm font-medium">Marking scheme included.</p>}
        </header>
        <ol className="mt-5 flex flex-col gap-7">
          {questions.map((q, i) => (
            <li key={q.id} className="print:break-inside-avoid">
              <div className="flex items-baseline justify-between gap-4">
                <p className="font-semibold">
                  {i + 1}. <span className="text-sm font-normal text-ink-3">{QUESTION_TYPE_LABEL[q.type]}</span>
                </p>
                <p className="shrink-0 text-sm">[{q.marks} mark{q.marks === 1 ? '' : 's'}]</p>
              </div>
              <div className="mt-1">
                <LazyMarkdown>{q.prompt}</LazyMarkdown>
              </div>
              {q.options ? (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {q.options.map((o) => (
                    <li key={o.id} className="flex gap-3">
                      <span className="mt-1 inline-block size-4 shrink-0 rounded-sm border border-ink-2" aria-hidden />
                      <span className="min-w-0">
                        <LazyMarkdown>{o.text}</LazyMarkdown>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mt-3 flex flex-col" aria-hidden>
                  {Array.from({ length: Math.min(16, Math.max(3, Math.round((q.expectedWords?.[1] ?? q.marks * 25) / 14))) }).map((_, k) => (
                    <div key={k} className="h-7 border-b border-rule-strong" />
                  ))}
                </div>
              )}
              {scheme && (
                <div className="mt-3 rounded border border-rule p-3 text-sm">
                  <Solution q={q} />
                </div>
              )}
            </li>
          ))}
        </ol>
      </article>
    </div>
  );
}
