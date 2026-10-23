import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { META_CSP } from '../../config/headers';
import { DEMO_PATH, ORIGINS } from './ports';
import { revealWithKeyboard, tab, trackRequests, watchProblems } from './helpers';

/**
 * The static public demo (`vite build --mode demo`, docs/DEMO.md), served under /studyai/ with NO response headers, as GitHub
 * Pages serves it: the policy that protects it is the one in the page.
 */
const SAMPLE = 'Skyship Navigation (invented demo course)';
const banner = (page: Page) => page.getByRole('region', { name: 'About this demo' });

async function loadSample(page: Page): Promise<void> {
  await page.goto('./');
  await banner(page).getByRole('button', { name: 'Load the sample course' }).click();
  await expect(page.getByRole('heading', { level: 1, name: SAMPLE })).toBeVisible();
}

test('the banner says what the demo is, and the policy inside the page is what is enforced', async ({ page, request }) => {
  const violations: string[] = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && violations.push(m.text()));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const res = await page.goto('./');
  // No header carries a policy here (GitHub Pages sends none): only the <meta> can be what blocks the probes below.
  expect(res!.headers()['content-security-policy']).toBeUndefined();
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', META_CSP);
  expect(META_CSP).toContain("connect-src 'self'");
  expect(META_CSP).toContain("script-src 'self'");
  expect(META_CSP).not.toContain("'unsafe-eval'");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');

  await expect(page).toHaveTitle('StudyAI demo');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  const note = banner(page);
  await expect(note).toContainText('Demo.');
  await expect(note).toContainText('The sample content is fictional.');
  await expect(note).toContainText('stays in this browser and is never uploaded');
  await expect(note).toContainText('AI features are not available in the demo.');
  await expect(note.getByRole('button', { name: 'Load the sample course' })).toBeVisible();
  violations.length = 0; // the page itself loaded cleanly; now probe the policy

  const ran = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true';
    document.head.appendChild(s);
    return (window as unknown as { __injected?: boolean }).__injected === true;
  });
  expect(ran).toBe(false);
  expect(await page.evaluate(() => fetch('https://example.com/', { mode: 'no-cors' }).then(() => true).catch(() => false))).toBe(false);
  expect(errors).toEqual([]);

  // GitHub Pages answers an unknown path with 404.html: it must be the app, so a reload on a deep link still opens it.
  const index = await (await request.get('./')).text();
  expect(await (await request.get('./404.html')).text()).toBe(index);
});

test('one click loads the sample course: slides beside text, search, flashcards and a practice exam', async ({ page }) => {
  const problems = watchProblems(page);
  const requests = trackRequests(page);
  await loadSample(page);

  // --- the course ------------------------------------------------------------------
  await expect(page.getByRole('link', { name: 'Lecture 1 - Reading a sky chart' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Lecture 2 - Dead reckoning aloft' })).toBeVisible();
  await expect(banner(page).getByRole('button', { name: 'Open the sample course' })).toBeVisible();

  // --- reading: the slide beside the text the app extracted ----------------------------
  await page.getByRole('link', { name: 'Lecture 2 - Dead reckoning aloft' }).click();
  await expect(page.getByText('Slide 1 of 7')).toBeVisible();
  for (const n of [2, 3, 4]) {
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText(`Slide ${n} of 7`)).toBeVisible();
  }
  const content = page.getByRole('tabpanel');
  await expect(content.getByText('A head wind takes its speed away')).toBeVisible();
  await expect(content.locator('.katex').first()).toBeVisible(); // the formula is drawn
  await expect(page.locator('section[aria-label="Slide"] .slide-stage')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(content.getByText('PLOT-LEG(start, heading, ground_speed, hours)')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(content.getByRole('table')).toBeVisible();

  // --- search --------------------------------------------------------------------------
  await page.getByLabel('Search all lectures').first().fill('mooring');
  await page.getByLabel('Search all lectures').first().press('Enter');
  await expect(page).toHaveURL(/\/studyai\/search\?q=mooring/);
  const hit = page.getByRole('link', { name: /Chart symbols/ });
  await expect(hit).toBeVisible();
  await expect(hit.locator('mark')).toContainText(/mooring/i);
  await hit.click();
  await expect(page.getByText('Slide 4 of 7')).toBeVisible();

  // --- flashcards: approved from the start, sources already checked ----------------------
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link').first().click();
  await tab(page, /Flashcards/).click();
  await expect(page.getByText(/13 cards ready/)).toBeVisible();
  await page.getByRole('link', { name: 'Start review' }).click();
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible();
  await revealWithKeyboard(page);
  await expect(page.getByText('Source verified')).toBeVisible();
  await page.keyboard.press('3');
  await expect(page.getByRole('button', { name: 'Show answer' }).or(page.getByRole('heading', { name: 'Session finished' }))).toBeVisible();

  // --- a practice exam from the sample questions ------------------------------------------
  await page.goto('./');
  await page.getByRole('link', { name: SAMPLE }).first().click();
  await tab(page, 'Practice and exams').click();
  await expect(page.getByText('8 approved questions in your bank.')).toBeVisible();
  await page.getByRole('button', { name: 'Build an exam' }).click();
  const builder = page.getByRole('dialog', { name: 'Build a practice exam' });
  await expect(builder.getByText(/8 approved questions match/)).toBeVisible();
  await builder.getByRole('button', { name: 'Start exam' }).click();
  await expect(page.getByText(/^0 of \d+ answered$/)).toBeVisible();
  const main = page.getByRole('main', { name: 'Question' });
  await expect(main).toBeVisible();
  await page.getByRole('button', { name: 'Submit' }).first().click();
  const confirm = page.getByRole('dialog', { name: 'Submit your exam?' });
  await confirm.getByRole('button', { name: 'Submit now' }).click();
  await expect(page).toHaveURL(/\/results$/);

  expect(problems, 'console errors / CSP violations').toEqual([]);
  const origin = ORIGINS.demo;
  expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')), 'only this site, blob and data URLs').toEqual([]);
  expect(requests.filter((u) => u.startsWith(origin) && !new URL(u).pathname.startsWith(DEMO_PATH)), 'everything is under the sub-path').toEqual([]);
  expect(requests.filter((u) => u.includes('/api/')), 'the demo never calls an API').toEqual([]);
});

test('the AI tutor is absent everywhere and nothing is sent', async ({ page }) => {
  const problems = watchProblems(page);
  const requests = trackRequests(page);
  await loadSample(page);

  await tab(page, 'AI tutor').click();
  await expect(page.getByText('No AI here')).toBeVisible();
  await expect(page.getByText('AI is not available in this copy of the app.')).toBeVisible();
  await page.getByLabel('Your question').fill('What is dead reckoning?');
  await expect(page.getByRole('button', { name: /^Send/ })).toBeDisabled();

  await page.getByRole('button', { name: 'Study packs from your own AI' }).click();
  await page.getByRole('menuitem', { name: 'Generate with the AI tutor (Gemini)…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate study material with the AI tutor' });
  await expect(dialog.getByText('AI is not available in this copy of the app.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Generate and check' })).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Settings and backup' }).first().click();
  await expect(page.getByText('AI is off here')).toBeVisible();
  await expect(page.getByText(/no AI server, so nothing is ever sent anywhere/)).toBeVisible();
  await expect(page.getByLabel(/owner key/i)).toHaveCount(0); // no sign-in form for a server that does not exist

  expect(requests.filter((u) => u.includes('/api/') || !u.startsWith(ORIGINS.demo) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
  expect(problems).toEqual([]);
});

test('the shipped demo files hold no AI client, no provider host and no key', async ({ request }) => {
  const files = readdirSync('dist-demo/assets').filter((f) => /\.(js|css)$/.test(f));
  expect(files.length).toBeGreaterThan(10);
  const bad = /api\.anthropic\.com|x-api-key|sk-ant-|ANTHROPIC_API_KEY|anthropic-version|generativelanguage\.googleapis\.com|x-goog-api-key|AIza[0-9A-Za-z_-]{20,}|GEMINI_API_KEY|\/api\/(?:health|auth|owner|ai)/;
  for (const f of files) {
    const body = await (await request.get(`assets/${f}`)).text();
    expect(bad.test(body), `${f} must not contain an AI client, a provider host or key material`).toBe(false);
  }
  expect(bad.test(await (await request.get('./')).text())).toBe(false);
});

test('the sample course survives a reload and is opened, not copied, by a second press', async ({ page }) => {
  await loadSample(page);
  const course = page.url();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: SAMPLE })).toBeVisible();
  await page.goto('./');
  await expect(page.getByRole('link', { name: SAMPLE }).first()).toBeVisible();
  await banner(page).getByRole('button', { name: 'Open the sample course' }).click();
  await expect(page).toHaveURL(course);
  await expect(page.getByRole('navigation', { name: 'Courses' }).getByRole('listitem')).toHaveCount(1);
});

test('the banner and the sample course fit a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadSample(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('./');
  await expect(banner(page).getByRole('button', { name: 'Open the sample course' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the demo banner and the sample course pass the accessibility audit (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const audit = async (label: string) => {
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      const bad = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
      expect(bad, `${label}\n${bad.join('\n')}`).toEqual([]);
    };
    await page.goto('./');
    await expect(banner(page)).toBeVisible();
    await audit('dashboard with the demo banner');
    await loadSample(page);
    await audit('the sample course');
  });
}
