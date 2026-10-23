# The public demo

A copy of the study app that anyone can try in a browser in about ten seconds: nothing to install, no account, no AI. It is a static site (HTML, scripts and fonts) that GitHub Pages can serve at `https://zuhairhalawa.github.io/studyai/`. This page says how it is built, how it is published and what it cannot do.

## What a visitor sees

* A banner on every page: the sample content is fictional, anything the visitor adds stays in their browser and is never uploaded, and AI features are not available in the demo.
* **Load the sample course**: one click creates *Skyship Navigation (invented demo course)*: two lectures of seven slides each, 13 flashcards, 8 practice-exam questions and two notes. The visitor can read the slides beside the text the app extracted, search them, review flashcards (with their source checks) and build and sit a practice exam. Pressing the button again opens the course instead of making a second copy.
* Everything else in the app works as it does anywhere: the visitor can also drop in their own `.pptx` files, which are read on their own device.
* The AI screens are there but say so: the tutor, the generate dialog and Settings → AI all show "AI is not available in this copy of the app" and cannot send anything, because the demo contains no code that could (see below).

All content is invented: the subject, the units, the towers and masts, the numbers and the "rules". No real course, person or institution appears anywhere in it.

## How it is built

```bash
pnpm build:demo       # type-checks, then writes the site to dist-demo/
pnpm preview:demo     # serves it at http://localhost:4173/studyai/ to look at it
```

`build:demo` is `vite build --mode demo`. The mode changes exactly this, in `vite.config.ts` and nowhere else:

| What | Regular build (`pnpm build`) | Demo build (`pnpm build:demo`) |
|---|---|---|
| Served from | the root of a Cloudflare Worker | a sub-path: `/studyai/` (set `STUDYAI_DEMO_BASE=/name/` for another one; the router, scripts, fonts and the file-reading worker follow) |
| Output folder | `dist/` | `dist-demo/` |
| AI client (`src/app/ai.ts`) | the real one, which talks to the Worker | replaced by `src/app/ai.demo.ts`, which has no `fetch` and always answers "unavailable"; the real client is not in the bundle |
| Security headers | `dist/_headers` (CSP, nosniff, frame and referrer rules ...) | none: GitHub Pages cannot send headers, so the policy is in the page (next section) |
| Banner and sample course | not compiled in | compiled in (the sample course loads on demand, as its own chunk) |
| `404.html` | none | a copy of the page, so a reload on an address such as `/studyai/course/…` still opens the app |

The sample course (`src/demo/`) is made when the button is pressed: two PowerPoint files are built in memory with the synthetic deck builder the tests use (`tests/fixtures/pptx-builder.ts`), read by the real PowerPoint engine in the same worker a visitor's own file would use, and stored; the flashcards, questions and notes then go through the normal study-pack import, so every quote is looked up on its slide. The demo approves them up front. In the real app, imported material waits for the student's approval; that is the one deliberate difference, so a visitor does not have to approve 21 items before trying a flashcard.

## The policy inside the page

The regular app is served with a Content-Security-Policy header. GitHub Pages sends no custom headers, so the demo carries the same policy in a `<meta http-equiv="Content-Security-Policy">` element that is the first thing after the charset. `config/headers.ts` is still the single source: the demo's policy is that one minus the directives a `<meta>` element cannot carry. What holds and what does not:

* **Holds:** `default-src 'none'`, scripts, styles, fonts, workers, images and connections only from the site itself (`'self'`, plus `blob:` and `data:` for images), no `unsafe-eval`, `base-uri 'none'`, `form-action 'self'`. A test serves the demo with no headers at all and proves that an injected inline script does not run and a request to another site is blocked. A referrer rule (`no-referrer`) is set with `<meta name="referrer">`.
* **Does not hold, because only a header can do it:** `frame-ancestors` and `X-Frame-Options` (another site may put the demo in a frame), `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`, `X-Content-Type-Options` and the `Strict-Transport-Security` choice (GitHub decides these for its own domain). The demo holds no account, no key and no private data, so none of these protects anything of value here; they are listed so nobody assumes they are in place.
* A policy in a page starts to apply when the browser reaches it. It is placed before every script and stylesheet, and the build fails if `index.html` no longer has the marker it is inserted after.

## What is guaranteed, and the test that says so

| Guarantee | Where it is tested |
|---|---|
| The demo bundle contains no AI client, no provider address and no key | `tests/demo.build.test.ts` (builds it for real) and `tests/e2e/demo-site.spec.ts` (reads every file the server hands out) |
| The AI stub offers exactly what the real client offers, and never calls `fetch`, XHR or a WebSocket | `tests/demo.ai-stub.test.ts` |
| A visitor's browser requests nothing but the site's own files, none of them under `/api/`; no console error or policy violation during a whole study session | `tests/e2e/demo-site.spec.ts` |
| The policy is in the page, before every script, and is what is enforced when no header is sent | `tests/demo.policy.test.ts`, `tests/demo.build.test.ts`, `tests/e2e/demo-site.spec.ts` |
| The demo works under its sub-path, including the file-reading worker, and 404.html is the app | `tests/demo.build.test.ts`, `tests/e2e/demo-site.spec.ts` |
| The regular app does not change: root paths, `_headers`, the real AI client, none of the demo code | `tests/demo.build.test.ts`, and the whole existing suite |
| The sample course passes the app's own checks (every quote found on its slide, no finding on any question), is varied, and contains only invented content | `tests/demo.sample-course.test.ts` |
| The banner and the sample course pass the accessibility audit in light and dark, and fit a phone | `tests/e2e/demo-site.spec.ts` |
| The workflow can only be started by hand, pins every action to a commit, and gives only the deploy job the right to publish | `tests/demo.workflow.test.ts` |

The browser tests run with `pnpm check` (see [CONTRIBUTING.md](../CONTRIBUTING.md)); the unit tests, including the real demo build, run in CI with `pnpm test`.

## Publishing it

`.github/workflows/demo.yml` builds the demo and deploys it with GitHub's official Pages actions (`configure-pages`, `upload-pages-artifact`, `deploy-pages`), each pinned to a full commit SHA. It runs **only** when started by hand (`workflow_dispatch`): merging or pushing never publishes anything, and the workflow never enables Pages or changes a setting.

One-time step for the owner, which no file in this repository does for them:

1. In the repository, **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Then, each time the demo should be published or refreshed:

1. **Actions → Demo → Run workflow**, branch `main`. It installs, runs the tests, builds the demo and deploys it; the deploy step shows the address.
2. A run started from another branch builds and stops; only the default branch is deployed.

To take the demo down: **Settings → Pages → Unpublish site**. To publish a fork under another name nothing needs changing: the workflow asks Pages for the path (`base_path`) and builds for it.

## Limits, said plainly

* **GitHub serves it.** The visitor's browser fetches the page and its files from `github.io`, and GitHub sees those visits like any host. The app adds nothing: no analytics, no third-party request, no cookie. A banner link to the repository is an ordinary link; it is followed only if the visitor clicks it.
* **The origin is shared.** Every GitHub Pages site of the same account lives on `zuhairhalawa.github.io`, and browsers share IndexedDB and local storage between pages of one origin. The demo keeps its data in a database named `studyai`; another project on the same origin could read it, and the demo could read theirs. The demo holds nothing private, but do not host a second app there that stores secrets, and do not put real lectures into the demo on a browser you share.
* **Data is per browser.** Clearing site data, private windows and some privacy settings remove or block it. The demo can export a backup (Settings) like the real app.
* **A reload on a deep link is answered with status 404** by GitHub Pages (the body is the app, so it works); search engines may treat such addresses as missing. The front page is a normal 200.
* **No AI, by construction.** The tutor, AI grading, the exam audit and generation exist as screens and say they are unavailable. Trying them needs your own copy with your own keys (README and [DEPLOY.md](DEPLOY.md)).
* **The sample is small on purpose** (two lectures, 14 slides). It shows the features; it is not a course to learn from, and the "rules" in it are made up.
* **Browsers.** The demo needs what the app needs: a current browser with IndexedDB and Web Workers. It was tested in Chrome only.
