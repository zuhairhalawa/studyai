import { attr, child, kids, numAttr, path, type XNode } from './xml';

export interface ThemeInfo {
  /** dk1, lt1, dk2, lt2, accent1..6, hlink, folHlink → "#RRGGBB" */
  colors: Record<string, string>;
  majorFont?: string;
  minorFont?: string;
}

export type ClrMap = Record<string, string>;

export interface ColorCtx {
  theme: ThemeInfo;
  clrMap: ClrMap;
}

export const DEFAULT_CLR_MAP: ClrMap = {
  bg1: 'lt1',
  tx1: 'dk1',
  bg2: 'lt2',
  tx2: 'dk2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hlink: 'hlink',
  folHlink: 'folHlink',
};

export const FALLBACK_THEME: ThemeInfo = {
  colors: {
    dk1: '#000000',
    lt1: '#FFFFFF',
    dk2: '#44546A',
    lt2: '#E7E6E6',
    accent1: '#4472C4',
    accent2: '#ED7D31',
    accent3: '#A5A5A5',
    accent4: '#FFC000',
    accent5: '#5B9BD5',
    accent6: '#70AD47',
    hlink: '#0563C1',
    folHlink: '#954F72',
  },
};

const PRESET_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#FFFFFF',
  red: '#FF0000',
  green: '#008000',
  blue: '#0000FF',
  yellow: '#FFFF00',
  gray: '#808080',
  grey: '#808080',
  orange: '#FFA500',
  purple: '#800080',
  cyan: '#00FFFF',
  magenta: '#FF00FF',
  darkBlue: '#00008B',
  darkRed: '#8B0000',
  darkGreen: '#006400',
  lightGray: '#D3D3D3',
  lightGrey: '#D3D3D3',
  darkGray: '#A9A9A9',
  darkGrey: '#A9A9A9',
};

export function parseTheme(root: XNode): ThemeInfo {
  const colors: Record<string, string> = { ...FALLBACK_THEME.colors };
  const scheme = path(root, 'a:themeElements', 'a:clrScheme');
  for (const c of scheme?.children ?? []) {
    const key = c.name.replace(/^a:/, '');
    const srgb = child(c, 'a:srgbClr');
    const sys = child(c, 'a:sysClr');
    const val = attr(srgb, 'val') ?? attr(sys, 'lastClr');
    if (val && /^[0-9a-fA-F]{6}$/.test(val)) colors[key] = `#${val.toUpperCase()}`;
  }
  const fonts = path(root, 'a:themeElements', 'a:fontScheme');
  return {
    colors,
    majorFont: attr(path(fonts, 'a:majorFont', 'a:latin'), 'typeface'),
    minorFont: attr(path(fonts, 'a:minorFont', 'a:latin'), 'typeface'),
  };
}

export function parseClrMap(node: XNode | undefined): ClrMap {
  if (!node) return DEFAULT_CLR_MAP;
  return { ...DEFAULT_CLR_MAP, ...node.attrs };
}

// --- colour math -----------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Resolve an <a:srgbClr|schemeClr|sysClr|prstClr> element (with its modifiers) to "#RRGGBB". */
export function resolveColorNode(node: XNode | undefined, ctx: ColorCtx): string | undefined {
  if (!node) return undefined;
  let base: string | undefined;
  switch (node.name) {
    case 'a:srgbClr': {
      const v = attr(node, 'val');
      base = v && /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toUpperCase()}` : undefined;
      break;
    }
    case 'a:schemeClr': {
      const v = attr(node, 'val') ?? '';
      const mapped = ctx.clrMap[v] ?? v;
      base = ctx.theme.colors[mapped] ?? (v === 'phClr' ? undefined : undefined);
      break;
    }
    case 'a:sysClr': {
      const v = attr(node, 'lastClr');
      base = v && /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toUpperCase()}` : attr(node, 'val') === 'window' ? '#FFFFFF' : '#000000';
      break;
    }
    case 'a:prstClr':
      base = PRESET_COLORS[attr(node, 'val') ?? ''];
      break;
    default:
      return undefined;
  }
  if (!base) return undefined;

  let [r, g, b] = hexToRgb(base);
  for (const mod of node.children) {
    const v = numAttr(mod, 'val');
    if (v === undefined) continue;
    const f = v / 100000;
    switch (mod.name) {
      case 'a:lumMod':
      case 'a:lumOff':
      case 'a:satMod': {
        const [h, s, l] = rgbToHsl(r, g, b);
        const [nh, ns, nl] =
          mod.name === 'a:lumMod' ? [h, s, Math.min(1, l * f)] : mod.name === 'a:lumOff' ? [h, s, Math.min(1, Math.max(0, l + f))] : [h, Math.min(1, s * f), l];
        [r, g, b] = hslToRgb(nh, ns, nl);
        break;
      }
      case 'a:tint':
        r = 255 - (255 - r) * f;
        g = 255 - (255 - g) * f;
        b = 255 - (255 - b) * f;
        break;
      case 'a:shade':
        r *= f;
        g *= f;
        b *= f;
        break;
      default:
        break; // alpha, hue shifts etc. are ignored
    }
  }
  return rgbToHex(r, g, b);
}

const COLOR_NODES = new Set(['a:srgbClr', 'a:schemeClr', 'a:sysClr', 'a:prstClr']);

/**
 * Read a fill container's colour.
 * Returns: a hex colour, `null` for explicit "no fill", or `undefined` when the
 * element says nothing (caller should inherit).
 */
export function colorFromFill(parent: XNode | undefined, ctx: ColorCtx): string | null | undefined {
  if (!parent) return undefined;
  for (const c of parent.children) {
    if (c.name === 'a:noFill') return null;
    if (c.name === 'a:solidFill') {
      const colorNode = c.children.find((k) => COLOR_NODES.has(k.name));
      return resolveColorNode(colorNode, ctx);
    }
    if (c.name === 'a:gradFill') {
      const stop = kids(child(c, 'a:gsLst'), 'a:gs')[0];
      const colorNode = stop?.children.find((k) => COLOR_NODES.has(k.name));
      return resolveColorNode(colorNode, ctx);
    }
    if (c.name === 'a:pattFill') {
      const fg = child(c, 'a:fgClr');
      return resolveColorNode(fg?.children.find((k) => COLOR_NODES.has(k.name)), ctx);
    }
  }
  return undefined;
}

export function firstColorChild(node: XNode | undefined): XNode | undefined {
  return node?.children.find((k) => COLOR_NODES.has(k.name));
}
