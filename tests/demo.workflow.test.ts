import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The workflow that publishes the demo (.github/workflows/demo.yml): checked as text, so no YAML library is needed. */
const raw = readFileSync('.github/workflows/demo.yml', 'utf8');
const code = raw
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .map((l) => l.replace(/\s+#.*$/, ''))
  .join('\n');

describe('the demo workflow', () => {
  it('can only be started by hand: merging, pushing or a schedule never publishes anything', () => {
    const on = /^on:\n((?: {2}.*\n)+)/m.exec(code)?.[1] ?? '';
    expect(on.trim()).toBe('workflow_dispatch:');
    for (const trigger of ['push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_run', 'workflow_call', 'repository_dispatch', 'release', 'create']) {
      expect(code, trigger).not.toMatch(new RegExp(`^\\s*${trigger}:`, 'm'));
    }
  });

  it('pins every action to a full commit SHA, with the version in a comment', () => {
    const uses = [...raw.matchAll(/^\s*- (?:id: \w+\n\s*)?uses: (\S+)(.*)$/gm)];
    expect(uses.length).toBe(6);
    for (const [, ref, rest] of uses) expect(`${ref}${rest}`, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
    for (const name of ['configure-pages', 'upload-pages-artifact', 'deploy-pages']) expect(code).toContain(`actions/${name}@`);
  });

  it('gives the build read access only, and the deploy job alone the right to publish', () => {
    const [head, build, deploy] = [code.split(/^jobs:/m)[0]!, /^ {2}build:\n([\s\S]*?)^ {2}deploy:/m.exec(code)?.[1] ?? '', code.split(/^ {2}deploy:/m)[1] ?? ''];
    expect(head).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(build).toMatch(/permissions:\n {6}contents: read\n {6}pages: read\n/);
    expect(build).not.toMatch(/write/);
    expect(deploy).toMatch(/pages: write/);
    expect(deploy).toMatch(/id-token: write/);
    expect(code.match(/pages: write/g)).toHaveLength(1);
    expect(code.match(/id-token: write/g)).toHaveLength(1);
  });

  it('never enables Pages or changes a setting, and keeps no credentials in the checkout', () => {
    expect(code).not.toMatch(/enablement/);
    expect(code).not.toMatch(/secrets\./);
    expect(code).toMatch(/persist-credentials: false/);
  });

  it('publishes only from the default branch', () => {
    expect(code).toMatch(/if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  });

  it('builds the demo, runs the tests first, and uploads exactly what the build wrote', () => {
    expect(code).toMatch(/- run: pnpm test\n/);
    expect(code).toMatch(/- run: pnpm build:demo\n/);
    expect(code).toMatch(/path: dist-demo\n/);
    expect(code).toMatch(/STUDYAI_DEMO_BASE: \$\{\{ steps\.pages\.outputs\.base_path \}\}\/\n/);
  });
});
