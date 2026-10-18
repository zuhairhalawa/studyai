import { handle, handleSite, type AppEnv, type Backend } from './app';
import { parseAllowedHosts } from './auth';
import { siteIsPrivate } from './gate';
import { StudyAiDO } from './do';
import { ScriptedGemini } from './scripted-gemini';
import { GEMINI_HOST, GeminiProvider } from '../../src/core/ai/gemini';
import type { Provider } from '../../src/core/ai/provider';

/**
 * LOCAL TEST ENTRY ONLY (wrangler.test.jsonc, used by the end-to-end tests). It swaps Google for a scripted fake so the
 * whole site can be exercised with no key and no network. The production entry (index.ts) never imports this file, and a
 * test checks that the production bundle contains none of it.
 */
const STUB_FLAG = "testmode:stub";
const STUB_KEY = 'stub-key-for-local-tests';

export class StudyAiTestDO extends StudyAiDO {
  protected override createProvider(): Provider {
    const stub = (this.env as Env & { GEMINI_STUB_URL?: string }).GEMINI_STUB_URL;
    // Normally the scripted fake. When a test switches it on, the REAL Gemini adapter runs (real fetch options, real HTTP) but
    // its requests go to a local stub server instead of Google. This is what catches runtime-only failures a fake cannot.
    if (stub && this.ctx.storage.sql.exec('SELECT 1 FROM kv WHERE k = ?', STUB_FLAG).toArray().length > 0) {
      return new GeminiProvider(STUB_KEY, (url, init) => fetch(url.replace(GEMINI_HOST, stub), init));
    }
    return new ScriptedGemini();
  }

  async useStubForTests(on: boolean): Promise<void> {
    if (on) this.ctx.storage.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING', STUB_FLAG, '1');
    else this.ctx.storage.sql.exec('DELETE FROM kv WHERE k = ?', STUB_FLAG);
  }

  /** Lets repeated end-to-end runs start from an empty ledger and no login locks. Exists only in this test class. */
  async resetLedgerForTests(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM kv WHERE k IN ('ledger', 'ledger:started', 'testmode:stub') OR k LIKE 'throttle:%'");
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const hosts = parseAllowedHosts(env.ALLOWED_HOSTS);
    const privateSite = siteIsPrivate(env.PRIVATE_SITE);
    if (!url.pathname.startsWith('/api/') && !privateSite) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/test/reset-ledger' && request.method === 'POST' && hosts.includes(url.host.toLowerCase())) {
      await (env.STUDYAI as DurableObjectNamespace<StudyAiTestDO>).getByName('owner').resetLedgerForTests();
      return new Response('reset', { status: 200, headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/api/test/provider' && request.method === 'POST' && hosts.includes(url.host.toLowerCase())) {
      const { stub } = (await request.json()) as { stub?: boolean };
      await (env.STUDYAI as DurableObjectNamespace<StudyAiTestDO>).getByName('owner').useStubForTests(stub === true);
      return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } });
    }
    const backend: Backend = env.STUDYAI.getByName('owner');
    const app: AppEnv = { backend, ownerKeyHash: env.OWNER_KEY_HASH, sessionSecret: env.SESSION_SECRET, allowedHosts: hosts, now: Date.now };
    if (url.pathname.startsWith('/api/')) return handle(request, app);
    return handleSite(request, app, (r) => env.ASSETS.fetch(r));
  },
} satisfies ExportedHandler<Env>;
