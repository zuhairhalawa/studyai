import { describe, expect, it } from 'vitest';
import { child, descendants, kids, parseXml } from '../src/core/pptx/xml';
import { PptxError } from '../src/core/pptx/errors';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

function code(fn: () => unknown): string {
  try {
    fn();
    return 'no-error';
  } catch (e) {
    return e instanceof PptxError ? e.code : `other:${String(e)}`;
  }
}

describe('parseXml', () => {
  it('canonicalises namespace prefixes by URI', () => {
    const root = parseXml(`<x:sld xmlns:x="${P}" xmlns:q="${A}"><q:t>hi</q:t></x:sld>`);
    expect(root.name).toBe('p:sld');
    expect(root.children[0]?.name).toBe('a:t');
  });

  it('treats OOXML Strict namespaces like Transitional', () => {
    const root = parseXml('<p:sld xmlns:p="http://purl.oclc.org/ooxml/presentationml/main"><p:cSld/></p:sld>');
    expect(root.name).toBe('p:sld');
    expect(child(root, 'p:cSld')).toBeDefined();
  });

  it('honours default namespaces and nested declarations', () => {
    const root = parseXml(`<sld xmlns="${P}"><inner xmlns="${A}"/></sld>`);
    expect(root.name).toBe('p:sld');
    expect(root.children[0]?.name).toBe('a:inner');
  });

  it('canonicalises attribute prefixes (r:embed)', () => {
    const root = parseXml(`<a:blip xmlns:a="${A}" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships" rel:embed="rId2"/>`);
    expect(root.attrs['r:embed']).toBe('rId2');
  });

  it('rejects DOCTYPE and ENTITY declarations (XXE / entity expansion)', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><a>&lol2;</a>';
    expect(code(() => parseXml(bomb))).toBe('XML_FORBIDDEN_DTD');
    const xxe = '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>';
    expect(code(() => parseXml(xxe))).toBe('XML_FORBIDDEN_DTD');
    expect(code(() => parseXml('<!doctype html><a/>'))).toBe('XML_FORBIDDEN_DTD');
  });

  it('accepts comments and CDATA', () => {
    const root = parseXml('<a><!-- note --><b><![CDATA[x < y]]></b></a>');
    expect(child(root, 'b')).toBeDefined();
  });

  it('rejects malformed documents', () => {
    expect(code(() => parseXml('<a><b></a>'))).toBe('XML_MALFORMED');
    expect(code(() => parseXml('not xml'))).toBe('XML_MALFORMED');
    expect(code(() => parseXml(''))).toBe('XML_MALFORMED');
  });

  it('decodes predefined and numeric character references', () => {
    const root = parseXml(`<a:p xmlns:a="${A}"><a:t>Tom &amp; Jerry &lt;3 &#945;&#x3b2;</a:t></a:p>`);
    const t = descendants(root, 'a:t')[0]!;
    expect(t.children[0]?.text).toBe('Tom & Jerry <3 αβ');
  });

  it('preserves whitespace inside a:t but drops pretty-print whitespace', () => {
    const root = parseXml(`<a:p xmlns:a="${A}">\n  <a:r>\n    <a:t> </a:t>\n  </a:r>\n  <a:r><a:t> x </a:t></a:r>\n</a:p>`);
    const runs = kids(root, 'a:r');
    expect(runs).toHaveLength(2); // no stray whitespace text nodes among children
    expect(root.children.every((c) => c.name !== '#text')).toBe(true);
    expect(runs[0]!.children[0]!.children[0]!.text).toBe(' ');
    expect(runs[1]!.children[0]!.children[0]!.text).toBe(' x ');
  });

  it('handles a UTF-16 document with BOM', () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><a><b/></a>';
    const bytes = new Uint8Array(2 + xml.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < xml.length; i++) {
      const c = xml.charCodeAt(i);
      bytes[2 + i * 2] = c & 255;
      bytes[3 + i * 2] = c >> 8;
    }
    expect(child(parseXml(bytes), 'b')).toBeDefined();
  });

  it('refuses pathologically deep nesting', () => {
    const deep = '<a>'.repeat(5000) + '</a>'.repeat(5000);
    expect(code(() => parseXml(deep))).toBe('XML_MALFORMED');
  });
});
