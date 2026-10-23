import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { META_CSP } from '../config/headers';

/**
 * Builds the demo and the regular app for real (into a temporary folder, about ten seconds) and reads what a visitor would be
 * served. This is what keeps the guarantees of docs/DEMO.md true in CI, where the browser tests do not run.
 */
const vite = join('node_modules', 'vite', 'bin', 'vite.js');
const roots: string[] = [];

function build(mode: 'demo' | 'production', env: Record<string, string> = {}): string {
  const out = mkdtempSync(join(tmpdir(), `studyai-${mode}-`));
  roots.push(out);
  execFileSync(process.execPath, [vite, 'build', '--mode', mode, '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { env: { ...process.env, ...env }, stdio: 'pipe', timeout: 120_000 });
  return out;
}

const scripts = (dir: string): string[] => readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, 'assets', f), 'utf8'));

let demo: string;
let regular: string;
beforeAll(() => {
  demo = build('demo', { STUDYAI_DEMO_BASE: '/pages-test/' });
  regular = build('production');
}, 240_000);
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe('the demo build', () => {
  it('carries its policy in the page, ahead of every script, and sends no headers file', () => {
    const html = readFileSync(join(demo, 'index.html'), 'utf8');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${META_CSP}" />`);
    expect(html.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(html.indexOf('<script'));
    expect(existsSync(join(demo, '_headers'))).toBe(false); // GitHub Pages would ignore it, and a file that looks like protection but is not would mislead
  });

  it('lives entirely under its sub-path', () => {
    const html = readFileSync(join(demo, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(5);
    for (const u of urls) expect(u.startsWith('/pages-test/'), u).toBe(true);
    for (const css of readdirSync(join(demo, 'assets')).filter((f) => f.endsWith('.css'))) {
      for (const [, u] of readFileSync(join(demo, 'assets', css), 'utf8').matchAll(/url\(([^)]+)\)/g)) expect(u!.replace(/["']/g, ''), `${css}: ${u}`).toMatch(/^\/pages-test\/|^data:/);
    }
    // the file-reading worker is found under the sub-path too
    expect(scripts(demo).some((js) => js.includes('/pages-test/assets/parse.worker-'))).toBe(true);
  });

  it('answers an unknown address with the app itself (GitHub Pages serves 404.html there)', () => {
    expect(readFileSync(join(demo, '404.html'), 'utf8')).toBe(readFileSync(join(demo, 'index.html'), 'utf8'));
  });

  it('has no AI client, no provider address and no key in any script', () => {
    const bad = /\/api\/(?:health|auth|owner|ai)|api\.anthropic\.com|x-api-key|sk-ant-|anthropic-version|generativelanguage\.googleapis\.com|x-goog-api-key|AIza[0-9A-Za-z_-]{20,}|GEMINI_API_KEY/;
    const all = scripts(demo);
    expect(all.length).toBeGreaterThan(10);
    for (const js of all) expect(js).not.toMatch(bad);
  });

  it('contains the sample course (loaded on demand) and the demo banner', () => {
    const all = scripts(demo).join('\n');
    expect(all).toContain('Skyship Navigation (invented demo course)');
    expect(all).toContain('AI features are not available in the demo.');
    expect(readdirSync(join(demo, 'assets')).some((f) => /^sample-course-.*\.js$/.test(f))).toBe(true);
  });
});

describe('the regular build', () => {
  it('is unchanged by the demo: root paths, the headers file, the AI client, and no demo code at all', () => {
    const html = readFileSync(join(regular, 'index.html'), 'utf8');
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain('http-equiv'); // its policy is sent as headers
    expect(readFileSync(join(regular, '_headers'), 'utf8')).toContain("frame-ancestors 'none'");
    const all = scripts(regular).join('\n');
    expect(all).toContain('/api/health');
    for (const demoOnly of ['Skyship Navigation', 'Invented Author', 'Load the sample course', 'AI features are not available in the demo', 'sample-course']) expect(all, demoOnly).not.toContain(demoOnly);
    expect(readdirSync(join(regular, 'assets')).some((f) => /sample|demo/i.test(f))).toBe(false);
    expect(existsSync(join(regular, '404.html'))).toBe(false);
  });
});
