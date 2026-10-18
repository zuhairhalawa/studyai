import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import { createCourse, PPTX_MIME, revealWithKeyboard, tab, watchProblems } from './helpers';

/**
 * Optional: run the whole chain on YOUR real material.
 *   STUDYAI_REAL_LECTURE=C:\path\lecture.pptx  STUDYAI_REAL_PACK=C:\path\pack.json  pnpm test:e2e real-data
 * The pack should already pass `node dist-cli/lecture-cli.mjs validate` (see the lecture-pack skill).
 * Skipped when the variables are not set. Nothing from these files is stored in the repository.
 */
const lecture = process.env['STUDYAI_REAL_LECTURE'];
const pack = process.env['STUDYAI_REAL_PACK'];

test.describe('real lecture and pack', () => {
  test.skip(!lecture || !pack, 'set STUDYAI_REAL_LECTURE and STUDYAI_REAL_PACK to run');

  test('import, read, import the pack, verify quotes, approve and study', async ({ page }, testInfo) => {
    const problems = watchProblems(page);
    await page.goto('/');
    await createCourse(page, 'Real course');
    await page.locator('input[aria-label="Choose PowerPoint files"]').setInputFiles({ name: basename(lecture!), mimeType: PPTX_MIME, buffer: readFileSync(lecture!) });
    await expect(page.getByText(/Imported: \d+ slides/)).toBeVisible({ timeout: 30_000 });
    const slides = Number(/Imported: (\d+) slides/.exec((await page.getByText(/Imported: \d+ slides/).textContent()) ?? '')?.[1]);
    expect(slides).toBeGreaterThan(0);

    // read it
    await page.getByRole('link', { name: /open|need attention/ }).first().click();
    await expect(page.getByText(new RegExp(`Slide 1 of ${slides}`))).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('section[aria-label="Slide"] .slide-stage')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('real-slide-2.png') });
    if ((await page.locator('section[aria-label="Slide"] .katex').count()) > 0) {
      await expect(page.locator('section[aria-label="Extracted content"] .katex').first()).toBeVisible(); // equations render
    }

    // import the pack: every quote must be found on the real slides
    await page.getByRole('link', { name: 'Real course' }).first().click();
    await page.getByRole('button', { name: 'Study packs from your own AI' }).click();
    await page.getByRole('menuitem', { name: 'Import a study pack…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import a study pack' });
    await dialog.getByLabel('Pack JSON').fill(readFileSync(pack!, 'utf8'));
    await dialog.getByRole('button', { name: 'Check this pack' }).click();
    const sources = await dialog.getByText(/cited quotes were found on the slide/).textContent();
    const m = /(\d+) of (\d+) cited quotes/.exec(sources ?? '');
    expect(m, sources ?? '').not.toBeNull();
    expect(m![1], 'every cited quote should be verified').toBe(m![2]);
    await page.screenshot({ path: testInfo.outputPath('real-pack-import.png') });
    await dialog.getByRole('button', { name: /^Import \d+ items for review$/ }).click();

    await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
    await page.getByRole('link', { name: 'Start review' }).click();
    await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible();
    await revealWithKeyboard(page);
    await page.screenshot({ path: testInfo.outputPath('real-card.png') });
    await page.keyboard.press('3');

    await page.goBack();
    await tab(page, 'Practice and exams').click();
    await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
    await page.getByRole('button', { name: 'Build an exam' }).click();
    await page.getByRole('dialog', { name: 'Build a practice exam' }).getByRole('button', { name: 'Start exam' }).click();
    await expect(page.getByRole('main', { name: 'Question' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('real-exam.png') });
    expect(problems, 'console errors / CSP violations').toEqual([]);
  });
});
