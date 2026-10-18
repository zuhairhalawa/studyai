import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASES, CARD_TYPES, NOTE_KINDS, QUESTION_TYPES } from '../src/core/study/types';
import { PACK_FORMAT, PACK_VERSION } from '../src/core/study/pack';

/** Guards the Claude Code skill against drifting away from the code it documents. */
const root = resolve(__dirname, '..');
const dir = join(root, '.claude', 'skills', 'lecture-pack');
const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
const format = readFileSync(join(dir, 'reference', 'pack-format.md'), 'utf8');

describe('lecture-pack skill', () => {
  it('has valid frontmatter in the supported format', () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(m, 'SKILL.md must start with YAML frontmatter').not.toBeNull();
    const fields = Object.fromEntries(m![1]!.split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
    expect(fields['name']).toBe('lecture-pack');
    expect(fields['name']).toMatch(/^[a-z0-9-]{1,64}$/);
    expect((fields['description'] ?? '').length).toBeGreaterThan(80);
    expect((fields['description'] ?? '').length).toBeLessThanOrEqual(1024);
    expect(fields['description']).toMatch(/pptx|lecture/i);
    expect(Object.keys(fields).sort()).toEqual(['description', 'name']);
  });

  it('only links to files that exist, and its script exists and is a real bash script', () => {
    const links = [...skill.matchAll(/\]\((reference\/[^)]+)\)/g)].map((x) => x[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(existsSync(join(dir, l)), l).toBe(true);
    const script = join(dir, 'scripts', 'ensure-cli.sh');
    expect(existsSync(script)).toBe(true);
    expect(readFileSync(script, 'utf8').startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(skill).toContain('scripts/ensure-cli.sh');
  });

  it('documents only CLI commands that exist, with the real build script', () => {
    const main = readFileSync(join(root, 'src', 'cli', 'main.ts'), 'utf8');
    for (const cmd of ['extract', 'validate', 'prompt']) {
      expect(skill).toContain(`lecture-cli.mjs ${cmd}`);
      expect(main).toContain(`cmd === '${cmd}'`);
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['cli:build']).toContain('vite.cli.config.ts');
    expect(readFileSync(join(dir, 'scripts', 'ensure-cli.sh'), 'utf8')).toContain('pnpm cli:build');
  });

  it('lists exactly the card, note, question and basis values the app accepts', () => {
    for (const v of [...CARD_TYPES, ...NOTE_KINDS, ...QUESTION_TYPES, ...BASES]) expect(format, `reference/pack-format.md is missing "${v}"`).toContain(v);
    expect(format).toContain(`"format": "${PACK_FORMAT}"`);
    expect(format).toContain(`"version": ${PACK_VERSION}`);
  });

  it('states the zero-spend and privacy rules', () => {
    expect(skill).toMatch(/Never call an AI API/);
    expect(skill).toMatch(/never ask for or use an API key/i);
    expect(skill).toMatch(/stay on this machine/);
    expect(skill).toMatch(/Never fake a quote/);
  });

  it('is committed (not swallowed by .gitignore)', () => {
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(ignore).toContain('!.claude/skills/');
  });
});
