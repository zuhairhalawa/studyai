import type { ReactNode } from 'react';
import { CircleCheck, ImageOff, TriangleAlert } from 'lucide-react';
import type { Flag, Paragraph, ShapeElement, SlideData, SlideElement, TextRun } from '@/core/pptx/model';
import { describePicture } from '@/core/pptx/describe';
import { pictureTextOf } from '@/core/pptx/picturetext';
import { orderedContentElements } from '@/core/pptx/shapes';
import { ConfidencePill, SeverityIcon } from '@/ui/primitives';
import { Math as MathView } from './math';
import { PictureTextEditor } from './PictureTextEditor';

/** Margin label for an element ("Title", "Table", …). */
export function blockLabel(el: SlideElement): string | undefined {
  switch (el.kind) {
    case 'shape':
      if (!el.paragraphs.some((p) => p.text.trim())) return undefined;
      if (el.role === 'title') return 'Title';
      if (el.role === 'subtitle') return 'Subtitle';
      if (el.role === 'body') return 'Body';
      return el.isTextBox ? 'Text box' : el.role ? 'Text' : 'Shape text';
    case 'table':
      return 'Table';
    case 'chart':
      return 'Chart';
    case 'smartart':
      return 'Diagram';
    case 'picture':
      return 'Picture';
    case 'ole':
      return 'Object';
    case 'media':
      return 'Media';
    case 'unsupported':
      return 'Unsupported';
    default:
      return undefined;
  }
}

/** Elements shown as blocks in the extracted view, in reading order. */
export function contentBlocks(slide: SlideData, slideHeight: number): { el: SlideElement; label: string }[] {
  return orderedContentElements(slide.elements, slideHeight).flatMap((el) => {
    const label = blockLabel(el);
    return label ? [{ el, label }] : [];
  });
}

const SAFE_LINK = /^(https?:|mailto:)/i;

function Run({ r }: { r: TextRun }) {
  let node: ReactNode = r.text;
  if (r.mono) node = <code className="rounded bg-sunken px-1 font-mono text-[0.9em]">{node}</code>;
  if (r.bold) node = <strong>{node}</strong>;
  if (r.italic) node = <em>{node}</em>;
  if (r.underline) node = <u>{node}</u>;
  if (r.strike) node = <s>{node}</s>;
  if (r.sup) node = <sup>{node}</sup>;
  if (r.sub) node = <sub>{node}</sub>;
  if (r.link && SAFE_LINK.test(r.link)) {
    node = (
      <a href={r.link} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
        {node}
      </a>
    );
  }
  return <>{node}</>;
}

export function ParagraphsView({ paragraphs, large = false }: { paragraphs: Paragraph[]; large?: boolean }) {
  const counters: number[] = [];
  const rows = paragraphs.filter((p) => p.text.trim() !== '' || p.inlines.some((i) => i.kind === 'math'));
  return (
    <div role="list" className={`flex flex-col gap-1.5 font-serif leading-relaxed ${large ? 'text-xl font-semibold leading-snug' : 'text-[1.0625rem]'}`}>
      {rows.map((p, i) => {
        let marker: string | undefined;
        if (p.bullet === 'bullet') marker = p.level === 0 ? '•' : '–';
        else if (p.bullet === 'number') {
          counters[p.level] = (counters[p.level] ?? 0) + 1;
          counters.length = p.level + 1;
          marker = `${counters[p.level]}.`;
        } else counters.length = 0;
        return (
          <div key={i} role="listitem" className="flex gap-2" style={{ paddingLeft: `${p.level * 1.25}rem` }}>
            {marker && (
              <span className="w-5 shrink-0 text-ink-3" aria-hidden>
                {marker}
              </span>
            )}
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
              {p.inlines.map((inl, k) => {
                if (inl.kind === 'text') return <Run key={k} r={inl} />;
                if (inl.kind === 'math') return <MathView key={k} latex={inl.latex} plain={inl.plain} display={inl.display} />;
                return <br key={k} />;
              })}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function BlockBody({ el, media, slide, onSavePictureText }: { el: SlideElement; media: Map<string, string>; slide: SlideData; onSavePictureText?: (elementId: string, text: string) => Promise<void> }) {
  switch (el.kind) {
    case 'shape':
      return <ParagraphsView paragraphs={el.paragraphs} large={el.role === 'title'} />;
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-serif text-[0.95rem]">
            <tbody>
              {el.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) =>
                    cell.merged ? null : el.headerRow && ri === 0 ? (
                      <th key={ci} colSpan={cell.gridSpan} rowSpan={cell.rowSpan} scope="col" className="border border-rule-strong bg-sunken px-2.5 py-1.5 text-left font-semibold">
                        {cell.text}
                      </th>
                    ) : (
                      <td key={ci} colSpan={cell.gridSpan} rowSpan={cell.rowSpan} className="border border-rule-strong px-2.5 py-1.5 align-top">
                        <ParagraphsView paragraphs={cell.paragraphs} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'chart':
      return el.chart ? (
        <div className="overflow-x-auto">
          <p className="font-serif font-semibold">
            {el.chart.title ?? 'Untitled chart'} <span className="font-sans text-sm font-normal text-ink-3">({el.chart.chartType})</span>
          </p>
          <table className="mt-1 w-full border-collapse font-serif text-[0.95rem]">
            <thead>
              <tr>
                <th className="border border-rule-strong bg-sunken px-2.5 py-1.5 text-left" scope="col">
                  Series
                </th>
                {(el.chart.categories.length ? el.chart.categories : el.chart.series[0]?.values.map((_, i) => String(i + 1)) ?? []).map((c, i) => (
                  <th key={i} scope="col" className="border border-rule-strong bg-sunken px-2.5 py-1.5 text-left">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {el.chart.series.map((s, i) => (
                <tr key={i}>
                  <th scope="row" className="border border-rule-strong px-2.5 py-1.5 text-left font-medium">
                    {s.name}
                  </th>
                  {s.values.map((v, k) => (
                    <td key={k} className="border border-rule-strong px-2.5 py-1.5">
                      {String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-bad">No data could be read from this chart.</p>
      );
    case 'smartart':
      return (
        <ul className="font-serif text-[1.0625rem] leading-relaxed">
          {el.outline.length === 0 && <li className="font-sans text-sm text-bad">No text could be read from this diagram.</li>}
          {el.outline.map((n, i) => (
            <li key={i} style={{ paddingLeft: `${n.depth * 1.25}rem` }} className="before:mr-2 before:text-ink-3 before:content-['–']">
              {n.text}
            </li>
          ))}
        </ul>
      );
    case 'picture': {
      const url = el.media ? media.get(el.media) : undefined;
      return (
        <div className="flex flex-wrap items-start gap-3">
          {url && el.renderable ? (
            <img src={url} alt={el.alt ?? ''} className="max-h-40 max-w-full rounded border border-rule bg-white object-contain" />
          ) : (
            <span className="inline-flex items-center gap-2 rounded border border-dashed border-rule-strong px-3 py-2 text-sm text-ink-2">
              <ImageOff className="size-4" aria-hidden /> Image not shown
            </span>
          )}
          <p className="min-w-0 flex-1 text-sm text-ink-2">{describePicture(el.alt) ? `${describePicture(el.alt)!.auto ? 'Automatic description (may be wrong)' : 'Alt text'}: ${describePicture(el.alt)!.text}` : 'No useful alt text. Any text inside the picture is not extracted.'}</p>
          {onSavePictureText && !el.decorative && <PictureTextEditor saved={pictureTextOf(slide, el.id)} onSave={(text) => onSavePictureText(el.id, text)} />}
        </div>
      );
    }
    case 'ole':
      return <p className="text-sm text-ink-2">Embedded object{el.progId ? ` (${el.progId})` : ''}. Its contents are not extracted.</p>;
    case 'media':
      return <p className="text-sm text-ink-2">Embedded {el.mediaKind}. Play it in PowerPoint.</p>;
    case 'unsupported':
      return <p className="text-sm text-ink-2">{el.what} was not extracted.</p>;
    default:
      return null;
  }
}

export function ExtractedView({
  slide,
  slideHeight,
  media,
  activeId,
  onActivate,
  onHover,
  onSavePictureText,
}: {
  slide: SlideData;
  slideHeight: number;
  media: Map<string, string>;
  activeId?: string;
  onActivate: (id: string | undefined) => void;
  onHover: (id: string | undefined) => void;
  /** When given, pictures get a box to type their words into. */
  onSavePictureText?: (elementId: string, text: string) => Promise<void>;
}) {
  const blocks = contentBlocks(slide, slideHeight);
  const byEl = new Map<string, Flag[]>();
  // A warning the student has dealt with (typed the picture's words) is not repeated under the picture.
  for (const f of slide.flags) if (f.elementId && !f.resolved) byEl.set(f.elementId, [...(byEl.get(f.elementId) ?? []), f]);
  const unplaced = slide.text.includes('[Unplaced text]') ? slide.text.slice(slide.text.indexOf('[Unplaced text]') + '[Unplaced text]'.length).trim() : '';

  if (slide.status === 'failed') {
    return <p className="rounded-[var(--radius-panel)] bg-bad-soft p-4 text-sm text-bad">This slide could not be read. None of its content is available here; open the original file in PowerPoint.</p>;
  }
  if (blocks.length === 0 && !unplaced) {
    return <p className="text-sm text-ink-2">This slide has no extractable content.</p>;
  }

  return (
    <div className="flex flex-col">
      {blocks.map(({ el, label }) => {
        const flags = byEl.get(el.id) ?? [];
        const active = activeId === el.id;
        return (
          <article
            key={`${el.id}-${el.z}`}
            id={`blk-${el.id}`}
            tabIndex={0}
            aria-current={active || undefined}
            onClick={() => onActivate(active ? undefined : el.id)}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                e.preventDefault();
                onActivate(active ? undefined : el.id);
              }
            }}
            onMouseEnter={() => onHover(el.id)}
            onMouseLeave={() => onHover(undefined)}
            onFocus={() => onHover(el.id)}
            onBlur={() => onHover(undefined)}
            className={`grid cursor-pointer gap-x-4 gap-y-1 border-t border-rule py-3.5 first:border-t-0 md:grid-cols-[5.5rem_minmax(0,1fr)] ${active ? 'bg-accent-soft' : 'hover:bg-sunken/60'}`}
          >
            <h3 className="px-2 text-xs font-medium text-ink-3 md:pt-1.5 md:text-right">{label}</h3>
            <div className={`min-w-0 px-2 md:border-l md:pl-4 ${active ? 'md:border-accent' : 'md:border-rule'}`}>
              <BlockBody el={el} media={media} slide={slide} {...(onSavePictureText ? { onSavePictureText } : {})} />
              {flags.map((f, i) => (
                <p key={i} className={`mt-2 flex items-start gap-1.5 text-[13px] ${f.severity === 'attention' ? 'text-bad' : f.severity === 'warning' ? 'text-warn' : 'text-ink-2'}`}>
                  <span className="mt-0.5 shrink-0">
                    <SeverityIcon severity={f.severity} />
                  </span>
                  {f.message}
                </p>
              ))}
            </div>
          </article>
        );
      })}
      {unplaced && (
        <article className="grid gap-x-4 border-t border-rule py-3.5 md:grid-cols-[5.5rem_minmax(0,1fr)]">
          <h3 className="px-2 text-xs font-medium text-bad md:pt-1.5 md:text-right">Unplaced text</h3>
          <div className="min-w-0 whitespace-pre-wrap px-2 font-serif text-[1.0625rem] md:border-l md:border-bad md:pl-4">{unplaced}</div>
        </article>
      )}
    </div>
  );
}

export function ChecksView({ slide }: { slide: SlideData }) {
  // Open problems first; the ones the student settled (typed a picture's words) are listed last, as settled.
  const rank = (f: Flag) => (f.resolved ? 3 : { attention: 0, warning: 1, info: 2 }[f.severity]);
  const flags = [...slide.flags].sort((a, b) => rank(a) - rank(b));
  const hasPictures = slide.counts.pictures > 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <ConfidencePill value={slide.confidence} />
        <span className="text-sm text-ink-2">
          Text coverage: {slide.coverage.rawChars === 0 ? 'no text boxes' : `${Math.min(100, Math.round((slide.coverage.capturedChars / Math.max(1, slide.coverage.rawChars)) * 100))}% of text in the file was captured`}
        </span>
      </div>
      {flags.length === 0 ? (
        <p className="flex items-start gap-2 text-sm text-ink-2">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
          No extraction problems were detected on this slide.{hasPictures ? ' Text inside pictures is not read automatically: type it under the picture if it matters.' : ''}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {flags.map((f, i) => (
            <li key={i} className={`flex items-start gap-2 text-sm ${f.resolved ? 'text-ink-2' : 'text-ink'}`}>
              <span className="mt-0.5 shrink-0">{f.resolved ? <CircleCheck className="size-4 text-ok" aria-hidden /> : <SeverityIcon severity={f.severity} />}</span>
              <span>{f.resolved ? `Settled, you typed the picture’s words: ${f.message}` : f.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="flex items-start gap-2 text-[13px] text-ink-3">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        The preview on the left is rebuilt from the file’s data. Fonts, effects and some shapes can look different in PowerPoint.
      </p>
    </div>
  );
}

export type { ShapeElement };
