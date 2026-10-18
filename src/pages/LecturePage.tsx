import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, ClipboardCopy, FileText, Search, Sparkles } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { setPictureText } from '@/core/db/library';
import { displayTitle } from '@/core/pptx/topics';
import { recordSlideView } from '@/core/study/progress';
import { useCourse, useLecture, useMediaUrls, useSlides } from '@/app/data';
import { useToast } from '@/app/toast';
import { ChecksView, ExtractedView } from '@/ui/slide/ExtractedView';
import { Filmstrip } from '@/ui/slide/Filmstrip';
import { SlideCanvas } from '@/ui/slide/SlideCanvas';
import { ConfidencePill, IconButton, Select, Spinner } from '@/ui/primitives';
import { NotFound } from './NotFound';

const db = getDb();
type Tab = 'content' | 'notes' | 'checks';

export function LecturePage() {
  const { lectureId } = useParams();
  const lecture = useLecture(lectureId);
  const course = useCourse(lecture?.courseId);
  const slides = useSlides(lectureId, lecture?.revision);
  const media = useMediaUrls(lectureId, lecture?.revision);
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('content');
  const [active, setActive] = useState<string | undefined>();
  const [hover, setHover] = useState<string | undefined>();
  const [decor, setDecor] = useState(true);
  const stageRef = useRef<HTMLDivElement>(null);

  const count = slides?.length ?? 0;
  const current = Math.min(Math.max(1, Number(params.get('slide')) || 1), Math.max(1, count));

  const go = useCallback(
    (n: number) => {
      const next = Math.min(Math.max(1, n), Math.max(1, count));
      setParams({ slide: String(next) }, { replace: true });
      setActive(undefined);
    },
    [count, setParams],
  );

  // Remember where the student stopped (dashboard "continue" card).
  useEffect(() => {
    if (!lectureId || !count) return;
    // A tiny write: do it immediately so leaving the page quickly never loses the position.
    void db.settings.put({ key: 'lastViewed', value: { lectureId, slide: current, at: Date.now() } });
  }, [lectureId, current, count]);

  // A slide counts as studied once it has stayed on screen for a few seconds (flicking past does not count).
  useEffect(() => {
    if (!lecture || !count) return;
    const t = window.setTimeout(() => {
      if (!document.hidden) void recordSlideView(db, lecture.courseId, lecture.id, current);
    }, 3000);
    return () => window.clearTimeout(t);
  }, [lecture?.id, lecture?.courseId, current, count]);

  // Keyboard navigation (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(current + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(current - 1);
      else if (e.key === 'Home') go(1);
      else if (e.key === 'End') go(count);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, count, go]);

  const slide = slides?.[current - 1];
  const W = lecture?.meta.slideWidth ?? 9144000;
  const H = lecture?.meta.slideHeight ?? 6858000;

  const select = useCallback((id: string | undefined) => {
    setActive(id);
    if (id) {
      setTab('content');
      requestAnimationFrame(() => document.getElementById(`blk-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  }, []);

  const topics = lecture?.report.topics ?? [];
  const currentTopic = useMemo(() => topics.find((t) => current >= t.startSlide && current <= t.endSlide), [topics, current]);

  if (lecture === null) return <NotFound what="lecture" />;
  if (!lecture || !slides) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }

  const attn = lecture.report.slidesRequiringAttention.length;
  const noteCount = slide?.notes.trim() ? 1 : 0;
  const flagCount = slide?.flags.filter((f) => f.severity !== 'info' && !f.resolved).length ?? 0;

  const copyText = async () => {
    if (!slide) return;
    try {
      await navigator.clipboard.writeText(`${lecture.title}, slide ${slide.index}\n\n${slide.text}${slide.notes ? `\n\nSpeaker notes:\n${slide.notes}` : ''}`);
      toast.show('Slide text copied.', 'ok');
    } catch {
      toast.show('Your browser blocked copying. Select the text and copy it manually.', 'error');
    }
  };

  const tabBtn = (id: Tab, label: string, badge?: number) => (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={tab === id}
      aria-controls="tabpanel"
      onClick={() => setTab(id)}
      className={`-mb-px min-h-10 border-b-2 px-3 text-sm font-medium ${tab === id ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink'}`}
    >
      {label}
      {badge ? <span className="ml-1.5 rounded-full bg-sunken px-1.5 py-0.5 text-xs text-ink-2">{badge}</span> : null}
    </button>
  );

  return (
    <div className="flex flex-col lg:h-dvh">
      <header className="border-b border-rule bg-surface px-4 py-3 md:px-6">
        <nav aria-label="Breadcrumb" className="text-[13px] text-ink-3">
          {course && (
            <Link to={`/course/${course.id}`} className="hover:text-ink hover:underline">
              {course.name}
            </Link>
          )}
        </nav>
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{lecture.title}</h1>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <ConfidencePill value={lecture.report.confidenceLabel} />
            <Link to={`/lecture/${lecture.id}/report`} className="inline-flex items-center gap-1.5 text-accent underline underline-offset-2">
              <FileText className="size-4" aria-hidden /> Extraction report{attn > 0 ? ` (${attn} to check)` : ''}
            </Link>
            <Link to={`/search?lecture=${lecture.id}`} className="inline-flex items-center gap-1.5 text-accent underline underline-offset-2">
              <Search className="size-4" aria-hidden /> Search this lecture
            </Link>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 lg:grid lg:grid-cols-[11.5rem_minmax(0,1fr)]">
        <aside className="hidden overflow-y-auto border-r border-rule bg-surface p-2 lg:block" aria-label="Slide list">
          <Filmstrip slides={slides} slideWidth={W} slideHeight={H} media={media} current={current} onSelect={go} orientation="vertical" />
        </aside>

        <div className="min-h-0 min-w-0 lg:overflow-y-auto xl:grid xl:grid-cols-[minmax(0,1.3fr)_minmax(22rem,1fr)] xl:overflow-hidden">
        <section className="min-w-0 xl:min-h-0 xl:overflow-y-auto xl:border-r xl:border-rule" aria-label="Slide">
          <div className="border-b border-rule bg-surface px-3 py-2 lg:hidden">
            <Filmstrip slides={slides} slideWidth={W} slideHeight={H} media={media} current={current} onSelect={go} orientation="horizontal" />
          </div>
          <div className="mx-auto w-full max-w-[60rem] p-3 md:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
              <div className="flex items-center gap-1">
                <IconButton label="Previous slide (left arrow)" onClick={() => go(current - 1)} disabled={current <= 1}>
                  <ChevronLeft className="size-5" aria-hidden />
                </IconButton>
                <p className="min-w-28 text-center text-sm tabular-nums" aria-live="polite">
                  Slide {current} of {count}
                </p>
                <IconButton label="Next slide (right arrow)" onClick={() => go(current + 1)} disabled={current >= count}>
                  <ChevronRight className="size-5" aria-hidden />
                </IconButton>
              </div>
              {topics.length > 1 && (
                <div className="min-w-0 max-w-full sm:max-w-72">
                  <label htmlFor="topic-jump" className="sr-only">
                    Jump to topic
                  </label>
                  <Select id="topic-jump" value={currentTopic?.id ?? ''} onChange={(e) => go(topics.find((t) => t.id === e.target.value)?.startSlide ?? 1)} className="min-h-9 text-[13px]">
                    {topics.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.startSlide === t.endSlide ? t.startSlide : `${t.startSlide}–${t.endSlide}`}: {t.title.slice(0, 60)}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>

            <div ref={stageRef}>
              {slide ? (
                <SlideCanvas slide={slide} slideWidth={W} slideHeight={H} media={media} showDecor={decor} activeId={active} hoverId={hover} onSelect={select} />
              ) : (
                <p className="text-sm text-ink-2">This lecture has no slides.</p>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[13px] text-ink-3">
              <label className="inline-flex min-h-8 items-center gap-2">
                <input type="checkbox" checked={decor} onChange={(e) => setDecor(e.target.checked)} className="size-4 accent-[var(--accent)]" />
                Show background graphics (logos, footers)
              </label>
              <p>Click a shape to see its extracted text. Use ← → to change slide.</p>
            </div>
            {slide?.hidden && <p className="mt-3 rounded bg-sunken px-3 py-2 text-sm text-ink-2">This slide is hidden in the presentation.</p>}
          </div>
        </section>

        <section className="min-w-0 border-t border-rule bg-surface xl:min-h-0 xl:overflow-y-auto xl:border-t-0" aria-label="Extracted content">
          <div className="sticky top-0 z-10 border-b border-rule bg-surface px-4 pt-3 md:px-5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 truncate pb-2 text-base font-semibold">
                <span className="text-ink-3">{current}.</span> {slide ? displayTitle(slide) : ''}
              </h2>
              <span className="flex shrink-0 items-center gap-1">
                <Link to={`/course/${lecture.courseId}/tutor?lecture=${lecture.id}&slide=${current}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-sm text-accent hover:bg-sunken">
                  <Sparkles className="size-4" aria-hidden /> Ask the tutor
                </Link>
                <IconButton label="Copy slide text" onClick={() => void copyText()} className="-mr-2 -mt-1 size-9">
                  <ClipboardCopy className="size-4" aria-hidden />
                </IconButton>
              </span>
            </div>
            <div role="tablist" aria-label="Slide details" className="flex">
              {tabBtn('content', 'Content')}
              {tabBtn('notes', 'Speaker notes', noteCount)}
              {tabBtn('checks', 'Checks', flagCount)}
            </div>
          </div>
          <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="px-2 py-3 md:px-3">
            {slide &&
              (tab === 'content' ? (
                <ExtractedView slide={slide} slideHeight={H} media={media} activeId={active} onActivate={select} onHover={setHover} onSavePictureText={(elementId, text) => setPictureText(db, lecture.id, slide.index, elementId, text)} />
              ) : tab === 'notes' ? (
                <div className="px-3">
                  {slide.notes.trim() ? (
                    <div className="reading whitespace-pre-wrap">{slide.notes}</div>
                  ) : (
                    <p className="text-sm text-ink-2">This slide has no speaker notes.</p>
                  )}
                </div>
              ) : (
                <div className="px-3">
                  <ChecksView slide={slide} />
                </div>
              ))}
          </div>
        </section>
        </div>
      </div>
    </div>
  );
}
