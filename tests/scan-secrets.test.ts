import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The secret scanner guards the public release: every detector must fire on its sample and placeholders must not. */
const root = resolve(__dirname, '..');

describe('scripts/scan-secrets.mjs', () => {
  it('passes its own self-test', () => {
    const r = spawnSync(process.execPath, ['scripts/scan-secrets.mjs', '--self-test'], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    expect(r.error).toBeUndefined();
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/self-test OK/);
  });
});
