import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parsePptx, PptxError } from '../src/core/pptx';
import { sha256Fallback } from '../src/core/pptx/hash';
import type { ParsedDeck, ShapeElement, SlideElement } from '../src/core/pptx/model';
import {
  PNG_1X1,
  bodySp,
  buildPptx,
  chartFrame,
  equationShape,
  fakeEmf,
  groupSp,
  mr,
  oleFrame,
  para,
  picture,
  run,
  simpleSlide,
  smartArtFrame,
  tableFrame,
  textBox,
  titleSp,
  type DeckSpec,
  type SlideSpec,
} from './fixtures/pptx-builder';

async function parse(spec: DeckSpec | Uint8Array, limits?: Parameters<typeof parsePptx>[1]): Promise<ParsedDeck> {
  const bytes = spec instanceof Uint8Array ? spec : buildPptx(spec);
  return parsePptx(bytes, limits);
}

const shapes = (els: SlideElement[]) => els.filter((e): e is ShapeElement => e.kind === 'shape');
const own = (els: SlideElement[]) => els.filter((e) => !e.decorative);

describe('basic extraction', () => {
  it('extracts titles, nested bullets, notes and metadata', async () => {
    const deck = await parse({
      title: 'CS301 Lecture 1',
      author: 'Prof Turing',
      masterDecor: true,
      slides: [
        { layout: 1, shapes: titleSp(2, 'Introduction to Computability', 'ctrTitle') + bodySp(3, [para('CS301 — Lecture 1')]) },
        {
          shapes: titleSp(2, 'Turing Machines') + bodySp(3, [para('A Turing machine has a tape'), para('Infinite in both directions', { lvl: 1 }), para('Finite control')]),
          notes: 'Remember the 7-tuple definition.\nSecond note line',
        },
      ],
    });
    expect(deck.meta).toMatchObject({ title: 'CS301 Lecture 1', author: 'Prof Turing', slideCount: 2, slideWidth: 9144000, slideHeight: 6858000 });
    const [s1, s2] = deck.slides;
    expect(s1!.title).toBe('Introduction to Computability');
    expect(s1!.text).toBe('Introduction to Computability\n\nCS301 — Lecture 1'); // subtitle has no bullet (layout buNone)
    expect(s2!.title).toBe('Turing Machines');
    expect(s2!.text).toBe('Turing Machines\n\n- A Turing machine has a tape\n  - Infinite in both directions\n- Finite control');
    expect(s2!.notes).toBe('Remember the 7-tuple definition.\nSecond note line');
    // Master decoration text must never leak into study text.
    expect(deck.slides.every((s) => !s.text.includes('University of Testing'))).toBe(true);
    // ...but the decoration is kept as a decorative element for the preview.
    expect(s2!.elements.some((e) => e.decorative && e.kind === 'shape' && e.paragraphs[0]?.text.includes('University of Testing'))).toBe(true);
    expect(deck.report).toMatchObject({ totalSlides: 2, processedSlides: 2, failedSlides: 0, slidesWithNotes: 1, slidesRequiringAttention: [] });
    expect(deck.report.confidenceLabel).toBe('high');
  });

  it('resolves placeholder geometry and font sizes through layout and master', async () => {
    const deck = await parse({ slides: [simpleSlide('Heading', ['Point one', 'Point two'])] });
    const [title, body] = shapes(own(deck.slides[0]!.elements));
    expect(title!.role).toBe('title');
    expect(title!.box).toMatchObject({ x: 457200, y: 274638, w: 8229600, h: 1143000 });
    const t = title!.paragraphs[0]!.inlines[0]!;
    expect(t).toMatchObject({ kind: 'text', size: 44, bold: true });
    const b = body!.paragraphs[0]!;
    expect(b.bullet).toBe('bullet');
    expect(b.inlines[0]).toMatchObject({ kind: 'text', size: 32 });
  });

  it('keeps footers and slide numbers out of the study text', async () => {
    const footer =
      `<p:sp><p:nvSpPr><p:cNvPr id="9" name="Footer"/><p:cNvSpPr/><p:nvPr><p:ph type="ftr" idx="3"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${para('Footer: University')}</p:txBody></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="10" name="Num"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="4"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{1}" type="slidenum"><a:rPr lang="en-US"/><a:t>7</a:t></a:fld></a:p></p:txBody></p:sp>`;
    const deck = await parse({ slides: [{ shapes: titleSp(2, 'T') + bodySp(3, [para('Body')]) + footer }] });
    expect(deck.slides[0]!.text).toBe('T\n\n- Body');
    expect(deck.slides[0]!.flags.filter((f) => f.code === 'TEXT_NOT_CAPTURED')).toEqual([]);
  });

  it('merges split runs, keeps formatting and only accepts safe hyperlinks', async () => {
    const deck = await parse({
      slides: [
        {
          shapes:
            titleSp(2, 'Links') +
            textBox(3, 500000, 2000000, 5000000, 800000, [
              para([run('Hel', { b: true }), run('lo ', { b: true }), run('world', { i: true }), run(' site', { link: 'rIdOk' }), run(' bad', { link: 'rIdBad' })]),
            ]),
          rels: { rIdOk: ['hyperlink', 'https://example.com/x', true], rIdBad: ['hyperlink', 'javascript:alert(1)', true] },
        },
      ],
    });
    const box = shapes(deck.slides[0]!.elements).find((s) => s.isTextBox)!;
    const inl = box.paragraphs[0]!.inlines;
    expect(inl[0]).toMatchObject({ kind: 'text', text: 'Hello ', bold: true });
    expect(inl[1]).toMatchObject({ text: 'world', italic: true });
    expect(inl[2]).toMatchObject({ text: ' site', link: 'https://example.com/x' });
    expect(inl[3]).toMatchObject({ text: ' bad' });
    expect((inl[3] as { link?: string }).link).toBeUndefined();
  });
});

describe('tables', () => {
  it('extracts cells in order and records merged cells', async () => {
    const deck = await parse({
      slides: [{ shapes: titleSp(2, 'Compare') + tableFrame(4, [['Property', 'P', 'NP'], ['Verify', 'poly', 'poly'], ['Solve', 'poly', '?']], { merge: true }) }],
    });
    const slide = deck.slides[0]!;
    const table = slide.elements.find((e) => e.kind === 'table');
    expect(table?.kind === 'table' && table.rows.map((r) => r.map((c) => c.text))).toEqual([
      ['Property', 'P', 'NP'],
      ['Verify', '', 'poly'],
      ['Solve', 'poly', '?'],
    ]);
    expect(table?.kind === 'table' && table.rows[1]![0]).toMatchObject({ gridSpan: 2 });
    expect(slide.text).toContain('Property | P | NP');
    expect(slide.counts.tables).toBe(1);
    expect(deck.report.tables).toBe(1);
    expect(slide.flags.some((f) => f.code === 'MERGED_TABLE_CELLS')).toBe(true);
  });
});

describe('pictures and media', () => {
  it('sniffs the real image type instead of trusting the extension and flags large pictures', async () => {
    const deck = await parse({
      slides: [
        {
          shapes: titleSp(2, 'Screenshot') + picture(4, 'rIdImg1', 0, 1400000, 9144000, 5400000, 'Architecture diagram'),
          rels: { rIdImg1: ['image', '../media/image1.jpg'] }, // PNG bytes with a .jpg name
          parts: { 'ppt/media/image1.jpg': PNG_1X1 },
        },
      ],
    });
    const s = deck.slides[0]!;
    const pic = s.elements.find((e) => e.kind === 'picture');
    expect(pic).toMatchObject({ kind: 'picture', media: 'ppt/media/image1.jpg', mime: 'image/png', renderable: true });
    expect(pic?.kind === 'picture' && pic.coverage).toBeGreaterThan(0.7);
    expect(deck.media.get('ppt/media/image1.jpg')?.mime).toBe('image/png');
    expect(s.flags.map((f) => f.code)).toContain('LARGE_PICTURE');
    expect(s.confidence).toBe('medium');
    expect(s.text).toContain('[Picture: Architecture diagram]');
    expect(deck.report.pictures).toBe(1);
  });

  it('flags image-only slides as needing attention', async () => {
    const deck = await parse({
      slides: [{ shapes: picture(4, 'rIdImg1', 500000, 500000, 8000000, 5800000), rels: { rIdImg1: ['image', '../media/image1.png'] }, parts: { 'ppt/media/image1.png': PNG_1X1 } }],
    });
    const s = deck.slides[0]!;
    expect(s.flags.map((f) => f.code)).toContain('NO_EXTRACTABLE_TEXT');
    expect(s.confidence).toBe('low');
    expect(deck.report.slidesRequiringAttention).toEqual([1]);
    expect(deck.report.potentiallyMissing.join(' ')).toMatch(/No extractable text/);
    expect(deck.report.confidenceLabel).not.toBe('high');
  });

  it('flags EMF images as not displayable', async () => {
    const deck = await parse({
      slides: [
        {
          shapes: titleSp(2, 'Vector clip') + picture(4, 'rIdImg1', 500000, 1500000, 6000000, 4000000),
          rels: { rIdImg1: ['image', '../media/image1.emf'] },
          parts: { 'ppt/media/image1.emf': fakeEmf() },
        },
      ],
    });
    const pic = deck.slides[0]!.elements.find((e) => e.kind === 'picture');
    expect(pic).toMatchObject({ mime: 'image/x-emf', renderable: false });
    expect(deck.slides[0]!.flags.find((f) => f.code === 'UNRENDERABLE_IMAGE')?.severity).toBe('attention');
  });

  it('reports a missing embedded image instead of dropping it silently', async () => {
    const deck = await parse({
      slides: [{ shapes: titleSp(2, 'Gone') + picture(4, 'rIdImg1', 500000, 1500000, 6000000, 4000000), rels: { rIdImg1: ['image', '../media/missing.png'] } }],
    });
    expect(deck.slides[0]!.flags.find((f) => f.code === 'MISSING_MEDIA')?.severity).toBe('attention');
  });
});

describe('equations and symbols', () => {
  it('converts PowerPoint equations to LaTeX and ignores the picture fallback', async () => {
    const omml =
      `<m:f><m:num>${mr('a')}</m:num><m:den>${mr('b')}</m:den></m:f>` +
      mr('=') +
      `<m:sSup><m:e>${mr('x')}</m:e><m:sup>${mr('2')}</m:sup></m:sSup>` +
      `<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${mr('i=1')}</m:sub><m:sup>${mr('n')}</m:sup><m:e>${mr('i')}</m:e></m:nary>`;
    const deck = await parse({
      slides: [{ shapes: titleSp(2, 'Formula') + equationShape(5, omml), rels: { rIdImg1: ['image', '../media/image1.png'] }, parts: { 'ppt/media/image1.png': PNG_1X1 } }],
    });
    const s = deck.slides[0]!;
    expect(s.counts.equations).toBe(1);
    expect(s.elements.some((e) => e.kind === 'picture')).toBe(false); // fallback branch not used
    const math = shapes(s.elements).flatMap((sh) => sh.paragraphs.flatMap((p) => p.inlines)).find((i) => i.kind === 'math');
    expect(math).toMatchObject({ kind: 'math', display: true, partial: false });
    expect(math && math.kind === 'math' && math.latex).toBe('\\frac{a}{b} = {x}^{2} \\sum_{i=1}^{n} {i}');
    expect(math && math.kind === 'math' && math.plain).toBe('a/b=x^2∑_(i=1)^n i');
    expect(s.text).toContain('a/b=x^2');
    expect(s.flags.map((f) => f.code)).toContain('MATH_CONVERTED');
  });

  it('decodes Symbol-font text to real Greek letters', async () => {
    const deck = await parse({
      slides: [{ shapes: titleSp(2, 'Greek') + textBox(3, 500000, 2000000, 5000000, 800000, [para([run('a', { font: 'Symbol' }), run('', {}), run(' and '), run('', { sym: 'Symbol' })])]) }],
    });
    expect(deck.slides[0]!.text).toContain('αβ and Σ');
    expect(deck.slides[0]!.flags.some((f) => f.code === 'SYMBOL_FONT')).toBe(false);
  });

  it('warns when private-use symbol characters cannot be decoded', async () => {
    const deck = await parse({ slides: [{ shapes: titleSp(2, 'W') + textBox(3, 500000, 2000000, 5000000, 800000, [para([run('', { font: 'Wingdings' })])]) }] });
    expect(deck.slides[0]!.flags.some((f) => f.code === 'SYMBOL_FONT')).toBe(true);
  });
});

describe('diagrams, charts and objects', () => {
  const dgm = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
  const dsp = 'http://schemas.microsoft.com/office/drawing/2008/diagram';
  const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const t = (s: string) => `<dgm:t><a:bodyPr/><a:p><a:r><a:t>${s}</a:t></a:r></a:p></dgm:t>`;
  const smartArtSlide: SlideSpec = {
    shapes: titleSp(2, 'Architecture') + smartArtFrame(5, { dm: 'rIdDm', lo: 'rIdLo', qs: 'rIdQs', cs: 'rIdCs' }),
    rels: {
      rIdDm: ['diagramData', '../diagrams/data1.xml'],
      rIdLo: ['diagramLayout', '../diagrams/layout1.xml'],
      rIdQs: ['diagramQuickStyle', '../diagrams/quickStyle1.xml'],
      rIdCs: ['diagramColors', '../diagrams/colors1.xml'],
      rIdDrw: ['http://schemas.microsoft.com/office/2007/relationships/diagramDrawing', '../diagrams/drawing1.xml'],
    },
    parts: {
      'ppt/diagrams/data1.xml':
        `<dgm:dataModel xmlns:dgm="${dgm}" xmlns:a="${a}"><dgm:ptLst><dgm:pt modelId="{D}" type="doc"/>` +
        `<dgm:pt modelId="{1}">${t('Client')}</dgm:pt><dgm:pt modelId="{2}">${t('Web server')}</dgm:pt><dgm:pt modelId="{3}">${t('Database')}</dgm:pt>` +
        `<dgm:pt modelId="{P}" type="parTrans" cxnId="{c1}"/></dgm:ptLst><dgm:cxnLst>` +
        `<dgm:cxn modelId="{c0}" srcId="{D}" destId="{1}" srcOrd="0" destOrd="0"/><dgm:cxn modelId="{c1}" srcId="{1}" destId="{2}" srcOrd="0" destOrd="0"/><dgm:cxn modelId="{c2}" srcId="{1}" destId="{3}" srcOrd="1" destOrd="0"/>` +
        `</dgm:cxnLst><dgm:extLst><a:ext uri="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:dataModelExt xmlns:dsp="${dsp}" relId="rIdDrw" minVer="${dgm}"/></a:ext></dgm:extLst></dgm:dataModel>`,
      'ppt/diagrams/drawing1.xml':
        `<dsp:drawing xmlns:dsp="${dsp}" xmlns:a="${a}"><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>` +
        `<dsp:sp modelId="{1}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="1000" cy="500"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2E75B6"/></a:solidFill></dsp:spPr><dsp:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Client</a:t></a:r></a:p></dsp:txBody></dsp:sp>` +
        `<dsp:sp modelId="{2}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="1500" y="200"/><a:ext cx="1000" cy="500"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Web server</a:t></a:r></a:p></dsp:txBody></dsp:sp>` +
        `</dsp:spTree></dsp:drawing>`,
    },
  };

  it('reads SmartArt text, infers hierarchy, keeps the cached drawing and flags uncertainty', async () => {
    const deck = await parse({ slides: [smartArtSlide] });
    const s = deck.slides[0]!;
    const sa = s.elements.find((e) => e.kind === 'smartart');
    expect(sa?.kind === 'smartart' && sa.outline).toEqual([
      { text: 'Client', depth: 0 },
      { text: 'Web server', depth: 1 },
      { text: 'Database', depth: 1 },
    ]);
    expect(sa?.kind === 'smartart' && sa.shapes).toHaveLength(2);
    // Drawing coordinates are shifted to slide space by the frame origin (1,000,000 / 2,000,000).
    expect(sa?.kind === 'smartart' && sa.shapes[0]!.box).toMatchObject({ x: 1_000_100, y: 2_000_200 });
    expect(s.text).toContain('Diagram:\n- Client\n  - Web server\n  - Database');
    expect(s.flags.find((f) => f.code === 'SMARTART')?.severity).toBe('warning');
    expect(s.confidence).toBe('medium');
    expect(deck.report.smartArt).toBe(1);
  });

  it('reads chart values from the chart cache', async () => {
    const c = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
    const chartXml =
      `<c:chartSpace xmlns:c="${c}" xmlns:a="${a}"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Runtime</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart>` +
      `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:f>S!A1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Quick</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
      `<c:cat><c:strRef><c:f>S!A2:A4</c:f><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>n=10</c:v></c:pt><c:pt idx="1"><c:v>n=100</c:v></c:pt><c:pt idx="2"><c:v>n=1000</c:v></c:pt></c:strCache></c:strRef></c:cat>` +
      `<c:val><c:numRef><c:f>S!B2:B4</c:f><c:numCache><c:ptCount val="3"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>7</c:v></c:pt><c:pt idx="2"><c:v>10</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>` +
      `</c:barChart></c:plotArea></c:chart></c:chartSpace>`;
    const deck = await parse({
      slides: [{ shapes: titleSp(2, 'Performance') + chartFrame(4, 'rIdChart'), rels: { rIdChart: ['chart', '../charts/chart1.xml'] }, parts: { 'ppt/charts/chart1.xml': chartXml } }],
    });
    const s = deck.slides[0]!;
    const chart = s.elements.find((e) => e.kind === 'chart');
    expect(chart?.kind === 'chart' && chart.chart).toEqual({
      chartType: 'bar',
      title: 'Runtime',
      categories: ['n=10', 'n=100', 'n=1000'],
      series: [{ name: 'Quick', values: [1, 7, 10] }],
    });
    expect(s.text).toContain('Chart (bar): Runtime');
    expect(s.text).toContain('Quick: 1, 7, 10');
    expect(s.confidence).toBe('high'); // data recovered => info only
    expect(deck.report.charts).toBe(1);
  });

  it('flags a chart with no readable data as needing attention', async () => {
    const deck = await parse({
      slides: [{ shapes: titleSp(2, 'Chart') + chartFrame(4, 'rIdChart'), rels: { rIdChart: ['chart', '../charts/missing.xml'] } }],
    });
    expect(deck.slides[0]!.flags.find((f) => f.code === 'CHART_NO_DATA')?.severity).toBe('attention');
    expect(deck.slides[0]!.confidence).toBe('low');
  });

  it('flags old equation objects and OLE objects without pretending to read them', async () => {
    const deck = await parse({
      slides: [
        { shapes: titleSp(2, 'Old eq') + oleFrame(4, 'Equation.3', 'rIdPrev'), rels: { rIdPrev: ['image', '../media/p.png'] }, parts: { 'ppt/media/p.png': PNG_1X1 } },
        { shapes: titleSp(2, 'Sheet') + oleFrame(4, 'Excel.Sheet.12', 'rIdPrev'), rels: { rIdPrev: ['image', '../media/p.png'] } },
      ],
    });
    expect(deck.slides[0]!.flags.map((f) => f.code)).toContain('EQUATION_OBJECT');
    expect(deck.slides[1]!.flags.map((f) => f.code)).toContain('OLE_OBJECT');
    expect(deck.report.oleObjects).toBe(2);
    expect(deck.report.slidesRequiringAttention).toEqual([1, 2]);
  });

  it('never silently drops text in unsupported containers', async () => {
    const mystery =
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Mystery"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="http://example.com/future-thing"><a:p><a:r><a:t>Hidden exam hint</a:t></a:r></a:p></a:graphicData></a:graphic></p:graphicFrame>`;
    const deck = await parse({ slides: [{ shapes: titleSp(2, 'T') + mystery }] });
    const s = deck.slides[0]!;
    expect(s.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['UNSUPPORTED_OBJECT', 'TEXT_NOT_CAPTURED']));
    expect(s.text).toContain('[Unplaced text]\nHidden exam hint');
    expect(s.coverage.missing).toEqual(['Hidden exam hint']);
    expect(s.confidence).toBe('low');
  });
});

describe('structure', () => {
  it('applies group transforms to child shapes', async () => {
    const inner = textBox(11, 1_000_000, 1_000_000, 2_000_000, 1_000_000, [para('Grouped')]);
    const deck = await parse({ slides: [{ shapes: titleSp(2, 'G') + groupSp(10, [1_000_000, 2_000_000], [2_000_000, 2_000_000], [0, 0], [4_000_000, 4_000_000], inner, 'Diagram group') }] });
    const g = shapes(deck.slides[0]!.elements).find((s) => s.paragraphs[0]?.text === 'Grouped')!;
    expect(g.box).toMatchObject({ x: 1_500_000, y: 2_500_000, w: 1_000_000, h: 500_000 });
    expect(g.groupPath).toEqual(['Diagram group']);
  });

  it('records hidden slides, hidden shapes and animations', async () => {
    const hiddenShape = `<p:sp><p:nvSpPr><p:cNvPr id="8" name="Answer" hidden="1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${para('Secret answer')}</p:txBody></p:sp>`;
    const deck = await parse({
      slides: [
        {
          hidden: true,
          shapes: titleSp(2, 'Hidden') + hiddenShape,
          tail: '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:par><p:cTn id="2" presetID="1" presetClass="entr" fill="hold"/></p:par></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>',
        },
      ],
    });
    const s = deck.slides[0]!;
    expect(s.hidden).toBe(true);
    expect(s.hasAnimations).toBe(true);
    expect(s.text).toBe('Hidden'); // hidden shape is not study text...
    expect(s.elements.some((e) => e.hidden)).toBe(true); // ...but is kept
    expect(s.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['HIDDEN_SLIDE', 'ANIMATIONS', 'HIDDEN_SHAPE']));
    expect(deck.report.hiddenSlides).toEqual([1]);
    expect(s.coverage.missing).toEqual([]); // hidden text still counts as captured
  });

  it('turns PowerPoint sections into topics', async () => {
    const deck = await parse({
      sections: [
        { name: 'Basics', slides: [1, 2] },
        { name: 'Undecidability', slides: [3, 4] },
      ],
      slides: [simpleSlide('A', ['x']), simpleSlide('B', ['y']), simpleSlide('Halting problem', ['z']), simpleSlide('Reductions', ['w'])],
    });
    expect(deck.report.topics.map((t) => [t.title, t.startSlide, t.endSlide, t.source])).toEqual([
      ['Basics', 1, 2, 'section'],
      ['Undecidability', 3, 4, 'section'],
    ]);
  });

  it('falls back to section-header layouts, then to title runs', async () => {
    const withHeaders = await parse({
      slides: [
        { layout: 3, shapes: titleSp(2, 'Part 1: Automata') },
        simpleSlide('DFA', ['a']),
        simpleSlide('NFA', ['b']),
        { layout: 3, shapes: titleSp(2, 'Part 2: Complexity') },
        simpleSlide('P vs NP', ['c']),
      ],
    });
    expect(withHeaders.report.topics.map((t) => [t.title, t.startSlide, t.endSlide, t.source])).toEqual([
      ['Part 1: Automata', 1, 3, 'layout'],
      ['Part 2: Complexity', 4, 5, 'layout'],
    ]);
    const byTitle = await parse({ slides: [simpleSlide('Sorting', ['a']), simpleSlide('Sorting (cont.)', ['b']), simpleSlide('Hashing', ['c'])] });
    expect(byTitle.report.topics.map((t) => [t.title, t.startSlide, t.endSlide, t.source])).toEqual([
      ['Sorting', 1, 2, 'title'],
      ['Hashing', 3, 3, 'title'],
    ]);
  });
});

describe('robustness', () => {
  it('isolates a corrupt slide and still processes the rest', async () => {
    const deck = await parse({
      slides: [simpleSlide('Good one', ['a']), { shapes: '', rawSlideXml: '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><unclosed></p:cSld></p:sld>' }, simpleSlide('Good two', ['b'])],
    });
    expect(deck.slides.map((s) => s.status)).toEqual(['ok', 'failed', 'ok']);
    expect(deck.slides[1]!.flags[0]).toMatchObject({ code: 'SLIDE_PARSE_FAILED', severity: 'attention' });
    expect(deck.report).toMatchObject({ totalSlides: 3, processedSlides: 2, failedSlides: 1, slidesRequiringAttention: [2] });
    expect(deck.report.confidenceLabel).not.toBe('high');
  });

  it('refuses slides that declare a DTD (XXE / entity expansion) but keeps the deck', async () => {
    const evil = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>';
    const deck = await parse({ slides: [simpleSlide('Ok', ['a']), { shapes: '', rawSlideXml: evil }] });
    expect(deck.slides[1]!.status).toBe('failed');
    expect(deck.slides[1]!.flags[0]!.message).toMatch(/DTD or entity declarations are not allowed/);
  });

  it('rejects files that are not presentations', async () => {
    const docx = zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': strToU8('<w:document xmlns:w="x"/>'),
    });
    await expect(parsePptx(docx)).rejects.toMatchObject({ code: 'NOT_PPTX', message: expect.stringContaining('Word document') });
    await expect(parsePptx(strToU8('plainly not a zip file, just text, long enough to pass the size check'))).rejects.toBeInstanceOf(PptxError);
    await expect(parsePptx(zipSync({ 'hello.txt': strToU8('hi') }))).rejects.toMatchObject({ code: 'NOT_PPTX' });
  });

  it('enforces size limits from the caller', async () => {
    const bytes = buildPptx({ slides: [simpleSlide('A', ['x'])] });
    await expect(parsePptx(bytes, { limits: { maxFileBytes: 100 } })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(parsePptx(bytes, { limits: { maxSlides: 0 } })).rejects.toMatchObject({ code: 'TOO_MANY_SLIDES' });
  });

  it('reports progress for every slide', async () => {
    const seen: number[] = [];
    await parsePptx(buildPptx({ slides: [simpleSlide('A', ['x']), simpleSlide('B', ['y']), simpleSlide('C', ['z'])] }), { onProgress: (d) => seen.push(d) });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('produces a stable content hash that matches SHA-256', async () => {
    const bytes = buildPptx({ slides: [simpleSlide('A', ['x'])] });
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect((await parsePptx(bytes)).fileHash).toBe(expected);
    expect(sha256Fallback(bytes)).toBe(expected);
    expect(sha256Fallback(new Uint8Array(0))).toBe(createHash('sha256').update('').digest('hex'));
    expect(sha256Fallback(strToU8('a'.repeat(1000)))).toBe(createHash('sha256').update('a'.repeat(1000)).digest('hex'));
  });
});

describe('real-world lecture quirks (found by running real decks)', () => {
  const mathBox = (omml: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="5" name="Math"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="1800000"/><a:ext cx="6000000" cy="800000"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a14:m xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${omml}</m:oMath></a14:m>${run(' halts on input w')}</a:p></p:txBody></p:sp>`;

  it('folds Unicode math letters, keeps spacing and reads baseline subscripts inside math runs', async () => {
    // 𝐴 (math italic A) followed by a "normal text" run lowered by baseline, then a trailing space.
    const omml = '<m:r><a:rPr/><m:t>\u{1D434}</m:t></m:r><m:r><m:rPr><m:nor/></m:rPr><a:rPr baseline="-25000"/><m:t>TM</m:t></m:r><m:r><m:t> </m:t></m:r>';
    const deck = await parse({ slides: [{ shapes: titleSp(2, 'Reductions') + mathBox(omml) }] });
    const m = shapes(deck.slides[0]!.elements).flatMap((s) => s.paragraphs.flatMap((p) => p.inlines)).find((i) => i.kind === 'math');
    expect(m && m.kind === 'math' && m.latex).toBe(String.raw`A _{\text{TM}}`);
    expect(m && m.kind === 'math' && m.plain).toBe('A_{TM} ');
    expect(deck.slides[0]!.text).toContain('A_{TM} halts on input w'); // the equation does not fuse with the next word (runs of spaces collapse to one)
  });

  it('keeps the spaces between words inside an equation and draws all three kinds of angle bracket as one', async () => {
    // found on a real lecture: "M accepts w" is written as M, a non-breaking space, the text "accepts", a space, w; LaTeX ignores
    // spaces in math, so it was drawn as "Maccepts w". The pair of brackets is typed as U+3008/U+3009 in one place and as ⟨ ⟩ or
    // \left\langle in others; KaTeX has no glyph for the first.
    const nb = ' ';
    const omml =
      `<m:r><m:t>${nb}</m:t></m:r><m:r><m:t>\u{1D440}</m:t></m:r><m:r><m:t>${nb}</m:t></m:r><m:r><m:rPr><m:nor/></m:rPr><m:t>accepts</m:t></m:r><m:r><m:t>${nb}</m:t></m:r><m:r><m:t>\u{1D464}</m:t></m:r>` +
      `<m:r><m:t> = 〈</m:t></m:r><m:r><m:t>\u{1D440}</m:t></m:r><m:r><m:t>〉⟨⟩〈〉</m:t></m:r><m:r><m:t>${nb}</m:t></m:r>`;
    const deck = await parse({ slides: [{ shapes: titleSp(2, 'Acceptance') + mathBox(omml) }] });
    const m = shapes(deck.slides[0]!.elements).flatMap((s) => s.paragraphs.flatMap((p) => p.inlines)).find((i) => i.kind === 'math');
    expect(m && m.kind === 'math' && m.latex).toBe(String.raw`M \ \text{accepts} \ w =\langle M \rangle \langle \rangle \langle \rangle`);
    expect(m && m.kind === 'math' && m.plain).toContain('M accepts w');
    expect(m && m.kind === 'math' && m.partial).toBe(false);
  });

  it('marks subscript and superscript text runs in study text', async () => {
    const deck = await parse({
      slides: [{ shapes: titleSp(2, 'Notation') + textBox(3, 500000, 2000000, 5000000, 800000, [para([run('A'), run('NFA', { baseline: -25000 }), run(' and x'), run('2', { baseline: 30000 })])]) }],
    });
    expect(deck.slides[0]!.text).toContain('A_{NFA} and x^2');
  });

  it('infers a title from the largest top text when the slide has no title placeholder', async () => {
    const deck = await parse({
      slides: [{ shapes: textBox(2, 300000, 200000, 8000000, 800000, [para([run('The Reducibility Method', { sz: 4000 })])]) + textBox(3, 300000, 1500000, 8000000, 3000000, [para([run('Body text goes here', { sz: 2400 })])]) }],
    });
    expect(deck.slides[0]!.title).toBe('The Reducibility Method');
    // ...but never from tiny or body-sized text
    const none = await parse({ slides: [{ shapes: textBox(2, 300000, 200000, 8000000, 800000, [para([run('just a note', { sz: 1400 })])]) }] });
    expect(none.slides[0]!.title).toBe('');
  });

  it('treats a hand-typed slide number at the bottom as furniture', async () => {
    const deck = await parse({
      slides: [simpleSlide('One', ['a']), { shapes: titleSp(2, 'Two') + bodySp(3, [para('b')]) + textBox(9, 5_600_000, 6_480_000, 300_000, 369_000, [para('2')]) }],
    });
    expect(deck.slides[1]!.text).toBe('Two\n\n- b');
    // a genuine "2" elsewhere (or a different number) is kept
    const keep = await parse({ slides: [{ shapes: titleSp(2, 'Count') + textBox(9, 500_000, 3_000_000, 300_000, 369_000, [para('2')]) }] });
    expect(keep.slides[0]!.text).toContain('2');
  });

  it('skips field-only paragraphs (slide number / date) in study text', async () => {
    const field = `<p:sp><p:nvSpPr><p:cNvPr id="9" name="num"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="3000000"/><a:ext cx="300000" cy="300000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{1}" type="slidenum"><a:rPr lang="en-US"/><a:t>7</a:t></a:fld></a:p></p:txBody></p:sp>`;
    const deck = await parse({ slides: [{ shapes: titleSp(2, 'F') + field }] });
    expect(deck.slides[0]!.text).toBe('F');
    expect(deck.slides[0]!.coverage.missing).toEqual([]);
  });

  it('weights overall confidence so SmartArt-heavy decks are not rated low', async () => {
    const dgm = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
    const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const sa: SlideSpec = {
      shapes: titleSp(2, 'D') + smartArtFrame(5, { dm: 'rIdDm', lo: 'rIdLo', qs: 'rIdQs', cs: 'rIdCs' }),
      rels: { rIdDm: ['diagramData', '../diagrams/data1.xml'] },
      parts: { 'ppt/diagrams/data1.xml': `<dgm:dataModel xmlns:dgm="${dgm}" xmlns:a="${a}"><dgm:ptLst><dgm:pt modelId="{1}"><dgm:t><a:p><a:r><a:t>Node</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst><dgm:cxnLst/></dgm:dataModel>` },
    };
    const deck = await parse({ slides: [sa, sa, simpleSlide('x', ['y'])] });
    expect(deck.slides.map((s) => s.confidence)).toEqual(['medium', 'medium', 'high']);
    expect(deck.report.overallConfidence).toBeCloseTo((0.75 + 0.75 + 1) / 3, 2);
    expect(deck.report.confidenceLabel).toBe('medium');
  });
});

describe('math script handling (found on a real slide)', () => {
  const box = (omml: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="5" name="M"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="1800000"/><a:ext cx="6000000" cy="800000"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a14:m xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${omml}</m:oMath></a14:m></a:p></p:txBody></p:sp>`;
  const sub = (t: string, sz = '') => `<m:r><m:rPr><m:nor/></m:rPr><a:rPr baseline="-25000"${sz}/><m:t>${t}</m:t></m:r>`;
  const latexOf = async (omml: string) => {
    const deck = await parse({ slides: [{ shapes: titleSp(2, 'T') + box(omml) }] });
    const m = shapes(deck.slides[0]!.elements).flatMap((s) => s.paragraphs.flatMap((p) => p.inlines)).find((i) => i.kind === 'math');
    return m && m.kind === 'math' ? m.latex : undefined;
  };

  it('never emits a double subscript: adjacent subscript runs are merged', async () => {
    expect(await latexOf(mr('A') + sub('TM') + sub('x'))).toBe(String.raw`A _{\text{TM}\text{x}}`);
  });

  it('ignores blank subscript runs entirely', async () => {
    const latex = await latexOf(mr('A') + sub('TM') + sub(' ') + mr('≤') + sub('m'));
    expect(latex).toBe(String.raw`A _{\text{TM}} ≤ _{\text{m}}`);
    expect(latex).not.toMatch(/_\{[^}]*\}\s*_\{/);
  });
});
