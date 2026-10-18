#!/usr/bin/env node
/**
 * Starts the REAL Worker and Durable Object locally (wrangler dev, workerd, no Cloudflare account, no network) with the
 * scripted fake Gemini, for the end-to-end tests. Test-only secrets are generated fresh on every run and never written
 * to the repository; the generated owner key goes to .scratch/ (git-ignored) so the tests can sign in.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

// The ports come from playwright.config.ts (tests/e2e/ports.ts); the defaults are the same numbers.
const P = { preview: process.env.E2E_PORT_PREVIEW ?? '4391', worker: process.env.E2E_PORT_WORKER ?? '8792', gate: process.env.E2E_PORT_GATE ?? '8793', stub: process.env.E2E_PORT_STUB ?? '8795' };
const PREVIEW = `http://127.0.0.1:${P.preview}/`;

// "node scripts/e2e-worker-server.mjs gate" runs the variant with the whole site behind the owner login.
const gate = process.argv[2] === 'gate';
const CONFIG = gate ? 'wrangler.gate.jsonc' : 'wrangler.test.jsonc';
const PORT = gate ? P.gate : P.worker;
const STATE = gate ? '.scratch/e2e-gate-state' : '.scratch/e2e-state';
const KEY_FILE = gate ? '.scratch/e2e-gate-owner-key.txt' : '.scratch/e2e-owner-key.txt';

// A local stand-in for Google's generateContent endpoint, so the REAL Gemini adapter (not the scripted fake) can be exercised inside
// workerd with real fetch options and real HTTP. It records what it receives (GET /__log) and never sees a real key or the internet.
const STUB_PORT = Number(P.stub);
const stubLog = [];
if (!gate) {
  createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const json = (status, value, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/__log') return json(200, stubLog);
      if (req.url === '/__clear') {
        stubLog.length = 0;
        return json(200, { ok: true });
      }
      stubLog.push({ method: req.method, url: req.url, key: req.headers['x-goog-api-key'] ?? null, contentType: req.headers['content-type'] ?? null, body });
      if (req.url === '/elsewhere') return json(200, { followed: true });
      if (!/^\/v1beta\/models\/[a-z0-9.-]+:generateContent$/.test(req.url ?? '') || req.method !== 'POST') return json(404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
      if (!req.headers['x-goog-api-key']) return json(401, { error: { code: 401, message: 'missing key', status: 'UNAUTHENTICATED' } });
      if (body.includes('STUB-REDIRECT')) return json(302, {}, { location: `http://127.0.0.1:${STUB_PORT}/elsewhere` });
      return json(200, {
        responseId: 'stub-1',
        candidates: [{ content: { role: 'model', parts: [{ text: 'A tape is the unbounded memory a Turing machine reads and writes [S1].\n\nBASIS: lecture\nFOLLOWUPS: What is the head? | How does it move? | Why infinite?' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 25, totalTokenCount: 145 },
      });
    });
  }).listen(STUB_PORT, '127.0.0.1');
}

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// The production build (served by the other web server) must be finished before the Worker serves it as assets.
await waitFor(PREVIEW, 300_000);

rmSync(STATE, { recursive: true, force: true });
mkdirSync('.scratch', { recursive: true });
const ownerKey = `sak_${randomBytes(32).toString('base64url')}`;
writeFileSync(KEY_FILE, ownerKey);
const hash = createHash('sha256').update(ownerKey).digest('hex');
const secret = randomBytes(48).toString('base64url');

const child = spawn(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js', 'dev', '-c', CONFIG, '--port', PORT, '--ip', '127.0.0.1', '--local', '--persist-to', STATE,
    '--var', `ALLOWED_HOSTS:127.0.0.1:${PORT}`, '--var', `OWNER_KEY_HASH:${hash}`, '--var', `SESSION_SECRET:${secret}`, '--var', `GEMINI_API_KEY:${randomBytes(24).toString('hex')}`, ...(gate ? [] : ['--var', `GEMINI_STUB_URL:http://127.0.0.1:${STUB_PORT}`]), // random, unused: the scripted fake never calls Google
  ],
  { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' } },
);
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
