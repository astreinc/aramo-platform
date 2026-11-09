// Aramo Sign Apple Platform Go-Live (LOCKED) R-9 — a minimal CBOR (RFC 8949) decoder,
// sufficient for the App Attest attestation object and the COSE key inside its
// authenticator data. The repository carries no CBOR dependency, so this reads only
// what those structures use: unsigned / negative integers, byte strings, text
// strings, arrays, maps, tags (the tag is dropped, the item kept) and the simple
// values false / true / null / undefined. Indefinite lengths, floats, integers
// beyond 2^53 - 1 and nesting deeper than MAX_DEPTH are refused (CborError).
// Maps decode to a Map (keys keep their CBOR type: COSE keys are integers).

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}

export type CborValue = number | Buffer | string | boolean | null | undefined | CborValue[] | Map<CborValue, CborValue>;

const MAX_DEPTH = 16;

function need(buf: Buffer, off: number, n: number): void {
  if (n < 0 || off + n > buf.length) throw new CborError('truncated');
}

function readArgument(buf: Buffer, off: number, info: number): { value: number; next: number } {
  if (info < 24) return { value: info, next: off };
  if (info === 24) {
    need(buf, off, 1);
    return { value: buf.readUInt8(off), next: off + 1 };
  }
  if (info === 25) {
    need(buf, off, 2);
    return { value: buf.readUInt16BE(off), next: off + 2 };
  }
  if (info === 26) {
    need(buf, off, 4);
    return { value: buf.readUInt32BE(off), next: off + 4 };
  }
  if (info === 27) {
    need(buf, off, 8);
    const big = buf.readBigUInt64BE(off);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('integer_too_large');
    return { value: Number(big), next: off + 8 };
  }
  // 28–30 reserved; 31 = indefinite length (not used by the structures read here).
  throw new CborError('unsupported_length');
}

function decodeAt(buf: Buffer, off: number, depth: number): { value: CborValue; end: number } {
  if (depth > MAX_DEPTH) throw new CborError('too_deep');
  need(buf, off, 1);
  const initial = buf.readUInt8(off);
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (major === 7) {
    if (info === 20) return { value: false, end: off + 1 };
    if (info === 21) return { value: true, end: off + 1 };
    if (info === 22) return { value: null, end: off + 1 };
    if (info === 23) return { value: undefined, end: off + 1 };
    throw new CborError('unsupported_simple_or_float');
  }
  const { value: arg, next } = readArgument(buf, off + 1, info);
  switch (major) {
    case 0:
      return { value: arg, end: next };
    case 1:
      return { value: -1 - arg, end: next };
    case 2:
      need(buf, next, arg);
      return { value: Buffer.from(buf.subarray(next, next + arg)), end: next + arg };
    case 3:
      need(buf, next, arg);
      return { value: buf.toString('utf8', next, next + arg), end: next + arg };
    case 4: {
      // Every item takes at least one byte: a length beyond what remains is truncated.
      need(buf, next, arg);
      const out: CborValue[] = [];
      let at = next;
      for (let i = 0; i < arg; i += 1) {
        const item = decodeAt(buf, at, depth + 1);
        out.push(item.value);
        at = item.end;
      }
      return { value: out, end: at };
    }
    case 5: {
      need(buf, next, arg * 2);
      const out = new Map<CborValue, CborValue>();
      let at = next;
      for (let i = 0; i < arg; i += 1) {
        const k = decodeAt(buf, at, depth + 1);
        const v = decodeAt(buf, k.end, depth + 1);
        if (typeof k.value !== 'string' && typeof k.value !== 'number') throw new CborError('unsupported_map_key');
        if (out.has(k.value)) throw new CborError('duplicate_map_key');
        out.set(k.value, v.value);
        at = v.end;
      }
      return { value: out, end: at };
    }
    case 6:
      return decodeAt(buf, next, depth + 1);
    default:
      throw new CborError('unsupported_major_type');
  }
}

/** Decodes one CBOR item starting at `offset`; `end` is the offset just after it. */
export function decodeCborItem(buf: Buffer, offset = 0): { value: CborValue; end: number } {
  return decodeAt(buf, offset, 0);
}

/** Decodes a buffer that holds exactly one CBOR item (trailing bytes are refused). */
export function decodeCbor(buf: Buffer): CborValue {
  const { value, end } = decodeAt(buf, 0, 0);
  if (end !== buf.length) throw new CborError('trailing_bytes');
  return value;
}
