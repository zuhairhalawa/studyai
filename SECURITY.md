# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** using GitHub's private vulnerability reporting on this repository:
open the **Security** tab, choose **Report a vulnerability**, and describe the problem. There is no email address for
security reports.

Please do not open a public issue, discussion or pull request for a suspected vulnerability, and do not include real
secrets, personal data or copyrighted lecture material in a report.

A useful report contains:

* what you found and which guarantee below it breaks;
* the commit or version, and the steps to reproduce (a minimal test case or request is ideal);
* the impact as you understand it.

This is a small project maintained on a best-effort basis. Reports are acknowledged when the maintainer can, with no
guaranteed response time and no bounty. Please allow time for a fix before disclosing details publicly.

## Supported versions

| Version | Supported |
|---|---|
| `main` (latest commit) | Yes |
| Any earlier commit or tag (the project is pre-1.0) | No, update to `main` |

## What the project guarantees

These are the security properties the project is designed to keep. A way to break one of them is a vulnerability.

* **Local-first.** Lectures, notes, flashcards, exams and progress are stored in the browser on the user's own device
  (IndexedDB). The study features work without an account and without any AI service.
* **No telemetry.** No analytics, tracking or third-party requests. The Content-Security-Policy limits network
  connections to the app's own origin, and an automated test enforces this.
* **Secrets only in Cloudflare secrets.** Credentials (the AI provider key, the owner key hash, the session secret)
  exist only as Cloudflare secrets in production and in an untracked `.dev.vars` file during local development. They
  are never committed, never present in git history, and never sent to the browser. `pnpm scan:secrets` checks the
  working tree and the full history for this.
* **Owner-only AI endpoint.** AI features are reachable only by the owner of a deployment, authenticated by the owner
  key. Requests from anyone else are rejected, and lecture content is sent to an AI service only as the result of an
  explicit action by the owner.
* **Budget guard.** Every AI call must pass a fail-closed guard that enforces owner-set limits. If a limit, price,
  confirmation or counter is missing, stale, unreadable or inconsistent, AI is switched off and the offline study
  features keep working. See [docs/FINANCIAL-SAFETY.md](docs/FINANCIAL-SAFETY.md).
* **Hostile input is expected.** PowerPoint files and study packs are treated as untrusted. Bypassing the documented
  protections (ZIP and XML limits, XSS and HTML sanitising, quote verification) is in scope.

## Out of scope

* Attacks that need control of the user's device, operating system, browser profile or an installed browser extension,
  including reading the IndexedDB data of a signed-in device profile. The app does not encrypt local data at rest.
* Security of third-party accounts and services (GitHub, Cloudflare, Google, Anthropic) and social engineering or
  phishing aimed at an owner. Report problems in those services to their vendors.
* Vulnerabilities in third-party dependencies that are not reachable through this project, or that affect only
  development tooling. Report them upstream.
* Deployments and forks that someone else operates, including their configuration, secrets, domains and modifications.
* The local development server (`pnpm dev`). Production headers are served by Cloudflare from `dist/_headers`.
* Incorrect, misleading or low-quality AI-generated study content. That is a quality bug: file a normal issue.
* Reports without a demonstrated impact, such as raw automated scanner output or missing best-practice headers on
  responses that carry no data.
* Denial of service by sheer request volume against a free-tier deployment, or by a file the user chose to import that
  stays within the documented limits.
