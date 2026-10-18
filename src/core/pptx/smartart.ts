import type { Box, ShapeElement, SmartArtNode } from './model';
import { boxFromXfrm } from './layout';
import { colorFromFill, type ColorCtx } from './theme';
import { parseParagraphs, type TextCtx } from './text';
import { attr, child, descendants, kids, ownText, path, type XNode } from './xml';

/**
 * SmartArt: slides contain a data model (the nodes and how they connect), a
 * layout definition (the algorithm that arranges them) and — in files saved by
 * PowerPoint 2010+ — a cached drawing with the final positioned shapes.
 *
 * We read the *data model* for the text and hierarchy, and the cached *drawing*
 * for something we can display. We never run SmartArt layout algorithms, so the
 * hierarchy is inferred from parent→child connections and always flagged.
 */

export function parseSmartArtData(root: XNode): SmartArtNode[] {
  const ptLst = child(root, 'dgm:ptLst');
  const cxnLst = child(root, 'dgm:cxnLst');
  const nodes = new Map<string, string>(); // id → text
  const order: string[] = [];
  for (const pt of kids(ptLst, 'dgm:pt')) {
    const type = attr(pt, 'type') ?? 'node';
    if (type !== 'node') continue;
    const id = attr(pt, 'modelId');
    if (!id) continue;
    const text = descendants(child(pt, 'dgm:t'), 'a:t')
      .map((t) => ownText(t))
      .join('')
      .trim();
    nodes.set(id, text);
    order.push(id);
  }

  // parent → ordered children, from parOf connections.
  const children = new Map<string, { id: string; ord: number }[]>();
  const hasParent = new Set<string>();
  const docIds = new Set(kids(ptLst, 'dgm:pt').filter((p) => attr(p, 'type') === 'doc').map((p) => attr(p, 'modelId') ?? ''));
  for (const cxn of kids(cxnLst, 'dgm:cxn')) {
    const type = attr(cxn, 'type') ?? 'parOf';
    if (type !== 'parOf') continue;
    const src = attr(cxn, 'srcId');
    const dest = attr(cxn, 'destId');
    if (!src || !dest || !nodes.has(dest)) continue;
    if (!nodes.has(src) && !docIds.has(src)) continue;
    const list = children.get(src) ?? [];
    list.push({ id: dest, ord: Number(attr(cxn, 'srcOrd') ?? list.length) });
    children.set(src, list);
    if (nodes.has(src)) hasParent.add(dest);
  }

  const out: SmartArtNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id) || depth > 12) return;
    seen.add(id);
    const text = nodes.get(id);
    if (text) out.push({ text, depth });
    for (const c of (children.get(id) ?? []).sort((a, b) => a.ord - b.ord)) visit(c.id, depth + 1);
  };
  // Roots: children of the document point, else nodes without a parent.
  const roots = [...docIds].flatMap((d) => (children.get(d) ?? []).sort((a, b) => a.ord - b.ord).map((c) => c.id));
  for (const id of roots.length > 0 ? roots : order.filter((id) => !hasParent.has(id))) visit(id, 0);
  for (const id of order) visit(id, 0); // any node not reached (broken connections)
  return out;
}

/** Relationship id (in the slide's rels) of the cached drawing part, from the data model's extension list. */
export function drawingRelId(dataRoot: XNode): string | undefined {
  for (const ext of descendants(dataRoot, 'a:ext')) {
    const m = child(ext, 'dsp:dataModelExt');
    if (m) return attr(m, 'relId');
  }
  return undefined;
}

export function parseSmartArtDrawing(root: XNode, colors: ColorCtx, makeTextCtx: (id: string) => TextCtx): ShapeElement[] {
  const out: ShapeElement[] = [];
  const shapes = descendants(child(root, 'dsp:spTree'), 'dsp:sp');
  shapes.forEach((sp, i) => {
    const spPr = child(sp, 'dsp:spPr');
    const box: Box | undefined = boxFromXfrm(child(spPr, 'a:xfrm'));
    const id = attr(path(sp, 'dsp:nvSpPr', 'dsp:cNvPr'), 'id') ?? `dsp-${i}`;
    const fill = colorFromFill(spPr, colors);
    const lnNode = child(spPr, 'a:ln');
    const lnColor = colorFromFill(lnNode, colors);
    const txBody = child(sp, 'dsp:txBody');
    const bodyPr = child(txBody, 'a:bodyPr');
    const anchor = attr(bodyPr, 'anchor');
    const shape: ShapeElement = {
      kind: 'shape',
      id,
      name: attr(path(sp, 'dsp:nvSpPr', 'dsp:cNvPr'), 'name') ?? `SmartArt shape ${i + 1}`,
      z: i,
      geom: attr(child(spPr, 'a:prstGeom'), 'prst') ?? 'rect',
      isTextBox: false,
      paragraphs: parseParagraphs(txBody, makeTextCtx(id)),
    };
    if (box) shape.box = box;
    if (typeof fill === 'string') shape.fill = fill;
    if (typeof lnColor === 'string') shape.line = { color: lnColor, width: Number(attr(lnNode, 'w') ?? 12700) };
    if (anchor === 'ctr') shape.anchor = 'middle';
    else if (anchor === 'b') shape.anchor = 'bottom';
    out.push(shape);
  });
  return out;
}
