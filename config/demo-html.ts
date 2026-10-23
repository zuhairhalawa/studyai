import { META_CSP } from './headers.ts';

/**
 * The static demo is served by GitHub Pages, which cannot send response headers, so the policy travels inside the page.
 * It must come before every script and stylesheet; the charset declaration stays first, as browsers require. Fails the build
 * when a marker is missing, so a changed index.html can never ship a demo without a policy.
 */
const CHARSET = '<meta charset="UTF-8" />';
const TITLE = '<title>StudyAI</title>';

export function injectDemoHead(html: string): string {
  for (const marker of [CHARSET, TITLE]) if (!html.includes(marker)) throw new Error(`index.html must contain ${marker} so the demo can adapt it.`);
  const tags = [`<meta http-equiv="Content-Security-Policy" content="${META_CSP}" />`, '<meta name="referrer" content="no-referrer" />'];
  const described = html.replace(TITLE, () => '<title>StudyAI demo</title>\n    <meta name="description" content="Try StudyAI in your browser with invented sample lectures: slides beside extracted text, search, flashcards and a practice exam. Nothing is uploaded and there is no AI." />');
  return described.replace(CHARSET, () => [CHARSET, ...tags].join('\n    '));
}

/** The sub-path the demo is served from (GitHub Pages: /<repository>/). Always starts and ends with a slash. */
export function demoBase(value = process.env['STUDYAI_DEMO_BASE']): string {
  const base = value && value.length > 0 ? value : '/studyai/';
  const dots = base.split('/').some((part) => part === '.' || part === '..');
  if (dots || !/^\/([A-Za-z0-9._~-]+\/)*$/.test(base)) throw new Error(`STUDYAI_DEMO_BASE must look like /name/ (got "${base}").`);
  return base;
}
