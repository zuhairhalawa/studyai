import { expect, type Page } from '@playwright/test';
import { PNG_1X1, bodySp, buildPptx, equationShape, mr, para, picture, tableFrame, titleSp, type DeckSpec } from '../fixtures/pptx-builder';

/** A small but realistic lecture: title, bullets + notes, table, equation, picture. */
export function lectureSpec(extra: { suffix?: string } = {}): DeckSpec {
  const s = extra.suffix ?? '';
  return {
    title: 'Turing machines',
    slides: [
      { layout: 1, shapes: titleSp(2, `Turing Machines and Decidability${s}`, 'ctrTitle') + bodySp(3, [para('BCS303 Lecture 4')]) },
      {
        shapes: titleSp(2, 'Definition of a Turing machine') + bodySp(3, [para('A tape that is infinite in both directions'), para('A finite control with states', { lvl: 1 }), para('A transition function')]),
        notes: 'Stress that the tape is unbounded. Draw the 7-tuple on the board.',
      },
      { shapes: titleSp(2, 'Decidable versus recognizable') + tableFrame(4, [['Class', 'Halts on yes', 'Halts on no'], ['Decidable', 'always', 'always'], ['Recognizable', 'always', 'maybe never']]) },
      { shapes: titleSp(2, 'Acceptance ratio') + equationShape(5, `<m:f><m:num>${mr('a')}</m:num><m:den>${mr('b')}</m:den></m:f>` + mr('=') + mr('0.5')), rels: { rIdImg1: ['image', '../media/image1.png'] }, parts: { 'ppt/media/image1.png': PNG_1X1 } },
      {
        shapes: titleSp(2, 'State diagram') + picture(4, 'rIdImg1', 1_000_000, 1_600_000, 5_000_000, 3_500_000, 'State diagram of a simple machine'),
        rels: { rIdImg1: ['image', '../media/image1.png'] },
        parts: { 'ppt/media/image1.png': PNG_1X1 },
      },
    ],
  };
}

export function lectureBytes(extra?: { suffix?: string }): Buffer {
  return Buffer.from(buildPptx(lectureSpec(extra)));
}

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Create a course from the empty dashboard (or via the sidebar button) and land on its page. */
export async function createCourse(page: Page, name: string, code?: string): Promise<void> {
  const empty = page.getByRole('button', { name: 'Create a course' });
  if (await empty.isVisible().catch(() => false)) await empty.click();
  else await page.getByRole('button', { name: 'New course' }).first().click();
  await page.getByLabel('Course name').fill(name);
  if (code) await page.getByLabel('Course code (optional)').fill(code);
  await page.getByRole('button', { name: 'Create course' }).click();
  await page.getByRole('heading', { level: 1, name }).waitFor();
}

export async function importFiles(page: Page, files: { name: string; buffer: Buffer }[]): Promise<void> {
  await page.locator('input[aria-label="Choose PowerPoint files"]').setInputFiles(files.map((f) => ({ name: f.name, mimeType: PPTX_MIME, buffer: f.buffer })));
}

/** Collect every request the page makes (for the "no third-party traffic" check). */
export function trackRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  return urls;
}

/** A study pack as an AI would write it. One cited quote is deliberately invented to prove verification works. */
export const PACK = {
  format: 'studyai-pack',
  version: 1,
  generator: 'Test AI (2026-10-16)',
  lectures: [{ ref: 'L1', title: 'Lecture 4 - Turing machines' }],
  cards: [
    { type: 'definition', front: 'What does the tape of a Turing machine look like?', back: 'It is infinite in both directions.', lecture: 'L1', basis: 'lecture', sources: [{ lecture: 'L1', slide: 2, quote: 'A tape that is infinite in both directions' }] },
    { type: 'qa', front: 'How many cells does the tape hold?', back: 'A million cells.', lecture: 'L1', basis: 'lecture', sources: [{ lecture: 'L1', slide: 2, quote: 'The tape holds a million cells that never end' }] },
  ],
  questions: [
    {
      type: 'mcq',
      prompt: 'Which statement about the tape is correct?',
      marks: 2,
      topic: 'Turing machines',
      lectures: ['L1'],
      options: [{ text: 'It is infinite in both directions', correct: true }, { text: 'It has exactly 100 cells', correct: false }],
      basis: 'lecture',
      sources: [{ lecture: 'L1', slide: 2, quote: 'A tape that is infinite in both directions' }],
    },
    {
      type: 'short',
      prompt: 'State two components of a Turing machine.',
      marks: 2,
      topic: 'Turing machines',
      lectures: ['L1'],
      modelAnswer: 'A tape and a finite control.',
      rubric: [{ text: 'Mentions the tape', marks: 1, keywords: ['tape'] }, { text: 'Mentions the finite control', marks: 1, keywords: ['control'] }],
      expectedWords: [3, 30],
      hint: 'Look at slide 2.',
      basis: 'lecture',
      sources: [{ lecture: 'L1', slide: 2, quote: 'A finite control with states' }],
    },
  ],
  notes: [{ title: 'Turing machine summary', kind: 'summary', lecture: 'L1', blocks: [{ text: 'A Turing machine has a **tape** and a *finite control*.', basis: 'derived', sources: [{ lecture: 'L1', slide: 2 }] }] }],
};


/** A tab of the course page (the breadcrumb can contain links with the same name). */
export const tab = (page: Page, name: string | RegExp) => page.getByRole('navigation', { name: 'Course sections' }).getByRole('link', { name });

/**
 * Reveals a flashcard's answer with the keyboard. The review page is loaded on demand, so a key pressed in the
 * instant the card appears can arrive before the page listens for keys; press again until the grade buttons show.
 * (Space does nothing once the answer is showing, so repeating it is harmless.)
 */
export async function revealWithKeyboard(page: Page): Promise<void> {
  await expect(async () => {
    await page.keyboard.press('Space');
    await expect(page.getByRole('group', { name: 'How well did you remember?' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}

export async function seed(page: Page) {
  await page.goto('/');
  await createCourse(page, 'Computability', 'BCS303');
  await importFiles(page, [{ name: 'Lecture 4 - Turing machines.pptx', buffer: lectureBytes() }]);
  await expect(page.getByText(/Imported: 5 slides/)).toBeVisible();
}

export async function importPack(page: Page) {
  await page.getByRole('button', { name: 'Study packs from your own AI' }).click();
  await page.getByRole('menuitem', { name: 'Import a study pack…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import a study pack' });
  // Paste with surrounding chatter and a code fence, as copied from a chat window.
  await dialog.getByLabel('Pack JSON').fill(`Here is your pack!\n\`\`\`json\n${JSON.stringify(PACK, null, 2)}\n\`\`\`\nGood luck.`);
  await dialog.getByRole('button', { name: 'Check this pack' }).click();
  return dialog;
}


/** Collect console errors, CSP violations and uncaught exceptions; assert the list is empty at the end of a test. */
export function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => (m.type() === 'error' || /Content Security Policy|Refused to/i.test(m.text())) && problems.push(`${m.type()}: ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}
