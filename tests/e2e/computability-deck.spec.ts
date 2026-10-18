import { expect, test } from '@playwright/test';
import { computabilityDeck } from '../fixtures/computability-deck';
import { createCourse, importFiles, watchProblems } from './helpers';

/**
 * A Computability and Complexity lecture in the real interface: formal definitions with symbols, exponents and subscripts, a
 * transition table, state diagrams as pictures whose words the student types. Synthetic deck (tests/fixtures/computability-deck.ts).
 */
test('a theory lecture is read and drawn: symbols, exponents and subscripts, the transition tables, the state diagram typed by the student', async ({ page }, testInfo) => {
  const problems = watchProblems(page);
  await page.goto('/');
  await createCourse(page, 'Computability', 'CS301');
  await importFiles(page, [{ name: 'Computability and complexity.pptx', buffer: Buffer.from(computabilityDeck()) }]);
  await expect(page.getByText(/Imported: 15 slides/)).toBeVisible();
  await page.locator('a[href*="/lecture/"]').first().click();
  const id = page.url().match(/\/lecture\/([^/?#]+)/)![1]!;
  const content = page.getByRole('tabpanel');

  // the definition with its symbols, exactly as written
  await page.goto(`/lecture/${id}?slide=4`);
  await expect(content).toContainText('δ: Q × Σ → Q is the transition function');
  await expect(content).toContainText('q0 ∈ Q is the start state and F ⊆ Q is the set of accept states');

  // the proof: exponents drawn as exponents, and the end of the proof
  await page.goto(`/lecture/${id}?slide=7`);
  await expect(content).toContainText('Assume for contradiction that B is regular');
  await expect(content.locator('sup', { hasText: 'p' }).first()).toBeVisible();
  await expect(content).toContainText('∎');
  await expect(content).not.toContainText('^{');

  // the language A_TM: a subscript drawn as a subscript, with the angle brackets
  await page.goto(`/lecture/${id}?slide=10`);
  await expect(content.locator('sub', { hasText: 'TM' }).first()).toBeVisible();
  await expect(content).toContainText('⟨M, w⟩');

  // the transition table of the Turing machine
  await page.goto(`/lecture/${id}?slide=9`);
  await expect(content.getByRole('table')).toBeVisible();
  await expect(content.getByRole('columnheader', { name: 'Move' })).toBeVisible();
  await expect(content.getByRole('cell', { name: 'q_accept' })).toBeVisible();

  // the state diagram is a picture: the report says so, and typing its words makes it part of the lecture
  await page.goto(`/lecture/${id}/report`);
  await expect(page.getByText(/Picture that may hold text or a diagram \(not read automatically\)/)).toBeVisible();
  await page.goto(`/lecture/${id}?slide=5`);
  await page.getByLabel('Words in this picture').fill('two circles q0 and q1; q0 has a double ring and an arrow in; q0 to q1 labelled 0; q1 to q0 labelled 0; each state loops on 1');
  await page.getByRole('button', { name: 'Save text' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Words in this picture')).toHaveValue(/q0 to q1 labelled 0/);
  await expect(content).toContainText('q0 (start, accept)');
  await page.screenshot({ path: testInfo.outputPath('computability-diagram.png'), fullPage: true });

  // search finds a definition by its words
  await page.goto('/');
  const search = page.getByLabel('Search all lectures');
  await search.fill('pumping length');
  await search.press('Enter');
  await expect(page.getByRole('link', { name: /pumping lemma/i }).first()).toBeVisible();
  expect(problems).toEqual([]);
});
