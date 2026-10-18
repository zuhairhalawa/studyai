import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Offline study must keep working whatever happens to AI: the code that makes it work may not depend on, or be able to
 * reach, the AI module or any network. These are static checks over the source tree.
 */
const root = resolve(__dirname, '..');
const src = join(root, 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const rel = (p: string) => relative(root, p).split(sep).join('/');
const read = (p: string) => readFileSync(p, 'utf8');

describe('the AI module is isolated from the offline app', () => {
  const ai = join(src, 'core', 'ai');
  const outside = files(src).filter((f) => !f.startsWith(ai));

  it('nothing outside src/core/ai imports it (the app has no AI call path yet)', () => {
    const offenders = outside.filter((f) => /from\s+['"][^'"]*(\/|@\/)core\/ai(\/|['"])|from\s+['"][^'"]*\/ai\/(guard|anthropic|ledger)['"]/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('nothing in the app mentions an AI provider host or key header', () => {
    const offenders = outside.filter((f) => /api\.anthropic\.com|x-api-key|sk-ant-|generativelanguage\.googleapis|x-goog-api-key|AIza[0-9A-Za-z_-]{20,}|ANTHROPIC_API_KEY|GEMINI_API_KEY/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the learning engine, parser, storage and search contain no network calls at all', () => {
    const offline = ['pptx', 'db', 'study', 'search', 'backup'].flatMap((d) => files(join(src, 'core', d)));
    const offenders = offline.filter((f) => /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon|importScripts/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the AI module itself depends only on pure code (no DOM, no storage, no app code)', () => {
    for (const f of files(ai)) {
      const text = read(f);
      expect(/from\s+['"]\.\.\/(?!ai\/)/.test(text), rel(f)).toBe(false);
      expect(/\b(window|document|localStorage|indexedDB|Dexie)\b/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), rel(f)).toBe(false);
    }
  });

  it('key headers and provider hosts are written only in the two adapters, one each', () => {
    const claude = files(ai).filter((f) => /x-api-key|api\.anthropic\.com/.test(read(f))).map((f) => rel(f));
    const gemini = files(ai).filter((f) => /x-goog-api-key|generativelanguage\.googleapis/.test(read(f))).map((f) => rel(f));
    expect(claude).toEqual(['src/core/ai/anthropic.ts']);
    expect(gemini).toEqual(['src/core/ai/gemini.ts']);
  });
});
