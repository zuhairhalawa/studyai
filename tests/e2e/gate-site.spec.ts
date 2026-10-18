import { readFileSync } from 'node:fs';
import { ORIGINS } from './ports';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { watchProblems } from './helpers';

/**
 * The private-site gate against the real local Worker (workerd), with the whole site behind the owner login
 * (wrangler.gate.jsonc: PRIVATE_SITE on, run_worker_first true). Fresh test secrets, scripted fake Gemini, no network.
 */
const ORIGIN = ORIGINS.gate;
const ownerKey = () => readFileSync('.scratch/e2e-gate-owner-key.txt', 'utf8').trim();
const randomIp = () => `198.51.100.${20 + Math.floor(Math.random() * 200)}`;

test('anonymous visitors get only the sign-in page, whatever they ask for', async ({ request }) => {
  for (const path of ['/', '/index.html', '/settings', '/course/anything', '/favicon.svg', '/theme-init.js', '/_headers', '/assets/missing.js']) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(401);
    const body = await r.text();
    expect(body, path).toContain('Enter your owner key');
    expect(body, path).not.toMatch(/<script|StudyAI|lecture/i); // nothing of the app
    expect(r.headers()['x-robots-tag'], path).toContain('noindex');
    expect(r.headers()['cache-control'], path).toBe('no-store');
  }
  const home = await request.get('/');
  expect(home.headers()['content-security-policy']).toMatch(/^default-src 'none'; style-src 'sha256-[^']+'; form-action 'self'/);
  expect(home.headers()['x-frame-options']).toBe('DENY');
  // the API surface is as closed as before
  expect(await (await request.get('/api/health')).json()).toEqual({ service: 'studyai', ok: true });
  expect((await request.get('/api/owner/status')).status()).toBe(401);
  expect((await request.post('/api/ai/ask', { headers: { origin: ORIGIN }, data: {} })).status()).toBe(401);
  expect((await request.fetch('/', { method: 'POST' })).status()).toBe(405);
});

test('the form needs this site’s Origin and cannot be used cross-site', async ({ request }) => {
  const form = { key: 'sak_' + 'A'.repeat(43) };
  expect((await request.post('/api/auth/gate', { form })).status()).toBe(403); // no Origin
  expect((await request.post('/api/auth/gate', { headers: { origin: 'https://evil.example' }, form })).status()).toBe(403);
  expect((await request.post('/api/auth/gate', { headers: { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, form })).status()).toBe(403);
  expect((await request.post('/api/auth/gate', { headers: { origin: ORIGIN }, data: form })).status()).toBe(415); // JSON is not a form
});

test('sign in at the gate, use the app, sign out, and the gate is back', async ({ page, context }) => {
  await page.setExtraHTTPHeaders({ 'cf-connecting-ip': randomIp() });
  const problems = watchProblems(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Private site' })).toBeVisible();
  await page.getByLabel('Owner key').fill('sak_' + 'x'.repeat(43));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That key was not accepted.');
  expect((await context.cookies()).filter((c) => c.name.includes('studyai'))).toHaveLength(0);

  await page.getByLabel('Owner key').fill(ownerKey());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/`);
  await expect(page.getByRole('link', { name: 'Settings' }).first()).toBeVisible(); // the app itself
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-studyai_session')!;
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });

  // the app loads fully and knows it is signed in
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'AI tutor (Gemini free tier)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.goto('/course/does-not-exist'); // the single-page app handles its own routes
  await expect(page.locator('body')).not.toContainText('Enter your owner key');

  // files carry the app's own security headers plus noindex
  const asset = await page.request.get('/index.html');
  expect(asset.status()).toBe(200);
  expect(asset.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(asset.headers()['x-robots-tag']).toContain('noindex');

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Private site' })).toBeVisible();
  // The sign-in page itself is answered with 401 by design, and Chrome logs every such page load; those are not problems.
  expect(problems.filter((p) => !/Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/.test(p)), 'console errors / CSP violations').toEqual([]);
});

test('a tampered cookie opens nothing; “sign out everywhere” closes the API at once', async ({ request }) => {
  const ip = randomIp();
  const login = await request.post('/api/auth/login', { headers: { origin: ORIGIN, 'cf-connecting-ip': ip }, data: { key: ownerKey() } });
  expect(login.status()).toBe(200);
  const cookie = login.headers()['set-cookie']!.split(';')[0]!;
  expect((await request.get('/', { headers: { cookie } })).status()).toBe(200);
  expect((await request.get('/', { headers: { cookie: cookie.slice(0, -3) + 'abc' } })).status()).toBe(401);
  expect((await request.get('/api/owner/status', { headers: { cookie } })).status()).toBe(200);
  expect((await request.post('/api/auth/logout-all', { headers: { cookie, origin: ORIGIN } })).status()).toBe(200);
  expect((await request.get('/api/owner/status', { headers: { cookie } })).status()).toBe(401); // the API checks fully
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the sign-in page has no WCAG A/AA violations and works with the keyboard (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Owner key')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
    await page.setViewportSize({ width: 360, height: 640 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
