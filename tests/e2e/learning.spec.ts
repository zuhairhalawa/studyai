import { expect, test } from '@playwright/test';
import { importPack, revealWithKeyboard, seed, tab, watchProblems } from './helpers';

test.describe.configure({ mode: 'serial' });

test('study pack → verified import → approve → spaced-repetition session → notes', async ({ page }, testInfo) => {
  const problems = watchProblems(page);
  await seed(page);
  const dialog = await importPack(page);

  // the app, not the AI, decides what was really on the slides
  await expect(dialog.getByText(/3 of 5 cited quotes were found on the slide \(1 were not\)/)).toBeVisible();
  await expect(dialog.getByText('Lecture 4 - Turing machines', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pack-import.png') });
  await dialog.getByRole('button', { name: 'Import 5 items for review' }).click();
  await expect(page).toHaveURL(/\/cards\?status=pending/);
  await expect(page.getByText('Imported 2 cards, 1 notes and 2 questions for you to review.')).toBeVisible();

  // --- nothing is studyable until approved ---------------------------------
  await expect(page.getByRole('heading', { name: '2 cards waiting for your decision' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start review' })).toBeDisabled();
  const invented = page.getByRole('listitem').filter({ hasText: 'How many cells does the tape hold?' });
  await expect(invented.getByText('Quote not found on the slide')).toBeVisible();
  await invented.getByRole('button', { name: 'Show source (1)' }).click();
  await expect(invented.getByText('not found on the slide').last()).toBeVisible();
  const real = page.getByRole('listitem').filter({ hasText: 'What does the tape of a Turing machine look like?' });
  await expect(real.getByText('Source verified')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('cards-pending.png'), fullPage: true });

  // "approve all" skips anything whose quote was contradicted by the slides
  await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
  await expect(page.getByRole('heading', { name: '1 card waiting for your decision' })).toBeVisible();
  await invented.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByRole('heading', { name: /waiting for your decision/ })).toHaveCount(0);

  // --- spaced repetition ----------------------------------------------------
  await page.getByRole('link', { name: 'Start review' }).click();
  await expect(page.getByText('What does the tape of a Turing machine look like?')).toBeVisible();
  await expect(page.getByText('It is infinite in both directions.')).toBeHidden(); // answer hidden until requested
  await revealWithKeyboard(page);
  await expect(page.getByText('It is infinite in both directions.')).toBeVisible();
  await expect(page.getByText('Source verified')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('review-card.png') });
  await expect(page.getByRole('button', { name: /^Good 10m/ })).toBeVisible(); // FSRS shows the next interval
  await page.keyboard.press('3');
  await expect(page.getByRole('heading', { name: 'Session finished' })).toBeVisible();
  await expect(page.getByText(/You answered 1 card; 1 of them Good or Easy/)).toBeVisible();
  await page.getByRole('link', { name: 'Back to flashcards' }).click();
  await expect(page.getByText('Reviewed today').locator('..')).toContainText('1');

  // --- notes: generated vs yours ---------------------------------------------
  await tab(page, 'Notes').click();
  await page.getByRole('button', { name: 'Notes from slides' }).click();
  const gen = page.getByRole('dialog', { name: 'Notes from your slides' });
  await expect(gen.getByText(/This is not AI-written/)).toBeVisible();
  await gen.getByRole('button', { name: 'Create notes' }).click();
  await expect(page.getByText('Created 1 note.')).toBeVisible();
  await page.getByRole('link', { name: /lecture notes/ }).click();
  await expect(page.getByText('Auto-extracted from slides').first()).toBeVisible();
  await expect(page.getByText('A transition function').first()).toBeVisible();
  await expect(page.getByText('Slide 2: Definition of a Turing machine').first()).toBeVisible();

  await tab(page, 'Notes').click();
  await page.getByRole('link', { name: /Turing machine summary/ }).click();
  await expect(page.getByText('Imported study pack')).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByLabel(/^Edit \(markdown/).fill('A Turing machine has a **tape**, a *finite control* and a transition function.');
  await page.getByRole('button', { name: 'Save block' }).click();
  await expect(page.getByText('Written by you')).toBeVisible(); // my edit is labelled as mine
  await expect(page.getByText('Imported study pack')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('note-editor.png') });
  expect(problems, 'console errors / CSP violations').toEqual([]);
});

test('question bank → exam with hints → autosave/resume → auto + self marking → repeat missed → paper', async ({ page }, testInfo) => {
  const problems = watchProblems(page);
  await seed(page);
  await importPack(page);
  await page.getByRole('dialog', { name: 'Import a study pack' }).getByRole('button', { name: 'Import 5 items for review' }).click();
  await tab(page, 'Practice and exams').click();

  await expect(page.getByRole('heading', { name: '2 questions waiting for your decision' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build an exam' })).toBeDisabled(); // pending questions are never used
  await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
  await expect(page.getByText('2 approved questions in your bank.')).toBeVisible();

  await page.getByRole('button', { name: 'Build an exam' }).click();
  const builder = page.getByRole('dialog', { name: 'Build a practice exam' });
  await expect(builder.getByText(/2 approved questions match; 2 will be used/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('exam-builder.png') });
  await builder.getByRole('button', { name: 'Start exam' }).click();

  // --- taking the exam ---------------------------------------------------------
  await expect(page.getByText('0 of 2 answered')).toBeVisible();
  const answerAll = async (mcqCorrect: boolean) => {
    for (let i = 0; i < 2; i++) {
      const main = page.getByRole('main', { name: 'Question' });
      if (await main.getByText('Which statement about the tape is correct?').isVisible()) {
        await main.getByText(mcqCorrect ? 'It is infinite in both directions' : 'It has exactly 100 cells').click();
      } else {
        await expect(main.getByText('State two components of a Turing machine.')).toBeVisible();
        await main.getByRole('button', { name: 'Show hint' }).click();
        await expect(main.getByText('Hint: Look at slide 2.')).toBeVisible();
        await main.getByLabel('Your answer').fill('A Turing machine has a tape and a finite control.');
        await expect(main.getByText(/words \(expected 3–30\)/)).toBeVisible();
      }
      if (i === 0) await page.getByRole('button', { name: 'Next' }).click();
    }
  };
  await answerAll(false); // wrong on purpose
  await expect(page.getByText('2 of 2 answered')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('exam-taking.png') });

  // answers are autosaved: a reload resumes exactly here
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByText('2 of 2 answered')).toBeVisible();

  await page.getByRole('button', { name: 'Submit' }).first().click();
  const confirm = page.getByRole('dialog', { name: 'Submit your exam?' });
  await expect(confirm.getByText('You answered 2 of 2 questions.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Submit now' }).click();

  // --- results: exact auto-marking, honest self-marking --------------------------
  await expect(page).toHaveURL(/\/results$/);
  await expect(page.getByRole('heading', { name: 'Provisional score' })).toBeVisible();
  await expect(page.getByText('1 written answer needs marking')).toBeVisible();
  await expect(page.getByText('You used the hint on this question.')).toBeVisible();
  const written = page.getByRole('listitem').filter({ hasText: 'State two components of a Turing machine.' });
  await expect(written.getByText('Needs marking')).toBeVisible();
  await expect(written.getByText('looks covered in your answer').first()).toBeVisible(); // keyword hint, not a mark
  const mcqCard = page.getByRole('listitem').filter({ hasText: 'Which statement about the tape is correct?' });
  await expect(mcqCard.getByText('No marks')).toBeVisible();
  await expect(mcqCard.getByText('Marked automatically')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('results-provisional.png'), fullPage: true });

  await written.getByLabel('Marks for: Mentions the tape').fill('1');
  await written.getByLabel('Marks for: Mentions the finite control').fill('1');
  await written.getByRole('button', { name: 'Save my mark' }).click();
  await expect(page.getByText('Mark saved.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your score' })).toBeVisible();
  await expect(page.locator('#score-h').locator('..')).toContainText('2');
  await expect(page.getByText('Marked by you, an estimate')).toBeVisible();
  await expect(page.getByText(/not an examiner’s marks/)).toBeVisible();

  // --- repeat missed, resume ----------------------------------------------------
  await page.getByRole('button', { name: 'Repeat 1 missed question' }).click();
  await expect(page.getByText('Which statement about the tape is correct?')).toBeVisible();
  await page.getByText('It is infinite in both directions').click();
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByLabel('It is infinite in both directions')).toBeChecked();
  await page.getByRole('button', { name: 'Submit' }).first().click();
  await page.getByRole('dialog', { name: 'Submit your exam?' }).getByRole('button', { name: 'Submit now' }).click();
  await expect(page.getByRole('heading', { name: 'Your score' })).toBeVisible();
  await expect(page.locator('#score-h').locator('..')).toContainText('2'); // 2 / 2, 100%
  await expect(page.getByRole('button', { name: 'Repeat 0 missed questions' })).toBeDisabled();

  // --- history and printable paper ------------------------------------------------
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Your exams' })).toBeVisible();
  await expect(page.getByText(/2 of 4 marks \(50%\)/)).toBeVisible();
  await expect(page.getByText(/2 of 2 marks \(100%\)/)).toBeVisible();
  await page.getByRole('button', { name: /^Actions for Repeat:/ }).click();
  await page.getByRole('menuitem', { name: 'Printable paper' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Repeat:');
  await page.getByLabel('Include marking scheme').check();
  await expect(page.getByText('A tape and a finite control.').or(page.getByText('It is infinite in both directions').last())).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('paper.png'), fullPage: true });
  expect(problems, 'console errors / CSP violations').toEqual([]);
});

test('everything you studied survives backup and restore', async ({ page }, testInfo) => {
  await seed(page);
  await importPack(page);
  await page.getByRole('dialog', { name: 'Import a study pack' }).getByRole('button', { name: 'Import 5 items for review' }).click();
  await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
  await page.getByRole('link', { name: 'Start review' }).click();
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible();
  await revealWithKeyboard(page);
  await page.keyboard.press('4');
  await expect(page.getByRole('heading', { name: 'Session finished' })).toBeVisible();

  await page.goto('/settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export backup' }).click()]);
  const path = testInfo.outputPath('backup.studyai.zip');
  await download.saveAs(path);
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((d) => new Promise<void>((res) => { const r = indexedDB.deleteDatabase(d.name!); r.onsuccess = r.onerror = r.onblocked = () => res(); })));
  });
  await page.goto('/settings');
  await page.locator('input[aria-label="Choose a backup file"]').setInputFiles(path);
  await page.getByRole('dialog', { name: 'Restore from backup' }).getByRole('button', { name: 'Merge into my library' }).click();
  await expect(page.getByText(/Restored: 1 lectures/)).toBeVisible();

  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, /^Flashcards/).click();
  await expect(page.getByText('All cards (2)')).toBeVisible();
  await expect(page.getByText('Reviewed today').locator('..')).toContainText('1'); // review history came back too
  await tab(page, 'Practice and exams').click();
  await expect(page.getByRole('heading', { name: '2 questions waiting for your decision' })).toBeVisible(); // still pending after restore
});

test('dashboard reflects real activity and gives one reasoned next step', async ({ page }, testInfo) => {
  await seed(page);
  await page.goto('/');
  const next = page.getByRole('region', { name: 'Next step' }).or(page.locator('section[aria-labelledby="next-h"]'));
  await expect(next.getByText('Study “Lecture 4 - Turing machines”')).toBeVisible();
  await expect(next.getByText('You have not opened this lecture yet.')).toBeVisible();
  await expect(page.getByText('0% studied')).toBeVisible();

  // slides only count once they have been on screen for a few seconds
  await next.getByRole('link').click();
  await expect(page.getByText('Slide 1 of 5')).toBeVisible();
  await page.waitForTimeout(3600);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight'); // flicked past: must not count
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByText('Slide 2 of 5')).toBeVisible();
  await page.waitForTimeout(3600);

  await page.goto('/');
  await expect(page.getByText('Slides studied today').locator('..')).toContainText('2');
  await expect(page.getByText('40% studied')).toBeVisible();
  // the lecture is open at slide 2: one card says where you left off, counts what was viewed, and links to that slide
  await expect(next.getByText('You left off at slide 2 of 5; 2 viewed so far.')).toBeVisible();
  await expect(next.getByText('Continue where you left off')).toBeVisible();
  await expect(next.getByRole('link')).toHaveAttribute('href', /\?slide=2$/);

  // import a pack: imported items are never studied, so the app asks you to check them first
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await importPack(page);
  await page.getByRole('dialog', { name: 'Import a study pack' }).getByRole('button', { name: 'Import 5 items for review' }).click();
  await page.goto('/');
  await expect(next.getByText('Check 4 imported items in Computability')).toBeVisible();

  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, /^Flashcards/).click();
  await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
  await page.getByRole('link', { name: 'Start review' }).click();
  await expect(page.getByText('What does the tape of a Turing machine look like?')).toBeVisible(); // wait for the lazily loaded page
  await revealWithKeyboard(page);
  await page.keyboard.press('3');
  await expect(page.getByRole('heading', { name: 'Session finished' })).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('Cards reviewed today').locator('..')).toContainText('1');
  const sessions = page.getByRole('heading', { name: 'Recent study sessions' }).locator('..');
  await expect(sessions).toContainText('2 slides viewed');
  await expect(sessions).toContainText('1 card reviewed');
  await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true });
});
