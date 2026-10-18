import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Things the Cloudflare Workers runtime rejects at run time, which no local fake can notice because a fake never calls the
 * real `fetch`. Each rule here comes from a real failure: the first live Gemini request threw before leaving the Worker
 * because `redirect: 'error'` is not implemented there ("must be one of follow or manual").
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx|js|mjs)$/.test(name) ? [p] : [];
  });
}

describe('code that runs in the Worker only uses options the Workers runtime supports', () => {
  const files = [...sources('worker/src'), ...sources('src/core/ai'), ...sources('src/core/tutor')];

  it('never asks fetch for redirect: "error" (Workers support only "follow" and "manual")', () => {
    const offenders = files.filter((f) => /redirect\s*:\s*['"]error['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the provider adapters refuse to follow redirects ("manual")', () => {
    for (const f of ['src/core/ai/gemini.ts', 'src/core/ai/anthropic.ts']) expect(readFileSync(f, 'utf8'), f).toMatch(/redirect\s*:\s*'manual'/);
  });
});
