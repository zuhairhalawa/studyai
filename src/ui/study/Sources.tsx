import { useState } from 'react';
import { Link } from 'react-router';
import { CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import { BASIS_LABEL, type Basis, type SourceRefRow } from '@/core/study/types';
import { sourceStatus } from '@/core/study/pack';
import { useAllLectures } from '@/app/data';

/**
 * "On the slides / Derived / Outside knowledge / Uncertain": the four-way provenance of an item.
 * A claim of "on the slides" that the app could not verify is shown as such, never as a trusted green chip.
 */
export function BasisChip({ basis, sources }: { basis: Basis; sources?: SourceRefRow[] }) {
  if (basis === 'lecture' && sources && sourceStatus(sources) !== 'verified') {
    const contradicted = sourceStatus(sources) === 'unverified';
    return (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${contradicted ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn'}`} title="The item says it comes from the slides, but this app could not confirm that.">
        {contradicted ? 'Says on the slides, not confirmed' : 'On the slides (not checked)'}
      </span>
    );
  }
  const cls = { lecture: 'bg-ok-soft text-ok', derived: 'bg-accent-soft text-ink', outside: 'bg-warn-soft text-warn', uncertain: 'bg-bad-soft text-bad' }[basis];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{BASIS_LABEL[basis]}</span>;
}

/** Whether the item's cited quotes were found on the cited slides. Never colour-only. */
export function SourceStatusChip({ sources }: { sources: SourceRefRow[] }) {
  const s = sourceStatus(sources);
  const map = {
    verified: { Icon: CircleCheck, text: 'Source verified', cls: 'text-ok' },
    'slide-only': { Icon: CircleHelp, text: 'Slide cited, quote not checked', cls: 'text-ink-2' },
    unverified: { Icon: TriangleAlert, text: 'Quote not found on the slide', cls: 'text-bad' },
    none: { Icon: CircleHelp, text: 'No source cited', cls: 'text-ink-3' },
  }[s];
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${map.cls}`}>
      <map.Icon className="size-3.5" aria-hidden /> {map.text}
    </span>
  );
}

/** Links to the cited slides ("Show source"), with the quote. Warns when the lecture has since been replaced. */
export function SourceList({ sources }: { sources: SourceRefRow[] }) {
  const lectures = useAllLectures();
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  return (
    <div className="text-sm">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-accent underline underline-offset-2">
        {open ? 'Hide source' : `Show source (${sources.length})`}
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-2">
          {sources.map((s, i) => {
            const lec = lectures?.find((l) => l.id === s.lectureId);
            return (
              <li key={i} className="rounded-[var(--radius-control)] border border-rule bg-sunken/50 px-3 py-2">
                {lec ? (
                  <Link to={`/lecture/${lec.id}?slide=${s.slide}`} className="font-medium text-accent underline underline-offset-2">
                    {lec.title}, slide {s.slide}
                  </Link>
                ) : (
                  <span className="text-ink-3">Lecture no longer in your library (slide {s.slide})</span>
                )}
                {lec && s.rev !== undefined && s.rev !== lec.revision && <p className="mt-1 text-[13px] text-warn">This lecture was replaced after this item was made; slide numbers may have moved.</p>}
                {s.quote && (
                  <p className="mt-1 font-serif text-[0.95rem] text-ink-2">
                    “{s.quote}” {s.verified === true ? <span className="font-sans text-xs text-ok">verified</span> : s.verified === false ? <span className="font-sans text-xs text-bad">not found on the slide</span> : null}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
