/**
 * PowerPoint's equation editor (and Cambria Math text) stores variables as
 * Unicode "Mathematical Alphanumeric Symbols" (U+1D400–U+1D7FF), e.g. 𝐴 𝑤 𝐻𝐴𝐿𝑇.
 * They look right on screen but are different code points from A, w, H… which
 * breaks search ("ATM" would not match "𝐴TM") and confuses AI context.
 * These helpers fold them back to ordinary letters, optionally keeping the
 * style (blackboard bold, script, fraktur…) as LaTeX commands.
 */

const HAS_MATH_ALNUM = /[\u{1D400}-\u{1D7FF}ℎ]/u;
const MATH_ALNUM = /[\u{1D400}-\u{1D7FF}ℎ]/gu;

/** Fold math alphanumerics to plain letters/digits/Greek (for plain text and search). */
export function normalizeMathAlnum(s: string): string {
  if (!HAS_MATH_ALNUM.test(s)) return s;
  return s.replace(MATH_ALNUM, (ch) => ch.normalize('NFKC'));
}

type Style = 'mathbb' | 'mathcal' | 'mathfrak' | 'mathbf' | 'mathsf' | 'mathtt' | null;

function styleOf(cp: number): Style {
  if ((cp >= 0x1d538 && cp <= 0x1d56b) || (cp >= 0x1d7d8 && cp <= 0x1d7e1)) return 'mathbb';
  if (cp >= 0x1d49c && cp <= 0x1d503) return 'mathcal';
  if ((cp >= 0x1d504 && cp <= 0x1d537) || (cp >= 0x1d56c && cp <= 0x1d59f)) return 'mathfrak';
  if ((cp >= 0x1d400 && cp <= 0x1d433) || (cp >= 0x1d6a8 && cp <= 0x1d6e1) || (cp >= 0x1d7ce && cp <= 0x1d7d7)) return 'mathbf';
  if (cp >= 0x1d5a0 && cp <= 0x1d607) return 'mathsf';
  if ((cp >= 0x1d670 && cp <= 0x1d6a3) || (cp >= 0x1d7f6 && cp <= 0x1d7ff)) return 'mathtt';
  return null; // italic / bold-italic: ordinary math italic is the LaTeX default
}

const BB: Record<string, string> = { ℂ: 'C', ℍ: 'H', ℕ: 'N', ℙ: 'P', ℚ: 'Q', ℝ: 'R', ℤ: 'Z' };

/** Fold math alphanumerics for use inside LaTeX, keeping blackboard/script/fraktur/bold as commands. */
export function texMathAlnum(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (BB[ch]) {
      out += `\\mathbb{${BB[ch]}}`;
    } else if (ch === '〈' || ch === '⟨' || ch === '〈') {
      out += '\\langle '; // angle brackets are written with three different characters; KaTeX has no glyph for the CJK one
    } else if (ch === '〉' || ch === '⟩' || ch === '〉') {
      out += '\\rangle ';
    } else if ((cp >= 0x1d400 && cp <= 0x1d7ff) || cp === 0x210e) {
      const base = ch.normalize('NFKC');
      const style = styleOf(cp);
      out += style ? `\\${style}{${base}}` : base;
    } else {
      out += ch;
    }
  }
  return out;
}
