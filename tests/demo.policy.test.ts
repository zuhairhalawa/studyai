import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { demoBase, injectDemoHead } from '../config/demo-html';
import { CSP, META_CSP } from '../config/headers';

const INDEX = readFileSync('index.html', 'utf8');

describe('the policy that travels inside the demo page', () => {
  it('is the production policy minus what a <meta> element cannot carry', () => {
    expect(META_CSP.split('; ')).toEqual(CSP.split('; ').filter((d) => !d.startsWith('frame-ancestors')));
    expect(META_CSP).not.toMatch(/frame-ancestors|report-uri|sandbox/);
  });

  it('still allows nothing but the site itself', () => {
    expect(META_CSP).toContain("default-src 'none'");
    const directives = META_CSP.split('; ');
    for (const d of ['script-src', 'style-src', 'font-src', 'connect-src', 'worker-src']) expect(directives, d).toContain(`${d} 'self'`);
    expect(META_CSP).not.toMatch(/unsafe-eval|https?:|\*/);
    expect(directives.filter((d) => d.includes("'unsafe-inline'"))).toEqual(["style-src-attr 'unsafe-inline'"]); // style attributes only, as in the headers
  });
});

describe('injectDemoHead', () => {
  const html = injectDemoHead(INDEX);

  it('puts the policy straight after the charset, before any script or link', () => {
    const charset = html.indexOf('<meta charset="UTF-8" />');
    const policy = html.indexOf('http-equiv="Content-Security-Policy"');
    expect(charset).toBeGreaterThanOrEqual(0);
    expect(policy).toBeGreaterThan(charset);
    for (const later of ['<script', '<link']) expect(html.indexOf(later), later).toBeGreaterThan(policy);
    expect(html).toContain(`content="${META_CSP}"`);
  });

  it('adds the no-referrer rule that the header would have set', () => {
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
  });

  it('names itself as the demo in the tab and in a link preview', () => {
    expect(html).toContain('<title>StudyAI demo</title>');
    expect(html).toMatch(/<meta name="description" content="[^"]*invented[^"]*there is no AI\." \/>/);
    expect(html).not.toContain('<title>StudyAI</title>');
  });

  it('refuses to ship a page it cannot protect', () => {
    expect(() => injectDemoHead('<html><head><title>StudyAI</title></head></html>')).toThrow(/charset/);
    expect(() => injectDemoHead('<html><head><meta charset="UTF-8" /></head></html>')).toThrow(/title/);
  });

  it('leaves the rest of the page as it was', () => {
    const stripped = html
      .replace(/\n {4}<meta http-equiv[^\n]*\n {4}<meta name="referrer"[^\n]*/, '')
      .replace(/<title>StudyAI demo<\/title>\n {4}<meta name="description"[^\n]*/, '<title>StudyAI</title>');
    expect(stripped).toBe(INDEX);
  });
});

describe('demoBase', () => {
  it('defaults to the GitHub Pages path of this repository', () => {
    expect(demoBase('')).toBe('/studyai/');
  });

  it('accepts a root or a sub-path', () => {
    for (const ok of ['/', '/studyai/', '/my-fork.v2/', '/a/b/']) expect(demoBase(ok)).toBe(ok);
  });

  it.each(['studyai/', '/studyai', '//evil.example/', '/a b/', '/../', '/./', '/a/../b/', 'https://x.example/', '/a?b/'])('rejects %j', (bad) => {
    expect(() => demoBase(bad)).toThrow(/STUDYAI_DEMO_BASE/);
  });
});
