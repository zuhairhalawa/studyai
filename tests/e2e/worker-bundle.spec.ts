import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * The PRODUCTION Worker bundle, built locally by `wrangler deploy --dry-run` (no login, no network, nothing deployed).
 * It must contain exactly one AI provider (Gemini), no Claude code, no test fake, and no secret-shaped values.
 */
test('the production Worker bundle has only the Gemini adapter, no test fake, and no secrets', async () => {
  rmSync('.scratch/dry-bundle', { recursive: true, force: true });
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', '.scratch/dry-bundle'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' }, stdio: 'pipe', timeout: 120_000 });
  const code = readFileSync('.scratch/dry-bundle/index.js', 'utf8');

  expect(code).toContain('generativelanguage.googleapis.com'); // the one provider
  expect(code).toContain('x-goog-api-key');
  for (const forbidden of ['api.anthropic.com', 'anthropic-version', 'x-api-key', 'ScriptedGemini', 'FAKE-QUOTA-DAY', 'StudyAiTestDO']) expect(code, forbidden).not.toContain(forbidden);
  expect(code).not.toMatch(/AIza[0-9A-Za-z_-]{35}|sk-ant-[A-Za-z0-9_-]{20,}|sak_[A-Za-z0-9_-]{43}/); // no key-shaped values
  expect(statSync('.scratch/dry-bundle/index.js').size).toBeLessThan(2_000_000); // well inside the free plan's limit
});
