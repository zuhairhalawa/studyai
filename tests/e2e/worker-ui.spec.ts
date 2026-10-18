import { readFileSync } from 'node:fs';
import { ORIGINS } from './ports';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createCourse, importFiles, importPack, revealWithKeyboard, seed, tab, trackRequests, watchProblems } from './helpers';
import { mathDeck } from '../fixtures/math-deck';
import { buildPptx, simpleSlide } from '../fixtures/pptx-builder';

/**
 * The real interface against the real local Worker + Durable Object (scripted fake Gemini, fresh test secrets).
 * Serial: the Durable Object keeps the owner's settings between tests, as in production.
 */
test.describe.configure({ mode: 'serial' });

const ORIGIN = ORIGINS.worker;
const ownerKey = () => readFileSync('.scratch/e2e-owner-key.txt', 'utf8').trim();
const IP = '203.0.113.50';

/** Puts the Durable Object back to "nothing confirmed, AI off" so every run starts the same. */
async function resetOwnerState(request: APIRequestContext) {
  expect((await request.post('/api/test/reset-ledger')).status()).toBe(200); // repeated runs start from an empty ledger
  const login = await request.post('/api/auth/login', { headers: { origin: ORIGIN, 'cf-connecting-ip': IP }, data: { key: ownerKey() } });
  const cookie = login.headers()['set-cookie']!.split(';')[0]!;
  const post = (path: string, data: unknown) => request.post(path, { headers: { cookie, origin: ORIGIN }, data });
  for (const name of ['projectHasNoBilling', 'modelsFreeOfCharge', 'acceptsFreeTierDataUse', 'observedFreeLimits', 'firstRequestApproved']) await post('/api/owner/revoke', { name });
  await post('/api/owner/reset-pause', {});
  await post('/api/owner/config', { models: ['gemini-3.1-flash-lite'], budgets: { dailyUsd: 0.5, monthlyUsd: 3 }, limits: { maxConcurrent: 2, maxInputTokens: 60_000, maxRequestsPerDay: 100, maxOutputTokens: 4_000 } });
}

async function signIn(page: Page) {
  await page.goto('/settings');
  await page.getByLabel('Owner key').fill(ownerKey());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}

test('Settings: private sign-in, then the confirmations in order, then AI is ready', async ({ page, request }, testInfo) => {
  await resetOwnerState(request);
  const problems = watchProblems(page);
  const requests = trackRequests(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'AI tutor (Gemini free tier)' })).toBeVisible();

  // private: only the owner key opens it
  const key = page.getByLabel('Owner key');
  await expect(key).toBeVisible();
  await key.fill('sak_' + 'x'.repeat(43));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That key was not accepted.');
  await key.fill(ownerKey());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  await expect(page.getByText(/confirmed by you|not confirmed yet/)).toBeVisible();
  await expect(page.getByText(/Nothing is ever sent until you confirm it/)).toBeVisible();

  // the usage text must not pretend the estimates are money or a guarantee
  await expect(page.getByText(/estimates at Google’s paid prices/)).toBeVisible();
  await expect(page.getByText(/not permission to spend money and not a guarantee against billing/)).toBeVisible();

  // can't switch on yet, can't approve yet
  await expect(page.getByRole('button', { name: 'Turn AI on' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();

  for (const title of ['The Google project has no billing account', 'The chosen model is free of charge', 'You accept how the free tier uses your content']) {
    const item = page.getByRole('listitem').filter({ hasText: title });
    await item.getByLabel('I checked this myself').check();
    await item.getByRole('button', { name: 'Confirm' }).click();
    await expect(item.getByText(/Confirmed \d{4}-\d{2}-\d{2}/)).toBeVisible();
  }
  const quotas = page.getByRole('listitem').filter({ hasText: 'The free quotas for the chosen model' });
  await quotas.getByLabel('These match AI Studio').check();
  await quotas.getByRole('button', { name: 'Confirm' }).click();
  await expect(quotas.getByText(/Confirmed \d{4}-\d{2}-\d{2}/)).toBeVisible();

  await page.getByLabel('I approve sending real requests to Google’s free Gemini service').check();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Approve the first real request' }).getByText(/Confirmed/)).toBeVisible();

  await page.getByRole('button', { name: 'Turn AI on' }).click();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn AI off' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('settings-ai.png'), fullPage: true });
  await audit(page, 'settings: AI ready');

  // an unsafe limit is refused with a reason
  await page.getByLabel('Monthly estimate limit (dollars)').fill('50');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /ceiling/ })).toBeVisible();
  await page.getByLabel('Monthly estimate limit (dollars)').fill('3');

  expect(requests.filter((u) => !u.startsWith(ORIGINS.worker) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
  // The only console noise is the browser logging the two refusals this test provokes on purpose (wrong key, unsafe limit).
  expect(problems.filter((p) => !/status of (401|400) /.test(p))).toEqual([]);
});

test('the AI tutor: shows what will be sent, answers with sources, and records nothing it should not', async ({ page }, testInfo) => {
  const problems = watchProblems(page);
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, 'AI tutor').click();

  const q = page.getByLabel('Your question');
  await q.fill('What is a transition function?');
  const sendInfo = page.getByText(/What will be sent to Google: your question and \d+ slides?/);
  await expect(sendInfo).toBeVisible(); // slides matching the question were found automatically
  await sendInfo.click();
  await expect(page.getByText(/Nothing else: no files, images, account details or other slides/)).toBeVisible();
  await expect(page.locator('details pre').first()).toContainText('transition function');

  // consent is needed once; until then sending is impossible
  await expect(page.getByRole('button', { name: /^Send/ })).toBeDisabled();
  await page.getByLabel(/I understand that my question and the slide text/).click(); // the notice disappears once accepted
  await page.getByRole('button', { name: /^Send/ }).click();

  const answer = page.getByRole('listitem').filter({ hasText: 'reads and writes symbols on an infinite tape' });
  await expect(answer).toBeVisible();
  await expect(answer.getByText(/On the slides/)).toBeVisible();
  await expect(answer).toContainText(/\[slide \d+\]/); // the saved text names real slides, never a label that only meant something inside one request
  await expect(answer).not.toContainText('[S1]');
  await expect(page.getByText(/Sent with \d+ slides? · Explain simply/)).toBeVisible();
  await expect(answer.getByRole('button', { name: /^Show source \(\d\)$/ })).toBeVisible();
  await answer.getByRole('button', { name: /^Show source \(\d\)$/ }).click();
  await expect(answer.getByRole('link', { name: /Lecture 4.*slide \d/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('tutor.png') });
  await audit(page, 'tutor: answer with sources and follow-ups');

  // follow-ups: the model's suggested questions fill the box
  await answer.getByRole('button', { name: 'What is the head?' }).click();
  await expect(q).toHaveValue('What is the head?');

  // answers can become notes and (pending) flashcards, marked as AI-written
  await answer.getByRole('button', { name: 'Save as note' }).click();
  await expect(page.getByText('Saved as a note. It is marked as AI-written.')).toBeVisible();
  await answer.getByRole('button', { name: 'Make a flashcard' }).click();
  await expect(page.getByText('Added as a flashcard waiting for your approval.')).toBeVisible();
  await tab(page, 'Notes').click();
  await expect(page.getByText('What is a transition function?')).toBeVisible();
  await tab(page, /^Flashcards/).click();
  await expect(page.getByRole('heading', { name: /waiting for your decision/ })).toBeVisible(); // AI cards are pending until you approve them
  await tab(page, 'AI tutor').click();

  // a model that claims "on the slides" without citing them is downgraded, never shown as trusted
  await page.getByLabel('Your question').fill('FAKE-NOCITE what is a tape');
  await page.getByRole('button', { name: /^Send/ }).click();
  const unsure = page.getByRole('listitem').filter({ hasText: 'A confident answer with no citation at all.' });
  await expect(unsure.getByText('Uncertain', { exact: true })).toBeVisible();

  // a refusal from Google is shown plainly, and then the tutor stops by itself
  await page.getByLabel('Your question').fill('FAKE-QUOTA-DAY transition function');
  await page.getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No answer.' })).toBeVisible();
  await expect(page.getByText('The tutor is not ready')).toBeVisible();
  await expect(page.getByText(/Pacific/).first()).toBeVisible();
  await page.getByLabel('Your question').fill('Another question about the tape');
  await expect(page.getByRole('button', { name: /^Send/ })).toBeDisabled();

  // back in Settings the owner sees why, checks, and resumes
  await page.goto('/settings');
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'I checked, resume AI' }).click();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  // the only console noise is the browser logging the refusal this test provokes on purpose (Google's quota error, 502)
  expect(problems.filter((p) => !/status of 502 /.test(p))).toEqual([]);
});

test('chats are kept on this device: the answer, its citation, its sources and its follow-up chips survive a reload', async ({ page }) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, 'AI tutor').click();
  await page.getByLabel('Your question').fill('What is a transition function?');
  await page.getByLabel(/I understand that my question and the slide text/).click(); // a fresh browser has not accepted yet; the box appears once the AI status has loaded
  await page.getByRole('button', { name: /^Send/ }).click();
  const answer = page.getByRole('listitem').filter({ hasText: 'reads and writes symbols on an infinite tape' });
  await expect(answer).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^What is a transition function/ }).click(); // the chat is in the list on the left
  const again = page.getByRole('listitem').filter({ hasText: 'reads and writes symbols on an infinite tape' });
  await expect(again).toBeVisible();
  await expect(again).toContainText(/\[slide \d+\]/);
  await expect(again.getByRole('button', { name: /^Show source \(\d\)$/ })).toBeVisible();
  await expect(again.getByRole('button', { name: 'What is the head?' })).toBeVisible();
  await expect(page.getByText(/Sent with \d+ slides? · Explain simply/)).toBeVisible();
});

test('the AI tutor writes cards and questions, but they go through the normal checking screen', async ({ page }, testInfo) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await page.getByRole('button', { name: 'Study packs from your own AI' }).click();
  await page.getByRole('menuitem', { name: 'Generate with the AI tutor (Gemini)…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate study material with the AI tutor' });
  await expect(dialog.getByText(/What will be sent to Google: the text of 1 lecture/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Generate and check' })).toBeDisabled(); // not before you have accepted how the free tier uses content

  // only the chosen slides are sent: leaving out the title slide removes it from what is shown, and an impossible range blocks sending
  const first = dialog.getByLabel(/^First slide of/);
  await first.fill('2');
  await expect(dialog.getByText(/slides 2–5 of /)).toBeVisible();
  await dialog.getByText(/What will be sent to Google/).click();
  await expect(dialog.locator('pre')).not.toContainText('### Slide 1:');
  await expect(dialog.locator('pre')).toContainText('### Slide 2: Definition of a Turing machine');
  await first.fill('9');
  await expect(dialog.getByText(/Use whole slide numbers from 1 to 5/)).toBeVisible();
  await first.fill('1');
  await expect(dialog.locator('pre')).toContainText('### Slide 1:');

  // exam questions are planned on the device first: a visible mix, said not to predict the real exam
  const examPlan = dialog.getByRole('region', { name: 'Exam plan' });
  await expect(examPlan).toContainText(/Exam plan: \d+ questions?, \d+ requests?/);
  await expect(examPlan).toContainText(/not a prediction of your real exam/);
  await expect(examPlan.getByText('(this request)').first()).toBeVisible();
  const planned = (await examPlan.getByRole('listitem').allInnerTexts()).length;
  expect(planned).toBeGreaterThanOrEqual(2);
  // the preview (opened above) says that the plan is sent with the slides
  await expect(dialog.getByText(/Also sent: the plan above for this request/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('exam-plan.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('exam-plan-phone.png') });
  await page.setViewportSize({ width: 1280, height: 720 });

  await dialog.getByLabel(/I understand this text is sent to Google/).click();
  await dialog.getByRole('button', { name: 'Generate and check' }).click();

  // the pack arrives in the usual import check: quotes verified against the slides, nothing used until approved
  const check = page.getByRole('dialog', { name: 'Import a study pack' });
  await expect(check.getByText(/cited quotes were found on the slide/)).toBeVisible();
  await expect(check.getByText('Flashcards')).toBeVisible();
  // what came back is held to the plan it was written for
  const questionSet = check.getByRole('region', { name: 'Exam questions in this pack' });
  await expect(questionSet).toContainText(/Exam questions: \d+ · \d+ marks? in all/);
  await expect(questionSet).toContainText(/Difficulty: \d+ easy, \d+ medium, \d+ hard/);
  await expect(questionSet).toContainText(/\d+ of \d+ came back exactly as planned/);
  await page.screenshot({ path: testInfo.outputPath('question-set.png') });
  await check.getByRole('button', { name: /^Import \d+ items? for review$/ }).click();
  await tab(page, /^Flashcards/).click();
  await expect(page.getByText('What does the first slide introduce?').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /waiting for your decision/ })).toBeVisible();
});

test('an answer that hits the length limit is never passed off as finished: the pack keeps its finished items, the chat offers to continue', async ({ page }, testInfo) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();

  // the dialog says how many items one request really asks for (it used to promise far more than fits)
  await page.getByRole('button', { name: 'Course details' }).click();
  await page.getByLabel('Professor’s exam instructions').fill('FAKE-CUTOFF the scripted model stops in the middle of its answer');
  await page.getByRole('button', { name: 'Save details' }).click();
  await page.getByRole('button', { name: 'Study packs from your own AI' }).click();
  await page.getByRole('menuitem', { name: 'Generate with the AI tutor (Gemini)…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate study material with the AI tutor' });
  await dialog.getByLabel('How many').selectOption('normal');
  await expect(dialog.getByText(/This request asks for \d+ exam questions?, \d+ flashcards?/)).toBeVisible();
  await expect(dialog.getByText(/writes at most about 4,000 tokens per answer/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('generate-dialog.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('generate-dialog-phone.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByLabel(/I understand this text is sent to Google/).click();
  await dialog.getByRole('button', { name: 'Generate and check' }).click();

  const check = page.getByRole('dialog', { name: 'Import a study pack' });
  await expect(check.getByText('The AI’s answer was cut off')).toBeVisible();
  await expect(check.getByText(/only the 1 complete item before the cut is shown here/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('cut-off-pack.png') });
  await expect(check.getByRole('button', { name: 'Import 1 item for review' })).toBeVisible();
  await check.getByRole('button', { name: 'Import 1 item for review' }).click();
  await tab(page, /^Flashcards/).click();
  await expect(page.getByText('What does the first slide introduce?').first()).toBeVisible();
  await expect(page.getByText('A second card that was never fin')).toHaveCount(0);

  // the chat: a cut-off answer says so, and one click asks for the rest
  await tab(page, 'AI tutor').click();
  await page.getByLabel('Your question').fill('FAKE-CUTOFF what is a tape');
  const consent = page.getByLabel(/I understand that my question and the slide text/);
  if (await consent.isVisible()) await consent.click(); // already accepted in the generate dialog above
  await page.getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByText(/This answer reached the length limit and stops early/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('cut-off-chat.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('cut-off-chat-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Ask it to continue' }).click();
  await expect(page.getByLabel('Your question')).toHaveValue('Please continue from where you stopped.');
});

test('AI marking is a labelled estimate that you can accept or discard', async ({ page }, testInfo) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await importPack(page);
  await page.getByRole('dialog', { name: 'Import a study pack' }).getByRole('button', { name: 'Import 5 items for review' }).click();
  await tab(page, 'Practice and exams').click();
  await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
  await page.getByRole('button', { name: 'Build an exam' }).click();
  await page.getByRole('dialog', { name: 'Build a practice exam' }).getByRole('button', { name: 'Start exam' }).click();

  await expect(page.getByText('0 of 2 answered')).toBeVisible();
  for (let i = 0; i < 2; i++) {
    const main = page.getByRole('main', { name: 'Question' });
    await expect(main).toBeVisible();
    if (await main.getByText('Which statement about the tape is correct?').isVisible()) await main.getByText('It is infinite in both directions').click();
    else await main.getByLabel('Your answer').fill('A Turing machine has a tape and a finite control.');
    if (i === 0) await page.getByRole('button', { name: 'Next' }).click();
  }
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Submit' }).first().click();
  await page.getByRole('dialog', { name: 'Submit your exam?' }).getByRole('button', { name: 'Submit now' }).click();
  await expect(page).toHaveURL(/\/results$/);

  const written = page.getByRole('listitem').filter({ hasText: 'State two components of a Turing machine.' });
  await expect(written.getByText('Second opinion from the AI (optional)')).toBeVisible();
  await expect(written.getByText(/it is an estimate, not an examiner’s mark/i)).toBeVisible();
  await written.getByLabel(/I understand this text is sent to Google/).click();
  await written.getByRole('button', { name: 'Ask the AI to mark this' }).click();
  const suggestion = written.getByLabel('AI\'s suggested marks');
  await expect(suggestion.getByText(/Suggested:/)).toContainText('1');
  await expect(suggestion.getByText(/confidence is medium/)).toBeVisible();
  await expect(suggestion.getByText('Mentions the tape')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('ai-marking.png'), fullPage: true });
  await audit(page, 'results: AI marking proposal');

  await suggestion.getByRole('button', { name: 'Use these marks' }).click();
  await expect(written.getByText('AI estimate (check it yourself)')).toBeVisible();
  // the saved marks are shown in the marker below, where you can still change them
  await expect(written.getByLabel('Marks for: Mentions the tape')).toHaveValue('1');

  // and the question can be taken to the tutor, already typed, with its source slide chosen
  await written.getByRole('link', { name: 'Ask the tutor' }).click();
  await expect(page.getByLabel('Your question')).toHaveValue(/^Explain how to answer this exam question and what a good answer needs: State two components of a Turing machine\./);
  await expect(page.getByLabel('The slides I pick')).toBeChecked();
});

test('a flashcard opens the tutor with its question and slide ready', async ({ page }) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await importPack(page);
  await page.getByRole('dialog', { name: 'Import a study pack' }).getByRole('button', { name: 'Import 5 items for review' }).click();
  // the note that arrived with the pack is not YOUR note until you write in it; only your own words are offered to the tutor
  await tab(page, 'Notes').click();
  await page.getByRole('link', { name: /Turing machine summary/ }).click();
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByLabel(/^Edit \(markdown/).fill('My own summary: a Turing machine has a tape, a finite control and a transition function.');
  await page.getByRole('button', { name: 'Save block' }).click();
  await expect(page.getByText('Written by you')).toBeVisible();
  await tab(page, /^Flashcards/).click();
  await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
  await page.getByRole('link', { name: 'Start review' }).click();
  await expect(page.getByRole('button', { name: 'Show answer' })).toBeVisible();
  await revealWithKeyboard(page);
  await page.getByRole('link', { name: 'Ask the tutor' }).click();

  // the question is already typed, the card's slide is already chosen, and nothing has been sent yet
  await expect(page.getByLabel('Your question')).toHaveValue(/^Explain this flashcard to me: What does the tape of a Turing machine look like\?/);
  await expect(page.getByLabel('The slides I pick')).toBeChecked();
  await expect(page.getByText(/What will be sent to Google: your question and 1 slide/)).toBeVisible();
  await expect(page.getByText('Your chats are kept on this device only.')).toBeVisible(); // no chat was created by opening it
  expect(page.url()).not.toContain('Explain'); // the typed question travels in router state, not in the address

  // your own notes can be added as extra context; they are listed, labelled as notes, before anything is sent
  await page.getByLabel(/Also use up to 3 of my own notes/).check();
  await expect(page.getByText(/your question and 1 slide and 1 of your notes/)).toBeVisible();
  await page.getByText(/What will be sent to Google/).click();
  await expect(page.getByText('My note: Turing machine summary')).toBeVisible();
  await expect(page.getByText(/labelled as your notes, not the professor/)).toBeVisible();
}); 

test('a guided lesson teaches the lecture part by part, in slide order, sending only the chosen part each time', async ({ page }) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  await tab(page, 'AI tutor').click();

  await page.getByRole('button', { name: 'Start a guided lesson from the beginning' }).click();
  // part 1 is chosen, the style is step by step, the question is typed for the student to read; nothing was sent
  const parts = page.getByRole('list', { name: 'Lesson parts' }).getByRole('button');
  await expect(parts.first()).toHaveAttribute('aria-current', 'step');
  await expect(page.getByLabel('Teaching style')).toHaveValue('steps');
  await expect(page.getByLabel('Your question')).toHaveValue(/^Teach me ".+" \(slides? [\d–]+\) from the beginning, in the order of the slides, as if I know nothing about it yet\. Use only these slides\./);
  await expect(page.getByText(/What will be sent to Google: your question and \d slides?/)).toBeVisible();
  await expect(page.getByText('Your chats are kept on this device only.')).toBeVisible();

  await page.getByLabel(/I understand that my question and the slide text/).click();
  await page.getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByText(/Sent with \d slides? · Step by step/)).toBeVisible();

  // the next part continues the lesson with the following slides, and only those
  const next = page.getByRole('button', { name: /^Next part:/ });
  await expect(next).toBeVisible();
  await next.click();
  await expect(parts.nth(1)).toHaveAttribute('aria-current', 'step');
  // the next part names what was really taught before it, so it can connect to it
  await expect(page.getByLabel('Your question')).toHaveValue(/^Now teach me the next part: ".+" \(slides? [\d–]+\), in the order of the slides\. Connect it to what we have already covered \(So far we have covered .+ \(slides? [\d–]+\)\.\)\./);

  // going back to an earlier part starts it from the beginning instead of pretending to continue
  await parts.first().click();
  await expect(page.getByLabel('Your question')).toHaveValue(/^Teach me ".+" .* from the beginning/);
  await expect(parts.first()).toHaveAttribute('aria-current', 'step');

  // choosing a later part again names only the part that was really sent, and a new chat has covered nothing
  await parts.nth(1).click();
  await expect(page.getByLabel('Your question')).toHaveValue(/So far we have covered/);
  await page.getByRole('button', { name: 'New chat' }).click();
  await parts.nth(1).click();
  await expect(page.getByLabel('Your question')).toHaveValue(/^Teach me ".+" .* from the beginning/); // a new chat has covered nothing
});

async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad, label + ': ' + bad.join(' ; ')).toEqual([]);
}

test('the student sees what the slides do not say before anything is sent, and the tutor is told', async ({ page }, testInfo) => {
  await page.goto('/');
  await createCourse(page, 'Security', 'SEC1');
  await importFiles(page, [
    {
      name: 'Gaps.pptx',
      buffer: Buffer.from(buildPptx({ slides: [simpleSlide('Buffer overflows', ['Introduction']), simpleSlide('Firewalls', ['A firewall filters network traffic using rules and blocks packets from untrusted addresses', 'It also logs every blocked attempt for later review'])] })),
    },
  ]);
  await expect(page.getByText(/Imported: 2 slides/)).toBeVisible();
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Security/ }).first().click();
  await tab(page, 'AI tutor').click();

  await page.getByRole('radio', { name: 'The slides I pick' }).check();
  await page.getByRole('checkbox', { name: /^2\. / }).check();
  await expect(page.getByRole('note', { name: 'Gaps found in these slides' })).toHaveCount(0); // a slide that explains itself has no gaps
  await page.getByRole('checkbox', { name: /^1\. / }).check();
  const gaps = page.getByRole('note', { name: 'Gaps found in these slides' });
  await expect(gaps).toContainText('Gaps the tutor will point out in these slides');
  await expect(gaps).toContainText('Slide 1 (“Buffer overflows”) has only a heading: it explains nothing by itself.');
  await page.getByLabel('Your question').fill('Explain buffer overflows using these slides.');
  await page.getByText(/What will be sent to Google/).click();
  await expect(page.getByText(/the 1 gap note shown above \(found on your device\)/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('gaps.png') });

  // the request with the gap notes is accepted by the server and answered
  const consent = page.getByLabel(/I understand that my question and the slide text/);
  if (await consent.isVisible()) await consent.click();
  await page.getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByText(/Sent with 2 slides?/)).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'reads and writes symbols on an infinite tape' })).toBeVisible();

  // leave the heading-only slide out and the note goes away
  await page.getByRole('checkbox', { name: /^1\. / }).uncheck();
  await expect(page.getByRole('note', { name: 'Gaps found in these slides' })).toHaveCount(0);
});

test('a mathematical lecture: the student sees which symbols a slide never explains, and the formulas and code go with the question as written', async ({ page }) => {
  await page.goto('/');
  await createCourse(page, 'Algorithms', 'CS201');
  await importFiles(page, [{ name: 'Divide and conquer.pptx', buffer: Buffer.from(mathDeck()) }]);
  await expect(page.getByText(/Imported: 12 slides/)).toBeVisible();
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Algorithms/ }).first().click();
  await tab(page, 'AI tutor').click();

  await page.getByRole('radio', { name: 'The slides I pick' }).check();
  for (const n of [4, 5, 8]) await page.getByRole('checkbox', { name: new RegExp(`^${n}\. `) }).check();
  const gaps = page.getByRole('note', { name: 'Gaps found in these slides' });
  await expect(gaps).toContainText('has a formula, and the slide does not say what its symbols mean (not explained: i).');
  await expect(gaps).toContainText('“on the board”');
  await expect(gaps).not.toContainText('Slide 5'); // the proof uses its own symbols in words
  await page.getByLabel('Your question').fill('Teach me the sum and its proof, then the merge sort code.');
  await page.getByText(/What will be sent to Google/).click();
  const sent = page.locator('details').filter({ hasText: 'What will be sent to Google' }).first();
  await expect(sent).toContainText('S1 Divide and conquer, slide 4: Sum of the first n integers');
  await expect(sent).toContainText('$$\\sum_{i=1}^{n} {i} = \\frac{n(n+1)}{2}$$');
  await expect(sent).toContainText('  if p < r'); // the code keeps its indentation and its < on the screen that shows what is sent

  const consent = page.getByLabel(/I understand that my question and the slide text/);
  if (await consent.isVisible()) await consent.click();
  await page.getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByText(/Sent with 3 slides?/)).toBeVisible();
});

test('the AI check of the marking points finds a point nobody asked for, and removing it takes its marks off', async ({ page }, testInfo) => {
  await seed(page);
  await signIn(page);
  await page.goto('/');
  await page.getByRole('link', { name: /Computability/ }).first().click();
  const pack = {
    format: 'studyai-pack',
    version: 1,
    lectures: [{ ref: 'L1', title: 'Lecture 4 - Turing machines' }],
    questions: [
      {
        type: 'short',
        prompt: 'State two components of a Turing machine and say what each one does.',
        marks: 3,
        difficulty: 2,
        topic: 'Turing machines',
        asks: [{ quote: 'State two components of a Turing machine', count: 2 }],
        modelAnswer: 'A tape that holds the symbols, and a head that reads and writes them.',
        rubric: [
          { text: 'A tape that holds the symbols', marks: 1, ask: 1 },
          { text: 'A head that reads and writes the symbols', marks: 1, ask: 1 },
          { text: 'Turing machines were described in 1936 FAKE-NOT-ASKED', marks: 1, ask: 1 },
        ],
        basis: 'derived',
        sources: [],
      },
    ],
  };
  await page.getByRole('button', { name: 'Study packs from your own AI' }).click();
  await page.getByRole('menuitem', { name: 'Import a study pack…' }).click();
  const imp = page.getByRole('dialog', { name: 'Import a study pack' });
  await imp.getByLabel('Pack JSON').fill(JSON.stringify(pack));
  await imp.getByRole('button', { name: 'Check this pack' }).click();

  // the device's own check already sees that three points answer an ask for two
  await imp.getByText(/\d+ skipped items?, \d+ warnings?/).click();
  await expect(imp.getByText(/3 marking points answer it: the extra marks are not asked for/)).toBeVisible();
  await expect(imp.getByText(/Exam questions: 1 · 3 marks in all/)).toBeVisible();

  // the AI check: what is sent is shown, nothing is sent before consent and a press
  const panel = imp.getByRole('region', { name: 'AI check of the marking points' });
  await expect(panel.getByText(/It uses one request/)).toBeVisible();
  await panel.getByText('What will be sent to Google').click();
  await expect(panel).toContainText('State two components of a Turing machine and say what each one does.');
  await expect(panel).toContainText('(3 marking points)');
  await expect(panel.getByRole('button', { name: 'Check with the AI' })).toBeDisabled();
  await panel.getByLabel(/I understand this text is sent to Google/).click();
  await panel.getByRole('button', { name: 'Check with the AI' }).click();
  const found = panel.getByLabel('What the AI found');
  await expect(found.getByText(/found 1 thing to look at/)).toBeVisible();
  await expect(found.getByText(/Marking point 3 \("Turing machines were described in 1936 FAKE-NOT-AS…"\) is not asked for by the question\. The question never asks for this\./)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('audit-found.png'), fullPage: true });
  await audit(page, 'import: AI check of the marking points');

  // removing the point takes its mark off the question and clears the warning
  await found.getByRole('button', { name: 'Remove marking point 3 of question 1' }).click();
  await expect(imp.getByText(/Exam questions: 1 · 2 marks in all/)).toBeVisible();
  await expect(imp.getByText(/the extra marks are not asked for/)).toHaveCount(0);
  await expect(found.getByText('Everything the AI flagged has been dealt with.')).toBeVisible(); // the finding is gone; the AI is not asked again by itself
  await expect(found.getByRole('button')).toHaveCount(0);
  await imp.getByRole('button', { name: 'Import 1 item for review' }).click();
  await tab(page, 'Practice and exams').click();
  await page.getByRole('button', { name: 'Approve all with no source problems' }).click();
  await expect(page.getByText('1 approved question in your bank.')).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the AI screens have no WCAG A/AA violations (${scheme})`, async ({ page, request }) => {
    await resetOwnerState(request);
    await page.emulateMedia({ colorScheme: scheme });
    await seed(page);
    await page.goto('/settings');
    await expect(page.getByLabel('Owner key')).toBeVisible();
    await audit(page, 'settings: signed out');
    await page.getByLabel('Owner key').fill(ownerKey());
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await audit(page, 'settings: signed in, nothing confirmed');
    // confirm everything through the API for speed, then look at the ready state and the tutor
    await page.goto('/');
    await page.getByRole('link', { name: /Computability/ }).first().click();
    await tab(page, 'AI tutor').click();
    await expect(page.getByLabel('Your question')).toBeVisible();
    await audit(page, 'tutor: not ready');
  });
}
