# Deploying StudyAI to Cloudflare (free, private first)

A deployment made from this repository is **private by default**: it is reachable on a `*.workers.dev` address, but the whole site (the app's files as well as
the API) shows only a sign-in page until you sign in with your own owner key. Nothing about your library is on the server: it
stays in your browser. A custom domain can be attached later; DNS is never changed without your approval.

## What gets created

| Thing | Free? | Notes |
|---|---|---|
| One Worker named `studyai` serving the app files and `/api/*` | Yes (Workers Free: 100 000 requests/day) | Every request passes through the Worker so the sign-in gate can check the session |
| One SQLite-backed Durable Object (`StudyAiDO`) | Yes (SQLite Durable Objects are on the free plan) | Holds only counters, settings, confirmations and the login throttle — no lecture text, prompts or answers |
| A `*.workers.dev` address (`workers_dev: true`) | Yes | Answers only the sign-in page without your session. Preview URLs stay off |

**Never** add: Workers Paid, R2, Workers AI, KV/D1 paid add-ons, a payment method, Cloudflare Access/Zero Trust, or any "upgrade"
prompt. When a free limit is exceeded Cloudflare returns an error; it does not bill. A stranger hitting the sign-in page spends
the same free request quota as you do (100 000/day); at worst they could use it up for the day, which costs nothing.

## Secrets (four, all Cloudflare secrets; none is in a file or in git)

| Secret | What it is | Who sets it |
|---|---|---|
| `ALLOWED_HOSTS` | The host the site answers on, e.g. `studyai.<your-subdomain>.workers.dev`. Missing or empty = it answers nothing | `wrangler secret put ALLOWED_HOSTS` after the first deploy shows the address |
| `OWNER_KEY_HASH`, `SESSION_SECRET` | SHA-256 of your owner key; the cookie-signing secret | `pnpm owner:keygen --deploy-secrets` (see below). The key is printed once, to your terminal only |
| `GEMINI_API_KEY` | Your Google AI Studio key | **You**, typed into the hidden prompt of `pnpm exec wrangler secret put GEMINI_API_KEY` |

`ALLOWED_HOSTS` is a secret only so that no hostname of yours is committed to a public repository.

## Steps

1. Cloudflare account on the free plan, no payment method. `pnpm exec wrangler login` (you sign in in the browser).
2. Build and deploy: `pnpm build` then `pnpm exec wrangler deploy`. The first deploy prints the address. Until the secrets below
   are set, the site answers "This site is not set up yet" and the API answers nothing.
3. `pnpm exec wrangler secret put ALLOWED_HOSTS` and give it the host from step 2 (no `https://`, no path).
4. `pnpm owner:keygen --deploy-secrets` stores `OWNER_KEY_HASH` and `SESSION_SECRET` and prints your **owner key** once. Save it in
   your password manager. Lost it? Run the command again (it replaces the old key).
5. `pnpm exec wrangler secret put GEMINI_API_KEY` — paste the key from AI Studio into the hidden prompt. Create the key in the
   project that shows "Free tier / No billing account". Never put it in a file, a chat or a screenshot.

## First run (after deploying)

1. Open the address; sign in with the owner key. The app opens; **Settings → AI tutor** shows the checklist.
2. In Google AI Studio check the project is on the **Free tier** with **No billing account**, then tick the confirmations on the page.
3. Press **Approve the first real request**, then **Turn AI on**.
4. Open a course → **AI tutor**, ask one small question, and read "What will be sent" first.

If anything about billing is uncertain, the app stays off or pauses by itself. You can also press **Turn AI off** at any time.

## Things that happened on the first deployment

* A brand-new `*.workers.dev` subdomain needs a few minutes before its TLS certificate works; until then the address resolves but handshakes fail. Wait and retry.
* `wrangler deploy` may say it could not register "studyai" as your subdomain even when your account already has one (a name clash message). Check Workers & Pages in the dashboard (Account details → Subdomain) and retry the deploy.
* The workers.dev subdomain name is chosen by Cloudflare per account and may contain part of your email address. It is only in your Cloudflare secret `ALLOWED_HOSTS`, never in the repository.

## Custom domain later

Add the domain to the Worker (a `routes` entry with `custom_domain: true` in `wrangler.jsonc`), put the new host into the
`ALLOWED_HOSTS` secret (comma separated; keep the workers.dev one only while you need it), then set `"workers_dev": false` and
deploy again. The domain must already be on Cloudflare DNS.

## A public copy of the app (optional, not what is deployed)

`PRIVATE_SITE` = `"off"` together with `run_worker_first: ["/api/*"]` serves the app files to everyone while still requiring the
owner for every AI endpoint. Do not do this for your own deployment unless you want the app itself public. A test checks that the
committed configuration keeps the site private.

## Rolling back / switching everything off

* Switch AI off in Settings, or delete the Worker secret `GEMINI_API_KEY` (`wrangler secret delete GEMINI_API_KEY`) — nothing can then be sent.
* Sign out everywhere: Settings → AI → *Sign out everywhere*.
* Roll the Worker back: `pnpm exec wrangler rollback`. Remove it completely: `pnpm exec wrangler delete`.
* Revoke the Gemini key in AI Studio (API Keys) if it was ever exposed. Rotate first, then clean up.

## Known limits of the free plan

* Workers Free allows about **10 ms of CPU per request**. Large "generate" requests do real parsing; the local test runtime does not
  enforce the limit. If a request ever hits the limit it fails with an error; it does not cost anything.
* Cloudflare free quotas reset daily. The app also enforces its own limits below Google's free quotas (see FINANCIAL-SAFETY.md).
