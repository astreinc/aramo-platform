// Feature-Parity Directive v1.0 §1.15 — a minimal, strict DER writer and reader for the
// PAdES document seal: CMS SignedData (RFC 5652), ESS signing-certificate-v2 (RFC 5035)
// and the X.509 fields the seal reads. Definite lengths and low tag numbers only, which
// is all DER (X.690 §10) produces for these structures; anything else is refused.
// Node's crypto does the cryptography; no ASN.1 dependency is added.

export class SealDerError extends Error {
  constructor(message: string) {
    super(`DER: ${message}`);
    this.name = 'SealDerError';
  }
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

// ---------------------------------------------------------------- writer

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One TLV from a full identifier octet and content. */
export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

export const seq = (...items: Buffer[]): Buffer => tlv(TAG.SEQUENCE, Buffer.concat(items));

/** DER SET OF: elements sorted by their encodings (X.690 §11.6). */
export const setOf = (...items: Buffer[]): Buffer => tlv(TAG.SET, Buffer.concat([...items].sort(Buffer.compare)));

export const octetString = (b: Buffer): Buffer => tlv(TAG.OCTET_STRING, b);
export const derNull = (): Buffer => Buffer.from([TAG.NULL, 0x00]);
export const utf8 = (s: string): Buffer => tlv(TAG.UTF8_STRING, Buffer.from(s, 'utf8'));
export const printable = (s: string): Buffer => tlv(TAG.PRINTABLE_STRING, Buffer.from(s, 'ascii'));
export const bitString = (b: Buffer): Buffer => tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([0x00]), b]));

/** [n] EXPLICIT (constructed) or IMPLICIT (constructed content kept) context tag. */
export const context = (n: number, content: Buffer, constructed = true): Buffer => tlv(0x80 | (constructed ? 0x20 : 0) | n, content);

/** A non-negative INTEGER from big-endian magnitude bytes (minimal, sign-padded). */
export function integerFromBytes(magnitude: Buffer): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0x00) start += 1;
  let body = magnitude.subarray(start);
  if (body.length === 0) body = Buffer.from([0]);
  if (((body[0] as number) & 0x80) !== 0) body = Buffer.concat([Buffer.from([0x00]), body]);
  return tlv(TAG.INTEGER, body);
}

export const integer = (n: number): Buffer => {
  if (!Number.isSafeInteger(n) || n < 0) throw new SealDerError('integer out of range');
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return integerFromBytes(Buffer.from(bytes));
};

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map((p) => Number(p));
  if (parts.length < 2 || parts.some((p) => !Number.isSafeInteger(p) || p < 0)) throw new SealDerError(`bad OID ${dotted}`);
  const out: number[] = [(parts[0] as number) * 40 + (parts[1] as number)];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...chunk);
  }
  return tlv(TAG.OID, Buffer.from(out));
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** UTCTime for 1950–2049, GeneralizedTime otherwise (RFC 5280 §4.1.2.5). */
export function time(d: Date): Buffer {
  const y = d.getUTCFullYear();
  const rest = `${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
  if (y >= 1950 && y < 2050) return tlv(TAG.UTC_TIME, Buffer.from(`${pad2(y % 100)}${rest}`, 'ascii'));
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(`${y}${rest}`, 'ascii'));
}

// ---------------------------------------------------------------- reader

export interface DerNode {
  tag: number;
  constructed: boolean;
  /** The whole TLV (header + content). */
  raw: Buffer;
  content: Buffer;
}

function readOne(buf: Buffer, offset: number): { node: DerNode; next: number } {
  if (offset + 2 > buf.length) throw new SealDerError('truncated header');
  const tag = buf[offset] as number;
  if ((tag & 0x1f) === 0x1f) throw new SealDerError('high tag numbers are not supported');
  let pos = offset + 1;
  const first = buf[pos] as number;
  pos += 1;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    if (count === 0) throw new SealDerError('indefinite length is not DER');
    if (count > 4) throw new SealDerError('length too large');
    if (pos + count > buf.length) throw new SealDerError('truncated length');
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + (buf[pos + i] as number);
    pos += count;
  }
  const end = pos + length;
  if (end > buf.length) throw new SealDerError('truncated content');
  return { node: { tag, constructed: (tag & 0x20) !== 0, raw: buf.subarray(offset, end), content: buf.subarray(pos, end) }, next: end };
}

/** Parse exactly one TLV filling `buf` (trailing bytes refused). */
export function parse(buf: Buffer): DerNode {
  const { node, next } = readOne(buf, 0);
  if (next !== buf.length) throw new SealDerError('trailing bytes');
  return node;
}

/** The children of a constructed node. */
export function children(node: DerNode): DerNode[] {
  if (!node.constructed) throw new SealDerError('not constructed');
  const out: DerNode[] = [];
  let pos = 0;
  while (pos < node.content.length) {
    const { node: child, next } = readOne(node.content, pos);
    out.push(child);
    pos = next;
  }
  return out;
}

export function child(node: DerNode, index: number): DerNode {
  const c = children(node)[index];
  if (c === undefined) throw new SealDerError(`missing child ${index}`);
  return c;
}

export function readOid(node: DerNode): string {
  if (node.tag !== TAG.OID || node.content.length === 0) throw new SealDerError('not an OID');
  const bytes = node.content;
  const first = bytes[0] as number;
  const parts = [first < 80 ? Math.floor(first / 40) : 2, first < 80 ? first % 40 : first - 80];
  let v = 0;
  for (let i = 1; i < bytes.length; i += 1) {
    const b = bytes[i] as number;
    v = v * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}
