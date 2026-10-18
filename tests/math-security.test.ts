// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderMath } from '../src/ui/slide/math';

/**
 * Slide equations are untrusted input that ends up in dangerouslySetInnerHTML via KaTeX.
 * KaTeX is configured with trust:false; these tests parse the generated HTML and assert
 * that no executable or network-capable construct exists, so a future KaTeX upgrade or
 * option change cannot silently reintroduce script/URL injection.
 */
function inspect(html: string) {
  const host = document.createElement('div');
  host.innerHTML = html;
  const all = [...host.querySelectorAll('*')];
  const attrs = all.flatMap((el) => [...el.attributes].map((a) => ({ tag: el.tagName.toLowerCase(), name: a.name.toLowerCase(), value: a.value })));
  return { host, tags: new Set(all.map((e) => e.tagName.toLowerCase())), attrs };
}

describe('renderMath with hostile LaTeX', () => {
  const hostile = [
    String.raw`\href{javascript:alert(1)}{click}`,
    String.raw`\url{javascript:alert(1)}`,
    String.raw`\htmlClass{x" onmouseover="alert(1)}{y}`,
    String.raw`\htmlId{x}{y}`,
    String.raw`\htmlStyle{background:url(https://evil.example/x)}{y}`,
    String.raw`\htmlData{a=b}{y}`,
    String.raw`\includegraphics{https://evil.example/x.png}`,
    String.raw`\text{<img src=x onerror=alert(1)>}`,
    String.raw`<script>alert(1)</script>`,
    String.raw`x^{<svg onload=alert(1)>}`,
    String.raw`\mathrm{</span><script>alert(1)</script>}`,
  ];

  it.each(hostile)('produces no executable or network-capable DOM for %s', (src) => {
    const { tags, attrs } = inspect(renderMath(src, false));
    for (const bad of ['script', 'iframe', 'object', 'embed', 'img', 'a', 'link', 'form', 'style', 'base', 'meta']) expect(tags.has(bad), `<${bad}> present`).toBe(false);
    for (const a of attrs) {
      expect(a.name.startsWith('on'), `event handler ${a.name}`).toBe(false);
      expect(['href', 'src', 'srcdoc', 'formaction', 'xlink:href', 'action', 'data'].includes(a.name), `attribute ${a.name}`).toBe(false);
      expect(a.value.toLowerCase().includes('javascript:'), `javascript: in ${a.name}`).toBe(false);
      if (a.name === 'style') expect(/url\(|expression\(|@import/i.test(a.value), `style=${a.value}`).toBe(false);
    }
  });

  it('keeps hostile text as inert text, not markup', () => {
    const { host } = inspect(renderMath(String.raw`\text{<img src=x onerror=alert(1)>}`, false));
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img');
  });

  it('renders ordinary maths', () => {
    const html = renderMath(String.raw`\frac{a}{b} = \sum_{i=1}^{n} x_i^2`, true);
    expect(html).toContain('katex');
    expect(html).toContain('mfrac');
  });

  it('does not throw on invalid input (callers fall back to plain text)', () => {
    expect(() => renderMath(String.raw`\frac{`, false)).not.toThrow();
  });
});
