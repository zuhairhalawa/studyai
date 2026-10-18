/**
 * Security headers for the production site. One source of truth used by:
 *  - the Vite preview server (so end-to-end tests run under the real policy),
 *  - the build, which writes dist/_headers for Cloudflare static assets.
 */

/** The app makes no cross-origin requests: everything is 'self'. AI calls (Phase 3) will add one explicit connect-src origin. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // React/KaTeX set inline style *attributes*; scripts and stylesheets stay locked down.
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
};

/** Content of dist/_headers (Cloudflare static assets syntax). HSTS is added here only: it is meaningless over plain HTTP. */
export function renderHeadersFile(): string {
  const lines = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `  ${k}: ${v}`);
  return [
    '/*',
    ...lines(SECURITY_HEADERS),
    '  Strict-Transport-Security: max-age=31536000',
    '  Cache-Control: no-cache',
    '',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
}
