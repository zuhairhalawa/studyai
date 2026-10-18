/**
 * The private-site gate: while it is on, nothing of the site is served to anyone who is not signed in as the owner, only
 * this one small sign-in page. It is plain HTML with a single form (no script at all), so it needs no script policy, and its
 * only inline style is allowed by hash. It contains no user-supplied text: every message is one of the fixed strings below.
 */

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1c1b19;--muted:#5b5851;--card:#ffffff;--line:#cfcac0;--accent:#1f4fd8;--accent-fg:#ffffff;--bad:#a4151d}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#efede8;--muted:#a9a59b;--card:#201f1c;--line:#44413a;--accent:#8aa8ff;--accent-fg:#0d1530;--bad:#ff9aa0}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{margin:0 0 6px;font-size:1.4rem}
p{margin:0 0 18px;color:var(--muted)}
label{display:block;font-weight:600;margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{margin-top:14px;width:100%;padding:11px 14px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.err{margin:0 0 16px;color:var(--bad);font-weight:600}
`.trim();

export type GateMessage = 'wrong-key' | 'locked' | 'not-configured' | undefined;

const MESSAGES: Record<Exclude<GateMessage, undefined>, string> = {
  'wrong-key': 'That key was not accepted.',
  locked: 'Too many wrong keys from this network. Wait a while and try again.',
  'not-configured': 'This site is not set up yet.',
};

export function gatePage(message?: GateMessage): string {
  const error = message ? `<p class="err" role="alert">${MESSAGES[message]}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Private site</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Private site</h1>
<p>Enter your owner key to continue.</p>
${error}<form method="post" action="/api/auth/gate">
<label for="key">Owner key</label>
<input id="key" name="key" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" required>
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>
`;
}

let styleHash: Promise<string> | undefined;

/** CSP source expression for the one inline stylesheet, e.g. 'sha256-…'. */
export function gateStyleSource(): Promise<string> {
  styleHash ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(STYLE)).then((d) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`);
  return styleHash;
}

export async function gateHeaders(): Promise<Record<string, string>> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src ${await gateStyleSource()}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    // Not "no-referrer": with that policy a browser sends `Origin: null` on a form post, which the CSRF check rightly refuses.
    'referrer-policy': 'same-origin',
    'x-robots-tag': 'noindex, nofollow',
    'cross-origin-resource-policy': 'same-origin',
  };
}

/** Anything other than an explicit "off" keeps the site private (fail closed). */
export const siteIsPrivate = (value: string | undefined): boolean => value !== 'off';
