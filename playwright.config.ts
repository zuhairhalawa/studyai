import { defineConfig, devices } from '@playwright/test';
import { DEMO_PATH, ORIGINS, PORTS } from './tests/e2e/ports';

/**
 * End-to-end tests run against the *production build* served by `vite preview`,
 * using the Chrome already installed on the machine (no browser download).
 *
 * A second server runs the real Worker + Durable Object locally (wrangler dev, with a scripted fake Gemini and
 * freshly generated test secrets) for the tests in `worker-*.spec.ts`; a third runs it with the whole site private
 * (the sign-in gate) for `gate-*.spec.ts`; a fourth serves the static public demo build under its sub-path for `demo-*.spec.ts`
 * (no headers: its policy is in the page). No Cloudflare account and no network are used.
 */
const WORKER = /worker-.*\.spec\.ts/;
const GATE = /gate-.*\.spec\.ts/;
const DEMO = /demo-.*\.spec\.ts/;
/** What the two Worker servers are told about the ports (see tests/e2e/ports.ts). */
const serverEnv = { E2E_PORT_PREVIEW: String(PORTS.preview), E2E_PORT_WORKER: String(PORTS.worker), E2E_PORT_GATE: String(PORTS.gate), E2E_PORT_STUB: String(PORTS.stub) };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: ORIGINS.preview,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } }, grep: /^(?!.*@mobile)/, testIgnore: [WORKER, GATE, DEMO] },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' }, grep: /@mobile/, testIgnore: [WORKER, GATE, DEMO] },
    { name: 'worker', testMatch: WORKER, use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 }, baseURL: ORIGINS.worker } },
    { name: 'gate', testMatch: GATE, use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 }, baseURL: ORIGINS.gate } },
    // The trailing slash matters: tests open pages with relative paths such as './settings'.
    { name: 'demo', testMatch: DEMO, use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 }, baseURL: `${ORIGINS.demo}${DEMO_PATH}` } },
  ],
  webServer: [
    {
      command: `pnpm build && pnpm exec vite preview --port ${PORTS.preview} --strictPort --host 127.0.0.1`,
      url: ORIGINS.preview,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `pnpm exec vite build --mode demo && pnpm exec vite preview --mode demo --port ${PORTS.demo} --strictPort --host 127.0.0.1`,
      url: `${ORIGINS.demo}${DEMO_PATH}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: 'node scripts/e2e-worker-server.mjs',
      env: serverEnv,
      url: `${ORIGINS.worker}/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
    {
      command: 'node scripts/e2e-worker-server.mjs gate',
      env: serverEnv,
      url: `${ORIGINS.gate}/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
