/**
 * Matching what a model quotes against what a slide says. Both are reduced to letters and digits so that markdown, LaTeX and
 * punctuation do not matter.
 */

/**
 * Letters and digits only, lower-cased: robust against markdown, LaTeX and punctuation differences.
 * LaTeX command names (\text, \left, \langle…) are dropped first, so a quote copied from the Markdown
 * export (which shows equations as LaTeX) matches the plain slide text.
 */
export function normForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The same with a subscript or superscript joined to what it belongs to: "M_1", "M_{1}" and "M1" are one thing, and so are
 * "n^{th}" and "nth". A model copying from the lecture text writes them either way.
 */
export function normJoined(s: string): string {
  return normForMatch(joinScripts(s));
}

/** The text with every subscript and superscript joined to its base ("M_{1}" becomes "M1"), for comparing words. */
export function joinScripts(s: string): string {
  return s.normalize('NFKC').replace(/\\[a-zA-Z]+/g, ' ').replace(/(?<=[\p{L}\p{N})])\s?[_^]\s*(?:\{\s*)*([\p{L}\p{N}]{1,4})(?:\s*\})*/gu, '$1');
}

/** Whether the words of `quote` (two or more) stand in `text` as written, in either normalisation. */
export function quoteIsVerbatim(quote: string, text: string): boolean {
  return [normForMatch, normJoined].some((norm) => {
    const q = norm(quote);
    return q.split(' ').length >= 2 && ` ${norm(text)} `.includes(` ${q} `);
  });
}
