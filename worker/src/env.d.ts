/** Secrets are not in wrangler.jsonc, so `wrangler types` cannot know them. They are optional on purpose: a missing one must fail closed. */
interface Env {
  GEMINI_API_KEY?: string;
  OWNER_KEY_HASH?: string;
  SESSION_SECRET?: string;
  /** Hosts the site answers on, e.g. "studyai.example.workers.dev". A secret, so no hostname is committed. Empty or missing = answers nothing. */
  ALLOWED_HOSTS?: string;
}
