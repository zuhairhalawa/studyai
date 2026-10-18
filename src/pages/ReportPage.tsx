import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { displayTitle } from '@/core/pptx/topics';
import { topicProgress } from '@/core/study/progress';
import { useCourse, useLecture, useSlides, useViewed } from '@/app/data';
import { ConfidencePill, formatBytes, SeverityIcon, Spinner } from '@/ui/primitives';
import { NotFound } from './NotFound';

type Filter = 'all' | 'check' | 'attention';

const SOURCE_LABEL = { section: 'PowerPoint sections', layout: 'section-header slides', title: 'slide titles' } as const;

export function ReportPage() {
  const { lectureId } = useParams();
  const lecture = useLecture(lectureId);
  const course = useCourse(lecture?.courseId);
  const slides = useSlides(lectureId, lecture?.revision);
  const [filter, setFilter] = useState<Filter>('check');
  const viewed = useViewed(lectureId);

  if (lecture === null) return <NotFound what="lecture" />;
  if (!lecture || !slides) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }
  const r = lecture.report;
  const shown = slides.filter((s) => (filter === 'all' ? true : filter === 'attention' ? s.confidence === 'low' : s.confidence !== 'high'));
  const stats: [string, number][] = [
    ['Slides', r.totalSlides],
    ['Read successfully', r.processedSlides],
    ['Need attention', r.slidesRequiringAttention.length],
    ['Tables', r.tables],
    ['Pictures', r.pictures],
    ['Charts', r.charts],
    ['Diagrams (SmartArt)', r.smartArt],
    ['Equations', r.equations],
    ['Embedded objects', r.oleObjects],
    ['With speaker notes', r.slidesWithNotes],
    ['Hidden slides', r.hiddenSlides.length],
    ['Topics found', r.topics.length],
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <nav aria-label="Breadcrumb" className="text-[13px] text-ink-3">
        {course && (
          <>
            <Link to={`/course/${course.id}`} className="hover:underline">
              {course.name}
            </Link>
            {' / '}
          </>
        )}
        <Link to={`/lecture/${lecture.id}`} className="hover:underline">
          {lecture.title}
        </Link>
      </nav>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Extraction report</h1>
        <ConfidencePill value={r.confidenceLabel} />
        <span className="text-sm text-ink-2">{Math.round(r.overallConfidence * 100)}% overall</span>
      </div>
      <p className="mt-2 max-w-prose text-sm text-ink-2">
        What was read from <span className="font-medium text-ink">{lecture.fileName}</span>, and what may be missing. The extracted text is checked against the file: every piece of text in a slide must be captured or listed here.
      </p>

      <section className="mt-6" aria-labelledby="stats-h">
        <h2 id="stats-h" className="sr-only">
          Counts
        </h2>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-rule sm:grid-cols-3 md:grid-cols-4">
          {stats.map(([k, v]) => (
            <div key={k} className="bg-surface px-4 py-3">
              <dt className="text-[13px] text-ink-3">{k}</dt>
              <dd className={`text-xl font-semibold tabular-nums ${k === 'Need attention' && v > 0 ? 'text-bad' : ''}`}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-8" aria-labelledby="missing-h">
        <h2 id="missing-h" className="text-lg font-semibold">
          Potentially missing content
        </h2>
        {r.potentiallyMissing.length === 0 ? (
          <p className="mt-2 text-sm text-ink-2">Nothing was flagged. Text inside pictures is still never read, so check any slide with screenshots yourself.</p>
        ) : (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
            {r.potentiallyMissing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="slides-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="slides-h" className="text-lg font-semibold">
            Slides
          </h2>
          <div role="group" aria-label="Filter slides" className="inline-flex overflow-hidden rounded-[var(--radius-control)] border border-rule-strong text-sm">
            {(
              [
                ['check', 'To check'],
                ['attention', 'Needs attention'],
                ['all', 'All'],
              ] as [Filter, string][]
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={`min-h-9 px-3 ${filter === id ? 'bg-accent-soft font-medium text-ink' : 'bg-surface text-ink-2 hover:bg-sunken'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="mt-3 text-sm text-ink-2">No slides match this filter.</p>
        ) : (
          <ul className="mt-3 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
            {shown.map((s) => (
              <li key={s.index} className="grid gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[3rem_minmax(0,1fr)_9rem]">
                <Link to={`/lecture/${lecture.id}?slide=${s.index}`} className="text-sm tabular-nums text-accent underline underline-offset-2">
                  {s.index}
                </Link>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{displayTitle(s)}</p>
                  {s.flags
                    .filter((f) => f.severity !== 'info')
                    .map((f, i) => (
                      <p key={i} className="mt-1 flex items-start gap-1.5 text-[13px] text-ink-2">
                        <span className="mt-0.5 shrink-0">
                          <SeverityIcon severity={f.severity} />
                        </span>
                        {f.message}
                      </p>
                    ))}
                </div>
                <div className="md:text-right">
                  <ConfidencePill value={s.confidence} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="topics-h">
        <h2 id="topics-h" className="text-lg font-semibold">
          Detected topics
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          Grouped from {r.topics[0] ? SOURCE_LABEL[r.topics[0].source] : 'slide titles'}. These are ranges of existing slides, not interpretations of the content.
        </p>
        <ul className="mt-3 divide-y divide-rule rounded-[var(--radius-panel)] border border-rule bg-surface">
          {(lecture ? topicProgress(lecture, viewed) : []).map((p) => ({ p, t: r.topics.find((x) => x.id === p.id)! })).map(({ p, t }) => (
            <li key={t.id} className="grid gap-x-4 px-4 py-2.5 text-sm md:grid-cols-[6rem_minmax(0,1fr)]">
              <Link to={`/lecture/${lecture.id}?slide=${t.startSlide}`} className="tabular-nums text-accent underline underline-offset-2">
                {t.startSlide === t.endSlide ? `Slide ${t.startSlide}` : `Slides ${t.startSlide}–${t.endSlide}`}
              </Link>
              <div className="min-w-0">
                <p className="truncate font-medium">{t.title}</p>
                <p className="text-[13px] text-ink-3">{p.done ? 'Studied: every slide viewed' : p.viewed === 0 ? 'Not studied yet' : `Studied ${p.viewed} of ${p.total} slides`}</p>
                {t.keyTerms.filter((k) => k.toLowerCase() !== t.title.toLowerCase()).length > 0 && (
                  <p className="truncate text-[13px] text-ink-3">{t.keyTerms.filter((k) => k.toLowerCase() !== t.title.toLowerCase()).join(', ')}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8" aria-labelledby="limits-h">
        <details>
          <summary id="limits-h" className="cursor-pointer text-lg font-semibold">
            Known limitations
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
            {r.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      </section>

      <section className="mt-8 border-t border-rule pt-4 text-[13px] text-ink-3" aria-label="Source file">
        <p>
          {lecture.fileName}, {formatBytes(lecture.fileSize)}, SHA-256 <span className="font-mono">{lecture.fileHash.slice(0, 12)}…</span>. Imported {new Date(lecture.importedAt).toLocaleString()}
          {lecture.revision > 1 ? `, replaced ${lecture.revision - 1} time${lecture.revision === 2 ? '' : 's'}` : ''}.
          {lecture.meta.author ? ` Author: ${lecture.meta.author}.` : ''}
        </p>
      </section>
    </div>
  );
}
