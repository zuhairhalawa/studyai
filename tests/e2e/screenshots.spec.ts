import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { computabilityDeck } from '../fixtures/computability-deck';
import { mathDeck } from '../fixtures/math-deck';
import { createCourse, importFiles, importPack, lectureBytes } from './helpers';

/**
 * Regenerates the screenshots in docs/screenshots (used by the README). Skipped unless STUDYAI_SCREENSHOTS=1:
 *   STUDYAI_SCREENSHOTS=1 pnpm exec playwright test screenshots --project=desktop
 * Every lecture and pack here is synthetic (tests/fixtures); nothing from a real course is ever shown.
 */
test.skip(!process.env['STUDYAI_SCREENSHOTS'], 'Set STUDYAI_SCREENSHOTS=1 to regenerate the README screenshots.');

const OUT = 'docs/screenshots';
const PROOF = 'Assume for contradiction that B is regular';

test('README screenshots, from synthetic lectures only', async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await createCourse(page, 'Theory and algorithms', 'CS301');
  await importFiles(page, [{ name: 'Computability.pptx', buffer: Buffer.from(computabilityDeck()) }]);
  await expect(page.getByText(/Imported: 15 slides/)).toBeVisible();
  await importFiles(page, [{ name: 'Divide and conquer.pptx', buffer: Buffer.from(mathDeck()) }]);
  await expect(page.getByText(/Imported: 12 slides/)).toBeVisible();
  await importFiles(page, [{ name: 'Lecture 4 - Turing machines.pptx', buffer: lectureBytes() }]);
  await expect(page.getByText(/Imported: 5 slides/)).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/course.png` });

  // a proof slide next to what the app extracted from it (exponents and symbols kept)
  await page.getByRole('link', { name: 'Computability' }).first().click();
  const id = page.url().match(/\/lecture\/([^/?#]+)/)![1]!;
  await page.goto(`/lecture/${id}?slide=7`);
  await expect(page.getByRole('tabpanel').getByText(PROOF)).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/lecture.png` });

  // a study pack from an AI: every cited quote is checked against the real slide
  await page.goto('/');
  await page.getByRole('link', { name: /Theory and algorithms/ }).first().click();
  const dialog = await importPack(page);
  await expect(dialog.getByText(/cited quotes were found/)).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/pack-check.png` });

  // the same app at the width of a phone (the same browser profile, so the lectures are already there)
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/lecture/${id}?slide=7`);
  await expect(page.getByRole('tabpanel').getByText(PROOF)).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/phone.png` });
});
