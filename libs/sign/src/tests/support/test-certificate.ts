import { constants, generateKeyPairSync, privateEncrypt, sign, type KeyObject } from 'node:crypto';

// Test support (Feature-Parity §1.16) — a throwaway self-signed X.509 v3 certificate built
// at run time, so no key or certificate is ever checked in. It stands in for a QTSP-issued
// signer certificate; it chains to nothing and is used only by unit and integration tests.

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), len(content.length), content]);
}
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a! + b!];
  for (const n of rest) {
    const chunk: number[] = [];
    let v = n;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function integer(n: number): Buffer {
  const hex = n.toString(16);
  let b = Buffer.from(hex.length % 2 === 1 ? `0${hex}` : hex, 'hex');
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const utcTime = (s: string) => tlv(0x17, Buffer.from(s, 'ascii'));
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), tlv(0x05, Buffer.alloc(0)));

export interface TestCertificate {
  pem: string;
  der_b64: string;
  privateKey: KeyObject;
}

export function makeTestCertificate(commonName = 'Test Signer', serial = 4242): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(tlv(0xa0, integer(2)), integer(serial), SHA256_RSA, name('Test QTSP CA'), seq(utcTime('250101000000Z'), utcTime('491231235959Z')), name(commonName), spki);
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const b64 = der.toString('base64');
  return { pem: `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`, der_b64: b64, privateKey };
}

/** A raw RSASSA-PKCS1-v1_5 signature over an already computed SHA-256 digest (what a QTSP's signHash returns). */
export function signDigest(privateKey: KeyObject, digest_b64: string): string {
  const digestInfo = Buffer.concat([Buffer.from('3031300d060960864801650304020105000420', 'hex'), Buffer.from(digest_b64, 'base64')]);
  return privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, digestInfo).toString('base64');
}
