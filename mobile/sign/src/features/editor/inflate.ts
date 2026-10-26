// A small, dependency-free DEFLATE decoder (RFC 1950 zlib wrapper + RFC 1951),
// used only to read PDF object streams for page sizes (pdfPageSizes.ts). Hermes has
// no zlib. Output is capped so a hostile stream can't exhaust memory.

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
}

function buildHuffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i += 1) counts[lengths[i] ?? 0]! += 1;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i += 1) offs[i] = offs[i - 1]! + counts[i - 1]!;
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i += 1) {
    const l = lengths[i] ?? 0;
    if (l) symbols[offs[l]!++] = i;
  }
  return { counts, symbols };
}

class BitReader {
  private pos: number;
  private bitBuf = 0;
  private bitCnt = 0;
  constructor(
    private readonly src: Uint8Array,
    start: number,
  ) {
    this.pos = start;
  }
  bits(n: number): number {
    while (this.bitCnt < n) {
      if (this.pos >= this.src.length) throw new Error('inflate: unexpected end of data');
      this.bitBuf |= this.src[this.pos++]! << this.bitCnt;
      this.bitCnt += 8;
    }
    const v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return v;
  }
  alignToByte(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  byte(): number {
    if (this.pos >= this.src.length) throw new Error('inflate: unexpected end of data');
    return this.src[this.pos++]!;
  }
  decode(h: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len += 1) {
      code |= this.bits(1);
      const count = h.counts[len]!;
      if (code - first < count) return h.symbols[index + (code - first)]!;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('inflate: bad code');
  }
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;
function fixedTables(): [Huffman, Huffman] {
  if (!fixedLit || !fixedDist) {
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i += 1) l[i] = 8;
    for (let i = 144; i < 256; i += 1) l[i] = 9;
    for (let i = 256; i < 280; i += 1) l[i] = 7;
    for (let i = 280; i < 288; i += 1) l[i] = 8;
    fixedLit = buildHuffman(l);
    fixedDist = buildHuffman(new Uint8Array(30).fill(5));
  }
  return [fixedLit, fixedDist];
}

class Output {
  buf: Uint8Array;
  len = 0;
  constructor(
    initial: number,
    private readonly max: number,
  ) {
    this.buf = new Uint8Array(Math.max(1024, initial));
  }
  push(b: number): void {
    if (this.len >= this.buf.length) this.grow();
    this.buf[this.len++] = b;
  }
  private grow(): void {
    if (this.buf.length >= this.max) throw new Error('inflate: output too large');
    const next = new Uint8Array(Math.min(this.max, this.buf.length * 2));
    next.set(this.buf);
    this.buf = next;
  }
}

/** Inflate a zlib (RFC 1950) or raw DEFLATE stream. */
export function inflate(data: Uint8Array, maxOutput = 64 * 1024 * 1024): Uint8Array {
  let start = 0;
  // zlib header: CMF/FLG with CM=8 and a valid check value.
  if (data.length >= 2 && (data[0]! & 0x0f) === 8 && ((data[0]! << 8) | data[1]!) % 31 === 0) {
    start = 2;
  }
  const r = new BitReader(data, start);
  const out = new Output(data.length * 4, maxOutput);
  let last = 0;
  while (!last) {
    last = r.bits(1);
    const type = r.bits(2);
    if (type === 0) {
      r.alignToByte();
      const len = r.byte() | (r.byte() << 8);
      r.byte();
      r.byte(); // NLEN
      for (let i = 0; i < len; i += 1) out.push(r.byte());
      continue;
    }
    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) {
      [lit, dist] = fixedTables();
    } else if (type === 2) {
      const hlit = r.bits(5) + 257;
      const hdist = r.bits(5) + 1;
      const hclen = r.bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i += 1) cl[CL_ORDER[i]!] = r.bits(3);
      const clh = buildHuffman(cl);
      const lengths = new Uint8Array(hlit + hdist);
      let n = 0;
      while (n < hlit + hdist) {
        const sym = r.decode(clh);
        if (sym < 16) lengths[n++] = sym;
        else {
          let rep = 0;
          let val = 0;
          if (sym === 16) {
            if (n === 0) throw new Error('inflate: bad repeat');
            val = lengths[n - 1]!;
            rep = 3 + r.bits(2);
          } else if (sym === 17) rep = 3 + r.bits(3);
          else rep = 11 + r.bits(7);
          if (n + rep > lengths.length) throw new Error('inflate: bad lengths');
          for (let i = 0; i < rep; i += 1) lengths[n++] = val;
        }
      }
      lit = buildHuffman(lengths.subarray(0, hlit));
      dist = buildHuffman(lengths.subarray(hlit));
    } else {
      throw new Error('inflate: bad block type');
    }
    for (;;) {
      const sym = r.decode(lit);
      if (sym < 256) out.push(sym);
      else if (sym === 256) break;
      else {
        const li = sym - 257;
        if (li >= 29) throw new Error('inflate: bad length');
        const len = LENGTH_BASE[li]! + r.bits(LENGTH_EXTRA[li]!);
        const di = r.decode(dist);
        if (di >= 30) throw new Error('inflate: bad distance');
        const d = DIST_BASE[di]! + r.bits(DIST_EXTRA[di]!);
        if (d > out.len) throw new Error('inflate: distance too far');
        for (let i = 0; i < len; i += 1) out.push(out.buf[out.len - d]!);
      }
    }
  }
  return out.buf.slice(0, out.len);
}
