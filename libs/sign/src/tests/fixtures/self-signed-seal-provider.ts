// TEST ONLY — never bound in production. A self-signed RSA seal identity and a
// DocumentSealSigningProvider that signs with it in process, plus an independent
// verifier of a sealed PDF's PAdES signature (ByteRange digest, CMS signed attributes,
// RSA signature, ESS signing-certificate-v2 and the certificate's own signature).

import { constants, createHash, createPublicKey, generateKeyPairSync, privateEncrypt, randomBytes, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';

import {
  child,
  children,
  context,
  derNull,
  integer,
  integerFromBytes,
  octetString,
  oid,
  parse,
  readOid,
  seq,
  setOf,
  time,
  tlv,
  utf8,
  bitString,
  type DerNode,
} from '../../lib/document-seal/der.js';
import { OID } from '../../lib/document-seal/cms.js';
import { byteRangeContent } from '../../lib/document-seal/pades.js';
import { type DocumentSealIdentity, type DocumentSealSigningProvider } from '../../lib/ports/document-seal.port.js';

const name = (cn: string, org: string): Buffer =>
  seq(setOf(seq(oid('2.5.4.10'), utf8(org))), setOf(seq(oid('2.5.4.3'), utf8(cn))));

export interface TestSealIdentity {
  identity: DocumentSealIdentity;
  privateKey: KeyObject;
  certificate_pem: string;
}

/** A self-signed RSA-2048 document-signing certificate (v3, keyUsage digitalSignature + nonRepudiation). */
export function createSelfSignedSealIdentity(cn = 'Aramo Sign TEST Seal', org = 'Aramo TEST'): TestSealIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const subject = name(cn, org);
  const now = Date.now();
  const sigAlg = seq(oid(OID.sha256WithRSA), derNull());
  const keyUsage = seq(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), octetString(tlv(0x03, Buffer.from([0x06, 0xc0]))));
  const basicConstraints = seq(oid('2.5.29.19'), octetString(seq()));
  const tbs = seq(
    context(0, integer(2)),
    integerFromBytes(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    sigAlg,
    subject,
    seq(time(new Date(now - 60_000)), time(new Date(now + 365 * 86_400_000))),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    context(3, seq(basicConstraints, keyUsage)),
  );
  const certificate_der = seq(tbs, sigAlg, bitString(sign('sha256', tbs, privateKey)));
  const certificate_pem = `-----BEGIN CERTIFICATE-----\n${certificate_der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
  return { identity: { certificate_der, chain_der: [] }, privateKey, certificate_pem };
}

export class SelfSignedTestSealProvider implements DocumentSealSigningProvider {
  readonly provider_id = 'test-self-signed';
  signCalls = 0;
  constructor(private readonly test: TestSealIdentity = createSelfSignedSealIdentity()) {}
  get certificate_pem(): string {
    return this.test.certificate_pem;
  }
  async identity(): Promise<DocumentSealIdentity> {
    return this.test.identity;
  }
  async signDigest(_identity: DocumentSealIdentity, sha256Digest: Buffer): Promise<Buffer> {
    this.signCalls += 1;
    // RSASSA-PKCS1-v1_5 over DigestInfo(SHA-256, digest) — i.e. a pre-hashed sha256WithRSA.
    const digestInfoPrefix = Buffer.from('3031300d060960864801650304020105000420', 'hex');
    return privateEncrypt({ key: this.test.privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([digestInfoPrefix, sha256Digest]));
  }
}

export interface VerifiedSeal {
  byte_range: [number, number, number, number];
  cms_der: Buffer;
  signer_certificate_der: Buffer;
  signed_content_sha256: string;
  timestamp_token_der: Buffer | null;
  signed_attribute_oids: string[];
  sub_filter: string;
}

const attrValue = (attrs: DerNode[], type: string): DerNode | undefined =>
  attrs.filter((a) => readOid(child(a, 0)) === type).map((a) => child(child(a, 1), 0))[0];

/**
 * Independently verify the LAST signature of a sealed PDF. Throws on any failure.
 * `trusted_certificate_der` pins the expected signer (the test cert).
 */
export function verifySealedPdf(pdf: Buffer, trusted_certificate_der: Buffer): VerifiedSeal {
  const text = pdf.toString('latin1');
  const brAt = text.lastIndexOf('/ByteRange');
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text.slice(brAt));
  if (m === null) throw new Error('no ByteRange');
  const range = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  if (range[0] !== 0 || range[2] + range[3] !== pdf.length) throw new Error('ByteRange does not cover the whole file');
  const hole = text.slice(range[1], range[2]);
  if (!/^<[0-9A-Fa-f]+>$/.test(hole)) throw new Error('ByteRange gap is not exactly the /Contents hex string');
  const subFilter = /\/SubFilter\s*\/([A-Za-z.]+)/.exec(text.slice(text.lastIndexOf('/Type /Sig')))?.[1] ?? '';

  // The hex is zero-padded after the DER; parse one TLV and drop the padding.
  const padded = Buffer.from(hole.slice(1, -1), 'hex');
  const first = parse(padded.subarray(0, derLength(padded)));
  const cms_der = first.raw;
  if (readOid(child(first, 0)) !== OID.signedData) throw new Error('not SignedData');
  const sd = child(child(first, 1), 0);
  const sdParts = children(sd);
  const certsNode = sdParts.find((n) => n.tag === 0xa0);
  if (certsNode === undefined) throw new Error('no certificates');
  const signerCert = children(certsNode)[0]?.raw;
  if (signerCert === undefined || !signerCert.equals(trusted_certificate_der)) throw new Error('signer certificate is not the trusted one');
  const encap = sdParts[2] as DerNode;
  if (readOid(child(encap, 0)) !== OID.data || children(encap).length !== 1) throw new Error('not detached id-data');
  const signerInfo = child(sdParts[sdParts.length - 1] as DerNode, 0);
  const si = children(signerInfo);
  const signedAttrsNode = si.find((n) => n.tag === 0xa0);
  const signatureNode = si.find((n, i) => i > 3 && n.tag === 0x04);
  if (signedAttrsNode === undefined || signatureNode === undefined) throw new Error('signer info incomplete');
  const attrsSet = Buffer.concat([Buffer.from([0x31]), signedAttrsNode.raw.subarray(1)]);
  const attrs = children(signedAttrsNode);

  const contentDigest = createHash('sha256').update(byteRangeContent(pdf, range)).digest();
  const md = attrValue(attrs, OID.messageDigest);
  if (md === undefined || !md.content.equals(contentDigest)) throw new Error('message-digest does not match the ByteRange content');
  const ct = attrValue(attrs, OID.contentType);
  if (ct === undefined || readOid(ct) !== OID.data) throw new Error('content-type is not id-data');
  const scv2 = attrValue(attrs, OID.signingCertificateV2);
  const certHash = scv2 === undefined ? undefined : child(child(child(scv2, 0), 0), 0).content;
  if (certHash === undefined || !certHash.equals(createHash('sha256').update(trusted_certificate_der).digest())) throw new Error('signing-certificate-v2 does not bind the signer');

  const x509 = new X509Certificate(trusted_certificate_der);
  if (!verify('sha256', attrsSet, createPublicKey(x509.publicKey.export({ type: 'spki', format: 'pem' })), signatureNode.content)) {
    throw new Error('CMS signature does not verify');
  }
  if (!x509.verify(x509.publicKey)) throw new Error('certificate self-signature does not verify');

  const unsigned = si.find((n) => n.tag === 0xa1);
  const tst = unsigned === undefined ? undefined : attrValue(children(unsigned), OID.signatureTimeStampToken);
  return {
    byte_range: range,
    cms_der,
    signer_certificate_der: signerCert,
    signed_content_sha256: contentDigest.toString('hex'),
    timestamp_token_der: tst?.raw ?? null,
    signed_attribute_oids: attrs.map((a) => readOid(child(a, 0))),
    sub_filter: subFilter,
  };
}

/** Total TLV length of the DER element at the start of `buf`. */
function derLength(buf: Buffer): number {
  const first = buf[1] as number;
  if (first < 0x80) return 2 + first;
  const count = first & 0x7f;
  let len = 0;
  for (let i = 0; i < count; i += 1) len = len * 256 + (buf[2 + i] as number);
  return 2 + count + len;
}
