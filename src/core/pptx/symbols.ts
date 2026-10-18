/**
 * Decoding of text typed in the legacy "Symbol" font.
 *
 * PowerPoint stores Greek letters / maths operators typed through the Symbol
 * font either as private-use code points (U+F020–U+F0FF) or as plain ASCII
 * letters that only *look* like Greek when drawn with the Symbol typeface.
 * Reading them verbatim yields gibberish ("a" instead of "α"), so we map them
 * through the standard Adobe Symbol encoding.
 */

// Index = byte value (0x20..0xFF) of the Symbol encoding.
const SYMBOL: Record<number, string> = {
  0x20: ' ', 0x21: '!', 0x22: '∀', 0x23: '#', 0x24: '∃', 0x25: '%', 0x26: '&', 0x27: '∋', 0x28: '(', 0x29: ')', 0x2a: '∗', 0x2b: '+',
  0x2c: ',', 0x2d: '−', 0x2e: '.', 0x2f: '/', 0x30: '0', 0x31: '1', 0x32: '2', 0x33: '3', 0x34: '4', 0x35: '5', 0x36: '6', 0x37: '7',
  0x38: '8', 0x39: '9', 0x3a: ':', 0x3b: ';', 0x3c: '<', 0x3d: '=', 0x3e: '>', 0x3f: '?', 0x40: '≅',
  0x41: 'Α', 0x42: 'Β', 0x43: 'Χ', 0x44: 'Δ', 0x45: 'Ε', 0x46: 'Φ', 0x47: 'Γ', 0x48: 'Η', 0x49: 'Ι', 0x4a: 'ϑ', 0x4b: 'Κ', 0x4c: 'Λ',
  0x4d: 'Μ', 0x4e: 'Ν', 0x4f: 'Ο', 0x50: 'Π', 0x51: 'Θ', 0x52: 'Ρ', 0x53: 'Σ', 0x54: 'Τ', 0x55: 'Υ', 0x56: 'ς', 0x57: 'Ω', 0x58: 'Ξ',
  0x59: 'Ψ', 0x5a: 'Ζ', 0x5b: '[', 0x5c: '∴', 0x5d: ']', 0x5e: '⊥', 0x5f: '_', 0x60: '‾',
  0x61: 'α', 0x62: 'β', 0x63: 'χ', 0x64: 'δ', 0x65: 'ε', 0x66: 'φ', 0x67: 'γ', 0x68: 'η', 0x69: 'ι', 0x6a: 'ϕ', 0x6b: 'κ', 0x6c: 'λ',
  0x6d: 'μ', 0x6e: 'ν', 0x6f: 'ο', 0x70: 'π', 0x71: 'θ', 0x72: 'ρ', 0x73: 'σ', 0x74: 'τ', 0x75: 'υ', 0x76: 'ϖ', 0x77: 'ω', 0x78: 'ξ',
  0x79: 'ψ', 0x7a: 'ζ', 0x7b: '{', 0x7c: '|', 0x7d: '}', 0x7e: '∼',
  0xa0: '€', 0xa1: 'ϒ', 0xa2: '′', 0xa3: '≤', 0xa4: '⁄', 0xa5: '∞', 0xa6: 'ƒ', 0xa7: '♣', 0xa8: '♦', 0xa9: '♥', 0xaa: '♠', 0xab: '↔',
  0xac: '←', 0xad: '↑', 0xae: '→', 0xaf: '↓', 0xb0: '°', 0xb1: '±', 0xb2: '″', 0xb3: '≥', 0xb4: '×', 0xb5: '∝', 0xb6: '∂', 0xb7: '•',
  0xb8: '÷', 0xb9: '≠', 0xba: '≡', 0xbb: '≈', 0xbc: '…', 0xbd: '⏐', 0xbe: '⎯', 0xbf: '↵', 0xc0: 'ℵ', 0xc1: 'ℑ', 0xc2: 'ℜ', 0xc3: '℘',
  0xc4: '⊗', 0xc5: '⊕', 0xc6: '∅', 0xc7: '∩', 0xc8: '∪', 0xc9: '⊃', 0xca: '⊇', 0xcb: '⊄', 0xcc: '⊂', 0xcd: '⊆', 0xce: '∈', 0xcf: '∉',
  0xd0: '∠', 0xd1: '∇', 0xd2: '®', 0xd3: '©', 0xd4: '™', 0xd5: '∏', 0xd6: '√', 0xd7: '⋅', 0xd8: '¬', 0xd9: '∧', 0xda: '∨', 0xdb: '⇔',
  0xdc: '⇐', 0xdd: '⇑', 0xde: '⇒', 0xdf: '⇓', 0xe0: '◊', 0xe1: '〈', 0xe2: '®', 0xe3: '©', 0xe4: '™', 0xe5: '∑', 0xf1: '〉', 0xf2: '∫',
};

export function isSymbolFont(typeface: string | undefined): boolean {
  return !!typeface && /^symbol$/i.test(typeface.trim());
}

export function isDingbatFont(typeface: string | undefined): boolean {
  return !!typeface && /wingdings|webdings|zapf/i.test(typeface);
}

/** True for characters in the private-use block PowerPoint uses for symbol fonts. */
export function hasSymbolPua(text: string): boolean {
  return /[-]/.test(text);
}

/**
 * Decode text that belongs to a Symbol-font run. Returns the decoded text and
 * whether anything could not be mapped.
 */
export function decodeSymbolText(text: string, fontIsSymbol: boolean): { text: string; unmapped: boolean } {
  let out = '';
  let unmapped = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let byte: number | undefined;
    if (cp >= 0xf020 && cp <= 0xf0ff) byte = cp - 0xf000;
    else if (fontIsSymbol && cp >= 0x20 && cp <= 0xff) byte = cp;
    if (byte === undefined) {
      out += ch;
      continue;
    }
    const mapped = SYMBOL[byte];
    if (mapped === undefined) {
      unmapped = true;
      out += ch;
    } else {
      out += mapped;
    }
  }
  return { text: out, unmapped };
}
