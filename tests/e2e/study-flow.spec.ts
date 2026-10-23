import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createCourse, importFiles, lectureBytes, trackRequests } from './helpers';

test.describe.configure({ mode: 'serial' });

test('upload → read → search → reload → backup → restore', async ({ page }, testInfo) => {
  const requests = trackRequests(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Start with a course')).toBeVisible();

  // --- course + import -----------------------------------------------------
  await createCourse(page, 'Computability and Complexity', 'BCS303');
  const original = lectureBytes();
  await importFiles(page, [{ name: 'Lecture 4 - Turing machines.pptx', buffer: original }]);
  await expect(page.getByText(/Imported: 5 slides/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Lecture 4 - Turing machines' })).toBeVisible();
  await expect(page.getByText('5 slides').first()).toBeVisible();

  // --- reading -------------------------------------------------------------
  await page.getByRole('link', { name: 'Lecture 4 - Turing machines' }).click();
  await expect(page.getByText('Slide 1 of 5')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('Slide 2 of 5')).toBeVisible();
  const content = page.getByRole('tabpanel');
  await expect(content.getByText('A tape that is infinite in both directions')).toBeVisible();
  await expect(content.getByText('A finite control with states')).toBeVisible();

  await page.getByRole('tab', { name: /Speaker notes/ }).click();
  await expect(content.getByText('Draw the 7-tuple on the board.')).toBeVisible();
  await page.getByRole('tab', { name: 'Content' }).click();

  // provenance: clicking a shape on the slide highlights its extracted block
  await page.locator('section[aria-label="Slide"] .slide-stage [data-el="3"]').click();
  await expect(page.locator('#blk-3')).toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: testInfo.outputPath('lecture-desktop.png') });

  // table slide
  await page.keyboard.press('ArrowRight');
  await expect(content.getByRole('table')).toBeVisible();
  await expect(content.getByRole('columnheader', { name: 'Halts on yes' })).toBeVisible();

  // equation slide: KaTeX renders in the extracted view
  await page.keyboard.press('ArrowRight');
  await expect(content.locator('.katex').first()).toBeVisible();

  // picture slide + checks tab honesty
  await page.keyboard.press('ArrowRight');
  await expect(content.getByText('State diagram of a simple machine')).toBeVisible();
  await page.getByRole('tab', { name: /Checks/ }).click();
  await expect(content.getByText(/may contain text, a diagram or a screenshot that was not extracted/i).first()).toBeVisible();

  // --- report --------------------------------------------------------------
  await page.getByRole('link', { name: /Extraction report/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Extraction report' })).toBeVisible();
  await expect(page.getByText('Potentially missing content')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('report-desktop.png'), fullPage: true });

  // --- search --------------------------------------------------------------
  await page.getByLabel('Search all lectures').fill('unbounded');
  await page.getByLabel('Search all lectures').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=unbounded/);
  const hit = page.getByRole('link', { name: /Definition of a Turing machine/ });
  await expect(hit).toBeVisible();
  await expect(hit.getByText('speaker notes')).toBeVisible(); // matched only in notes
  await expect(hit.locator('mark')).toContainText('unbounded');
  await page.screenshot({ path: testInfo.outputPath('search-desktop.png') });
  await hit.click();
  await expect(page.getByText('Slide 2 of 5')).toBeVisible();

  // --- persistence ---------------------------------------------------------
  await page.reload();
  await expect(page.getByText('Slide 2 of 5')).toBeVisible();
  await expect(page.getByRole('tabpanel').getByText('A transition function')).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('Continue where you left off')).toBeVisible();
  await expect(page.getByRole('link', { name: /Computability and Complexity/ }).first()).toBeVisible();

  // --- backup & restore ----------------------------------------------------
  await page.getByRole('link', { name: 'Settings and backup' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^studyai-backup-\d{4}-\d{2}-\d{2}\.studyai\.zip$/);
  const backupPath = testInfo.outputPath('backup.studyai.zip');
  await download.saveAs(backupPath);
  expect(readFileSync(backupPath).subarray(0, 2).toString()).toBe('PK');

  // wipe the library completely
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((d) => new Promise<void>((res) => { const r = indexedDB.deleteDatabase(d.name!); r.onsuccess = r.onerror = r.onblocked = () => res(); })));
  });
  await page.goto('/');
  await expect(page.getByText('Start with a course')).toBeVisible();

  await page.getByRole('link', { name: 'Settings and backup' }).click();
  await page.locator('input[aria-label="Choose a backup file"]').setInputFiles(backupPath);
  const dialog = page.getByRole('dialog', { name: 'Restore from backup' });
  await expect(dialog.getByText('It was checked and is safe to read.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('restore-dialog.png') });
  await dialog.getByRole('button', { name: 'Merge into my library' }).click();
  await expect(page.getByText(/Restored: 1 lectures \(5 slides\)/)).toBeVisible();

  await page.getByRole('link', { name: /Computability and Complexity/ }).first().click();
  await page.getByRole('link', { name: 'Lecture 4 - Turing machines' }).click();
  await expect(page.getByText('Slide 1 of 5')).toBeVisible(); // wait for the lazily loaded page
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tabpanel').getByText('A tape that is infinite in both directions')).toBeVisible();
  // original file and images survived the round trip
  await page.getByRole('link', { name: /Computability and Complexity/ }).first().click();
  await page.getByRole('button', { name: /Actions for Lecture 4/ }).click();
  const [orig] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download original file' }).click()]);
  const origPath = testInfo.outputPath('original.pptx');
  await orig.saveAs(origPath);
  expect(readFileSync(origPath).equals(original)).toBe(true);

  // --- privacy: the app never talks to anyone but its own origin ------------
  const origin = new URL(page.url()).origin;
  const foreign = requests.filter((u) => !(u.startsWith(origin) || u.startsWith('blob:') || u.startsWith('data:')));
  expect(foreign, `unexpected network requests: ${foreign.join(', ')}`).toEqual([]);
});

test('duplicates and same-named files ask before doing anything', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, 'Algorithms');
  const original = lectureBytes();
  await importFiles(page, [{ name: 'lec.pptx', buffer: original }]);
  await expect(page.getByText(/Imported: 5 slides/)).toBeVisible();

  // exact same bytes again (different name) → duplicate prompt, default is skip
  await importFiles(page, [{ name: 'copy of lec.pptx', buffer: original }]);
  await expect(page.getByText(/This exact file is already in your library/)).toBeVisible();
  await page.getByRole('button', { name: 'Skip it' }).click();
  await expect(page.getByText('Skipped')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'copy of lec' })).toHaveCount(0 + 1); // only the queue row, no lecture row
  await expect(page.getByRole('link', { name: 'copy of lec' })).toHaveCount(0);

  // same file name, different content → offer to replace in place
  await page.getByRole('button', { name: 'Clear finished' }).click();
  await importFiles(page, [{ name: 'lec.pptx', buffer: lectureBytes({ suffix: ' (updated)' }) }]);
  await expect(page.getByText(/A lecture from a file with this name already exists/)).toBeVisible();
  await page.getByRole('button', { name: 'Replace the existing lecture' }).click();
  await expect(page.getByText(/Replaced: 5 slides/)).toBeVisible();
  await page.getByRole('link', { name: 'lec', exact: true }).click();
  await expect(page.getByRole('tabpanel').getByText('Turing Machines and Decidability (updated)')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('listitem').filter({ hasText: 'lec.pptx' })).toHaveCount(1);
});

test('rejects unsafe or unsupported files with clear messages', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, 'Security');
  const input = page.locator('input[aria-label="Choose PowerPoint files"]');
  await input.setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    { name: 'old.ppt', mimeType: 'application/vnd.ms-powerpoint', buffer: Buffer.from('x') },
    { name: 'fake.pptx', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not a zip file but is long enough to be read') },
  ]);
  await expect(page.getByText('Only PowerPoint files (.pptx, .pptm, .ppsx, .potx) can be imported.')).toBeVisible();
  await expect(page.getByText(/old \.ppt file/)).toBeVisible();
  await expect(page.getByText('This file is not a valid .pptx presentation.')).toBeVisible();
  await expect(page.getByText('No lectures yet')).toBeVisible(); // nothing was stored
});
