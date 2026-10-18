import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PNG_1X1, bodySp, buildPptx, para, picture, titleSp } from '../fixtures/pptx-builder';
import { createCourse, importFiles, watchProblems } from './helpers';

/**
 * A diagram's words are not in the file as text. The student can type them in; they become study text marked as typed by
 * the student, settle the "may hold text" warning, are searchable, and survive a reload. Synthetic deck only.
 */
const deck = () =>
  Buffer.from(
    buildPptx({
      slides: [
        {
          shapes: titleSp(2, 'Memory layout') + bodySp(3, [para('Two regions are shown', { bullet: 'char' })]) + picture(4, 'rIdImg1', 4500000, 1800000, 3800000, 3600000),
          rels: { rIdImg1: ['image', '../media/image1.png'] },
          parts: { 'ppt/media/image1.png': PNG_1X1 },
        },
      ],
    }),
  );

test('type the words of a picture: marked as typed, searchable, report updated, saved across reload', async ({ page }) => {
  const problems = watchProblems(page);
  await page.goto('/');
  await createCourse(page, 'Pictures', 'PIC1');
  await importFiles(page, [{ name: 'Diagram lecture.pptx', buffer: deck() }]);
  await expect(page.getByText(/Imported: 1 slide/)).toBeVisible();
  await page.locator('a[href*="/lecture/"]').first().click();
  const id = page.url().match(/\/lecture\/([^/?#]+)/)![1]!;

  // the report says plainly that the picture may hold words that were not read
  await page.goto(`/lecture/${id}/report`);
  await expect(page.getByText(/Picture that may hold text or a diagram \(not read automatically\)/)).toBeVisible();

  await page.goto(`/lecture/${id}?slide=1`);
  const box = page.getByLabel('Words in this picture');
  await expect(box).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save text' })).toBeDisabled(); // nothing typed yet
  await box.fill('high address\nstack\nuninitialized data (bss)\nlow address');
  await page.getByRole('button', { name: 'Save text' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

  // the viewer's checks and the report now treat the picture as dealt with
  await page.reload();
  await expect(page.getByLabel('Words in this picture')).toHaveValue(/uninitialized data \(bss\)/);
  await expect(page.getByText(/may contain text, a diagram or a screenshot that was not extracted/)).toHaveCount(0); // not repeated under the picture
  await expect(page.getByRole('tab', { name: 'Checks' })).toBeVisible(); // and no count of open problems on the tab
  await page.getByRole('tab', { name: /Checks/ }).click();
  await expect(page.getByText(/You typed the text of a picture on this slide/)).toBeVisible();
  await expect(page.getByText(/Settled, you typed the picture’s words/)).toBeVisible();
  await page.goto(`/lecture/${id}/report`);
  await expect(page.getByText(/Picture that may hold text or a diagram/)).toHaveCount(0);
  await expect(page.getByText('Reliable').first()).toBeVisible();

  // the typed words are searchable, and only because the student typed them
  await page.getByLabel('Search all lectures').fill('bss');
  await page.getByLabel('Search all lectures').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=bss/);
  await expect(page.getByRole('link', { name: /Memory layout/ })).toBeVisible();

  // removing them brings the warning back
  await page.goto(`/lecture/${id}?slide=1`);
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Removed.' })).toBeVisible();
  await page.goto(`/lecture/${id}/report`);
  await expect(page.getByText(/Picture that may hold text or a diagram/)).toBeVisible();
  expect(problems, 'console errors / CSP violations').toEqual([]);
});

test('the picture-text box has no WCAG A/AA violations', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, 'Pictures', 'PIC2');
  await importFiles(page, [{ name: 'Diagram lecture.pptx', buffer: deck() }]);
  await page.locator('a[href*="/lecture/"]').first().click();
  const id = page.url().match(/\/lecture\/([^/?#]+)/)![1]!;
  await page.goto(`/lecture/${id}?slide=1`);
  await expect(page.getByLabel('Words in this picture')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
