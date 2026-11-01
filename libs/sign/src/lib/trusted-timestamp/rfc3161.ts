import { X509Certificate, constants as cryptoConstants, createHash, verify as cryptoVerify } from 'node:crypto';

import {
  DerError,
  TAG,
  children,
  contextTag,
  decodeGeneralizedTime,
  decodeInteger,
  decodeOid,
  encodeBoolean,
  encodeNull,
  encodeOctetString,
  encodeOid,
  encodeSequence,
  encodeUnsignedInteger,
  expectTag,
  parseDer,
  type DerNode,
} from './der.js';

// Feature-Parity Directive v1.0 §1.18 — RFC 3161 (with RFC 5816 / RFC 5652 CMS) time-
// stamp protocol: build a TimeStampReq over a SHA-256 digest, then parse and verify the
// TimeStampResp. Verification is fail-closed and checks:
//   - PKIStatus is granted (0) or grantedWithMods (1);
//   - the token is CMS SignedData over id-ct-TSTInfo;
//   - TSTInfo.messageImprint is SHA-256 over exactly the requested digest;
//   - TSTInfo.nonce equals the request nonce;
//   - TSTInfo.genTime is a valid GeneralizedTime within the allowed clock skew;
//   - the signedAttrs messageDigest equals the digest of the encapsulated TSTInfo and
//     contentType is id-ct-TSTInfo;
//   - the SignerInfo signature verifies with an embedded certificate (certReq=TRUE)
//     that carries the id-kp-timeStamping EKU and is valid at genTime.
// Chaining the TSA certificate to a pinned root is NOT done here (no TSA is contracted
// yet, §5 D-3); the certificate's SHA-256 fingerprint is recorded for later checking.

export const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SHA384 = '2.16.840.1.101.3.4.2.2';
const OID_SHA512 = '2.16.840.1.101.3.4.2.3';
const OID_SHA1 = '1.3.14.3.2.26';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_CT_TSTINFO = '1.2.840.113549.1.9.16.1.4';
const OID_ATTR_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_ATTR_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_KP_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';

const DIGEST_BY_OID: Record<string, 'sha1' | 'sha256' | 'sha384' | 'sha512'> = {
  [OID_SHA1]: 'sha1',
  [OID_SHA256]: 'sha256',
  [OID_SHA384]: 'sha384',
  [OID_SHA512]: 'sha512',
};

type SignatureScheme = { kind: 'RSA_PKCS1' | 'ECDSA'; hash?: 'sha1' | 'sha256' | 'sha384' | 'sha512' };

const SIGNATURE_BY_OID: Record<string, SignatureScheme> = {
  '1.2.840.113549.1.1.1': { kind: 'RSA_PKCS1' }, // rsaEncryption: hash from digestAlgorithm
  '1.2.840.113549.1.1.5': { kind: 'RSA_PKCS1', hash: 'sha1' },
  '1.2.840.113549.1.1.11': { kind: 'RSA_PKCS1', hash: 'sha256' },
  '1.2.840.113549.1.1.12': { kind: 'RSA_PKCS1', hash: 'sha384' },
  '1.2.840.113549.1.1.13': { kind: 'RSA_PKCS1', hash: 'sha512' },
  '1.2.840.10045.4.3.2': { kind: 'ECDSA', hash: 'sha256' },
  '1.2.840.10045.4.3.3': { kind: 'ECDSA', hash: 'sha384' },
  '1.2.840.10045.4.3.4': { kind: 'ECDSA', hash: 'sha512' },
};

export class Rfc3161Error extends Error {
  constructor(
    readonly code:
      | 'MALFORMED'
      | 'REJECTED'
      | 'IMPRINT_MISMATCH'
      | 'NONCE_MISMATCH'
      | 'GEN_TIME_OUT_OF_RANGE'
      | 'SIGNATURE_INVALID'
      | 'CERTIFICATE_INVALID',
    message: string,
  ) {
    super(`RFC 3161 ${code}: ${message}`);
    this.name = 'Rfc3161Error';
  }
}

export interface TimeStampRequestInput {
  sha256: Buffer; // the 32-byte digest to time-stamp
  nonce: Buffer; // random bytes; encoded as a positive INTEGER
  certReq?: boolean; // default true: the TSA must include its certificate
}

/** DER TimeStampReq (RFC 3161 §2.4.1), version 1, SHA-256 imprint, nonce, certReq. */
export function buildTimeStampRequest(input: TimeStampRequestInput): Buffer {
  if (input.sha256.length !== 32) throw new Rfc3161Error('MALFORMED', 'a SHA-256 digest is 32 bytes');
  if (input.nonce.length === 0) throw new Rfc3161Error('MALFORMED', 'a nonce is required');
  const imprint = encodeSequence(encodeSequence(encodeOid(OID_SHA256), encodeNull()), encodeOctetString(input.sha256));
  return encodeSequence(
    encodeUnsignedInteger(1n),
    imprint,
    encodeUnsignedInteger(input.nonce),
    ...(input.certReq === false ? [] : [encodeBoolean(true)]),
  );
}

/** The nonce bytes as the positive INTEGER value the request carries. */
export function nonceValue(nonce: Buffer): bigint {
  let v = 0n;
  for (const b of nonce) v = (v << 8n) | BigInt(b);
  return v;
}

export interface VerifiedTimeStamp {
  status: number; // 0 granted, 1 grantedWithMods
  token_der: Buffer; // the TimeStampToken (ContentInfo), DER
  gen_time: Date;
  serial_number: string; // hex, uppercase
  policy_oid: string;
  hash_algorithm: 'SHA-256';
  message_imprint_sha256: string; // hex, lowercase
  nonce: string; // hex, lowercase
  tsa_name: string; // signer certificate subject
  tsa_certificate_sha256: string; // hex, lowercase, of the signer certificate DER
}

export interface VerifyExpectations {
  sha256: Buffer;
  nonce: Buffer;
  now: Date;
  // Accepted distance between genTime and `now`, in ms (default 5 minutes).
  maxClockSkewMs?: number;
}

function malformed(message: string): never {
  throw new Rfc3161Error('MALFORMED', message);
}

function algorithmOid(node: DerNode | undefined, what: string): string {
  const seq = expectTag(node, TAG.SEQUENCE, what);
  return decodeOid(expectTag(children(seq)[0], TAG.OID, `${what}.algorithm`));
}

interface ParsedSignedToken {
  tstInfoDer: Buffer;
  certificates: Buffer[];
  signerInfos: DerNode[];
}

function parseToken(token: DerNode): ParsedSignedToken {
  const [ctype, explicit] = children(expectTag(token, TAG.SEQUENCE, 'TimeStampToken'));
  if (decodeOid(expectTag(ctype, TAG.OID, 'ContentInfo.contentType')) !== OID_SIGNED_DATA) malformed('token is not CMS SignedData');
  const wrapper = expectTag(explicit, contextTag(0, true), 'ContentInfo.content');
  const signedData = children(expectTag(children(wrapper)[0], TAG.SEQUENCE, 'SignedData'));
  // version, digestAlgorithms, encapContentInfo, [0] certificates?, [1] crls?, signerInfos
  const encap = children(expectTag(signedData[2], TAG.SEQUENCE, 'encapContentInfo'));
  if (decodeOid(expectTag(encap[0], TAG.OID, 'eContentType')) !== OID_CT_TSTINFO) malformed('encapsulated content is not TSTInfo');
  const eContent = expectTag(encap[1], contextTag(0, true), 'eContent');
  const octets = expectTag(children(eContent)[0], TAG.OCTET_STRING, 'eContent OCTET STRING');
  const certificates: Buffer[] = [];
  let signerInfos: DerNode | undefined;
  for (const item of signedData.slice(3)) {
    if (item.tag === contextTag(0, true)) for (const c of children(item)) if (c.tag === TAG.SEQUENCE) certificates.push(Buffer.from(c.raw));
    if (item.tag === TAG.SET) signerInfos = item;
  }
  if (signerInfos === undefined) malformed('SignedData has no signerInfos');
  const infos = children(signerInfos);
  if (infos.length === 0) malformed('SignedData has no SignerInfo');
  return { tstInfoDer: Buffer.from(octets.content), certificates, signerInfos: infos };
}

interface ParsedTstInfo {
  policy_oid: string;
  imprintAlgorithm: string;
  imprint: Buffer;
  serial: bigint;
  genTime: Date;
  nonce: bigint | null;
}

function parseTstInfo(der: Buffer): ParsedTstInfo {
  const fields = children(expectTag(parseDer(der), TAG.SEQUENCE, 'TSTInfo'));
  if (decodeInteger(expectTag(fields[0], TAG.INTEGER, 'TSTInfo.version')) !== 1n) malformed('TSTInfo version is not 1');
  const policy_oid = decodeOid(expectTag(fields[1], TAG.OID, 'TSTInfo.policy'));
  const imprint = children(expectTag(fields[2], TAG.SEQUENCE, 'TSTInfo.messageImprint'));
  const imprintAlgorithm = algorithmOid(imprint[0], 'messageImprint.hashAlgorithm');
  const hashed = expectTag(imprint[1], TAG.OCTET_STRING, 'messageImprint.hashedMessage');
  const serial = decodeInteger(expectTag(fields[3], TAG.INTEGER, 'TSTInfo.serialNumber'));
  const genTime = decodeGeneralizedTime(expectTag(fields[4], TAG.GENERALIZED_TIME, 'TSTInfo.genTime'));
  // accuracy (SEQUENCE)?, ordering (BOOLEAN)?, nonce (INTEGER)?, tsa [0]?, extensions [1]?
  let nonce: bigint | null = null;
  for (const f of fields.slice(5)) if (f.tag === TAG.INTEGER) nonce = decodeInteger(f);
  return { policy_oid, imprintAlgorithm, imprint: Buffer.from(hashed.content), serial, genTime, nonce };
}

function signedAttribute(attrs: DerNode[], oid: string): DerNode[] {
  const found = attrs.filter((a) => decodeOid(expectTag(children(a)[0], TAG.OID, 'Attribute.attrType')) === oid);
  if (found.length !== 1) throw new Rfc3161Error('SIGNATURE_INVALID', `signedAttrs must carry exactly one ${oid}`);
  return children(expectTag(children(found[0] as DerNode)[1], TAG.SET, 'Attribute.attrValues'));
}

function verifyWithCertificate(cert: X509Certificate, scheme: SignatureScheme, hash: string, data: Buffer, signature: Buffer): boolean {
  const key = cert.publicKey;
  try {
    if (scheme.kind === 'ECDSA') {
      if (key.asymmetricKeyType !== 'ec') return false;
      return cryptoVerify(hash, data, { key, dsaEncoding: 'der' }, signature);
    }
    if (key.asymmetricKeyType !== 'rsa') return false;
    return cryptoVerify(hash, data, { key, padding: cryptoConstants.RSA_PKCS1_PADDING }, signature);
  } catch {
    return false;
  }
}

/** Verify one SignerInfo against the embedded certificates; returns the signing certificate. */
function verifySignerInfo(info: DerNode, tstInfoDer: Buffer, certificates: Buffer[]): X509Certificate {
  const fields = children(expectTag(info, TAG.SEQUENCE, 'SignerInfo'));
  // version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature, [1]?
  const digestOid = algorithmOid(fields[2], 'SignerInfo.digestAlgorithm');
  const digest = DIGEST_BY_OID[digestOid];
  if (digest === undefined) throw new Rfc3161Error('SIGNATURE_INVALID', `unsupported digest algorithm ${digestOid}`);
  const signedAttrs = expectTag(fields[3], contextTag(0, true), 'SignerInfo.signedAttrs');
  const sigOid = algorithmOid(fields[4], 'SignerInfo.signatureAlgorithm');
  const scheme = SIGNATURE_BY_OID[sigOid];
  if (scheme === undefined) throw new Rfc3161Error('SIGNATURE_INVALID', `unsupported signature algorithm ${sigOid}`);
  const signature = Buffer.from(expectTag(fields[5], TAG.OCTET_STRING, 'SignerInfo.signature').content);

  const attrs = children(signedAttrs);
  const contentType = signedAttribute(attrs, OID_ATTR_CONTENT_TYPE)[0];
  if (contentType === undefined || decodeOid(contentType) !== OID_CT_TSTINFO) {
    throw new Rfc3161Error('SIGNATURE_INVALID', 'signed contentType is not id-ct-TSTInfo');
  }
  const messageDigest = expectTag(signedAttribute(attrs, OID_ATTR_MESSAGE_DIGEST)[0], TAG.OCTET_STRING, 'messageDigest');
  if (!createHash(digest).update(tstInfoDer).digest().equals(messageDigest.content)) {
    throw new Rfc3161Error('SIGNATURE_INVALID', 'messageDigest does not match the TSTInfo');
  }
  // RFC 5652 §5.4 — the signature covers the signedAttrs re-encoded with the SET tag.
  const signedBytes = Buffer.concat([Buffer.from([TAG.SET]), signedAttrs.raw.subarray(1)]);
  const hash = scheme.hash ?? digest;

  if (certificates.length === 0) throw new Rfc3161Error('CERTIFICATE_INVALID', 'the token carries no certificate (certReq was set)');
  for (const der of certificates) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(der);
    } catch {
      continue;
    }
    if (verifyWithCertificate(cert, scheme, hash, signedBytes, signature)) return cert;
  }
  throw new Rfc3161Error('SIGNATURE_INVALID', 'no embedded certificate verifies the token signature');
}

/**
 * Parse and verify a DER TimeStampResp against the request it answers. Throws
 * Rfc3161Error on any failure; never returns an unverified token.
 */
export function verifyTimeStampResponse(responseDer: Uint8Array, expected: VerifyExpectations): VerifiedTimeStamp {
  try {
    return verifyUnsafe(responseDer, expected);
  } catch (e) {
    if (e instanceof Rfc3161Error) throw e;
    if (e instanceof DerError) throw new Rfc3161Error('MALFORMED', e.message);
    throw new Rfc3161Error('MALFORMED', (e as Error).message);
  }
}

function verifyUnsafe(responseDer: Uint8Array, expected: VerifyExpectations): VerifiedTimeStamp {
  const resp = children(expectTag(parseDer(responseDer), TAG.SEQUENCE, 'TimeStampResp'));
  const statusInfo = children(expectTag(resp[0], TAG.SEQUENCE, 'PKIStatusInfo'));
  const status = Number(decodeInteger(expectTag(statusInfo[0], TAG.INTEGER, 'PKIStatus')));
  if (status !== 0 && status !== 1) {
    const text = statusInfo[1]?.tag === TAG.SEQUENCE ? children(statusInfo[1]).map((s) => s.content.toString('utf8')).join('; ') : '';
    throw new Rfc3161Error('REJECTED', `TSA status ${status}${text !== '' ? ` (${text})` : ''}`);
  }
  const tokenNode = resp[1];
  if (tokenNode === undefined) malformed('granted response carries no timeStampToken');
  const token = parseToken(tokenNode);
  const tst = parseTstInfo(token.tstInfoDer);

  if (tst.imprintAlgorithm !== OID_SHA256 || !tst.imprint.equals(expected.sha256)) {
    throw new Rfc3161Error('IMPRINT_MISMATCH', 'messageImprint does not match the requested SHA-256 digest');
  }
  if (tst.nonce === null || tst.nonce !== nonceValue(expected.nonce)) {
    throw new Rfc3161Error('NONCE_MISMATCH', 'nonce does not match the request');
  }
  const skew = expected.maxClockSkewMs ?? 300_000;
  if (Math.abs(tst.genTime.getTime() - expected.now.getTime()) > skew) {
    throw new Rfc3161Error('GEN_TIME_OUT_OF_RANGE', `genTime ${tst.genTime.toISOString()} is outside the allowed clock skew`);
  }

  const cert = verifySignerInfo(token.signerInfos[0] as DerNode, token.tstInfoDer, token.certificates);
  if (!(cert.keyUsage ?? []).includes(OID_KP_TIMESTAMPING)) {
    throw new Rfc3161Error('CERTIFICATE_INVALID', 'the signing certificate lacks the id-kp-timeStamping extended key usage');
  }
  const gen = tst.genTime.getTime();
  if (gen < new Date(cert.validFrom).getTime() || gen > new Date(cert.validTo).getTime()) {
    throw new Rfc3161Error('CERTIFICATE_INVALID', 'genTime is outside the signing certificate validity');
  }

  return {
    status,
    token_der: Buffer.from(tokenNode.raw),
    gen_time: tst.genTime,
    serial_number: tst.serial.toString(16).toUpperCase(),
    policy_oid: tst.policy_oid,
    hash_algorithm: 'SHA-256',
    message_imprint_sha256: tst.imprint.toString('hex'),
    nonce: expected.nonce.toString('hex'),
    tsa_name: cert.subject.replace(/\n/g, ', '),
    tsa_certificate_sha256: createHash('sha256').update(cert.raw).digest('hex'),
  };
}
