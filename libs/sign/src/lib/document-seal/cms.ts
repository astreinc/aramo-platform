// Feature-Parity Directive v1.0 §1.15 — the CMS SignedData (RFC 5652) of a PAdES
// baseline signature (ETSI EN 319 142-1, SubFilter ETSI.CAdES.detached):
//   - detached: encapContentInfo is id-data with no eContent; the signed content is the
//     PDF ByteRange;
//   - signed attributes: content-type, message-digest and ESS signing-certificate-v2
//     (RFC 5035). No signing-time attribute: in PAdES the claimed time is the signature
//     dictionary's /M (EN 319 142-1 §5.2);
//   - B-T: the unsigned signature-time-stamp attribute carries an RFC 3161 token over
//     the SHA-256 of the signature value (RFC 3161 Appendix A).
// RSA keys only (RSASSA-PKCS1-v1_5 with SHA-256), which is what the AATL seal services
// issue. The private key never reaches this code: the provider signs the digest.

import { createHash } from 'node:crypto';

import { type DocumentSealIdentity } from '../ports/document-seal.port.js';

import { child, children, context, derNull, integer, octetString, oid, parse, readOid, seq, setOf, TAG } from './der.js';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  signatureTimeStampToken: '1.2.840.113549.1.9.16.2.14',
} as const;

export class DocumentSealCmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentSealCmsError';
  }
}

export interface CertificateFacts {
  issuer_der: Buffer; // the issuer Name, DER
  serial_der: Buffer; // the serialNumber INTEGER, DER
  subject_der: Buffer;
  spki_der: Buffer;
  sha256: Buffer;
  public_key_algorithm: string; // OID
}

/** Read the fields of an X.509 certificate the seal needs. */
export function certificateFacts(certificate_der: Buffer): CertificateFacts {
  const cert = parse(certificate_der);
  const tbs = child(cert, 0);
  const fields = children(tbs);
  // version is [0] EXPLICIT and optional (absent = v1).
  const offset = (fields[0]?.tag ?? 0) === 0xa0 ? 1 : 0;
  const serial = fields[offset];
  const issuer = fields[offset + 2];
  const subject = fields[offset + 4];
  const spki = fields[offset + 5];
  if (serial === undefined || issuer === undefined || subject === undefined || spki === undefined || serial.tag !== TAG.INTEGER) {
    throw new DocumentSealCmsError('signing certificate is not a well-formed X.509 certificate');
  }
  return {
    issuer_der: issuer.raw,
    serial_der: serial.raw,
    subject_der: subject.raw,
    spki_der: spki.raw,
    sha256: createHash('sha256').update(certificate_der).digest(),
    public_key_algorithm: readOid(child(child(spki, 0), 0)),
  };
}

const algorithm = (dotted: string, withNull: boolean): Buffer => (withNull ? seq(oid(dotted), derNull()) : seq(oid(dotted)));
const attribute = (type: string, ...values: Buffer[]): Buffer => seq(oid(type), setOf(...values));

/**
 * The DER SET OF signed attributes. Its SHA-256 is what the provider signs; inside the
 * SignerInfo the same bytes carry the [0] IMPLICIT tag (RFC 5652 §5.4).
 */
export function signedAttributes(contentDigest: Buffer, facts: CertificateFacts): Buffer {
  // ESSCertIDv2: hashAlgorithm defaults to SHA-256 and is omitted (DER), certHash,
  // issuerSerial { GeneralNames { directoryName [4] issuer }, serialNumber }.
  const issuerSerial = seq(seq(context(4, facts.issuer_der)), facts.serial_der);
  const signingCertificateV2 = seq(seq(seq(octetString(facts.sha256), issuerSerial)));
  return setOf(
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octetString(contentDigest)),
    attribute(OID.signingCertificateV2, signingCertificateV2),
  );
}

export interface SignedDataInput {
  identity: DocumentSealIdentity;
  facts: CertificateFacts;
  signed_attributes: Buffer; // the DER SET from signedAttributes()
  signature: Buffer;
  timestamp_token_der?: Buffer; // B-T
}

/** The ContentInfo { signedData } that goes in the PDF /Contents. */
export function signedData(input: SignedDataInput): Buffer {
  const implicitSignedAttrs = Buffer.concat([Buffer.from([0xa0]), input.signed_attributes.subarray(1)]);
  const unsigned = input.timestamp_token_der !== undefined
    ? [context(1, attribute(OID.signatureTimeStampToken, input.timestamp_token_der))]
    : [];
  const signerInfo = seq(
    integer(1),
    seq(input.facts.issuer_der, input.facts.serial_der),
    algorithm(OID.sha256, false),
    implicitSignedAttrs,
    algorithm(OID.rsaEncryption, true),
    octetString(input.signature),
    ...unsigned,
  );
  const certificates = context(0, Buffer.concat([input.identity.certificate_der, ...input.identity.chain_der]));
  const sd = seq(
    integer(1),
    setOf(algorithm(OID.sha256, false)),
    seq(oid(OID.data)),
    certificates,
    setOf(signerInfo),
  );
  return seq(oid(OID.signedData), context(0, sd));
}

/** Guard: the seal signs with RSA only. */
export function assertRsa(facts: CertificateFacts): void {
  if (facts.public_key_algorithm !== OID.rsaEncryption) {
    throw new DocumentSealCmsError(`unsupported seal key algorithm ${facts.public_key_algorithm} (RSA required)`);
  }
}

/**
 * A vendor that answers a hash-signing request with a CMS instead of a raw signature:
 * the signature value of its (single) SignerInfo. Only a SignerInfo WITHOUT signed
 * attributes signs the submitted hash directly, so any other shape is refused. The
 * PAdES engine then verifies the value against the seal certificate (fail closed).
 */
export function signatureFromVendorCms(cms_der: Buffer): Buffer {
  const ci = parse(cms_der);
  if (readOid(child(ci, 0)) !== OID.signedData) throw new DocumentSealCmsError('vendor CMS is not SignedData');
  const sd = child(child(ci, 1), 0);
  const parts = children(sd);
  const infos = parts[parts.length - 1];
  if (infos === undefined || infos.tag !== TAG.SET) throw new DocumentSealCmsError('vendor CMS has no SignerInfos');
  const list = children(infos);
  if (list.length !== 1) throw new DocumentSealCmsError('vendor CMS must carry exactly one SignerInfo');
  const si = children(list[0] as ReturnType<typeof parse>);
  if (si.some((n) => n.tag === 0xa0)) throw new DocumentSealCmsError('vendor CMS signs its own attributes, not the submitted hash');
  const signature = si[4];
  if (signature === undefined || signature.tag !== TAG.OCTET_STRING) throw new DocumentSealCmsError('vendor CMS SignerInfo has no signature value');
  return Buffer.from(signature.content);
}
