import type { Box } from './model';
import type { Package } from './opc';
import { FALLBACK_THEME, parseClrMap, parseTheme, type ClrMap, type ThemeInfo } from './theme';
import { attr, child, numAttr, path, type XNode } from './xml';

export interface PlaceholderInfo {
  type?: string;
  idx?: string;
  box?: Box;
  lstStyle?: XNode;
  bodyPr?: XNode;
}

export interface MasterInfo {
  part: string;
  theme: ThemeInfo;
  clrMap: ClrMap;
  txStyles: { title?: XNode; body?: XNode; other?: XNode };
  placeholders: PlaceholderInfo[];
  cSld?: XNode;
}

export interface LayoutInfo {
  part: string;
  name?: string;
  type?: string;
  showMasterSp: boolean;
  clrMap: ClrMap;
  placeholders: PlaceholderInfo[];
  cSld?: XNode;
  master: MasterInfo;
}

export function readXfrm(spPr: XNode | undefined): Box | undefined {
  if (!spPr) return undefined;
  const x = child(spPr, 'a:xfrm') ?? child(spPr, 'p:xfrm');
  return boxFromXfrm(x);
}

export function boxFromXfrm(x: XNode | undefined): Box | undefined {
  if (!x) return undefined;
  const off = child(x, 'a:off');
  const ext = child(x, 'a:ext');
  if (!off || !ext) return undefined;
  const box: Box = {
    x: numAttr(off, 'x') ?? 0,
    y: numAttr(off, 'y') ?? 0,
    w: numAttr(ext, 'cx') ?? 0,
    h: numAttr(ext, 'cy') ?? 0,
  };
  const rot = numAttr(x, 'rot');
  if (rot) box.rot = rot / 60000;
  if (attr(x, 'flipH') === '1') box.flipH = true;
  if (attr(x, 'flipV') === '1') box.flipV = true;
  return box;
}

export function phOf(sp: XNode): { type?: string; idx?: string } | undefined {
  for (const nvName of ['p:nvSpPr', 'p:nvPicPr', 'p:nvGraphicFramePr']) {
    const ph = path(sp, nvName, 'p:nvPr', 'p:ph');
    if (ph) return { type: attr(ph, 'type'), idx: attr(ph, 'idx') };
  }
  return undefined;
}

function collectPlaceholders(tree: XNode | undefined): PlaceholderInfo[] {
  const out: PlaceholderInfo[] = [];
  const visit = (nodes: XNode[]) => {
    for (const n of nodes) {
      if (n.name === 'p:sp' || n.name === 'p:pic' || n.name === 'p:graphicFrame') {
        const ph = phOf(n);
        if (!ph) continue;
        const txBody = child(n, 'p:txBody');
        out.push({
          ...ph,
          box: readXfrm(child(n, 'p:spPr')) ?? boxFromXfrm(child(n, 'p:xfrm')),
          lstStyle: child(txBody, 'a:lstStyle'),
          bodyPr: child(txBody, 'a:bodyPr'),
        });
      } else if (n.name === 'p:grpSp' || n.name === 'mc:AlternateContent' || n.name === 'mc:Choice') {
        visit(n.children);
      }
    }
  };
  if (tree) visit(tree.children);
  return out;
}

export function loadMaster(pkg: Package, part: string): MasterInfo {
  const root = pkg.xml(part);
  const cSld = child(root, 'p:cSld');
  let theme = FALLBACK_THEME;
  const themeRel = pkg.relsOfType(part, 'theme')[0];
  if (themeRel) {
    const themeXml = pkg.tryXml(themeRel.target);
    if (themeXml) theme = parseTheme(themeXml);
  }
  const tx = child(root, 'p:txStyles');
  return {
    part,
    theme,
    clrMap: parseClrMap(child(root, 'p:clrMap')),
    txStyles: { title: child(tx, 'p:titleStyle'), body: child(tx, 'p:bodyStyle'), other: child(tx, 'p:otherStyle') },
    placeholders: collectPlaceholders(child(cSld, 'p:spTree')),
    cSld,
  };
}

export function loadLayout(pkg: Package, part: string, masters: Map<string, MasterInfo>): LayoutInfo {
  const root = pkg.xml(part);
  const cSld = child(root, 'p:cSld');
  const masterRel = pkg.relsOfType(part, 'slideMaster')[0];
  if (!masterRel) throw new Error(`Layout ${part} has no master`);
  let master = masters.get(masterRel.target);
  if (!master) {
    master = loadMaster(pkg, masterRel.target);
    masters.set(masterRel.target, master);
  }
  const override = child(child(root, 'p:clrMapOvr'), 'a:overrideClrMapping');
  return {
    part,
    name: attr(cSld, 'name'),
    type: attr(root, 'type'),
    showMasterSp: attr(root, 'showMasterSp') !== '0',
    clrMap: override ? { ...master.clrMap, ...override.attrs } : master.clrMap,
    placeholders: collectPlaceholders(child(cSld, 'p:spTree')),
    cSld,
    master,
  };
}

/** Normalise placeholder type for matching between slide, layout and master. */
function normType(t: string | undefined): string {
  switch (t) {
    case undefined:
    case 'obj':
    case 'body':
      return 'body';
    case 'ctrTitle':
      return 'title';
    default:
      return t;
  }
}

export function findPlaceholder(list: PlaceholderInfo[], ph: { type?: string; idx?: string }, byIdx: boolean): PlaceholderInfo | undefined {
  if (byIdx && ph.idx !== undefined) {
    const hit = list.find((p) => p.idx === ph.idx);
    if (hit) return hit;
  }
  const t = normType(ph.type);
  // subTitle falls back to body on masters.
  return list.find((p) => normType(p.type) === t) ?? (t === 'subTitle' ? list.find((p) => normType(p.type) === 'body') : undefined);
}

export interface Inherited {
  box?: Box;
  layoutPh?: PlaceholderInfo;
  masterPh?: PlaceholderInfo;
}

export function inheritPlaceholder(layout: LayoutInfo, ph: { type?: string; idx?: string }): Inherited {
  const layoutPh = findPlaceholder(layout.placeholders, ph, true);
  const masterPh = findPlaceholder(layout.master.placeholders, { type: layoutPh?.type ?? ph.type, idx: layoutPh?.idx }, false);
  return { box: layoutPh?.box ?? masterPh?.box, layoutPh, masterPh };
}

/** Master text-style container for a placeholder type. */
export function masterStyleFor(master: MasterInfo, type: string | undefined): XNode | undefined {
  switch (type) {
    case 'title':
    case 'ctrTitle':
      return master.txStyles.title;
    case 'dt':
    case 'ftr':
    case 'sldNum':
      return master.txStyles.other;
    default:
      return master.txStyles.body;
  }
}
