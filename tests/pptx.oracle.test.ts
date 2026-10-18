import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePptx } from '../src/core/pptx';
import type { ParsedDeck } from '../src/core/pptx/model';

/**
 * Independent oracle: a deck authored by python-pptx (real PowerPoint template,
 * real master/layout/theme XML) is read back by python-pptx itself, and our
 * extractor must find everything python-pptx finds. Skipped when Python or
 * python-pptx is not installed.
 */

interface Expected {
  slideCount: number;
  slides: { index: number; title: string; texts: string[]; pictures: number; tables: number; charts: { categories: string[]; series: { name: string; values: number[] }[] }[]; notes: string }[];
}

const SCRIPT = resolve(__dirname, 'fixtures', 'gen_python_deck.py');
const available = spawnSync('python', ['-I', '-c', 'import pptx'], { encoding: 'utf8' }).status === 0;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe.skipIf(!available)('python-pptx oracle', () => {
  let dir: string;
  let deck: ParsedDeck;
  let expected: Expected;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'studyai-oracle-'));
    const pptx = join(dir, 'deck.pptx');
    const json = join(dir, 'expected.json');
    const r = spawnSync('python', ['-I', SCRIPT, pptx, json], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`generator failed: ${r.stderr}`);
    expected = JSON.parse(readFileSync(json, 'utf8')) as Expected;
    deck = await parsePptx(new Uint8Array(readFileSync(pptx)));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('finds the same number of slides and titles', () => {
    expect(deck.slides).toHaveLength(expected.slideCount);
    for (const e of expected.slides) expect(norm(deck.slides[e.index - 1]!.title)).toBe(norm(e.title));
  });

  it('captures every text string python-pptx sees (100% recall)', () => {
    for (const e of expected.slides) {
      const ours = norm(deck.slides[e.index - 1]!.text);
      for (const t of e.texts) expect(ours, `slide ${e.index} is missing "${t}"`).toContain(norm(t));
    }
  });

  it('adds no text python-pptx does not see (precision)', () => {
    for (const e of expected.slides) {
      const allowed = new Set(e.texts.map(norm));
      const lines = deck.slides[e.index - 1]!.text.split('\n').map((l) => norm(l.replace(/^\s*-\s+/, ''))).filter(Boolean);
      for (const line of lines) {
        const known = allowed.has(line) || [...allowed].some((a) => a.includes(line)) || /^\[Picture/.test(line) || /^(Chart|Categories|Diagram)/.test(line) || /^[\w ]+: [\d, ]+$/.test(line) || / \| /.test(line);
        expect(known, `slide ${e.index} has unexpected text "${line}"`).toBe(true);
      }
    }
  });

  it('matches notes, table, picture and chart counts', () => {
    for (const e of expected.slides) {
      const s = deck.slides[e.index - 1]!;
      expect(norm(s.notes), `notes of slide ${e.index}`).toBe(norm(e.notes));
      expect(s.counts.tables).toBe(e.tables);
      expect(s.counts.pictures).toBe(e.pictures);
      expect(s.counts.charts).toBe(e.charts.length);
    }
  });

  it('reads chart categories and series values identically', () => {
    for (const e of expected.slides) {
      const charts = deck.slides[e.index - 1]!.elements.filter((el) => el.kind === 'chart');
      e.charts.forEach((c, i) => {
        const ours = charts[i]?.kind === 'chart' ? charts[i].chart : null;
        expect(ours?.categories).toEqual(c.categories);
        expect(ours?.series.map((s) => ({ name: s.name, values: s.values }))).toEqual(c.series);
      });
    }
  });

  it('keeps run formatting and safe hyperlinks from a real-world file', () => {
    const slide4 = deck.slides[3]!;
    const box = slide4.elements.find((el) => el.kind === 'shape' && el.isTextBox);
    const inlines = box?.kind === 'shape' ? box.paragraphs[0]!.inlines : [];
    expect(inlines[0]).toMatchObject({ text: 'A firewall ', bold: true });
    expect(inlines[1]).toMatchObject({ text: 'filters traffic', italic: true });
    expect(inlines[2]).toMatchObject({ link: 'https://www.rfc-editor.org/rfc/rfc2979' });
  });

  it('reports a clean, fully confident extraction for a plain deck', () => {
    expect(deck.report).toMatchObject({ failedSlides: 0, slidesRequiringAttention: [] });
    expect(deck.slides.every((s) => s.coverage.missing.length === 0)).toBe(true);
  });

  it('applies group transforms (python-pptx groups)', () => {
    const slide6 = deck.slides[5]!;
    const inside = slide6.elements.filter((el) => el.kind === 'shape' && el.groupPath && el.groupPath.length > 0);
    expect(inside.length).toBe(2);
  });
});
