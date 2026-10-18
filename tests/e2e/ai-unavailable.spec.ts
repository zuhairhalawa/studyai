import AxeBuilder from '@axe-core/playwright';
import { ORIGINS } from './ports';
import { expect, test, type Page } from '@playwright/test';
import { seed, tab, trackRequests, watchProblems } from './helpers';

/**
 * The app opened WITHOUT the AI server (plain static preview): every AI screen must say so, send nothing anywhere, and the
 * rest of the app must be untouched.
 */
async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad, `${label}\n${bad.join('\n')}`).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`without an AI server every AI screen explains it and sends nothing (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const problems = watchProblems(page);
    const requests = trackRequests(page);
    await seed(page);

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'AI tutor (Gemini free tier)' })).toBeVisible();
    await expect(page.getByText('AI is off here')).toBeVisible();
    await expect(page.getByText(/no AI server, so nothing is ever sent anywhere/)).toBeVisible();
    await audit(page, 'settings (no server)');

    await page.goto('/');
    await page.getByRole('link', { name: /Computability/ }).first().click();
    await tab(page, 'AI tutor').click();
    await expect(page.getByText('No AI here')).toBeVisible();
    await page.getByLabel('Your question').fill('What is a tape?');
    await expect(page.getByRole('button', { name: /^Send/ })).toBeDisabled();
    await audit(page, 'tutor (no server)');

    await page.getByRole('button', { name: 'Study packs from your own AI' }).click();
    await page.getByRole('menuitem', { name: 'Generate with the AI tutor (Gemini)…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Generate study material with the AI tutor' });
    await expect(dialog.getByText('AI is not available in this copy of the app.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Generate and check' })).toBeDisabled();
    await audit(page, 'generate dialog (no server)');
    await page.keyboard.press('Escape');

    // the lecture viewer offers the tutor, and everything else there still works
    await tab(page, 'Lectures').click();
    await page.getByRole('link', { name: 'Lecture 4 - Turing machines' }).click();
    await expect(page.getByRole('link', { name: 'Ask the tutor' })).toHaveAttribute('href', /\/tutor\?lecture=.*&slide=1/);
    await expect(page.getByText('Slide 1 of 5')).toBeVisible();

    // nothing but this site's own files was ever requested, and the only /api calls were the harmless availability check
    expect(requests.filter((u) => !u.startsWith(ORIGINS.preview) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
    expect(requests.filter((u) => u.includes('/api/')).every((u) => /\/api\/health$/.test(u))).toBe(true);
    expect(problems).toEqual([]);
  });
}
