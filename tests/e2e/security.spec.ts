import { expect, test } from '@playwright/test';
import { createCourse, importFiles, lectureBytes } from './helpers';

test('security headers are present and the CSP actually blocks injected script', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && violations.push(m.text()));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const res = await page.goto('/');
  const h = res!.headers();
  expect(h['content-security-policy']).toContain("default-src 'none'");
  expect(h['content-security-policy']).toContain("script-src 'self'");
  expect(h['content-security-policy']).not.toContain("'unsafe-eval'");
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['permissions-policy']).toContain('camera=()');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  violations.length = 0; // the page itself loaded cleanly; now probe the policy

  // An injected inline <script> must not run.
  const ran = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true';
    document.head.appendChild(s);
    return (window as unknown as { __injected?: boolean }).__injected === true;
  });
  expect(ran).toBe(false);
  // Outbound requests to other origins are blocked.
  const fetched = await page.evaluate(() => fetch('https://example.com/', { mode: 'no-cors' }).then(() => true).catch(() => false));
  expect(fetched).toBe(false);
  expect(errors).toEqual([]);
});

test('a full study session produces no CSP violations or script errors', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) && problems.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto('/');
  await createCourse(page, 'Security', 'BCS303');
  await importFiles(page, [{ name: 'lec.pptx', buffer: lectureBytes() }]);
  await expect(page.getByText(/Imported: 5 slides/)).toBeVisible();
  await page.getByRole('link', { name: 'lec', exact: true }).click();
  await expect(page.getByText('Slide 1 of 5')).toBeVisible();
  for (const n of [2, 3, 4, 5]) {
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText(`Slide ${n} of 5`)).toBeVisible();
  }
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Backup and restore' })).toBeVisible();
  await page.goto('/search?q=turing');
  await expect(page.getByText(/slide/).first()).toBeVisible();
  expect(problems).toEqual([]);
});

test('the shipped files contain no AI provider host, key header or key material', async ({ request }) => {
  // Fetch what a visitor actually receives (the production build served under the production headers).
  const html = await (await request.get('/')).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
  expect(assets.length).toBeGreaterThan(0);
  // Include every lazily loaded chunk too: read the build output listing the server serves from.
  const { readdirSync } = await import('node:fs');
  const all = readdirSync('dist/assets').filter((f) => /\.(js|css)$/.test(f)).map((f) => `/assets/${f}`);
  expect(all.length).toBeGreaterThanOrEqual(assets.length);
  const bad = /api\.anthropic\.com|x-api-key|sk-ant-|ANTHROPIC_API_KEY|anthropic-version|generativelanguage\.googleapis\.com|x-goog-api-key|AIza[0-9A-Za-z_-]{20,}|GEMINI_API_KEY/;
  for (const url of all) {
    const body = await (await request.get(url)).text();
    expect(bad.test(body), `${url} must not contain provider hosts or key material`).toBe(false);
  }
  expect(bad.test(html)).toBe(false);
});
