import { memo, useEffect, useRef, useState } from 'react';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import type { SlideData } from '@/core/pptx/model';
import { displayTitle } from '@/core/pptx/topics';
import { SlideCanvas } from './SlideCanvas';

/** True once the element has come within `margin` px of the viewport (and stays true). */
function useNearViewport(margin = 500) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: `${margin}px` });
    io.observe(el);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near] as const;
}

const Thumb = memo(function Thumb({ slide, slideWidth, slideHeight, media, current, onSelect }: { slide: SlideData; slideWidth: number; slideHeight: number; media: Map<string, string>; current: boolean; onSelect: (n: number) => void }) {
  const [ref, near] = useNearViewport();
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (current) btn.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  const title = displayTitle(slide);
  return (
    <li>
      <button
        ref={btn}
        type="button"
        onClick={() => onSelect(slide.index)}
        aria-current={current ? 'true' : undefined}
        aria-label={`Slide ${slide.index}: ${title}${slide.confidence !== 'high' ? `, ${slide.confidence === 'low' ? 'needs attention' : 'check'}` : ''}${slide.hidden ? ', hidden slide' : ''}`}
        className={`group flex w-full flex-col gap-1 rounded-[var(--radius-control)] p-1.5 text-left ${current ? 'bg-accent-soft ring-2 ring-accent' : 'hover:bg-sunken'}`}
      >
        <div ref={ref} style={{ aspectRatio: `${slideWidth} / ${slideHeight}` }} className="w-full overflow-hidden rounded-[3px] bg-sunken ring-1 ring-rule-strong">
          {near && <SlideCanvas slide={slide} slideWidth={slideWidth} slideHeight={slideHeight} media={media} thumbnail />}
        </div>
        <div className="flex items-start gap-1.5 px-0.5">
          <span className="w-5 shrink-0 text-xs tabular-nums text-ink-3">{slide.index}</span>
          <span className={`min-w-0 flex-1 truncate text-xs ${slide.hidden ? 'italic text-ink-3' : 'text-ink-2'}`}>{title}</span>
          {slide.confidence === 'low' && <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-bad" aria-hidden />}
          {slide.confidence === 'medium' && <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />}
        </div>
      </button>
    </li>
  );
});

export function Filmstrip({ slides, slideWidth, slideHeight, media, current, onSelect, orientation }: { slides: SlideData[]; slideWidth: number; slideHeight: number; media: Map<string, string>; current: number; onSelect: (n: number) => void; orientation: 'vertical' | 'horizontal' }) {
  return (
    <ol className={orientation === 'vertical' ? 'flex flex-col gap-1' : 'flex gap-1 overflow-x-auto pb-1 [&>li]:w-36 [&>li]:shrink-0'} aria-label="Slides">
      {slides.map((s) => (
        <Thumb key={s.index} slide={s} slideWidth={slideWidth} slideHeight={slideHeight} media={media} current={s.index === current} onSelect={onSelect} />
      ))}
    </ol>
  );
}
