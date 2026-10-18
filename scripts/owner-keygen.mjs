#!/usr/bin/env node
/**
 * Creates the owner's private access key and the two server secrets.
 *
 *   node scripts/owner-keygen.mjs                   prints them
 *   node scripts/owner-keygen.mjs --write-dev-vars  also writes .dev.vars for local development (never overwrites)
 *   node scripts/owner-keygen.mjs --deploy-secrets  stores the two server secrets in Cloudflare (needs `wrangler login` and a
 *                                                   deployed Worker) and prints ONLY the owner key, once, to this terminal
 *
 * The OWNER KEY is shown once and never written anywhere by this script: save it in your password manager and paste it
 * into the site's sign-in box. The server only ever stores its SHA-256 hash (OWNER_KEY_HASH), so the key cannot be
 * recovered from the server. With --deploy-secrets the hash and the session secret go straight into Cloudflare through
 * wrangler's standard input: they are not printed and not written to any file.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const ownerKey = `sak_${randomBytes(32).toString('base64url')}`;
const ownerKeyHash = createHash('sha256').update(ownerKey).digest('hex');
const sessionSecret = randomBytes(48).toString('base64url');

function putSecret(name, value) {
  const r = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', name], { input: value, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
  if (r.status !== 0) {
    // wrangler's own message can name the Worker or account but never the value it was given
    console.error(`\nCould not store ${name} in Cloudflare:\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n')}`);
    return false;
  }
  console.log(`  stored ${name} in Cloudflare`);
  return true;
}

if (process.argv.includes('--deploy-secrets')) {
  console.log('Storing the server secrets in Cloudflare (nothing is printed or saved locally)...');
  if (!putSecret('OWNER_KEY_HASH', ownerKeyHash) || !putSecret('SESSION_SECRET', sessionSecret)) {
    console.error('\nNo owner key was shown, because the secrets were not stored. Fix the problem above and run this again.');
    process.exit(1);
  }
  console.log(`
YOUR OWNER KEY - shown once, here only. Copy it into your password manager now.
It is not saved anywhere and cannot be recovered from the server; if you lose it, run this command again.

  ${ownerKey}
`);
  process.exit(0);
}

console.log(`
YOUR OWNER KEY (shown once - save it in your password manager, never commit or share it):

  ${ownerKey}

Server secrets (store as Cloudflare secrets; they are useless without the key above):

  OWNER_KEY_HASH=${ownerKeyHash}
  SESSION_SECRET=${sessionSecret}
`);

if (process.argv.includes('--write-dev-vars')) {
  if (existsSync('.dev.vars')) {
    console.log('.dev.vars already exists, so it was left alone. Edit it by hand to use the values above.');
  } else {
    writeFileSync('.dev.vars', `# Local development secrets. Git-ignored. Never commit this file.\nALLOWED_HOSTS=localhost:8787\nOWNER_KEY_HASH=${ownerKeyHash}\nSESSION_SECRET=${sessionSecret}\n# Paste your Gemini key here yourself, only when you are ready for the first real request:\nGEMINI_API_KEY=\n`, { mode: 0o600 });
    console.log('Wrote .dev.vars (git-ignored). Add GEMINI_API_KEY yourself when you are ready.');
  }
}
