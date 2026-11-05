import { type KeyObject, generateKeyPairSync, sign as nodeSign } from 'node:crypto';

import { CompactSign } from 'jose';

// M-A12 tests — a TEST certificate authority built in memory (no network, no committed key, never an
// Apple or Google secret): a minimal DER X.509 v3 builder for a root → intermediate → leaf chain shaped
// like Apple's (the intermediate and leaf carry Apple's marker OIDs), and a signer for App Store style
// JWS payloads with the x5c header. Every key is generated per test run.

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const int = (n: number): Buffer => tlv(0x02, Buffer.from(n < 0x80 ? [n] : [0, n & 0xff]));
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octet = (b: Buffer): Buffer => tlv(0x04, b);
const bitstring = (b: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n: number, b: Buffer): Buffer => tlv(0xa0 + n, b);

function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const out: number[] = [40 * (arcs[0] as number) + (arcs[1] as number)];
  for (const a of arcs.slice(2)) {
    const enc: number[] = [a & 0x7f];
    let v = a >> 7;
    while (v > 0) {
      enc.unshift(0x80 | (v & 0x7f));
      v >>= 7;
    }
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  return y < 2050 ? tlv(0x17, Buffer.from(`${p(y % 100)}${body}`)) : tlv(0x18, Buffer.from(`${y}${body}`));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const name = (cn: string): Buffer => seq(set(seq(oid('2.5.4.3'), utf8(cn))));

export const APPLE_LEAF_MARKER_OID = '1.2.840.113635.100.6.11.1';
export const APPLE_INTERMEDIATE_MARKER_OID = '1.2.840.113635.100.6.2.1';

export interface TestCert {
  der: Buffer;
  key: KeyObject;
  publicKey: KeyObject;
  cn: string;
}

let serial = 1;

/** One certificate: self-signed when `issuer` is absent. */
export function makeCert(opts: { cn: string; issuer?: TestCert; ca?: boolean; marker?: string; notBefore?: Date; notAfter?: Date; signWith?: KeyObject }): TestCert {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exts: Buffer[] = [];
  if (opts.ca === true) {
    exts.push(seq(oid('2.5.29.19'), bool(true), octet(seq(bool(true)))));
    exts.push(seq(oid('2.5.29.15'), bool(true), octet(bitstring(Buffer.from([0x06]), 1))));
  }
  if (opts.marker !== undefined) exts.push(seq(oid(opts.marker), octet(Buffer.from([0x05, 0x00]))));
  const tbs = seq(
    explicit(0, int(2)),
    int((serial += 1)),
    ECDSA_SHA256,
    name(opts.issuer?.cn ?? opts.cn),
    seq(time(opts.notBefore ?? new Date('2025-01-01T00:00:00Z')), time(opts.notAfter ?? new Date('2045-01-01T00:00:00Z'))),
    name(opts.cn),
    publicKey.export({ type: 'spki', format: 'der' }),
    ...(exts.length > 0 ? [tlv(0xa3, seq(...exts))] : []),
  );
  const signer = opts.signWith ?? opts.issuer?.key ?? privateKey;
  const sig = nodeSign('sha256', tbs, signer);
  return { der: seq(tbs, ECDSA_SHA256, bitstring(sig)), key: privateKey, publicKey, cn: opts.cn };
}

export interface TestChain {
  root: TestCert;
  intermediate: TestCert;
  leaf: TestCert;
  /** The root as PEM (the trust anchor a test verifier is given). */
  rootPem: string;
}

/** An Apple-shaped chain: root CA → intermediate CA (marker) → leaf (marker). */
export function appleShapedChain(opts: { leafNotAfter?: Date; leafMarker?: string | null } = {}): TestChain {
  const root = makeCert({ cn: 'Test Root CA', ca: true });
  const intermediate = makeCert({ cn: 'Test WWDR Intermediate', issuer: root, ca: true, marker: APPLE_INTERMEDIATE_MARKER_OID });
  const leaf = makeCert({
    cn: 'Test App Store Signing',
    issuer: intermediate,
    ...(opts.leafMarker === null ? {} : { marker: opts.leafMarker ?? APPLE_LEAF_MARKER_OID }),
    ...(opts.leafNotAfter !== undefined ? { notAfter: opts.leafNotAfter } : {}),
  });
  return { root, intermediate, leaf, rootPem: pem(root.der) };
}

export function pem(der: Buffer): string {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE-----\n`;
}

/** An App Store style JWS (ES256, x5c = [leaf, intermediate, root]) over `payload`. */
export async function signedByChain(payload: object, chain: { leaf: TestCert; intermediate: TestCert; root: TestCert }, signingKey?: KeyObject): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'ES256', x5c: [chain.leaf.der.toString('base64'), chain.intermediate.der.toString('base64'), chain.root.der.toString('base64')] })
    .sign(signingKey ?? chain.leaf.key);
}
