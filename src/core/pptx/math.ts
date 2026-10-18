import { attr, child, kids, ownText, type XNode } from './xml';
import { normalizeMathAlnum, texMathAlnum } from './unicode';

/**
 * Office Math (OMML) → LaTeX / linear text.
 *
 * PowerPoint stores equations typed in its equation editor as OMML
 * (`<a14:m><m:oMath>…`). We convert the common constructs (fractions, scripts,
 * radicals, n-ary operators, delimiters, functions, accents, matrices, equation
 * arrays). Anything unknown still contributes its text but marks the result
 * `partial` so the UI can tell the student to check the original slide.
 */

export interface MathResult {
  latex: string;
  plain: string;
  partial: boolean;
}

type Mode = 'tex' | 'lin';

const KNOWN_FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp',
  'lim', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'gcd', 'deg', 'arg', 'ker', 'Pr', 'mod',
]);

const NARY: Record<string, string> = {
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge',
};

const DELIM_TEX: Record<string, string> = {
  '': '.', '(': '(', ')': ')', '[': '[', ']': ']', '{': '\\{', '}': '\\}', '|': '|', '‖': '\\|',
  // Several code points are used for angle brackets depending on who typed them.
  '⟨': '\\langle', '⟩': '\\rangle', '〈': '\\langle', '〉': '\\rangle', '〈': '\\langle', '〉': '\\rangle',
  '⌈': '\\lceil', '⌉': '\\rceil', '⌊': '\\lfloor', '⌋': '\\rfloor',
};

const ACCENTS: Record<string, string> = {
  '̂': '\\hat', '^': '\\hat', '̃': '\\tilde', '~': '\\tilde', '̄': '\\bar', '¯': '\\bar', '̅': '\\overline',
  '̇': '\\dot', '̈': '\\ddot', '⃗': '\\vec', '→': '\\vec', '̌': '\\check', '̆': '\\breve', '´': '\\acute', '`': '\\grave',
};

function texEscape(text: string, keepAmpersand: boolean): string {
  let out = '';
  for (const ch of text) {
    switch (ch) {
      case '\\': out += '\\backslash '; break;
      case '{': out += '\\{'; break;
      case '}': out += '\\}'; break;
      case '#': out += '\\#'; break;
      case '$': out += '\\$'; break;
      case '%': out += '\\%'; break;
      case '_': out += '\\_'; break;
      case '&': out += keepAmpersand ? '&' : '\\&'; break;
      case '~': out += '\\sim '; break;
      case '^': out += '\\hat{}'; break;
      case ' ': case ' ': break; // math mode ignores spaces
      default: out += ch;
    }
  }
  return out;
}

/** If `piece` is exactly one script group like `_{abc}` or `^{abc}`, return its operator and content. */
function asScript(piece: string): { op: '_' | '^'; inner: string } | undefined {
  const p = piece.trim();
  if ((p[0] !== '_' && p[0] !== '^') || p[1] !== '{') return undefined;
  let depth = 0;
  for (let i = 1; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\') i += 1; // skip the escaped character (\{ or \})
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i === p.length - 1 ? { op: p[0], inner: p.slice(2, -1) } : undefined;
    }
  }
  return undefined;
}

/** `_{a} _{b}` is a LaTeX "double subscript" error; join such neighbours into `_{ab}`. */
function mergeAdjacentScripts(pieces: string[]): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.trim() === '') continue;
    const cur = asScript(piece);
    const prev = out.length > 0 ? asScript(out[out.length - 1]!) : undefined;
    if (cur && prev && cur.op === prev.op) out[out.length - 1] = `${cur.op}{${prev.inner}${cur.inner}}`;
    else out.push(piece);
  }
  return out;
}

class Converter {
  partial = false;

  constructor(private readonly mode: Mode) {}

  seq(nodes: XNode[], inEqArr = false): string {
    let pieces = nodes.map((n) => this.node(n, inEqArr));
    if (this.mode === 'tex') pieces = mergeAdjacentScripts(pieces);
    const joined = pieces.join(this.mode === 'tex' ? ' ' : '').replace(/\s+/g, ' ');
    // Whitespace is meaningless in LaTeX math, but in the linear form it separates the equation from surrounding words.
    return this.mode === 'tex' ? joined.trim() : joined;
  }

  arg(n: XNode | undefined, inEqArr = false): string {
    return n ? this.seq(n.children, inEqArr) : '';
  }

  private group(s: string): string {
    if (this.mode === 'tex') return `{${s}}`;
    const core = s.trim();
    return core.length > 1 ? `(${core})` : core;
  }

  private prop(n: XNode, pr: string, name: string): string | undefined {
    return attr(child(child(n, pr), name), 'm:val');
  }

  /** Plain text of a subtree (all m:t content). */
  static text(n: XNode | undefined): string {
    if (!n) return '';
    let s = '';
    for (const c of n.children) {
      if (c.name === 'm:t') s += ownText(c);
      else if (c.name !== 'm:rPr' && !c.name.endsWith('Pr')) s += Converter.text(c);
    }
    return s;
  }

  node(n: XNode, inEqArr = false): string {
    const t = this.mode === 'tex';
    switch (n.name) {
      case 'm:oMathPara': {
        const rows = kids(n, 'm:oMath').map((m) => this.arg(m));
        return t && rows.length > 1 ? `\\begin{gathered}${rows.join(' \\\\ ')}\\end{gathered}` : rows.join(t ? ' ' : '; ');
      }
      case 'm:oMath':
      case 'm:e':
      case 'm:num':
      case 'm:den':
      case 'm:sub':
      case 'm:sup':
      case 'm:deg':
      case 'm:lim':
      case 'm:fName':
      case 'm:box':
      case 'm:borderBox':
      case 'm:phant':
        return this.arg(n, inEqArr);
      case 'm:r': {
        const raw = Converter.text(n);
        // Sub/superscript applied as font formatting: <a:rPr baseline="-25000"/> inside the math run.
        const baseline = Number(attr(child(n, 'a:rPr'), 'baseline') ?? 0);
        const script = (s: string): string => {
          if (!baseline) return s;
          if (raw.trim() === '') return ''; // a blank sub/superscript carries no information
          const op = baseline < 0 ? '_' : '^';
          if (!t) {
            const core = normalizeMathAlnum(s).trim();
            return `${op}${[...core].length > 1 ? `{${core}}` : core}`;
          }
          return `${op}{${s}}`;
        };
        if (!t) return script(baseline ? raw : normalizeMathAlnum(raw)) || raw;
        const rpr = child(n, 'm:rPr');
        const norEl = child(rpr, 'm:nor');
        // CT_OnOff: an element with no val attribute means "true".
        const normal = !!norEl && (norEl.attrs['m:val'] === undefined || ['1', 'on', 'true'].includes(norEl.attrs['m:val']));
        const sty = attr(child(rpr, 'm:sty'), 'm:val');
        if (normal) return script(`\\text{${raw.replace(/[\\{}#$%&_^~]/g, (c) => `\\${c}`)}}`);
        const esc = texMathAlnum(texEscape(raw, inEqArr));
        // A run of only spaces (PowerPoint writes the gaps of "M accepts w" as non-breaking spaces between the runs) is a space in the
        // equation; LaTeX ignores spaces in math mode, so it has to be asked for.
        if (!esc) return /^[\s  -​]+$/u.test(raw) ? '\\ ' : '';
        if (sty === 'p') return script(`\\mathrm{${esc}}`);
        if (sty === 'b') return script(`\\mathbf{${esc}}`);
        if (sty === 'bi') return script(`\\boldsymbol{${esc}}`);
        return script(esc);
      }
      case 'm:f': {
        const num = this.arg(child(n, 'm:num'));
        const den = this.arg(child(n, 'm:den'));
        const type = this.prop(n, 'm:fPr', 'm:type');
        if (!t) return `${this.group(num)}/${this.group(den)}`;
        if (type === 'noBar') return `\\binom{${num}}{${den}}`;
        if (type === 'lin' || type === 'skw') return `{${num}}/{${den}}`;
        return `\\frac{${num}}{${den}}`;
      }
      case 'm:sSup':
        return `${this.group(this.arg(child(n, 'm:e')))}^${this.group(this.arg(child(n, 'm:sup')))}`;
      case 'm:sSub':
        return `${this.group(this.arg(child(n, 'm:e')))}_${this.group(this.arg(child(n, 'm:sub')))}`;
      case 'm:sSubSup':
        return `${this.group(this.arg(child(n, 'm:e')))}_${this.group(this.arg(child(n, 'm:sub')))}^${this.group(this.arg(child(n, 'm:sup')))}`;
      case 'm:sPre':
        return t
          ? `{}_${this.group(this.arg(child(n, 'm:sub')))}^${this.group(this.arg(child(n, 'm:sup')))}${this.group(this.arg(child(n, 'm:e')))}`
          : `_${this.group(this.arg(child(n, 'm:sub')))}^${this.group(this.arg(child(n, 'm:sup')))}${this.arg(child(n, 'm:e'))}`;
      case 'm:rad': {
        const e = this.arg(child(n, 'm:e'));
        const deg = this.arg(child(n, 'm:deg'));
        const hide = this.prop(n, 'm:radPr', 'm:degHide');
        const noDeg = hide === '1' || hide === 'on' || deg === '';
        if (t) return noDeg ? `\\sqrt{${e}}` : `\\sqrt[${deg}]{${e}}`;
        return noDeg ? `√(${e})` : `${deg}√(${e})`;
      }
      case 'm:nary': {
        const chr = this.prop(n, 'm:naryPr', 'm:chr') ?? '∫';
        const subHide = this.prop(n, 'm:naryPr', 'm:subHide');
        const supHide = this.prop(n, 'm:naryPr', 'm:supHide');
        const sub = subHide === '1' || subHide === 'on' ? '' : this.arg(child(n, 'm:sub'));
        const sup = supHide === '1' || supHide === 'on' ? '' : this.arg(child(n, 'm:sup'));
        const e = this.arg(child(n, 'm:e'));
        if (t) {
          const op = NARY[chr] ?? `\\mathop{${chr}}`;
          return `${op}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''} {${e}}`;
        }
        return `${chr}${sub ? `_${this.group(sub)}` : ''}${sup ? `^${this.group(sup)}` : ''} ${e}`;
      }
      case 'm:d': {
        const beg = this.prop(n, 'm:dPr', 'm:begChr') ?? '(';
        const end = this.prop(n, 'm:dPr', 'm:endChr') ?? ')';
        const sepRaw = this.prop(n, 'm:dPr', 'm:sepChr');
        const sep = sepRaw ?? '|';
        const parts = kids(n, 'm:e').map((e) => this.arg(e));
        if (t) {
          const l = DELIM_TEX[beg] ?? beg;
          const r = DELIM_TEX[end] ?? end;
          const s = DELIM_TEX[sep] ?? sep;
          return `\\left${l} ${parts.join(` ${s === '|' ? '\\mid' : s} `)} \\right${r}`;
        }
        return `${beg}${parts.join(sep === '|' ? ' | ' : `${sep} `)}${end}`;
      }
      case 'm:func': {
        const nameNode = child(n, 'm:fName');
        const name = Converter.text(nameNode).trim();
        const e = this.arg(child(n, 'm:e'));
        if (!t) return `${name} ${e}`;
        const fn = /^[A-Za-z]+$/.test(name) ? (KNOWN_FUNCTIONS.has(name) ? `\\${name}` : `\\operatorname{${name}}`) : this.arg(nameNode);
        return `${fn} {${e}}`;
      }
      case 'm:limLow':
        return t ? `\\mathop{${this.arg(child(n, 'm:e'))}}\\limits_{${this.arg(child(n, 'm:lim'))}}` : `${this.arg(child(n, 'm:e'))}_${this.group(this.arg(child(n, 'm:lim')))}`;
      case 'm:limUpp':
        return t ? `\\mathop{${this.arg(child(n, 'm:e'))}}\\limits^{${this.arg(child(n, 'm:lim'))}}` : `${this.arg(child(n, 'm:e'))}^${this.group(this.arg(child(n, 'm:lim')))}`;
      case 'm:acc': {
        const e = this.arg(child(n, 'm:e'));
        if (!t) return e;
        const chr = this.prop(n, 'm:accPr', 'm:chr') ?? '̂';
        let cmd = ACCENTS[chr];
        if (!cmd) {
          this.partial = true;
          cmd = '\\hat';
        }
        if (cmd === '\\hat' && [...e].length > 1) cmd = '\\widehat';
        if (cmd === '\\tilde' && [...e].length > 1) cmd = '\\widetilde';
        return `${cmd}{${e}}`;
      }
      case 'm:bar': {
        const e = this.arg(child(n, 'm:e'));
        if (!t) return e;
        return this.prop(n, 'm:barPr', 'm:pos') === 'bot' ? `\\underline{${e}}` : `\\overline{${e}}`;
      }
      case 'm:groupChr': {
        const e = this.arg(child(n, 'm:e'));
        if (!t) return e;
        const pos = this.prop(n, 'm:groupChrPr', 'm:pos') ?? 'bot';
        const chr = this.prop(n, 'm:groupChrPr', 'm:chr') ?? '⏟';
        if (chr === '⏟' || chr === '⏞') return chr === '⏞' || pos === 'top' ? `\\overbrace{${e}}` : `\\underbrace{${e}}`;
        return pos === 'top' ? `\\overset{${chr}}{${e}}` : `\\underset{${chr}}{${e}}`;
      }
      case 'm:m': {
        const rows = kids(n, 'm:mr').map((r) => kids(r, 'm:e').map((e) => this.arg(e)));
        if (t) return `\\begin{matrix} ${rows.map((r) => r.join(' & ')).join(' \\\\ ')} \\end{matrix}`;
        return `[${rows.map((r) => r.join(', ')).join('; ')}]`;
      }
      case 'm:eqArr': {
        const rows = kids(n, 'm:e').map((e) => this.arg(e, true));
        if (t) return `\\begin{aligned} ${rows.join(' \\\\ ')} \\end{aligned}`;
        return rows.join('; ').replace(/&/g, '');
      }
      case 'm:t':
        return kids(n, '#text').map((x) => x.text).join('');
      default:
        if (n.name.endsWith('Pr') || n.name === 'm:ctrlPr') return '';
        if (n.name === '#text') return '';
        this.partial = true;
        return this.seq(n.children, inEqArr);
    }
  }
}

/** Convert an `m:oMath`, `m:oMathPara` or `a14:m` element. */
export function ommlToLatex(root: XNode): MathResult {
  const body = root.name === 'a14:m' ? (child(root, 'm:oMathPara') ?? child(root, 'm:oMath') ?? root) : root;
  const tex = new Converter('tex');
  const lin = new Converter('lin');
  // a space asked for at the very start or end of an equation is not a space between things
  const latex = tex.node(body).replace(/^\s*(?:\\ \s*)+/, '').replace(/(?:\s*(?<!\\)\\ ?)+\s*$/, '').trim();
  // Keep one leading/trailing space if present: "M" + " halts" must not fuse into "Mhalts".
  // "n" followed by the function "log n" is "n log n", not "nlog n": a function name is set off from what precedes it.
  const plain = lin
    .node(body)
    .replace(/([\p{L}\p{N})\]])((?:sin|cos|tan|cot|sec|csc|log|ln|lg|exp|lim|max|min|det|gcd|arg|mod) )/gu, '$1 $2')
    .replace(/\s+/g, ' ');
  return { latex, plain, partial: tex.partial || lin.partial };
}

export function isDisplayMath(root: XNode): boolean {
  return root.name === 'm:oMathPara' || (root.name === 'a14:m' && !!child(root, 'm:oMathPara'));
}
