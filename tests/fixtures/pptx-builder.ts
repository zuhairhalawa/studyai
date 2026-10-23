import { zipSync, strToU8 } from 'fflate';

/**
 * Programmatic PPTX writer for tests. It produces structurally valid OOXML
 * packages (content types, relationships, master/layouts/theme, notes) so the
 * extraction engine can be exercised on exactly the constructs we care about.
 */

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export function fakeEmf(): Uint8Array {
  const b = new Uint8Array(100);
  b[0] = 1;
  b.set([0x20, 0x45, 0x4d, 0x46], 40);
  return b;
}

const GRP_HEADER =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

// ---------------------------------------------------------------------------
// XML snippet helpers
// ---------------------------------------------------------------------------

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface RunOpts {
  b?: boolean;
  i?: boolean;
  sz?: number;
  font?: string;
  sym?: string;
  baseline?: number;
  color?: string;
  link?: string;
}

export function run(text: string, o: RunOpts = {}): string {
  const attrs = [`lang="en-US"`, o.b ? 'b="1"' : '', o.i ? 'i="1"' : '', o.sz ? `sz="${o.sz}"` : '', o.baseline ? `baseline="${o.baseline}"` : '']
    .filter(Boolean)
    .join(' ');
  const kids =
    (o.color ? `<a:solidFill><a:srgbClr val="${o.color}"/></a:solidFill>` : '') +
    (o.font ? `<a:latin typeface="${o.font}"/>` : '') +
    (o.sym ? `<a:sym typeface="${o.sym}"/>` : '') +
    (o.link ? `<a:hlinkClick r:id="${o.link}"/>` : '');
  return `<a:r><a:rPr ${attrs}>${kids}</a:rPr><a:t>${esc(text)}</a:t></a:r>`;
}

export function para(content: string | string[], o: { lvl?: number; bullet?: 'none' | 'char' | 'num' } = {}): string {
  const inner = Array.isArray(content) ? content.join('') : run(content);
  const bu = o.bullet === 'none' ? '<a:buNone/>' : o.bullet === 'char' ? '<a:buChar char="•"/>' : o.bullet === 'num' ? '<a:buAutoNum type="arabicPeriod"/>' : '';
  const attrs = o.lvl ? ` lvl="${o.lvl}"` : '';
  return `<a:p>${bu || attrs ? `<a:pPr${attrs}>${bu}</a:pPr>` : ''}${inner}</a:p>`;
}

export function titleSp(id: number, text: string, type: 'title' | 'ctrTitle' = 'title'): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Title ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${para(text)}</p:txBody></p:sp>`
  );
}

export function bodySp(id: number, paragraphs: string[], idx = 1): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Content ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="${idx}"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`
  );
}

export function textBox(id: number, x: number, y: number, w: number, h: number, paragraphs: string[], extra = ''): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"${extra}/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`
  );
}

export function picture(id: number, rId: string, x: number, y: number, w: number, h: number, descr = ''): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${esc(descr)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

export function tableFrame(id: number, rows: string[][], opts: { merge?: boolean } = {}): string {
  const cols = rows[0]?.length ?? 1;
  const grid = Array.from({ length: cols }, () => '<a:gridCol w="2000000"/>').join('');
  const trs = rows
    .map((r, ri) => {
      const tcs = r
        .map((cell, ci) => {
          if (opts.merge && ri === 1 && ci === 0) return `<a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:lstStyle/>${para(cell)}</a:txBody></a:tc>`;
          if (opts.merge && ri === 1 && ci === 1) return `<a:tc hMerge="1"><a:txBody><a:bodyPr/><a:lstStyle/>${para('')}</a:txBody></a:tc>`;
          return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(cell)}</a:txBody></a:tc>`;
        })
        .join('');
      return `<a:tr h="370840">${tcs}</a:tr>`;
    })
    .join('');
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="500000" y="1800000"/><a:ext cx="${cols * 2000000}" cy="1500000"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

export function groupSp(id: number, off: [number, number], ext: [number, number], chOff: [number, number], chExt: [number, number], inner: string, name = `Group ${id}`): string {
  return (
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="${off[0]}" y="${off[1]}"/><a:ext cx="${ext[0]}" cy="${ext[1]}"/><a:chOff x="${chOff[0]}" y="${chOff[1]}"/><a:chExt cx="${chExt[0]}" cy="${chExt[1]}"/></a:xfrm></p:grpSpPr>` +
    `${inner}</p:grpSp>`
  );
}

export function chartFrame(id: number, rId: string): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="500000" y="1800000"/><a:ext cx="6000000" cy="3500000"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rId}"/></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

export function smartArtFrame(id: number, rIds: { dm: string; lo: string; qs: string; cs: string }): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Diagram ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="1000000" y="2000000"/><a:ext cx="6000000" cy="3000000"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="${rIds.dm}" r:lo="${rIds.lo}" r:qs="${rIds.qs}" r:cs="${rIds.cs}"/></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

export function oleFrame(id: number, progId: string, previewRid: string): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Object ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="1000000" y="2000000"/><a:ext cx="2000000" cy="800000"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj name="Obj" r:id="rIdOle" imgW="100" imgH="40" progId="${progId}">` +
    `<p:embed/><p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${previewRid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
    `</p:oleObj></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/** An equation shape the way PowerPoint 2010+ writes it (AlternateContent with picture fallback). `box` is its x, y, width and height in EMU. */
export function equationShape(id: number, omml: string, box: [number, number, number, number] = [1000000, 3500000, 4000000, 800000]): string {
  const [x, y, w, h] = box;
  return (
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    `<mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14">` +
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Equation ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath>${omml}</m:oMath></m:oMathPara></a14:m><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>` +
    `</mc:Choice><mc:Fallback>` +
    `<p:pic><p:nvPicPr><p:cNvPr id="${id + 100}" name="Equation fallback"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
    `</mc:Fallback></mc:AlternateContent>`
  );
}

export const mr = (t: string, sty?: string) => `<m:r>${sty ? `<m:rPr><m:sty m:val="${sty}"/></m:rPr>` : ''}<m:t>${esc(t)}</m:t></m:r>`;

// ---------------------------------------------------------------------------
// Package assembly
// ---------------------------------------------------------------------------

export interface SlideSpec {
  /** Inner XML of the p:spTree (shapes only). */
  shapes: string;
  layout?: 1 | 2 | 3;
  notes?: string;
  hidden?: boolean;
  /** Additional relationships: id → [type suffix, target, external?]. */
  rels?: Record<string, [string, string, boolean?]>;
  /** Additional package parts (path → bytes/text). */
  parts?: Record<string, string | Uint8Array>;
  /** Raw XML placed after cSld (e.g. <p:timing>). */
  tail?: string;
  /** Replace the whole slide XML (to inject malformed content). */
  rawSlideXml?: string;
  bg?: string;
}

export interface DeckSpec {
  slides: SlideSpec[];
  title?: string;
  author?: string;
  sections?: { name: string; slides: number[] }[];
  /** Include a decorative text shape on the master. */
  masterDecor?: boolean;
  extraParts?: Record<string, string | Uint8Array>;
  extraContentTypes?: string;
}

const relsXml = (items: { id: string; type: string; target: string; external?: boolean }[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type.startsWith('http') ? r.type : `${REL}/${r.type}`}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`;

function themeXml(): string {
  const c = (n: string, v: string) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test"><a:themeElements>` +
    `<a:clrScheme name="Test">${c('dk1', '000000')}${c('lt1', 'FFFFFF')}${c('dk2', '1F3864')}${c('lt2', 'EEEEEE')}${c('accent1', '2E75B6')}${c('accent2', 'ED7D31')}${c('accent3', 'A5A5A5')}${c('accent4', 'FFC000')}${c('accent5', '5B9BD5')}${c('accent6', '70AD47')}${c('hlink', '0563C1')}${c('folHlink', '954F72')}</a:clrScheme>` +
    `<a:fontScheme name="Test"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Test"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>` +
    `</a:themeElements></a:theme>`
  );
}

function ph(id: number, name: string, type: string | undefined, idx: number | undefined, box: [number, number, number, number], lst = '', text = 'Click to edit'): string {
  const attrs = `${type ? ` type="${type}"` : ''}${idx !== undefined ? ` idx="${idx}"` : ''}`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${attrs}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/>${lst || '<a:lstStyle/>'}<a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

function masterXml(decor: boolean): string {
  const decorShape = decor
    ? textBox(90, 100000, 6400000, 3000000, 300000, [para('University of Testing — CS101')])
    : '';
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP_HEADER}` +
    ph(2, 'Title Placeholder 1', 'title', undefined, [457200, 274638, 8229600, 1143000]) +
    ph(3, 'Text Placeholder 2', 'body', 1, [457200, 1600200, 8229600, 4525963]) +
    ph(4, 'Footer Placeholder 3', 'ftr', 3, [3124200, 6356350, 2895600, 365125], '', 'Footer text') +
    ph(5, 'Slide Number Placeholder 4', 'sldNum', 4, [6553200, 6356350, 2133600, 365125], '', '‹#›') +
    decorShape +
    `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/><p:sldLayoutId id="2147483651" r:id="rId3"/></p:sldLayoutIdLst>` +
    `<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"/></a:lvl1pPr></p:titleStyle>` +
    `<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="•"/><a:defRPr sz="3200"/></a:lvl1pPr><a:lvl2pPr marL="742950" indent="-285750"><a:buChar char="–"/><a:defRPr sz="2800"/></a:lvl2pPr></p:bodyStyle>` +
    `<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`
  );
}

function layoutXml(kind: 1 | 2 | 3): string {
  const spec = {
    1: { type: 'title', name: 'Title Slide', shapes: ph(2, 'Title 1', 'ctrTitle', undefined, [685800, 2130425, 7772400, 1470025]) + ph(3, 'Subtitle 2', 'subTitle', 1, [1371600, 3886200, 6400800, 1752600], '<a:lstStyle><a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle>') },
    2: { type: 'obj', name: 'Title and Content', shapes: ph(2, 'Title 1', 'title', undefined, [457200, 274638, 8229600, 1143000]) + ph(3, 'Content Placeholder 2', undefined, 1, [457200, 1600200, 8229600, 4525963]) },
    3: { type: 'secHead', name: 'Section Header', shapes: ph(2, 'Title 1', 'title', undefined, [722313, 4406900, 7772400, 1362075]) },
  }[kind];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${NS} type="${spec.type}"><p:cSld name="${spec.name}"><p:spTree>${GRP_HEADER}${spec.shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

export function buildPptx(deck: DeckSpec): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, data: string | Uint8Array) => {
    files[path] = typeof data === 'string' ? strToU8(data) : data;
  };

  const overrides: string[] = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`,
  ];
  for (const n of [1, 2, 3]) overrides.push(`<Override PartName="/ppt/slideLayouts/slideLayout${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`);

  put('_rels/.rels', relsXml([
    { id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' },
  ]));
  put('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>${esc(deck.title ?? 'Test deck')}</dc:title><dc:creator>${esc(deck.author ?? 'Dr Test')}</dc:creator><dcterms:created>2026-01-01T00:00:00Z</dcterms:created><dcterms:modified>2026-02-01T00:00:00Z</dcterms:modified></cp:coreProperties>`);
  put('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office PowerPoint</Application></Properties>`);
  put('ppt/theme/theme1.xml', themeXml());
  put('ppt/slideMasters/slideMaster1.xml', masterXml(deck.masterDecor ?? false));
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', relsXml([
    { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: 'slideLayout', target: '../slideLayouts/slideLayout2.xml' },
    { id: 'rId3', type: 'slideLayout', target: '../slideLayouts/slideLayout3.xml' },
    { id: 'rId4', type: 'theme', target: '../theme/theme1.xml' },
  ]));
  for (const n of [1, 2, 3] as const) {
    put(`ppt/slideLayouts/slideLayout${n}.xml`, layoutXml(n));
    put(`ppt/slideLayouts/_rels/slideLayout${n}.xml.rels`, relsXml([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]));
  }

  const presRels: { id: string; type: string; target: string }[] = [{ id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }];
  const sldIds: string[] = [];
  deck.slides.forEach((s, i) => {
    const n = i + 1;
    const rid = `rId${n + 1}`;
    presRels.push({ id: rid, type: 'slide', target: `slides/slide${n}.xml` });
    sldIds.push(`<p:sldId id="${255 + n}" r:id="${rid}"/>`);
    overrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);

    const slideRels: { id: string; type: string; target: string; external?: boolean }[] = [
      { id: 'rIdLayout', type: 'slideLayout', target: `../slideLayouts/slideLayout${s.layout ?? 2}.xml` },
    ];
    for (const [id, [type, target, external]] of Object.entries(s.rels ?? {})) slideRels.push({ id, type, target, external });
    if (s.notes !== undefined) {
      slideRels.push({ id: 'rIdNotes', type: 'notesSlide', target: `../notesSlides/notesSlide${n}.xml` });
      overrides.push(`<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`);
      put(
        `ppt/notesSlides/notesSlide${n}.xml`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${NS}><p:cSld><p:spTree>${GRP_HEADER}` +
          `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
          `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${s.notes
            .split('\n')
            .map((l) => para(l))
            .join('')}</p:txBody></p:sp>` +
          `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number Placeholder 3"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="10"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{00000000-0000-0000-0000-000000000000}" type="slidenum"><a:rPr lang="en-US"/><a:t>${n}</a:t></a:fld></a:p></p:txBody></p:sp>` +
          `</p:spTree></p:cSld></p:notes>`,
      );
      put(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, relsXml([{ id: 'rId1', type: 'slide', target: `../slides/slide${n}.xml` }]));
    }
    put(`ppt/slides/_rels/slide${n}.xml.rels`, relsXml(slideRels));
    put(
      `ppt/slides/slide${n}.xml`,
      s.rawSlideXml ??
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}${s.hidden ? ' show="0"' : ''}><p:cSld>${s.bg ? `<p:bg><p:bgPr>${s.bg}<a:effectLst/></p:bgPr></p:bg>` : ''}<p:spTree>${GRP_HEADER}${s.shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${s.tail ?? ''}</p:sld>`,
    );
    for (const [path, data] of Object.entries(s.parts ?? {})) put(path, data);
  });

  const sections = deck.sections
    ? `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">${deck.sections
        .map((sec, k) => `<p14:section name="${esc(sec.name)}" id="{0000000${k}-0000-0000-0000-000000000000}"><p14:sldIdLst>${sec.slides.map((n) => `<p14:sldId id="${255 + n}"/>`).join('')}</p14:sldIdLst></p14:section>`)
        .join('')}</p14:sectionLst></p:ext></p:extLst>`
    : '';
  put('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${sldIds.join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle>${sections}</p:presentation>`);
  put('ppt/_rels/presentation.xml.rels', relsXml(presRels));
  for (const [path, data] of Object.entries(deck.extraParts ?? {})) put(path, data);

  put(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="emf" ContentType="image/x-emf"/>${overrides.join('')}${deck.extraContentTypes ?? ''}</Types>`,
  );
  return zipSync(files, { level: 6 });
}

/** Convenience: a slide with a single title and bullets. */
export function simpleSlide(title: string, bullets: string[], notes?: string): SlideSpec {
  return { shapes: titleSp(2, title) + bodySp(3, bullets.map((b) => para(b))), notes };
}

/** A straight connector with an arrowhead at its end. */
export function arrowLine(id: number, x: number, y: number, w: number, h: number): string {
  return (
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Connector ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom>` +
    `<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>`
  );
}
