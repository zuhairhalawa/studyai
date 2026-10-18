import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createCourse, importFiles, lectureBytes, revealWithKeyboard } from './helpers';

/**
 * Automated accessibility checks (axe-core) on every screen, in both themes.
 * Automated tools catch roughly a third of real problems; keyboard and screen-reader
 * behaviour are covered by the role/label based selectors used throughout the e2e tests.
 */
async function seed(page: Page) {
  await page.goto('/');
  await createCourse(page, 'Computability and Complexity', 'BCS303');
  await importFiles(page, [{ name: 'Lecture 4 - Turing machines.pptx', buffer: lectureBytes() }]);
  await expect(page.getByText(/Imported: 5 slides/)).toBeVisible();
}

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad, `${label}\n${bad.join('\n')}`).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`no WCAG A/AA violations on any screen (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await seed(page);
    const lectureUrl = page.url();

    await audit(page, 'course page');
    await page.getByRole('link', { name: 'Lecture 4 - Turing machines' }).click();
    await expect(page.getByText('Slide 1 of 5')).toBeVisible();
    await audit(page, 'lecture viewer (content)');
    await page.getByRole('tab', { name: /Checks/ }).click();
    await audit(page, 'lecture viewer (checks)');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText('Slide 4 of 5')).toBeVisible();
    await page.getByRole('tab', { name: 'Content' }).click();
    await audit(page, 'lecture viewer (equation slide)');

    await page.getByRole('link', { name: /Extraction report/ }).click();
    await audit(page, 'report');
    await page.goto('/search?q=turing');
    await expect(page.getByText(/slide/).first()).toBeVisible();
    await audit(page, 'search results');
    await page.goto('/settings');
    await audit(page, 'settings');
    await page.goto('/');
    await audit(page, 'dashboard');
    await page.getByRole('button', { name: 'New course' }).first().click();
    await expect(page.getByRole('dialog', { name: 'New course' })).toBeVisible();
    await audit(page, 'new course dialog');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'New course' })).toBeHidden();
    void lectureUrl;
  });
}

test('keyboard: skip link, focus is never lost, dialogs trap and restore focus', async ({ page }) => {
  await seed(page);
  await page.reload(); // start from a fresh focus state
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByRole('button', { name: 'Course details' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Course details' });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('Course name', { exact: true })).toBeFocused(); // first field is focused on open
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Course details' })).toBeFocused(); // focus returns to the opener
});

for (const scheme of ['light', 'dark'] as const) {
  test(`no WCAG A/AA violations on the study screens (${scheme})`, async ({ page }) => {
    const { importPack, seed: seedLecture, tab } = await import('./helpers');
    await page.emulateMedia({ colorScheme: scheme });
    await seedLecture(page);
    const dialog = await importPack(page);
    await expect(dialog.getByText(/cited quotes were found/)).toBeVisible();
    await audit(page, 'study pack import dialog');
    await dialog.getByRole('button', { name: 'Import 5 items for review' }).click();

    await expect(page.getByRole('heading', { name: '2 cards waiting for your decision' })).toBeVisible();
    await audit(page, 'flashcards (pending review)');
    await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
    await page.getByRole('button', { name: 'New card' }).click();
    await expect(page.getByRole('dialog', { name: 'New card' })).toBeVisible();
    await audit(page, 'card editor dialog');
    await page.keyboard.press('Escape');

    await page.getByRole('link', { name: 'Start review' }).click();
    await expect(page.getByRole('main', { name: 'Flashcard' })).toBeVisible();
    await audit(page, 'review (question side)');
    await revealWithKeyboard(page);
    await audit(page, 'review (answer side)');
    await page.goBack();

    await tab(page, 'Notes').click();
    await page.getByRole('button', { name: 'Notes from slides' }).click();
    await page.getByRole('dialog', { name: 'Notes from your slides' }).getByRole('button', { name: 'Create notes' }).click();
    await expect(page.getByText('Created 1 note.')).toBeVisible();
    await audit(page, 'notes list');
    await page.getByRole('link', { name: /lecture notes/ }).click();
    await expect(page.getByText('Auto-extracted from slides').first()).toBeVisible();
    await audit(page, 'note editor');

    await tab(page, 'Practice and exams').click();
    await expect(page.getByRole('heading', { name: '2 questions waiting for your decision' })).toBeVisible();
    await audit(page, 'practice (pending questions)');
    await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
    await page.getByRole('button', { name: 'New question' }).click();
    await expect(page.getByRole('dialog', { name: 'New question' })).toBeVisible();
    await audit(page, 'question editor dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Build an exam' }).click();
    await expect(page.getByRole('dialog', { name: 'Build a practice exam' })).toBeVisible();
    await audit(page, 'exam builder dialog');
    await page.getByRole('dialog', { name: 'Build a practice exam' }).getByRole('button', { name: 'Start exam' }).click();

    await expect(page.getByRole('main', { name: 'Question' })).toBeVisible();
    await audit(page, 'exam (taking)');
    await page.getByRole('button', { name: 'Submit' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Submit your exam?' })).toBeVisible();
    await audit(page, 'submit confirmation');
    await page.getByRole('dialog', { name: 'Submit your exam?' }).getByRole('button', { name: 'Submit now' }).click();
    await expect(page.getByRole('heading', { name: 'Your score' })).toBeVisible();
    await expect(page.getByText('Mark your answer')).toBeVisible();
    await audit(page, 'exam results with self-marking');
  });
}
