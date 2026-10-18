import type { ChartData } from './model';
import { child, descendants, firstDescendant, kids, numAttr, ownText, type XNode } from './xml';

const CHART_TYPE = /^c:(bar|bar3D|line|line3D|pie|pie3D|doughnut|area|area3D|scatter|bubble|radar|stock|surface|surface3D|ofPie)Chart$/;

/** Read a c:strRef / c:numRef / c:strLit / c:numLit into an index-ordered array. */
function readCache(ref: XNode | undefined): (string | number)[] {
  if (!ref) return [];
  const container =
    child(ref, 'c:strRef') ?? child(ref, 'c:numRef') ?? child(ref, 'c:multiLvlStrRef') ?? ref;
  const cache = child(container, 'c:strCache') ?? child(container, 'c:numCache') ?? child(container, 'c:multiLvlStrCache') ?? child(container, 'c:strLit') ?? child(container, 'c:numLit');
  if (!cache) return [];
  const count = numAttr(child(cache, 'c:ptCount'), 'val') ?? 0;
  const out: (string | number)[] = new Array(Math.min(count, 10_000)).fill('');
  // Multi-level categories: the first c:lvl holds the leaf labels.
  const lvl = child(cache, 'c:lvl');
  const pts = kids(lvl ?? cache, 'c:pt');
  for (const pt of pts) {
    const idx = numAttr(pt, 'idx');
    const v = ownText(child(pt, 'c:v'));
    if (idx === undefined || idx < 0 || idx >= out.length) continue;
    const num = Number(v);
    out[idx] = v !== '' && Number.isFinite(num) && child(container, 'c:numCache') ? num : v;
  }
  return out;
}

function seriesName(ser: XNode): string {
  const tx = child(ser, 'c:tx');
  const v = firstDescendant(tx, 'c:v');
  return v ? ownText(v) : '';
}

export function parseChartPart(root: XNode): ChartData | null {
  const chart = child(root, 'c:chart');
  const plotArea = child(chart, 'c:plotArea');
  if (!plotArea) return null;
  const types: string[] = [];
  const series: ChartData['series'] = [];
  const xValues: (string | number)[][] = [];
  let categories: string[] = [];

  for (const plot of plotArea.children) {
    const m = CHART_TYPE.exec(plot.name);
    if (!m) continue;
    types.push(m[1]!);
    for (const ser of kids(plot, 'c:ser')) {
      const isXY = m[1] === 'scatter' || m[1] === 'bubble';
      const cats = readCache(child(ser, isXY ? 'c:xVal' : 'c:cat'));
      const vals = readCache(child(ser, 'c:val') ?? child(ser, 'c:yVal'));
      series.push({ name: seriesName(ser) || `Series ${series.length + 1}`, values: vals });
      if (isXY) xValues.push(cats);
      else if (categories.length === 0 && cats.length > 0) categories = cats.map(String);
    }
  }
  if (series.length === 0) return null;

  const titleNode = child(chart, 'c:title');
  const title = titleNode
    ? descendants(titleNode, 'a:t')
        .map((t) => ownText(t))
        .join('')
        .trim()
    : undefined;
  const data: ChartData = { chartType: [...new Set(types)].join('+'), categories, series };
  if (title) data.title = title;
  if (xValues.length > 0) data.xValues = xValues;
  return data;
}

/** Text rendering of chart data for search / study text. */
export function chartToText(chart: ChartData): string {
  const lines: string[] = [`Chart (${chart.chartType})${chart.title ? `: ${chart.title}` : ''}`];
  if (chart.categories.length > 0) lines.push(`Categories: ${chart.categories.join(', ')}`);
  chart.series.forEach((s, i) => {
    const xs = chart.xValues?.[i];
    const pts = xs ? s.values.map((v, k) => `(${xs[k] ?? ''}, ${v})`).join(' ') : s.values.join(', ');
    lines.push(`${s.name}: ${pts}`);
  });
  return lines.join('\n');
}
