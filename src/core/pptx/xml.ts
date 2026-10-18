import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { PptxError } from './errors';

/**
 * Safe XML reading for untrusted OOXML parts.
 *
 *  - DTDs / entity declarations are rejected outright (OOXML never needs them),
 *    which removes the whole "billion laughs"/external-entity class of attacks.
 *  - Documents must be well-formed (validated before parsing).
 *  - Nesting depth is capped.
 *  - Namespaces are resolved: element and attribute prefixes are rewritten to a
 *    canonical set (a:, p:, r:, m:, c:, ...) based on their namespace URI, so
 *    files written by other tools with unusual prefixes still parse, and the
 *    OOXML "Strict" namespaces are treated like the "Transitional" ones.
 */

export interface XNode {
  /** Canonical qualified name, e.g. "a:t". Text nodes use "#text". */
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Only for text nodes. */
  text?: string;
}

const NS: Record<string, string> = {
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://purl.oclc.org/ooxml/presentationml/main': 'p',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
  'http://purl.oclc.org/ooxml/officeDocument/math': 'm',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
  'http://purl.oclc.org/ooxml/drawingml/chart': 'c',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram': 'dgm',
  'http://purl.oclc.org/ooxml/drawingml/diagram': 'dgm',
  'http://schemas.microsoft.com/office/drawing/2008/diagram': 'dsp',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.microsoft.com/office/drawing/2010/main': 'a14',
  'http://schemas.microsoft.com/office/powerpoint/2010/main': 'p14',
  'http://schemas.microsoft.com/office/powerpoint/2012/main': 'p15',
  'http://schemas.microsoft.com/office/drawing/2016/SVG/main': 'asvg',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'rel',
  'http://schemas.openxmlformats.org/package/2006/content-types': 'ct',
  'http://schemas.openxmlformats.org/package/2006/metadata/core-properties': 'cp',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://purl.org/dc/terms/': 'dcterms',
  'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties': 'ep',
};

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  processEntities: true,
  htmlEntities: false,
  removeNSPrefix: false,
  allowBooleanAttributes: false,
  maxNestedTags: 200,
});

/** Elements whose whitespace-only text content is significant. */
const SIGNIFICANT_WS = new Set(['a:t', 'm:t', 'c:v', 'ep:Application', 'dc:title']);

type RawNode = Record<string, unknown>;
type Scope = ReadonlyMap<string, string>;

/** Decode &#NNN; and &#xHHH; references (the parser only handles the five named entities). */
function decodeNumericRefs(s: string): string {
  if (!s.includes('&#')) return s;
  return s.replace(/&#(x[0-9a-fA-F]{1,6}|[0-9]{1,7});/g, (whole, body: string) => {
    const cp = body[0] === 'x' ? parseInt(body.slice(1), 16) : parseInt(body, 10);
    const valid =
      cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
    return valid ? String.fromCodePoint(cp) : whole;
  });
}

function canonicalName(qname: string, scope: Scope, isAttribute: boolean): string {
  const i = qname.indexOf(':');
  if (i < 0) {
    if (isAttribute) return qname;
    const uri = scope.get('');
    const canon = uri ? NS[uri] : undefined;
    return canon ? `${canon}:${qname}` : qname;
  }
  const uri = scope.get(qname.slice(0, i));
  const canon = uri ? NS[uri] : undefined;
  return canon ? `${canon}:${qname.slice(i + 1)}` : qname;
}

function convert(raws: RawNode[], scope: Scope, parentName: string): XNode[] {
  const out: XNode[] = [];
  for (const raw of raws) {
    const attrRaw = raw[':@'] as Record<string, string> | undefined;
    for (const key of Object.keys(raw)) {
      if (key === ':@') continue;
      if (key === '#text') {
        const text = decodeNumericRefs(String(raw[key]));
        if (text.trim() === '' && !SIGNIFICANT_WS.has(parentName)) continue;
        out.push({ name: '#text', attrs: {}, children: [], text });
        continue;
      }
      // Namespace declarations first: they apply to this element and its descendants.
      let local: Scope = scope;
      if (attrRaw) {
        let copy: Map<string, string> | undefined;
        for (const a of Object.keys(attrRaw)) {
          if (a === '@_xmlns') (copy ??= new Map(scope)).set('', String(attrRaw[a]));
          else if (a.startsWith('@_xmlns:')) (copy ??= new Map(scope)).set(a.slice(8), String(attrRaw[a]));
        }
        if (copy) local = copy;
      }
      const name = canonicalName(key, local, false);
      const attrs: Record<string, string> = {};
      if (attrRaw) {
        for (const a of Object.keys(attrRaw)) {
          if (a === '@_xmlns' || a.startsWith('@_xmlns:')) continue;
          attrs[canonicalName(a.slice(2), local, true)] = decodeNumericRefs(String(attrRaw[a]));
        }
      }
      const kids = raw[key];
      out.push({
        name,
        attrs,
        children: Array.isArray(kids) ? convert(kids as RawNode[], local, name) : [],
      });
    }
  }
  return out;
}

export function decodeXmlBytes(input: Uint8Array): string {
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) return new TextDecoder('utf-16le').decode(input);
  if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) return new TextDecoder('utf-16be').decode(input);
  return new TextDecoder('utf-8').decode(input);
}

export function parseXml(input: Uint8Array | string, label = 'xml'): XNode {
  const text = typeof input === 'string' ? input : decodeXmlBytes(input);
  // Allow comments and CDATA; reject DOCTYPE, ENTITY, ELEMENT, ATTLIST, NOTATION declarations.
  if (/<!(?!--|\[CDATA\[)/.test(text)) {
    throw new PptxError('XML_FORBIDDEN_DTD', `${label}: DTD or entity declarations are not allowed.`);
  }
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    throw new PptxError('XML_MALFORMED', `${label}: ${valid.err.msg}`);
  }
  let raws: RawNode[];
  try {
    raws = parser.parse(text) as RawNode[];
  } catch (err) {
    throw new PptxError('XML_MALFORMED', `${label}: ${err instanceof Error ? err.message : 'parse error'}`);
  }
  const roots = convert(raws, new Map(), '').filter((n) => n.name !== '#text');
  const root = roots[0];
  if (!root) throw new PptxError('XML_MALFORMED', `${label}: no root element.`);
  return root;
}

// ---------------------------------------------------------------------------
// Traversal helpers
// ---------------------------------------------------------------------------

export function child(n: XNode | undefined, name: string): XNode | undefined {
  return n?.children.find((c) => c.name === name);
}

export function kids(n: XNode | undefined, name: string): XNode[] {
  return n ? n.children.filter((c) => c.name === name) : [];
}

/** Follow a chain of child element names. */
export function path(n: XNode | undefined, ...names: string[]): XNode | undefined {
  let cur = n;
  for (const nm of names) {
    cur = child(cur, nm);
    if (!cur) return undefined;
  }
  return cur;
}

export function attr(n: XNode | undefined, name: string): string | undefined {
  return n?.attrs[name];
}

export function numAttr(n: XNode | undefined, name: string): number | undefined {
  const v = n?.attrs[name];
  if (v === undefined) return undefined;
  const num = Number(v);
  return Number.isFinite(num) ? num : undefined;
}

/** Concatenate all direct text-node content of an element. */
export function ownText(n: XNode | undefined): string {
  if (!n) return '';
  let s = '';
  for (const c of n.children) if (c.name === '#text') s += c.text ?? '';
  return s;
}

/** Depth-first search for all descendants with the given name (not descending into matches). */
export function descendants(n: XNode | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    else descendants(c, name, out);
  }
  return out;
}

/** All descendants with the given name, including matches nested inside other matches. */
export function allDescendants(n: XNode | undefined, name: string, out: XNode[] = []): XNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    allDescendants(c, name, out);
  }
  return out;
}

export function firstDescendant(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) {
    if (c.name === name) return c;
    const f = firstDescendant(c, name);
    if (f) return f;
  }
  return undefined;
}
