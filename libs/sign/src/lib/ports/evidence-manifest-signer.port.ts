import { constants as cryptoConstants, createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

import { Injectable } from '@nestjs/common';

// DOC-3 R19/§262 — the EvidenceManifestSignerPort ABSTRACTION exists from the
// E-Sign core. DOC-3 ships a SOFTWARE signer; the AWS-KMS-backed production
// signer is DOC-4 and alters no domain semantics (the port stays identical).
// The private signing key MUST NOT be exportable into app config/source — the
// software signer here is a deterministic development/stub signer, clearly NOT
// the production KMS signer.

export const EVIDENCE_MANIFEST_SIGNER_PORT = 'EVIDENCE_MANIFEST_SIGNER_PORT';

export interface EvidenceManifest {
  envelope_id: string;
  source_sha256: string | null;
  executed_sha256: string | null;
  event_chain_hash: string;
  disclosure_hash: string | null;
  execution_manifest_hash: string;
  consent_version: string | null;
  signers: string[];
  completed_at: string | null;
  service_version: string;
  // Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED SX-1
  // item 3 — EVERY executed document's hash and the certificate's, taken from the
  // append-only ledger. `artifact_hash_source` says where they came from: LEDGER,
  // LEGACY_UNLEDGERED_ROW (completed before SX-1, no ledger record, bytes
  // re-digested), or NONE (nothing produced yet). Optional only so manifests built
  // by other callers still type-check; EsignService always sets them.
  executed_documents?: EvidenceArtifactHash[];
  certificate?: EvidenceArtifactHash | null;
  artifact_hash_source?: EvidenceArtifactHashSource;
}

export type EvidenceArtifactHashSource = 'LEDGER' | 'LEGACY_UNLEDGERED_ROW' | 'NONE';

export interface EvidenceArtifactHash {
  artifact_id: string;
  envelope_document_id: string | null;
  sha256: string;
  byte_size: number;
  source_sha256?: string;
}

export interface SignedEvidenceManifest {
  manifest: EvidenceManifest;
  signature: string;
  signature_algorithm: string;
  kms_key_version_ref: string | null;
  signing_timestamp: string;
}

export interface EvidenceManifestSignerPort {
  sign(manifest: EvidenceManifest, signingTimestamp: string): Promise<SignedEvidenceManifest>;
  verify(signed: SignedEvidenceManifest): Promise<boolean>;
}

// DOC-3 software signer: sha256 HMAC-less digest over the canonical manifest.
// Deterministic + independently verifiable. NOT the KMS production signer (DOC-4).
@Injectable()
export class SoftwareEvidenceManifestSigner implements EvidenceManifestSignerPort {
  static readonly ALGORITHM = 'SHA256-SOFTWARE-DOC3';

  private digest(manifest: EvidenceManifest): string {
    return createHash('sha256').update(JSON.stringify(manifest)).digest('base64url');
  }

  async sign(manifest: EvidenceManifest, signingTimestamp: string): Promise<SignedEvidenceManifest> {
    return {
      manifest,
      signature: this.digest(manifest),
      signature_algorithm: SoftwareEvidenceManifestSigner.ALGORITHM,
      kms_key_version_ref: null,
      signing_timestamp: signingTimestamp,
    };
  }

  async verify(signed: SignedEvidenceManifest): Promise<boolean> {
    return signed.signature === this.digest(signed.manifest);
  }
}

// SX-1 item 4 / LC-3 — a plain SHA-256 digest (above) is an INTEGRITY digest, not
// a cryptographic signature. The production signer is the asymmetric AWS KMS
// signer (apps/sign-service KmsEvidenceManifestSigner). The helpers below are the
// key-free half of that scheme: anyone holding the KMS PUBLIC key (GetPublicKey,
// DER SubjectPublicKeyInfo) can verify a signed manifest offline — tests and the
// recovery-validation tooling use this without any KMS call.

// Prefix the KMS signer writes into `signature_algorithm` (e.g. "KMS:ECDSA_SHA_256").
export const KMS_SIGNATURE_ALGORITHM_PREFIX = 'KMS:';

export type KmsEvidenceSigningAlgorithm =
  | 'ECDSA_SHA_256'
  | 'ECDSA_SHA_384'
  | 'ECDSA_SHA_512'
  | 'RSASSA_PSS_SHA_256'
  | 'RSASSA_PSS_SHA_384'
  | 'RSASSA_PSS_SHA_512'
  | 'RSASSA_PKCS1_V1_5_SHA_256'
  | 'RSASSA_PKCS1_V1_5_SHA_384'
  | 'RSASSA_PKCS1_V1_5_SHA_512';

const KMS_ALGORITHM_HASH: Record<KmsEvidenceSigningAlgorithm, 'sha256' | 'sha384' | 'sha512'> = {
  ECDSA_SHA_256: 'sha256',
  ECDSA_SHA_384: 'sha384',
  ECDSA_SHA_512: 'sha512',
  RSASSA_PSS_SHA_256: 'sha256',
  RSASSA_PSS_SHA_384: 'sha384',
  RSASSA_PSS_SHA_512: 'sha512',
  RSASSA_PKCS1_V1_5_SHA_256: 'sha256',
  RSASSA_PKCS1_V1_5_SHA_384: 'sha384',
  RSASSA_PKCS1_V1_5_SHA_512: 'sha512',
};

export function isKmsEvidenceSigningAlgorithm(value: string): value is KmsEvidenceSigningAlgorithm {
  return Object.prototype.hasOwnProperty.call(KMS_ALGORITHM_HASH, value);
}

// The hash a KMS signing algorithm signs over (KMS DIGEST mode needs the caller's
// digest to use the algorithm's own hash).
export function kmsEvidenceAlgorithmHash(algorithm: KmsEvidenceSigningAlgorithm): 'sha256' | 'sha384' | 'sha512' {
  return KMS_ALGORITHM_HASH[algorithm];
}

// The exact bytes the evidence signature covers: the canonical manifest JSON.
export function canonicalEvidenceManifestBytes(manifest: EvidenceManifest): Buffer {
  return Buffer.from(JSON.stringify(manifest), 'utf8');
}

/**
 * Verify a KMS-signed evidence manifest with the KMS key's PUBLIC key (DER
 * SubjectPublicKeyInfo, as returned by KMS GetPublicKey). Fails closed: any
 * non-KMS algorithm, unsupported algorithm, malformed key or bad signature
 * returns false. KMS RSASSA-PSS uses a salt as long as the digest.
 */
export function verifyKmsEvidenceSignatureWithPublicKey(
  signed: SignedEvidenceManifest,
  publicKeySpkiDer: Uint8Array,
): boolean {
  if (!signed.signature_algorithm.startsWith(KMS_SIGNATURE_ALGORITHM_PREFIX)) return false;
  const algorithm = signed.signature_algorithm.slice(KMS_SIGNATURE_ALGORITHM_PREFIX.length);
  if (!isKmsEvidenceSigningAlgorithm(algorithm)) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiDer), format: 'der', type: 'spki' });
    const signature = Buffer.from(signed.signature, 'base64url');
    const message = canonicalEvidenceManifestBytes(signed.manifest);
    const hash = kmsEvidenceAlgorithmHash(algorithm);
    if (algorithm.startsWith('ECDSA_')) {
      if (key.asymmetricKeyType !== 'ec') return false;
      return cryptoVerify(hash, message, { key, dsaEncoding: 'der' }, signature);
    }
    if (key.asymmetricKeyType !== 'rsa') return false;
    if (algorithm.startsWith('RSASSA_PSS_')) {
      return cryptoVerify(
        hash,
        message,
        { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST },
        signature,
      );
    }
    return cryptoVerify(hash, message, { key, padding: cryptoConstants.RSA_PKCS1_PADDING }, signature);
  } catch {
    return false;
  }
}
