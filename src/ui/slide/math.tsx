import katex from 'katex';

const cache = new Map<string, string>();

/**
 * Render LaTeX with KaTeX. `trust` is off (no \href/\url/\includegraphics) and
 * errors never throw: unparseable input is shown as plain text instead.
 */
export function renderMath(latex: string, display: boolean): string {
  const key = `${display ? 'D' : 'I'}:${latex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = katex.renderToString(latex, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml', maxSize: 20, maxExpand: 500 });
  } catch {
    html = '';
  }
  // KaTeX renders unparseable input as red source text; show the readable linear form instead.
  if (html.includes('katex-error')) html = '';
  if (cache.size > 2000) cache.clear();
  cache.set(key, html);
  return html;
}

export function Math({ latex, plain, display }: { latex: string; plain: string; display: boolean }) {
  const html = renderMath(latex, display);
  if (!html) return <span>{plain}</span>;
  if (display) return <span className="block overflow-x-auto text-center" dangerouslySetInnerHTML={{ __html: html }} />;
  // PowerPoint sets a space inside an equation as a space ("ℕ" + a no-break space + "and"): keep the one that stood between it and the words
  return (
    <>
      {/^\s/.test(plain) ? ' ' : null}
      <span dangerouslySetInnerHTML={{ __html: html }} />
      {/\s$/.test(plain) ? ' ' : null}
    </>
  );
}
