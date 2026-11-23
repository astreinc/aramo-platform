import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream, type PDFContext, type PDFFont, type PDFObject, type PDFPage } from 'pdf-lib';

import { coverPagesWithBoxes, dropUnreachable, type PdfCoverBox } from './pdf-form-import.js';
import { extractTextLayer, type TextLayerPage } from './text-layer.js';

// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) A-6,
// ruling C-8 (amends FIELD-PARITY-1 R-5) — a text tag is REMOVED from the page, not only
// painted over: the glyphs of `{{…}}` are taken out of the page content stream, so the tag
// cannot be found by searching, copying or reading the text layer of the stored source, the
// executed PDF or the signer's view. The white cover (coverPdfBoxes) is still painted on top as
// a fallback.
//
// How (pdf-lib, no rendering, nothing executed):
//   1. The page's content streams are read operator by operator, following the graphics state
//      (q / Q / cm) and the text state (BT / ET, Tm, Td, TD, T*, Tf, Tc, Tw, Tz, TL, Ts), so
//      every shown glyph has its character (ToUnicode, else the font encoding) and its centre on
//      the page (the font's widths: /Widths, a Type0 font's /W, or the standard-14 metrics).
//   2. For each tag, the occurrence of its text (whitespace ignored) whose glyphs fall inside
//      the tag's box is chosen; those glyphs, and the spaces between them, are removed. A text
//      operator that showed them is rewritten as a TJ that keeps every other glyph and moves
//      past each removed one by exactly its width, so nothing else on the page moves. Every
//      other byte of the content is kept as it was.
//   3. Proof: the page's text is read again with the shared extractor (text-layer.ts). The
//      page is kept only if its text is exactly the old text without the removed tags
//      (whitespace ignored); otherwise the page's content is put back unchanged and its tags
//      are reported as not removed. A tag whose text is not found (drawn inside a form XObject,
//      a Type3 font, vertical text, an unreadable stream …) is reported too.
//   4. Objects no longer reachable (the old content streams, which still hold the tag text)
//      are dropped before saving.

/** A text tag to remove: its cover box (field frame) and its text, braces included. */
export interface PdfTextTagBox extends PdfCoverBox {
  readonly text: string;
}

export interface PdfTextTagRemoval {
  readonly bytes: Uint8Array;
  /** The indexes (into the input) of the tags whose text could not be removed (they are only covered). */
  readonly not_removed: number[];
}

const N = (s: string): PDFName => PDFName.of(s);
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 × m2 (PDF row-vector convention). */
function mul(m1: Matrix, m2: Matrix): Matrix {
  const [a, b, c, d, e, f] = m1;
  const [A, B, C, D, E, F] = m2;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// ── Content-stream tokens ─────────────────────────────────────────────────────

type Tok =
  | { readonly k: 'num'; readonly v: number; readonly s: number; readonly e: number }
  | { readonly k: 'str'; readonly v: Uint8Array; readonly s: number; readonly e: number }
  | { readonly k: 'name'; readonly v: string; readonly s: number; readonly e: number }
  | { readonly k: 'open' | 'close' | 'dopen' | 'dclose'; readonly s: number; readonly e: number }
  | { readonly k: 'op'; readonly v: string; readonly s: number; readonly e: number };

class Unsupported extends Error {}

const isWs = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number): boolean => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

function tokenize(src: Uint8Array): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] ?? 0;
    if (isWs(c)) {
      i += 1;
      continue;
    }
    if (c === 37) {
      while (i < n && src[i] !== 10 && src[i] !== 13) i += 1;
      continue;
    }
    const s = i;
    if (c === 40) {
      const bytes: number[] = [];
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        const ch = src[i] ?? 0;
        if (ch === 92) {
          const nx = src[i + 1] ?? 0;
          const esc: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
          if (esc[nx] !== undefined) {
            bytes.push(esc[nx] ?? 0);
            i += 2;
          } else if (nx >= 48 && nx <= 55) {
            let j = i + 1;
            let v = 0;
            while (j < n && j < i + 4 && (src[j] ?? 0) >= 48 && (src[j] ?? 0) <= 55) {
              v = v * 8 + ((src[j] ?? 0) - 48);
              j += 1;
            }
            bytes.push(v & 0xff);
            i = j;
          } else if (nx === 13 || nx === 10) {
            i += nx === 13 && src[i + 2] === 10 ? 3 : 2;
          } else {
            i += 1;
          }
          continue;
        }
        if (ch === 40) depth += 1;
        if (ch === 41) depth -= 1;
        if (depth > 0) bytes.push(ch);
        i += 1;
      }
      if (depth !== 0) throw new Unsupported('unterminated string');
      out.push({ k: 'str', v: Uint8Array.from(bytes), s, e: i });
      continue;
    }
    if (c === 60 && src[i + 1] === 60) {
      out.push({ k: 'dopen', s, e: i + 2 });
      i += 2;
      continue;
    }
    if (c === 62 && src[i + 1] === 62) {
      out.push({ k: 'dclose', s, e: i + 2 });
      i += 2;
      continue;
    }
    if (c === 60) {
      let hex = '';
      i += 1;
      while (i < n && src[i] !== 62) {
        const ch = src[i] ?? 0;
        if (!isWs(ch)) hex += String.fromCharCode(ch);
        i += 1;
      }
      if (i >= n) throw new Unsupported('unterminated hex string');
      i += 1;
      if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Unsupported('bad hex string');
      if (hex.length % 2 === 1) hex += '0';
      const v = new Uint8Array(hex.length / 2);
      for (let k = 0; k < v.length; k += 1) v[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16);
      out.push({ k: 'str', v, s, e: i });
      continue;
    }
    if (c === 91 || c === 93) {
      out.push({ k: c === 91 ? 'open' : 'close', s, e: i + 1 });
      i += 1;
      continue;
    }
    if (c === 123 || c === 125 || c === 41 || c === 62) throw new Unsupported('unexpected delimiter');
    i += 1;
    while (i < n && !isWs(src[i] ?? 0) && !isDelim(src[i] ?? 0)) i += 1;
    const word = Buffer.from(src.subarray(s, i)).toString('latin1');
    if (c === 47) {
      out.push({ k: 'name', v: word.slice(1), s, e: i });
    } else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      out.push({ k: 'num', v: Number(word), s, e: i });
    } else if (word === 'BI') {
      // An inline image: its data is binary; skip to the EI that ends it.
      const text = Buffer.from(src).toString('latin1');
      const id = text.indexOf('ID', i);
      if (id < 0) throw new Unsupported('inline image without ID');
      const end = /\sEI(?=\s|$)/g;
      end.lastIndex = id + 3;
      const m = end.exec(text);
      if (m === null) throw new Unsupported('inline image without EI');
      i = m.index + m[0].length;
      out.push({ k: 'op', v: 'BI…EI', s, e: i });
    } else {
      out.push({ k: 'op', v: word, s, e: i });
    }
  }
  return out;
}

// ── Fonts ─────────────────────────────────────────────────────────────────────

interface FontInfo {
  /** Bytes per character code. */
  readonly bytes: 1 | 2;
  width(code: number): number;
  char(code: number): string;
}

const UNKNOWN_FONT: FontInfo = { bytes: 1, width: () => NaN, char: () => '\uFFFD' };

const STANDARD_FONT_NAMES = new Set<string>(Object.values(StandardFonts));

// Glyph names a tag's characters use (letters and the standard ASCII punctuation names).
const GLYPH_CHARS: Readonly<Record<string, string>> = {
  space: ' ', braceleft: '{', braceright: '}', colon: ':', equal: '=', underscore: '_', at: '@', period: '.', comma: ',', hyphen: '-',
  minus: '-', plus: '+', slash: '/', parenleft: '(', parenright: ')', exclam: '!', question: '?', quotesingle: "'", quotedbl: '"',
  numbersign: '#', dollar: '$', percent: '%', ampersand: '&', asterisk: '*', semicolon: ';', less: '<', greater: '>',
  bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', grave: '`', bar: '|', asciitilde: '~',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

function glyphChar(name: string): string | null {
  if (/^[A-Za-z]$/.test(name)) return name;
  const g = GLYPH_CHARS[name];
  if (g !== undefined) return g;
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  return uni === null ? null : String.fromCharCode(parseInt(uni[1] ?? '0', 16));
}

function lookup(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}
const dictOf = (ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined => {
  const v = lookup(ctx, o);
  return v instanceof PDFDict ? v : undefined;
};
const arrayOf = (ctx: PDFContext, o: PDFObject | undefined): PDFArray | undefined => {
  const v = lookup(ctx, o);
  return v instanceof PDFArray ? v : undefined;
};
const numOf = (ctx: PDFContext, o: PDFObject | undefined): number | null => {
  const v = lookup(ctx, o);
  return v instanceof PDFNumber ? v.asNumber() : null;
};
const nameOf = (ctx: PDFContext, o: PDFObject | undefined): string | null => {
  const v = lookup(ctx, o);
  return v instanceof PDFName ? v.decodeText() : null;
};

function streamBytes(ctx: PDFContext, o: PDFObject | undefined): Uint8Array {
  const v = lookup(ctx, o);
  if (!(v instanceof PDFRawStream)) throw new Unsupported('not a raw stream');
  return decodePDFRawStream(v).decode();
}

/** A ToUnicode CMap's bfchar / bfrange entries. */
function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const utf16 = (hex: string): string => {
    let s = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16));
    return s;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1] ?? '0', 16), utf16(m[2] ?? ''));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1] ?? '0', 16);
      const hi = parseInt(m[2] ?? '0', 16);
      if (hi - lo > 0xffff) continue;
      const dst = m[3] ?? '';
      if (dst.startsWith('[')) {
        const items = [...dst.matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1] ?? '');
        for (let c = lo; c <= hi; c += 1) {
          const it = items[c - lo];
          if (it !== undefined) map.set(c, utf16(it));
        }
      } else {
        const base = dst.slice(1, -1);
        for (let c = lo; c <= hi; c += 1) {
          const last = parseInt(base.slice(-4) || '0', 16) + (c - lo);
          map.set(c, utf16(base.slice(0, -4) + last.toString(16).padStart(4, '0')));
        }
      }
    }
  }
  return map;
}

function fontInfo(ctx: PDFContext, font: PDFDict, standard: (name: string) => PDFFont): FontInfo {
  const subtype = nameOf(ctx, font.get(N('Subtype')));
  let toUnicode: Map<number, string> | null = null;
  if (font.get(N('ToUnicode')) !== undefined) {
    try {
      toUnicode = parseToUnicode(Buffer.from(streamBytes(ctx, font.get(N('ToUnicode')))).toString('latin1'));
    } catch {
      toUnicode = null;
    }
  }
  if (subtype === 'Type0') {
    if (nameOf(ctx, font.get(N('Encoding'))) !== 'Identity-H') throw new Unsupported('Type0 font not Identity-H');
    const desc = dictOf(ctx, arrayOf(ctx, font.get(N('DescendantFonts')))?.get(0));
    if (desc === undefined) throw new Unsupported('Type0 font without a descendant');
    const dw = numOf(ctx, desc.get(N('DW'))) ?? 1000;
    const widths = new Map<number, number>();
    const w = arrayOf(ctx, desc.get(N('W')));
    for (let i = 0; w !== undefined && i < w.size(); ) {
      const first = numOf(ctx, w.get(i));
      const next = lookup(ctx, w.get(i + 1));
      if (first === null) throw new Unsupported('bad /W');
      if (next instanceof PDFArray) {
        for (let k = 0; k < next.size(); k += 1) widths.set(first + k, numOf(ctx, next.get(k)) ?? dw);
        i += 2;
      } else {
        const last = numOf(ctx, next);
        const value = numOf(ctx, w.get(i + 2));
        if (last === null || value === null || last - first > 0xffff) throw new Unsupported('bad /W range');
        for (let c = first; c <= last; c += 1) widths.set(c, value);
        i += 3;
      }
    }
    return { bytes: 2, width: (c) => widths.get(c) ?? dw, char: (c) => toUnicode?.get(c) ?? '\uFFFD' };
  }
  if (subtype !== 'Type1' && subtype !== 'TrueType' && subtype !== 'MMType1') throw new Unsupported(`font ${subtype ?? '?'}`);
  // The character of a code: ToUnicode, else the encoding's /Differences, else ASCII / Latin-1.
  const differences = new Map<number, string>();
  const enc = lookup(ctx, font.get(N('Encoding')));
  if (enc instanceof PDFDict) {
    const diffs = arrayOf(ctx, enc.get(N('Differences')));
    let code = 0;
    for (let i = 0; diffs !== undefined && i < diffs.size(); i += 1) {
      const it = lookup(ctx, diffs.get(i));
      if (it instanceof PDFNumber) code = it.asNumber();
      else if (it instanceof PDFName) {
        const ch = glyphChar(it.decodeText());
        if (ch !== null) differences.set(code, ch);
        else differences.set(code, '\uFFFD');
        code += 1;
      }
    }
  }
  const char = (c: number): string => {
    const u = toUnicode?.get(c) ?? differences.get(c);
    if (u !== undefined) return u;
    return (c >= 32 && c <= 126) || c >= 160 ? String.fromCharCode(c) : '\uFFFD';
  };
  const first = numOf(ctx, font.get(N('FirstChar')));
  const widthsArr = arrayOf(ctx, font.get(N('Widths')));
  if (first !== null && widthsArr !== undefined) {
    const missing = numOf(ctx, dictOf(ctx, font.get(N('FontDescriptor')))?.get(N('MissingWidth'))) ?? 0;
    return { bytes: 1, width: (c) => numOf(ctx, widthsArr.get(c - first)) ?? missing, char };
  }
  const base = nameOf(ctx, font.get(N('BaseFont')));
  if (base === null || !STANDARD_FONT_NAMES.has(base)) throw new Unsupported('font without widths');
  const std = standard(base);
  return {
    bytes: 1,
    width: (c) => {
      try {
        return std.widthOfTextAtSize(String.fromCharCode(c), 1000);
      } catch {
        return NaN;
      }
    },
    char,
  };
}

// ── Reading a page ────────────────────────────────────────────────────────────

/** One glyph a text operator shows. */
interface Glyph {
  /** Index of the operator token in the page's tokens. */
  readonly op: number;
  /** Index of the string operand (in the TJ array, 0 for Tj / ' / "). */
  readonly part: number;
  /** Byte offset of the code in that string. */
  readonly at: number;
  readonly char: string;
  readonly cx: number;
  readonly cy: number;
}

/** A text operator that showed at least one glyph, with what is needed to rewrite it. */
interface ShowOp {
  readonly op: number;
  readonly name: string;
  /** Token index of the first operand. */
  readonly first: number;
  /** The array (TJ) or single string (Tj, ', ") operands, in order: a string or a number. */
  readonly parts: ReadonlyArray<Uint8Array | number>;
  readonly font: FontInfo;
  readonly fontSize: number;
  readonly charSpacing: number;
  readonly wordSpacing: number;
  /** For ": the operands aw and ac. */
  readonly aw?: number;
  readonly ac?: number;
}

interface PageRead {
  readonly src: Uint8Array;
  readonly toks: Tok[];
  readonly glyphs: Glyph[];
  readonly shows: Map<number, ShowOp>;
}

interface TextState {
  ctm: Matrix;
  font: FontInfo | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  ts: number;
}

function readPage(ctx: PDFContext, page: PDFPage, standard: (name: string) => PDFFont): PageRead {
  const contents = lookup(ctx, page.node.get(N('Contents')));
  const parts: Uint8Array[] = [];
  if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i += 1) parts.push(streamBytes(ctx, contents.get(i)));
  else if (contents !== undefined) parts.push(streamBytes(ctx, page.node.get(N('Contents'))));
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const src = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    src.set(p, off);
    src[off + p.length] = 10;
    off += p.length + 1;
  }
  const toks = tokenize(src);
  const fonts = dictOf(ctx, page.node.Resources()?.get(N('Font')));
  const fontCache = new Map<string, FontInfo>();
  // A font this reader cannot measure (a Type3 font, vertical text, no widths …): its glyphs have
  // no character and no width, so the position becomes unknown (NaN) until the next line or text
  // matrix; no tag can be found in or after it on that line, and it is never rewritten.
  const fontNamed = (name: string): FontInfo => {
    const hit = fontCache.get(name);
    if (hit !== undefined) return hit;
    const dict = dictOf(ctx, fonts?.get(N(name)));
    let info: FontInfo = UNKNOWN_FONT;
    if (dict !== undefined) {
      try {
        info = fontInfo(ctx, dict, standard);
      } catch {
        info = UNKNOWN_FONT;
      }
    }
    fontCache.set(name, info);
    return info;
  };

  const glyphs: Glyph[] = [];
  const shows = new Map<number, ShowOp>();
  const stack: TextState[] = [];
  let st: TextState = { ctm: [...IDENTITY], font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0 };
  let tm: Matrix = [...IDENTITY];
  let tlm: Matrix = [...IDENTITY];
  let operands: Array<{ tok: number; v: Tok | Array<Tok> }> = [];
  let arr: Tok[] | null = null;
  let arrStart = -1;
  let dictDepth = 0;
  const nums = (): number[] => operands.map((o) => (!Array.isArray(o.v) && o.v.k === 'num' ? o.v.v : NaN));
  const nextLine = (): void => {
    tlm = mul([1, 0, 0, 1, 0, -st.tl], tlm);
    tm = [...tlm];
  };
  const show = (opIndex: number, part: number, bytes: Uint8Array): void => {
    const font = st.font;
    if (font === null) throw new Unsupported('text without a font');
    const step = font.bytes;
    for (let at = 0; at + step <= bytes.length; at += step) {
      const code = step === 1 ? (bytes[at] ?? 0) : ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
      const w = font.width(code);
      const trm = mul(tm, st.ctm);
      const [cx, cy] = apply(trm, (w / 2000) * st.size * st.th, 0.35 * st.size + st.ts);
      glyphs.push({ op: opIndex, part, at, char: font.char(code), cx, cy });
      const tx = ((w / 1000) * st.size + st.tc + (step === 1 && code === 32 ? st.tw : 0)) * st.th;
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    }
  };

  for (let t = 0; t < toks.length; t += 1) {
    const tok = toks[t] as Tok;
    if (tok.k === 'dopen') dictDepth += 1;
    if (tok.k === 'dclose') dictDepth -= 1;
    if (dictDepth > 0 || tok.k === 'dopen' || tok.k === 'dclose') {
      if (tok.k === 'dopen' && dictDepth === 1 && arr === null) operands.push({ tok: t, v: tok });
      continue;
    }
    if (tok.k === 'open') {
      if (arr !== null) throw new Unsupported('nested array');
      arr = [];
      arrStart = t;
      continue;
    }
    if (tok.k === 'close') {
      if (arr === null) throw new Unsupported('unbalanced array');
      operands.push({ tok: arrStart, v: arr });
      arr = null;
      continue;
    }
    if (arr !== null) {
      arr.push(tok);
      continue;
    }
    if (tok.k !== 'op') {
      operands.push({ tok: t, v: tok });
      continue;
    }
    const n = nums();
    const first = operands[0]?.tok ?? t;
    switch (tok.v) {
      case 'q':
        stack.push({ ...st, ctm: [...st.ctm] });
        break;
      case 'Q':
        st = stack.pop() ?? st;
        break;
      case 'cm':
        if (n.length === 6 && n.every(Number.isFinite)) st.ctm = mul(n as Matrix, st.ctm);
        break;
      case 'BT':
        tm = [...IDENTITY];
        tlm = [...IDENTITY];
        break;
      case 'Tc':
        st.tc = n[0] ?? 0;
        break;
      case 'Tw':
        st.tw = n[0] ?? 0;
        break;
      case 'Tz':
        st.th = (n[0] ?? 100) / 100;
        break;
      case 'TL':
        st.tl = n[0] ?? 0;
        break;
      case 'Ts':
        st.ts = n[0] ?? 0;
        break;
      case 'Tf': {
        const name = operands[0]?.v;
        if (name === undefined || Array.isArray(name) || name.k !== 'name') throw new Unsupported('bad Tf');
        st.font = fontNamed(name.v);
        st.size = n[1] ?? 0;
        break;
      }
      case 'Td':
      case 'TD':
        if (tok.v === 'TD') st.tl = -(n[1] ?? 0);
        tlm = mul([1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0], tlm);
        tm = [...tlm];
        break;
      case 'Tm':
        if (n.length === 6 && n.every(Number.isFinite)) {
          tlm = n as Matrix;
          tm = [...tlm];
        }
        break;
      case 'T*':
        nextLine();
        break;
      case 'Tj':
      case "'":
      case '"': {
        const s = operands[operands.length - 1]?.v;
        if (s === undefined || Array.isArray(s) || s.k !== 'str') throw new Unsupported(`bad ${tok.v}`);
        let aw: number | undefined;
        let ac: number | undefined;
        if (tok.v === '"') {
          aw = n[0] ?? 0;
          ac = n[1] ?? 0;
          st.tw = aw;
          st.tc = ac;
        }
        if (tok.v !== 'Tj') nextLine();
        shows.set(t, { op: t, name: tok.v, first, parts: [s.v], font: st.font as FontInfo, fontSize: st.size, charSpacing: st.tc, wordSpacing: st.tw, ...(aw !== undefined ? { aw, ac } : {}) });
        show(t, 0, s.v);
        break;
      }
      case 'TJ': {
        const a = operands[operands.length - 1]?.v;
        if (a === undefined || !Array.isArray(a)) throw new Unsupported('bad TJ');
        const partsOf: Array<Uint8Array | number> = [];
        for (const el of a) {
          if (el.k === 'str') partsOf.push(el.v);
          else if (el.k === 'num') partsOf.push(el.v);
          else throw new Unsupported('bad TJ element');
        }
        shows.set(t, { op: t, name: 'TJ', first, parts: partsOf, font: st.font as FontInfo, fontSize: st.size, charSpacing: st.tc, wordSpacing: st.tw });
        partsOf.forEach((p, i) => {
          if (typeof p === 'number') tm = mul([1, 0, 0, 1, (-p / 1000) * st.size * st.th, 0], tm);
          else show(t, i, p);
        });
        break;
      }
      default:
        break;
    }
    operands = [];
  }
  if (arr !== null || dictDepth !== 0) throw new Unsupported('unbalanced content');
  return { src, toks, glyphs, shows };
}

// ── Matching and rewriting ───────────────────────────────────────────────────

const strip = (s: string): string => s.replace(/\s+/g, '');

/** The glyph indexes (first..last, spaces between included) of the tag's text inside its box, or null. */
function locateTag(glyphs: readonly Glyph[], taken: ReadonlySet<number>, tag: PdfTextTagBox): number[] | null {
  const want = strip(tag.text);
  if (want.length === 0) return null;
  // The page's characters without whitespace, each mapped to its glyph.
  const chars: string[] = [];
  const index: number[] = [];
  glyphs.forEach((g, i) => {
    for (const ch of g.char) {
      if (/\s/.test(ch)) continue;
      chars.push(ch);
      index.push(i);
    }
  });
  const text = chars.join('');
  const tol = Math.max(1, tag.height * 0.25);
  const inside = (g: Glyph): boolean => g.cx >= tag.x - tol && g.cx <= tag.x + tag.width + tol && g.cy >= tag.y - tol && g.cy <= tag.y + tag.height + tol;
  let best: { first: number; last: number; hits: number } | null = null;
  for (let at = text.indexOf(want); at >= 0; at = text.indexOf(want, at + 1)) {
    const ids = index.slice(at, at + want.length);
    const firstG = ids[0] ?? 0;
    const lastG = ids[ids.length - 1] ?? 0;
    let hits = 0;
    for (const id of new Set(ids)) if (inside(glyphs[id] as Glyph)) hits += 1;
    if (hits * 2 < new Set(ids).size) continue;
    if (best === null || hits > best.hits) best = { first: firstG, last: lastG, hits };
  }
  if (best === null) return null;
  const out: number[] = [];
  for (let i = best.first; i <= best.last; i += 1) {
    if (taken.has(i)) return null;
    out.push(i);
  }
  return out;
}

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) throw new Unsupported('a move that cannot be measured');
  const r = Math.round(n * 10_000) / 10_000;
  return Object.is(r, -0) ? '0' : String(r);
};
const hex = (b: Uint8Array): string => `<${Buffer.from(b).toString('hex')}>`;

/** The TJ text that shows `op` without the removed glyphs (their widths kept as moves). */
function rewriteShow(op: ShowOp, removed: ReadonlySet<string>): string {
  const step = op.font.bytes;
  if (op.fontSize === 0) throw new Unsupported('zero font size');
  // Strings and moves, in order; consecutive moves are summed into one number (the same move
  // for any reader, and pdf.js adds the character spacing once per number in a TJ).
  const out: Array<string | number> = [];
  const move = (n: number): void => {
    const last = out[out.length - 1];
    if (typeof last === 'number') out[out.length - 1] = last + n;
    else out.push(n);
  };
  op.parts.forEach((p, part) => {
    if (typeof p === 'number') {
      move(p);
      return;
    }
    let run: number[] = [];
    const flush = (): void => {
      if (run.length > 0) out.push(hex(Uint8Array.from(run)));
      run = [];
    };
    for (let at = 0; at + step <= p.length; at += step) {
      const bytes = Array.from(p.subarray(at, at + step));
      if (!removed.has(`${op.op}:${part}:${at}`)) {
        run.push(...bytes);
        continue;
      }
      flush();
      const code = step === 1 ? (bytes[0] ?? 0) : ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
      const spacing = op.charSpacing + (step === 1 && code === 32 ? op.wordSpacing : 0);
      move(-(op.font.width(code) + (spacing * 1000) / op.fontSize));
    }
    flush();
  });
  const list = (es: ReadonlyArray<string | number>): string => `[${es.map((e) => (typeof e === 'number' ? fmt(e) : e)).join(' ')}] TJ`;
  // A TJ that starts with a move: pdf.js (the signer's text layer) adds the character spacing to
  // such a move, a renderer does not. With character spacing on, the leading move is made with
  // it set to 0 (a TJ number never uses it, so the page is drawn the same), then it is restored.
  const lead = out[0];
  const tj =
    typeof lead === 'number' && op.charSpacing !== 0
      ? `0 Tc ${list([lead])} ${fmt(op.charSpacing)} Tc${out.length > 1 ? ` ${list(out.slice(1))}` : ''}`
      : list(out);
  if (op.name === "'") return `T* ${tj}`;
  if (op.name === '"') return `${fmt(op.aw ?? 0)} Tw ${fmt(op.ac ?? 0)} Tc T* ${tj}`;
  return tj;
}

function rewritePage(read: PageRead, glyphIds: ReadonlySet<number>): Uint8Array {
  const removed = new Set<string>();
  const ops = new Set<number>();
  for (const id of glyphIds) {
    const g = read.glyphs[id] as Glyph;
    removed.add(`${g.op}:${g.part}:${g.at}`);
    ops.add(g.op);
  }
  const edits = [...ops]
    .map((o) => {
      const show = read.shows.get(o);
      if (show === undefined) throw new Unsupported('lost operator');
      return { s: (read.toks[show.first] as Tok).s, e: (read.toks[o] as Tok).e, text: rewriteShow(show, removed) };
    })
    .sort((a, b) => a.s - b.s);
  const chunks: Buffer[] = [];
  let pos = 0;
  for (const ed of edits) {
    chunks.push(Buffer.from(read.src.subarray(pos, ed.s)), Buffer.from(ed.text, 'latin1'));
    pos = ed.e;
  }
  chunks.push(Buffer.from(read.src.subarray(pos)));
  return new Uint8Array(Buffer.concat(chunks));
}

function pageText(p: TextLayerPage | undefined): string {
  return strip((p?.words ?? []).map((w) => w.t).join(''));
}

function removeOnce(text: string, tag: string): string {
  const at = text.indexOf(tag);
  return at < 0 ? text : text.slice(0, at) + text.slice(at + tag.length);
}

/**
 * A-6 / ruling C-8 — removes each tag's text from the page content (see the header), then
 * paints every cover box white as a fallback. A tag whose text could not be removed cleanly is
 * only covered and its index is returned in `not_removed`; its page is then left exactly as it
 * was (apart from the covers). With no tag the bytes are returned unchanged.
 */
export async function removeAndCoverTextTags(bytes: Uint8Array, tags: readonly PdfTextTagBox[]): Promise<PdfTextTagRemoval> {
  const usable = tags.map((t, i) => ({ t, i })).filter(({ t }) => t.width > 0 && t.height > 0);
  if (usable.length === 0) return { bytes, not_removed: [] };
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const pages = doc.getPages();
  const notRemoved = new Set<number>(tags.map((_, i) => i).filter((i) => !usable.some((u) => u.i === i)));
  const stdFonts = new Map<string, PDFFont>();
  const standard = (name: string): PDFFont => {
    let f = stdFonts.get(name);
    if (f === undefined) {
      f = doc.embedStandardFont(name as StandardFonts);
      stdFonts.set(name, f);
    }
    return f;
  };
  // Per page: the tags removed and the content to put back if the proof fails.
  const changed = new Map<number, { tags: number[]; contents: PDFObject | undefined }>();
  const byPage = new Map<number, Array<{ t: PdfTextTagBox; i: number }>>();
  for (const u of usable) {
    const list = byPage.get(u.t.page_number) ?? [];
    list.push(u);
    byPage.set(u.t.page_number, list);
  }
  for (const [pageIndex, list] of byPage) {
    const page = pages[pageIndex];
    if (page === undefined) {
      for (const u of list) notRemoved.add(u.i);
      continue;
    }
    try {
      const read = readPage(ctx, page, standard);
      const taken = new Set<number>();
      const done: number[] = [];
      for (const u of list) {
        const ids = locateTag(read.glyphs, taken, u.t);
        if (ids === null) {
          notRemoved.add(u.i);
          continue;
        }
        for (const id of ids) taken.add(id);
        done.push(u.i);
      }
      if (done.length === 0) continue;
      const content = rewritePage(read, taken);
      const original = page.node.get(N('Contents'));
      page.node.set(N('Contents'), ctx.register(ctx.flateStream(content)));
      changed.set(pageIndex, { tags: done, contents: original });
    } catch {
      // Unsupported content (or a stream that cannot be read): the page is left as it was.
      for (const u of list) notRemoved.add(u.i);
    }
  }
  if (changed.size > 0) {
    // The proof: each changed page's text is its old text without the removed tags.
    let before: TextLayerPage[] | null = null;
    let after: TextLayerPage[] | null = null;
    try {
      before = await extractTextLayer(bytes);
      after = await extractTextLayer(await doc.save({ useObjectStreams: false }));
    } catch {
      before = null;
    }
    for (const [pageIndex, c] of changed) {
      let expected = before === null ? null : pageText(before.find((p) => p.page === pageIndex + 1));
      for (const i of c.tags) if (expected !== null) expected = removeOnce(expected, strip(tags[i]?.text ?? ''));
      const actual = after === null ? null : pageText(after.find((p) => p.page === pageIndex + 1));
      if (expected === null || actual === null || expected !== actual) {
        const page = pages[pageIndex] as PDFPage;
        if (c.contents === undefined) page.node.delete(N('Contents'));
        else page.node.set(N('Contents'), c.contents);
        for (const i of c.tags) notRemoved.add(i);
      }
    }
  }
  coverPagesWithBoxes(doc, usable.map((u) => u.t));
  // The old content streams (which still hold the tag text) are no longer referenced.
  dropUnreachable(ctx);
  return { bytes: await doc.save({ useObjectStreams: false }), not_removed: [...notRemoved].sort((a, b) => a - b) };
}
