import { handle, handleSite, type AppEnv, type Backend } from './app';
import { parseAllowedHosts } from './auth';
import { siteIsPrivate } from './gate';

export { StudyAiDO } from './do';

/**
 * Entry point. While the site is private (PRIVATE_SITE is anything but "off", and `run_worker_first` is true in wrangler.jsonc),
 * every request comes through here: /api/* is the API, everything else is the app's static files, served only to a signed-in
 * owner. There is deliberately no route that proxies arbitrary requests anywhere.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const backend: Backend = env.STUDYAI.getByName('owner');
    const app: AppEnv = {
      backend,
      ownerKeyHash: env.OWNER_KEY_HASH,
      sessionSecret: env.SESSION_SECRET,
      allowedHosts: parseAllowedHosts(env.ALLOWED_HOSTS),
      now: Date.now,
    };
    if (url.pathname.startsWith('/api/')) return handle(request, app);
    return siteIsPrivate(env.PRIVATE_SITE) ? handleSite(request, app, (r) => env.ASSETS.fetch(r)) : env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
