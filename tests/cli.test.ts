import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractLectures, formatExtraction, promptText, defaultPromptOptions, validatePackFile } from '../src/cli/commands';
import { buildPptx, picture, simpleSlide, PNG_1X1 } from './fixtures/pptx-builder';

/** The command-line tool behind the Claude Code skill: same engine as the app, run on real files in a temp folder. */
let dir: string;
let pptx: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'studyai-cli-'));
  pptx = join(dir, '0123456789abcdef0123456789abcdef_Lecture_7_Undecidability.pptx');
  writeFileSync(
    pptx,
    buildPptx({
      slides: [
        simpleSlide('Halting problem', ['The halting problem is undecidable', 'Proof by contradiction using diagonalisation'], 'Mention Turing 1936'),
        simpleSlide('Reductions', ['If A reduces to B and B is decidable then A is decidable']),
        {
          shapes: picture(4, 'rIdImg1', 500000, 700000, 8000000, 5000000),
          rels: { rIdImg1: ['image', '../media/image1.png'] },
          parts: { 'ppt/media/image1.png': PNG_1X1 },
        },
      ],
    }),
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const writePack = (over: Record<string, unknown>) => {
  const p = join(dir, `pack-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ format: 'studyai-pack', version: 1, generator: 'test', lectures: [{ ref: 'L1', title: 'Lecture 7 Undecidability' }], notes: [], cards: [], questions: [], ...over }));
  return p;
};

describe('extract', () => {
  it('writes Markdown with slide numbers and a completeness report, and flags what could not be read', async () => {
    const out = join(dir, 'out');
    const [r] = await extractLectures([pptx], out);
    expect(r).toMatchObject({ ref: 'L1', title: 'Lecture 7 Undecidability', slideCount: 3 });
    expect(r!.fileHash).toMatch(/^[0-9a-f]{64}$/);
    const md = readFileSync(r!.markdownPath, 'utf8');
    expect(md).toContain('## Lecture L1: Lecture 7 Undecidability');
    expect(md).toContain(`hash=${r!.fileHash} slides=3`);
    expect(md).toContain('### Slide 1: Halting problem');
    expect(md).toContain('**Speaker notes:** Mention Turing 1936');
    expect(r!.slidesNeedingAttention).toEqual([3]); // the picture-only slide
    expect(r!.caveats.join(' ')).toMatch(/No extractable text/);
    const report = JSON.parse(readFileSync(r!.reportPath, 'utf8'));
    expect(report.slides[2].flags.join(' ')).toMatch(/NO_EXTRACTABLE_TEXT/);
    expect(JSON.parse(readFileSync(join(out, 'lectures.json'), 'utf8'))[0]).toMatchObject({ ref: 'L1', slideCount: 3 });
    expect(formatExtraction([r!])).toContain('SLIDES NEEDING ATTENTION (content may be missing): 3');
  });
});

describe('validate', () => {
  it('accepts a pack whose every quote is on the real slide', async () => {
    const p = writePack({
      cards: [{ type: 'qa', front: 'f', back: 'b', lecture: 'L1', basis: 'lecture', sources: [{ lecture: 'L1', slide: 1, quote: 'The halting problem is undecidable' }] }],
      questions: [{ type: 'truefalse', prompt: 'HALT is decidable.', marks: 1, answer: false, basis: 'lecture', lectures: ['L1'], sources: [{ lecture: 'L1', slide: 2, quote: 'if A reduces to B and B is decidable then A is decidable' }] }],
    });
    const r = await validatePackFile(p, [pptx]);
    expect(r.ok).toBe(true);
    expect(r.report).toContain('2 of 2 cited quotes verified');
    expect(r.report).toContain('OK: the pack is valid');
  });

  it('rejects invented quotes and tells the AI what the slide really says', async () => {
    const p = writePack({ cards: [{ type: 'qa', front: 'f', back: 'b', lecture: 'L1', basis: 'lecture', sources: [{ lecture: 'L1', slide: 1, quote: 'The halting problem is easily solved in linear time' }] }] });
    const r = await validatePackFile(p, [pptx]);
    expect(r.ok).toBe(false);
    expect(r.report).toContain('NOT READY');
    expect(r.report).toMatch(/not found on slide 1/);
    expect(r.report).toContain('slide 1 actually says: Halting problem');
    expect(r.report).toContain('The halting problem is undecidable');
  });

  it('rejects out-of-range slides, unmatched lectures, skipped items and unreadable files', async () => {
    const r1 = await validatePackFile(writePack({ cards: [{ type: 'qa', front: 'f', back: 'b', lecture: 'L1', basis: 'derived', sources: [{ lecture: 'L1', slide: 40, quote: 'anything at all goes here' }] }] }), [pptx]);
    expect(r1.ok).toBe(false);
    expect(r1.report).toMatch(/has only 3 slides/);
    const r2 = await validatePackFile(writePack({ lectures: [{ ref: 'L1', title: 'Some other lecture' }], cards: [{ type: 'qa', front: 'f', back: 'b', lecture: 'L1', basis: 'derived' }] }), [pptx]);
    expect(r2.ok).toBe(false);
    expect(r2.report).toContain('NOT MATCHED to any lecture file');
    const r3 = await validatePackFile(writePack({ cards: [{ type: 'bogus', front: '', back: '' }] }), [pptx]);
    expect(r3.ok).toBe(false);
    expect(r3.report).toMatch(/skipped/i);
    const notPack = join(dir, 'bad.json');
    writeFileSync(notPack, 'not json at all');
    expect((await validatePackFile(notPack, [pptx])).report).toMatch(/FAILED: No JSON object found/);
    const wrong = join(dir, 'wrong.json');
    writeFileSync(wrong, '{"hello": 1}');
    expect((await validatePackFile(wrong, [pptx])).report).toMatch(/not a StudyAI pack/);
  });

  it('matches lectures by file hash even when the title differs', async () => {
    const [r] = await extractLectures([pptx], join(dir, 'out2'));
    const p = writePack({ lectures: [{ ref: 'L1', title: 'Renamed', fileHash: r!.fileHash }], cards: [{ type: 'qa', front: 'f', back: 'b', lecture: 'L1', basis: 'derived' }] });
    const v = await validatePackFile(p, [pptx]);
    expect(v.report).toContain('matched by hash');
  });
});

describe('prompt', () => {
  it('is the same instruction text the app shows', () => {
    const t = promptText({ ...defaultPromptOptions, examStyle: 'Scenario questions only.' });
    expect(t).toContain('"studyai-pack"');
    expect(t).toContain('Scenario questions only.');
    expect(t).toContain('Do not invent lecture content');
  });
});
