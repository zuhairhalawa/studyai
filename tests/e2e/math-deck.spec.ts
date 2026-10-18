import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mathDeck } from '../fixtures/math-deck';
import { buildPptx } from '../fixtures/pptx-builder';
import { createCourse, importFiles, tab, watchProblems } from './helpers';

/**
 * A mathematical lecture in the real interface: formulas drawn as maths, a proof in order, pseudocode with its indentation, a table,
 * a matrix, and marking points that hold formulas. Synthetic deck only (tests/fixtures/math-deck.ts).
 */

test('a mathematical lecture is read and drawn: formulas as maths, the proof in order, pseudocode as code, the table, the matrix', async ({ page }, testInfo) => {
  const problems = watchProblems(page);
  await page.goto('/');
  await createCourse(page, 'Algorithms', 'CS201');
  await importFiles(page, [{ name: 'Divide and conquer.pptx', buffer: Buffer.from(mathDeck()) }]);
  await expect(page.getByText(/Imported: 12 slides/)).toBeVisible();
  await page.locator('a[href*="/lecture/"]').first().click();
  const id = page.url().match(/\/lecture\/([^/?#]+)/)![1]!;
  const content = page.getByRole('tabpanel');

  // the sum: drawn on the slide and in the extracted view, none of it left as raw LaTeX
  await page.goto(`/lecture/${id}?slide=4`);
  await expect(content.locator('.katex').first()).toBeVisible();
  await expect(page.locator('section[aria-label="Slide"] .katex').first()).toBeVisible();
  await expect(content.getByText('Claim: for every n ≥ 1 the following holds.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('math-sum.png'), fullPage: true });

  // the proof: the five steps in order, and the formula under them
  await page.goto(`/lecture/${id}?slide=5`);
  const steps = content.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Body' }) }).getByRole('listitem');
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(0)).toContainText('Base case');
  await expect(steps.nth(1)).toContainText('Inductive hypothesis');
  await expect(steps.nth(2)).toContainText('Inductive step');
  await expect(steps.nth(4)).toContainText('∎');
  await expect(content.locator('.katex').first()).toBeVisible();

  // the recurrence with its two formulas, and the master theorem with its cases
  await page.goto(`/lecture/${id}?slide=6`);
  await expect(content.locator('.katex')).toHaveCount(2);
  await page.goto(`/lecture/${id}?slide=7`);
  await expect(content.locator('.katex').first()).toBeVisible();
  await expect(content).toContainText('Let a ≥ 1 and b > 1 be constants');

  // pseudocode keeps its lines and its indentation, and the < is a <
  await page.goto(`/lecture/${id}?slide=8`);
  const line = content.locator('code', { hasText: 'if p < r' }).first();
  await expect(line).toBeVisible();
  expect(await line.evaluate((el) => el.textContent)).toBe('  if p < r');
  expect(await line.evaluate((el) => getComputedStyle(el).fontFamily.toLowerCase())).toMatch(/mono|consolas|courier/);
  await expect(content.locator('code', { hasText: 'MERGE-SORT(A, q + 1, r)' })).toBeVisible();

  // the table
  await page.goto(`/lecture/${id}?slide=9`);
  await expect(content.getByRole('table')).toBeVisible();
  await expect(content.getByRole('columnheader', { name: 'Worst case' })).toBeVisible();
  await expect(content.getByRole('cell', { name: 'O(n²)' }).first()).toBeVisible();

  // the matrix and the determinant
  await page.goto(`/lecture/${id}?slide=11`);
  await expect(content.locator('.katex .mtable')).toBeVisible();
  await expect(content.locator('.katex')).toHaveCount(2);

  // search finds a formula by its readable text and a word of the proof
  await page.goto('/');
  const search = page.getByLabel('Search all lectures');
  await search.fill('inductive hypothesis');
  await search.press('Enter');
  await expect(page.getByRole('link', { name: /Proof by induction/ }).first()).toBeVisible();

  // the report counts the formulas and says nothing was half-understood
  await page.goto(`/lecture/${id}/report`);
  await expect(page.getByRole('heading', { level: 1, name: 'Extraction report' })).toBeVisible();
  await expect(page.getByRole('term').filter({ hasText: 'Equations' }).locator('xpath=following-sibling::*[1]')).toHaveText('7');
  expect(problems).toEqual([]);
});

test('marking points with formulas are drawn as maths in the exam and its results, and a dollar price is left alone', async ({ page }, testInfo) => {
  const problems = watchProblems(page);
  await page.goto('/');
  await createCourse(page, 'Algorithms', 'CS201');
  await importFiles(page, [{ name: 'Divide and conquer.pptx', buffer: Buffer.from(mathDeck()) }]);
  await expect(page.getByText(/Imported: 12 slides/)).toBeVisible();
  await page.getByRole('link', { name: /Algorithms/ }).first().click();

  const pack = {
    format: 'studyai-pack',
    version: 1,
    lectures: [{ ref: 'L1', title: 'Divide and conquer' }],
    questions: [
      {
        type: 'calculation',
        prompt: 'Use the formula on the slide to find the sum of the first $n = 10$ integers. Show the formula and the substitution.',
        marks: 3,
        difficulty: 2,
        topic: 'Sum of the first n integers',
        modelAnswer: 'The sum is $\\frac{n(n+1)}{2}$, so for $n = 10$ it is $\\frac{10 \\cdot 11}{2} = 55$.',
        rubric: [
          { text: 'States the formula $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$', marks: 1 },
          { text: 'Substitutes $n = 10$ to get $\\frac{10 \\cdot 11}{2}$', marks: 1 },
          { text: 'Evaluates it to 55 (not $5 or $10)', marks: 1 },
        ],
        basis: 'derived',
        sources: [{ lecture: 'L1', slide: 4, quote: '\\frac{n(n+1)}{2}' }],
      },
    ],
  };
  await page.getByRole('button', { name: 'Study packs from your own AI' }).click();
  await page.getByRole('menuitem', { name: 'Import a study pack…' }).click();
  const imp = page.getByRole('dialog', { name: 'Import a study pack' });
  await imp.getByLabel('Pack JSON').fill(JSON.stringify(pack));
  await imp.getByRole('button', { name: 'Check this pack' }).click();
  await expect(imp.getByText(/1 of 1 cited quotes were found on the slide/)).toBeVisible(); // the quote is a formula written as LaTeX
  await imp.getByRole('button', { name: 'Import 1 item for review' }).click();
  await tab(page, 'Practice and exams').click();
  await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
  await page.getByRole('button', { name: 'Build an exam' }).click();
  await page.getByRole('dialog', { name: 'Build a practice exam' }).getByRole('button', { name: 'Start exam' }).click();

  const main = page.getByRole('main', { name: 'Question' });
  await expect(main.locator('.katex').first()).toBeVisible(); // the question's own formula
  await main.getByLabel('Your answer').fill('The sum is n(n+1)/2 = 10*11/2 = 55.');
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Submit' }).first().click();
  await page.getByRole('dialog', { name: 'Submit your exam?' }).getByRole('button', { name: 'Submit now' }).click();
  await expect(page).toHaveURL(/\/results$/);

  // the marking scheme: formulas drawn, the dollar amounts left as typed
  const item = page.getByRole('listitem').filter({ hasText: 'Use the formula on the slide' }).first();
  await expect(item.getByText('Model answer', { exact: true })).toBeVisible();
  const scheme = item.getByText('What the marks are for').locator('xpath=following-sibling::ul[1]');
  await expect(scheme.locator('.katex')).toHaveCount(3); // the formula in point 1, the substitution in point 2 (two)
  await expect(scheme.getByRole('listitem').nth(2)).toContainText('Evaluates it to 55 (not $5 or $10)'); // a price is not maths
  await expect(scheme.getByRole('listitem').nth(2).locator('.katex')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('math-results.png'), fullPage: true });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  expect(problems).toEqual([]);
});

test('formulas, code and the table stay inside a phone screen, with no sideways scrolling of the page @mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await createCourse(page, 'Algorithms', 'CS201');
  await importFiles(page, [{ name: 'Divide and conquer.pptx', buffer: Buffer.from(mathDeck()) }]);
  await expect(page.getByText(/Imported: 12 slides/)).toBeVisible();
  await page.getByRole('link', { name: 'Divide and conquer' }).click();
  const id = page.url().match(/\/lecture\/([^/?#]+)/)![1]!;
  for (const n of [4, 5, 6, 7, 8, 9, 11]) {
    await page.goto(`/lecture/${id}?slide=${n}`);
    await expect(page.getByRole('tabpanel')).toBeVisible();
    await page.waitForTimeout(400);
    const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(w.scroll, `slide ${n} scrolls sideways: ${JSON.stringify(w)}`).toBeLessThanOrEqual(w.client + 1);
  }
});

/**
 * Found on a real lecture: PowerPoint stores the space between an equation and the words after it inside the equation (a no-break
 * space), and a title with a subscript was listed as "A_{TM} is undecidable". Both are drawn as a person would write them.
 */
test('a space inside an equation stays a space, and a subscript in a title is listed without braces', async ({ page }) => {
  const problems = watchProblems(page);
  const ns = 'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  const math = (...parts: string[]) => `<a14:m ${ns}><m:oMath>${parts.map((t) => `<m:r><m:t>${t}</m:t></m:r>`).join('')}</m:oMath></a14:m>`;
  const text = (t: string, rPr = '') => `<a:r><a:rPr lang="en-US"${rPr}/><a:t>${t}</a:t></a:r>`;
  const title =
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${text('A')}${text('TM', ' baseline="-25000"')}${text(' is undecidable')}</a:p></p:txBody></p:sp>`;
  const body =
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 3"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${text('Show ')}${math('ℕ', ' ')}${text('and ')}${math('ℤ')}${text(' have the same size')}</a:p></p:txBody></p:sp>`;
  await page.goto('/');
  await createCourse(page, 'Theory', 'CS301');
  await importFiles(page, [{ name: 'Spaces.pptx', buffer: Buffer.from(buildPptx({ slides: [{ shapes: title + body }] })) }]);
  await expect(page.getByText(/Imported: 1 slides?/)).toBeVisible();
  await page.locator('a[href*="/lecture/"]').first().click();
  const id = page.url().match(/\/lecture\/([^/?#]+)/)![1]!;
  await page.goto(`/lecture/${id}?slide=1`);
  const para = page.getByRole('tabpanel').locator('p', { hasText: 'have the same size' }).first();
  await expect(para.locator('.katex')).toHaveCount(2);
  // what the eye reads: the drawn letters (not the hidden MathML copy) with the space kept between the first set and "and"
  const seen = await para.evaluate((p) => {
    const c = p.cloneNode(true) as HTMLElement;
    c.querySelectorAll('.katex-mathml').forEach((e) => e.remove());
    return (c.textContent ?? '').replace(/​/g, '');
  });
  expect(seen).toMatch(/Show\s+N\s+and\s+Z\s+have the same size/);
  // the lists name the slide the way it reads, without the braces of its subscript
  await expect(page.getByRole('button', { name: /^Slide 1: A_TM is undecidable/ })).toBeVisible();
  await expect(page.getByText('A_{TM}')).toHaveCount(0);
  expect(problems).toEqual([]);
});

/**
 * Found on a real lecture: PowerPoint pushes text down with blank lines and "space before", and the labels of a figure sit in that
 * gap. The slide drew the text packed together, so it ran over the labels.
 */
test('a blank line and the space before a paragraph keep the text where PowerPoint puts it', async ({ page }) => {
  const sp = (id: number, paragraphs: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Content ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="800000"/><a:ext cx="8000000" cy="4000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
  const r = (t: string) => `<a:r><a:rPr lang="en-US" sz="2000"/><a:t>${t}</a:t></a:r>`;
  const paragraphs =
    `<a:p><a:pPr><a:spcBef><a:spcPts val="1200"/></a:spcBef></a:pPr>${r('First line')}</a:p>` +
    `<a:p><a:pPr><a:spcBef><a:spcPts val="1200"/></a:spcBef></a:pPr><a:endParaRPr lang="en-US" sz="2000"/></a:p>` +
    `<a:p><a:pPr><a:spcBef><a:spcPts val="1200"/></a:spcBef></a:pPr>${r('Second line')}</a:p>`;
  await page.goto('/');
  await createCourse(page, 'Spacing', 'CS302');
  await importFiles(page, [{ name: 'Spacing.pptx', buffer: Buffer.from(buildPptx({ slides: [{ shapes: sp(2, paragraphs) }] })) }]);
  await expect(page.getByText(/Imported: 1 slides?/)).toBeVisible();
  await page.locator('a[href*="/lecture/"]').first().click();
  const canvas = page.locator('section[aria-label="Slide"]').first();
  await expect(canvas.getByText('Second line')).toBeVisible();
  const first = (await canvas.getByText('First line').filter({ visible: true }).boundingBox())!;
  const second = (await canvas.getByText('Second line').filter({ visible: true }).boundingBox())!;
  const width = (await canvas.boundingBox())!.width;
  const pointsBetween = ((second.y - (first.y + first.height)) / width) * 960; // the slide is 960 pt wide
  expect(pointsBetween).toBeGreaterThan(40);
});
