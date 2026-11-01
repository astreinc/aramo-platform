// Feature-Parity Directive v1.0 §1.18 — a minimal, strict DER reader/writer for the
// RFC 3161 time-stamp protocol (TimeStampReq, TimeStampResp, CMS SignedData, TSTInfo,
// X.509 certificates). Only definite lengths and low tag numbers are accepted, which
// is all DER (X.690 §10) produces for these structures; anything else is refused.

export class DerError extends Error {
  constructor(message: string) {
    super(`DER: ${message}`);
    this.name = 'DerError';
  }
}

// Universal tags used here.
export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  GENERALIZED_TIME: 0x18,
} as const;

export interface DerNode {
  // The full identifier octet (class + constructed bit + tag number).
  tag: number;
  constructed: boolean;
  // The whole TLV (header + content) and the content alone.
  raw: Buffer;
  content: Buffer;
}

/** Context-specific tag octet for [n] (constructed or primitive). */
export function contextTag(n: number, constructed: boolean): number {
  return 0x80 | (constructed ? 0x20 : 0) | n;
}

function readOne(buf: Buffer, offset: number): { node: DerNode; next: number } {
  if (offset + 2 > buf.length) throw new DerError('truncated header');
  const tag = buf[offset] as number;
  if ((tag & 0x1f) === 0x1f) throw new DerError('high tag numbers are not supported');
  let pos = offset + 1;
  const first = buf[pos] as number;
  pos += 1;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    if (count === 0) throw new DerError('indefinite length is not DER');
    if (count > 4) throw new DerError('length too large');
    if (pos + count > buf.length) throw new DerError('truncated length');
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + (buf[pos + i] as number);
    pos += count;
    if (length < 0x80) throw new DerError('non-minimal length encoding');
  }
  const end = pos + length;
  if (end > buf.length) throw new DerError('content runs past the end of the input');
  return {
    node: { tag, constructed: (tag & 0x20) !== 0, raw: buf.subarray(offset, end), content: buf.subarray(pos, end) },
    next: end,
  };
}

/** Parse exactly one TLV that spans the whole input. */
export function parseDer(input: Uint8Array): DerNode {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const { node, next } = readOne(buf, 0);
  if (next !== buf.length) throw new DerError('trailing bytes after the top-level element');
  return node;
}

/** The child TLVs of a constructed node. */
export function children(node: DerNode): DerNode[] {
  if (!node.constructed) throw new DerError(`tag 0x${node.tag.toString(16)} is not constructed`);
  const out: DerNode[] = [];
  let offset = 0;
  while (offset < node.content.length) {
    const { node: child, next } = readOne(node.content, offset);
    out.push(child);
    offset = next;
  }
  return out;
}

export function expectTag(node: DerNode | undefined, tag: number, what: string): DerNode {
  if (node === undefined) throw new DerError(`${what} is missing`);
  if (node.tag !== tag) throw new DerError(`${what}: expected tag 0x${tag.toString(16)}, got 0x${node.tag.toString(16)}`);
  return node;
}

export function decodeOid(node: DerNode): string {
  if (node.tag !== TAG.OID) throw new DerError('expected an OBJECT IDENTIFIER');
  const bytes = node.content;
  if (bytes.length === 0) throw new DerError('empty OBJECT IDENTIFIER');
  const arcs: number[] = [];
  let value = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] as number;
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    } else if (i === bytes.length - 1) {
      throw new DerError('truncated OBJECT IDENTIFIER');
    }
  }
  const first = arcs.shift() as number;
  const head = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  return [...head, ...arcs].join('.');
}

/** A non-negative or negative INTEGER as a bigint. */
export function decodeInteger(node: DerNode): bigint {
  if (node.tag !== TAG.INTEGER) throw new DerError('expected an INTEGER');
  if (node.content.length === 0) throw new DerError('empty INTEGER');
  let value = 0n;
  for (const b of node.content) value = (value << 8n) | BigInt(b);
  if (((node.content[0] as number) & 0x80) !== 0) value -= 1n << BigInt(node.content.length * 8);
  return value;
}

/** GeneralizedTime in the DER form RFC 3161 requires: YYYYMMDDHHMMSS[.f+]Z. */
export function decodeGeneralizedTime(node: DerNode): Date {
  if (node.tag !== TAG.GENERALIZED_TIME) throw new DerError('expected a GeneralizedTime');
  const text = node.content.toString('latin1');
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,9}))?Z$/.exec(text);
  if (m === null) throw new DerError(`malformed GeneralizedTime "${text}"`);
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = frac === undefined ? 0 : Math.floor(Number(`0.${frac}`) * 1000);
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms));
  if (Number.isNaN(date.getTime())) throw new DerError(`invalid GeneralizedTime "${text}"`);
  return date;
}

// ── Encoding ────────────────────────────────────────────────────────────────

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

export function encodeTlv(tag: number, content: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), Buffer.from(content)]);
}

export function encodeSequence(...items: Uint8Array[]): Buffer {
  return encodeTlv(TAG.SEQUENCE, Buffer.concat(items.map((i) => Buffer.from(i))));
}

export function encodeSet(...items: Uint8Array[]): Buffer {
  return encodeTlv(TAG.SET, Buffer.concat(items.map((i) => Buffer.from(i))));
}

/** A non-negative INTEGER in minimal two's-complement form. */
export function encodeUnsignedInteger(value: bigint | Uint8Array): Buffer {
  let bytes: Buffer;
  if (typeof value === 'bigint') {
    if (value < 0n) throw new DerError('negative INTEGER is not supported');
    let hex = value.toString(16);
    if (hex.length % 2 === 1) hex = `0${hex}`;
    bytes = Buffer.from(hex, 'hex');
  } else {
    bytes = Buffer.from(value);
  }
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  bytes = bytes.subarray(start);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if (((bytes[0] as number) & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return encodeTlv(TAG.INTEGER, bytes);
}

export function encodeOid(oid: string): Buffer {
  const arcs = oid.split('.').map((a) => {
    if (!/^\d+$/.test(a)) throw new DerError(`invalid OID "${oid}"`);
    return Number(a);
  });
  if (arcs.length < 2) throw new DerError(`invalid OID "${oid}"`);
  const out: number[] = [];
  const pushArc = (arc: number): void => {
    const stack = [arc & 0x7f];
    let n = Math.floor(arc / 128);
    while (n > 0) {
      stack.unshift((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(...stack);
  };
  pushArc((arcs[0] as number) * 40 + (arcs[1] as number));
  for (const arc of arcs.slice(2)) pushArc(arc);
  return encodeTlv(TAG.OID, Buffer.from(out));
}

export function encodeOctetString(bytes: Uint8Array): Buffer {
  return encodeTlv(TAG.OCTET_STRING, bytes);
}

export function encodeNull(): Buffer {
  return Buffer.from([TAG.NULL, 0x00]);
}

export function encodeBoolean(value: boolean): Buffer {
  return Buffer.from([TAG.BOOLEAN, 0x01, value ? 0xff : 0x00]);
}

export function encodeGeneralizedTime(date: Date): Buffer {
  const iso = date.toISOString(); // 2026-11-01T10:20:30.123Z
  const ms = iso.slice(20, 23).replace(/0+$/, '');
  const text = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${ms.length > 0 ? `.${ms}` : ''}Z`;
  return encodeTlv(TAG.GENERALIZED_TIME, Buffer.from(text, 'latin1'));
}
