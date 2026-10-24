import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The commit-attribution check runs in CI: its rules must catch AI trailers, footers and identities and leave human co-authors alone. */
const root = resolve(__dirname, '..');

describe('scripts/check-attribution.mjs', () => {
  it('passes its own self-test', () => {
    const r = spawnSync(process.execPath, ['scripts/check-attribution.mjs', '--self-test'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    expect(r.error).toBeUndefined();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/self-test OK/);
  });
});
