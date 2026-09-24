import { createHash } from 'node:crypto';

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
