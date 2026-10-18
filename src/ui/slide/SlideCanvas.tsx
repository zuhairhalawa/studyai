import { memo, type CSSProperties, type ReactNode } from 'react';
import type { Box, ChartData, Paragraph, ShapeElement, SlideData, SlideElement, TableElement, TextRun } from '@/core/pptx/model';
import { Math as MathView } from './math';

/**
 * Reconstructs a slide from extracted geometry, text, tables and images.
 *
 * This is an approximation built from the file's XML (no PowerPoint renderer is
 * involved): fonts, gradients, effects and some preset shapes differ from the
 * original. Everything is sized in container-width units so the same component
 * serves thumbnails and the full stage. Nothing here is ever injected as HTML
 * except KaTeX output for equations.
 */

export interface SlideCanvasProps {
  slide: SlideData;
  slideWidth: number;
  slideHeight: number;
  /** media key → object URL */
  media: Map<string, string>;
  showDecor?: boolean;
  activeId?: string;
  hoverId?: string;
  onSelect?: (id: string | undefined) => void;
  /** Thumbnails: no selection, no text selection, hidden from assistive tech. */
  thumbnail?: boolean;
}

const EMU_PER_PT = 12700;
const SAFE_LINK = /^(https?:|mailto:)/i;

/** Relative luminance of a #RRGGBB colour (0 = black, 1 = white). */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

const POLYGONS: Record<string, string> = {
  triangle: '50,0 100,100 0,100',
  rtTriangle: '0,0 0,100 100,100',
  diamond: '50,0 100,50 50,100 0,50',
  parallelogram: '20,0 100,0 80,100 0,100',
  trapezoid: '20,0 80,0 100,100 0,100',
  pentagon: '50,0 100,38 82,100 18,100 0,38',
  hexagon: '25,0 75,0 100,50 75,100 25,100 0,50',
  octagon: '30,0 70,0 100,30 100,70 70,100 30,100 0,70 0,30',
  rightArrow: '0,25 60,25 60,0 100,50 60,100 60,75 0,75',
  leftArrow: '100,25 40,25 40,0 0,50 40,100 40,75 100,75',
  upArrow: '25,100 25,40 0,40 50,0 100,40 75,40 75,100',
  downArrow: '25,0 75,0 75,60 100,60 50,100 0,60 25,60',
  chevron: '0,0 70,0 100,50 70,100 0,100 30,50',
  homePlate: '0,0 75,0 100,50 75,100 0,100',
  plus: '35,0 65,0 65,35 100,35 100,65 65,65 65,100 35,100 35,65 0,65 0,35 35,35',
  star5: '50,0 61,35 98,35 68,57 79,91 50,70 21,91 32,57 2,35 39,35',
};

export const SlideCanvas = memo(function SlideCanvas({ slide, slideWidth, slideHeight, media, showDecor = true, activeId, hoverId, onSelect, thumbnail = false }: SlideCanvasProps) {
  const W = slideWidth;
  const H = slideHeight;
  const cq = (pt: number) => `${((pt * EMU_PER_PT) / W) * 100}cqw`;
  const emu = (v: number) => `${(v / W) * 100}cqw`;
  const pts = (pt: number) => cq(pt);

  const bg: CSSProperties = {};
  if (slide.background?.color) bg.background = slide.background.color;
  // Text with no explicit colour (including equations) must stay readable on dark slides.
  bg.color = slide.background?.color && !slide.background.media && luminance(slide.background.color) < 0.35 ? '#ffffff' : '#111111';
  const bgUrl = slide.background?.media ? media.get(slide.background.media) : undefined;
  if (bgUrl) {
    bg.backgroundImage = `url("${bgUrl}")`;
    bg.backgroundSize = 'cover';
    bg.backgroundPosition = 'center';
  }

  const place = (box: Box | undefined): CSSProperties => {
    if (!box) return { left: 0, top: 0, width: '100%', height: 0 };
    const t: string[] = [];
    if (box.rot) t.push(`rotate(${box.rot}deg)`);
    if (box.flipH) t.push('scaleX(-1)');
    if (box.flipV) t.push('scaleY(-1)');
    return {
      left: `${(box.x / W) * 100}%`,
      top: `${(box.y / H) * 100}%`,
      width: `${(box.w / W) * 100}%`,
      height: `${(box.h / H) * 100}%`,
      ...(t.length ? { transform: t.join(' ') } : {}),
    };
  };

  const runView = (r: TextRun, key: number): ReactNode => {
    const style: CSSProperties = {};
    if (r.size) style.fontSize = r.sup || r.sub ? `calc(${cq(r.size)} * 0.66)` : cq(r.size);
    if (r.bold) style.fontWeight = 700;
    if (r.italic) style.fontStyle = 'italic';
    if (r.underline || r.strike) style.textDecoration = [r.underline ? 'underline' : '', r.strike ? 'line-through' : ''].filter(Boolean).join(' ');
    if (r.color) style.color = r.color;
    if (r.mono) style.fontFamily = "'IBM Plex Mono', Consolas, 'Courier New', monospace";
    let node: ReactNode = <span style={style}>{r.text}</span>;
    if (r.sup) node = <sup style={{ lineHeight: 0 }}>{node}</sup>;
    else if (r.sub) node = <sub style={{ lineHeight: 0 }}>{node}</sub>;
    if (r.link && SAFE_LINK.test(r.link) && !thumbnail) {
      node = (
        <a href={r.link} target="_blank" rel="noopener noreferrer" style={{ color: r.color ?? '#0563c1' }}>
          {node}
        </a>
      );
    }
    return <span key={key}>{node}</span>;
  };

  const paragraphsView = (paragraphs: Paragraph[], opts: { align?: 'top' | 'middle' | 'bottom'; padX?: number; padY?: number } = {}): ReactNode => {
    const counters: number[] = [];
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: opts.align === 'middle' ? 'center' : opts.align === 'bottom' ? 'flex-end' : 'flex-start',
          width: '100%',
          height: '100%',
          padding: `${emu(opts.padY ?? 45720)} ${emu(opts.padX ?? 91440)}`,
          lineHeight: 1.15,
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
        }}
      >
        {paragraphs.map((p, i) => {
          if (p.inlines.length === 0) {
            // a blank line is as tall as its font says (PowerPoint uses it to push the text below down)
            return <div key={i} style={{ minHeight: p.endSize ? `calc(${cq(p.endSize)} * ${(p.lineSpacing ?? 1) * 1.2})` : '0.6em', marginTop: i === 0 || p.spaceBefore === undefined ? 0 : pts(p.spaceBefore) }} />;
          }
          let marker: string | undefined;
          if (p.bullet === 'bullet') marker = p.level === 0 ? '•' : '–';
          else if (p.bullet === 'number') {
            counters[p.level] = (counters[p.level] ?? 0) + 1;
            counters.length = p.level + 1;
            marker = `${counters[p.level]}.`;
          } else counters.length = 0;
          const firstRun = p.inlines.find((x) => x.kind === 'text') as TextRun | undefined;
          const firstSize = firstRun?.size ?? 18;
          const paraColor = (p.inlines.find((x) => x.kind === 'text' && x.color) as TextRun | undefined)?.color;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                textAlign: p.align === 'ctr' ? 'center' : p.align === 'r' ? 'right' : p.align === 'just' ? 'justify' : 'left',
                paddingLeft: emu(p.level * 342900),
                marginTop: i === 0 ? 0 : p.spaceBefore !== undefined ? pts(p.spaceBefore) : `calc(${cq(firstSize)} * 0.25)`,
                ...(p.spaceAfter ? { marginBottom: pts(p.spaceAfter) } : {}),
                ...(p.lineSpacing ? { lineHeight: p.lineSpacing * 1.2 } : {}),
                fontSize: cq(firstSize),
                ...(paraColor ? { color: paraColor } : {}),
              }}
            >
              {marker && <span style={{ flex: '0 0 auto', minWidth: emu(285750), whiteSpace: 'nowrap', paddingRight: '0.2em' }}>{marker}</span>}
              <div style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap' }}>
                {p.inlines.map((inl, k) => {
                  if (inl.kind === 'text') return runView(inl, k);
                  if (inl.kind === 'math') return <MathView key={k} latex={inl.latex} plain={inl.plain} display={inl.display} />;
                  return <br key={k} />;
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const shapeView = (s: ShapeElement): ReactNode => {
    const polygon = POLYGONS[s.geom];
    const style: CSSProperties = {};
    if (!polygon && s.fill) style.background = s.fill;
    if (!polygon && s.line) style.border = `max(1px, ${emu(s.line.width)}) solid ${s.line.color}`;
    if (s.geom === 'ellipse') style.borderRadius = '50%';
    else if (s.geom === 'roundRect' || s.geom === 'flowChartAlternateProcess') style.borderRadius = '12%/30%';
    const hasText = s.paragraphs.some((p) => p.inlines.length > 0);
    return (
      <>
        {polygon && (s.fill || s.line) && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }} aria-hidden>
            <polygon points={polygon} fill={s.fill ?? 'none'} stroke={s.line?.color ?? 'none'} strokeWidth={s.line ? `max(1px, ${emu(s.line.width)})` : 0} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <div style={{ position: 'absolute', inset: 0, ...style }}>{hasText && paragraphsView(s.paragraphs, { align: s.anchor ?? (s.isTextBox ? 'top' : 'middle') })}</div>
      </>
    );
  };

  const tableView = (t: TableElement): ReactNode => {
    const totalW = t.columnWidths.reduce((a, b) => a + b, 0) || 1;
    const totalH = t.rowHeights.reduce((a, b) => a + b, 0) || 1;
    const border = `max(1px, 0.1cqw) solid #8a8f98`;
    return (
      <table style={{ width: '100%', height: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          {t.columnWidths.map((w, i) => (
            <col key={i} style={{ width: `${(w / totalW) * 100}%` }} />
          ))}
        </colgroup>
        <tbody>
          {t.rows.map((row, ri) => (
            <tr key={ri} style={{ height: `${((t.rowHeights[ri] ?? 0) / totalH) * 100}%` }}>
              {row.map((cell, ci) =>
                cell.merged ? null : (
                  <td key={ci} colSpan={cell.gridSpan} rowSpan={cell.rowSpan} style={{ border, padding: emu(45720), verticalAlign: 'middle', background: t.headerRow && ri === 0 ? 'rgba(11,110,110,.12)' : undefined, fontWeight: t.headerRow && ri === 0 ? 700 : undefined }}>
                    {paragraphsView(cell.paragraphs, { padX: 0, padY: 0 })}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const chartView = (c: ChartData | null): ReactNode => (
    <div style={{ width: '100%', height: '100%', border: `max(1px, 0.1cqw) dashed #8a8f98`, padding: emu(91440), overflow: 'hidden', fontSize: cq(12), lineHeight: 1.25 }}>
      <strong>{c ? `Chart (${c.chartType})${c.title ? `: ${c.title}` : ''}` : 'Chart (no readable data)'}</strong>
      {c && (
        <div style={{ marginTop: '0.3em' }}>
          {c.series.slice(0, 6).map((s, i) => (
            <div key={i}>
              {s.name}: {s.values.slice(0, 12).join(', ')}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const placeholderView = (label: string): ReactNode => (
    <div style={{ width: '100%', height: '100%', border: `max(1px, 0.12cqw) dashed #8a8f98`, background: 'rgba(120,130,140,.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: cq(12), color: '#555', padding: emu(45720) }}>
      {label}
    </div>
  );

  const lineView = (el: Extract<SlideElement, { kind: 'line' }>): ReactNode => {
    const stroke = el.color ?? '#444';
    const w = `max(1px, ${emu(el.width ?? 12700)})`;
    const id = `arr-${slide.index}-${el.id}`;
    return (
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }} aria-hidden>
        {(el.arrowEnd || el.arrowStart) && (
          <defs>
            <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={stroke} />
            </marker>
          </defs>
        )}
        <line x1="0" y1="0" x2="100" y2="100" stroke={stroke} strokeWidth={w} vectorEffect="non-scaling-stroke" strokeDasharray={el.dash ? '6 4' : undefined} markerEnd={el.arrowEnd ? `url(#${id})` : undefined} markerStart={el.arrowStart ? `url(#${id})` : undefined} />
      </svg>
    );
  };

  const body = (el: SlideElement): ReactNode => {
    switch (el.kind) {
      case 'shape':
        return shapeView(el);
      case 'line':
        return lineView(el);
      case 'picture': {
        const url = el.media ? media.get(el.media) : undefined;
        if (!url || !el.renderable) return placeholderView(`Image not shown${el.mime ? ` (${el.mime.replace('image/x-', '').replace('image/', '').toUpperCase()})` : ''}`);
        const c = el.crop;
        const wr = c ? 1 - c.l - c.r : 1;
        const hr = c ? 1 - c.t - c.b : 1;
        return (
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
            <img
              src={url}
              alt={thumbnail ? '' : (el.alt ?? '')}
              draggable={false}
              style={{ position: 'absolute', width: `${100 / wr}%`, height: `${100 / hr}%`, left: c ? `${(-c.l / wr) * 100}%` : 0, top: c ? `${(-c.t / hr) * 100}%` : 0, objectFit: 'fill', userSelect: 'none' }}
            />
          </div>
        );
      }
      case 'table':
        return tableView(el);
      case 'chart':
        return chartView(el.chart);
      case 'smartart':
        return el.shapes.length > 0 ? null : (
          <div style={{ width: '100%', height: '100%', border: `max(1px, 0.1cqw) dashed #8a8f98`, padding: emu(91440), fontSize: cq(14), overflow: 'hidden' }}>
            {el.outline.map((n, i) => (
              <div key={i} style={{ paddingLeft: emu(n.depth * 228600) }}>
                {n.text}
              </div>
            ))}
          </div>
        );
      case 'ole': {
        const url = el.previewMedia ? media.get(el.previewMedia) : undefined;
        return url && el.previewRenderable ? <img src={url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'fill' }} /> : placeholderView(`Embedded object${el.progId ? ` (${el.progId})` : ''}`);
      }
      case 'media': {
        const url = el.posterMedia ? media.get(el.posterMedia) : undefined;
        return url ? <img src={url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'fill' }} /> : placeholderView(`Embedded ${el.mediaKind}`);
      }
      case 'unsupported':
        return placeholderView(el.what);
    }
  };

  const wrap = (el: SlideElement, key: string, extra?: ReactNode) => {
    const selectable = !thumbnail && !el.decorative && !!onSelect;
    return (
      <div
        key={key}
        className="slide-el"
        data-el={el.id}
        data-active={!thumbnail && activeId === el.id ? 'true' : undefined}
        data-hover={!thumbnail && hoverId === el.id && activeId !== el.id ? 'true' : undefined}
        style={{ ...place(el.box), cursor: selectable ? 'pointer' : undefined }}
        onClick={selectable ? (e) => { e.stopPropagation(); onSelect(el.id); } : undefined}
      >
        {body(el)}
        {extra}
      </div>
    );
  };

  const visible = slide.elements.filter((e) => !e.hidden && (showDecor || !e.decorative));
  return (
    <div
      className="slide-stage"
      style={{ aspectRatio: `${W} / ${H}`, width: '100%', ...bg, pointerEvents: thumbnail ? 'none' : undefined }}
      onClick={!thumbnail && onSelect ? () => onSelect(undefined) : undefined}
      aria-hidden={thumbnail || undefined}
    >
      {visible.map((el, i) => (
        <SlideElementNode key={`${el.id}-${i}`}>
          {wrap(
            el,
            `${el.id}-${i}`,
            el.kind === 'smartart'
              ? el.shapes.map((s, k) => (
                  <div key={k} className="slide-el" style={placeRelative(s.box, el.box, W, H)}>
                    {shapeView(s)}
                  </div>
                ))
              : null,
          )}
        </SlideElementNode>
      ))}
    </div>
  );
});

function SlideElementNode({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** SmartArt shapes carry slide-absolute boxes; position them relative to the frame element. */
function placeRelative(box: Box | undefined, frame: Box | undefined, W: number, H: number): CSSProperties {
  void H;
  if (!box || !frame || frame.w === 0 || frame.h === 0) return { display: 'none' };
  return {
    left: `${((box.x - frame.x) / frame.w) * 100}%`,
    top: `${((box.y - frame.y) / frame.h) * 100}%`,
    width: `${(box.w / frame.w) * 100}%`,
    height: `${(box.h / frame.h) * 100}%`,
    fontSize: `${(12 * EMU_PER_PT) / W}cqw`,
  };
}
