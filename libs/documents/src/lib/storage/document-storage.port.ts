// DOC-1a — DocumentStoragePort (R4). The workflow-neutral storage contract the
// Documents domain depends on. Business code depends on THIS, never the AWS SDK.
//
// Mirrors the TranscriptArtifactStore precedent: a string DI token + interface
// in the boundary lib; the concrete AramoS3DocumentStorageAdapter is bound at
// the apps/api composition root over @aramo/object-storage — so libs/documents
// has ZERO nx edge to object-storage (scope:boundary neutrality preserved).
//
// applyRetention / applyLegalHold / createWriteAccess are declared but the
// DOC-1a adapter throws DocumentStorageNotSupportedError — the S3 Object
// Lock/WORM and generic presigned-write surface lands in the R27.1 increment.

export const DOCUMENT_STORAGE_PORT = 'DOCUMENT_STORAGE_PORT';

export interface PutArtifactInput {
  storage_key: string;
  body: Buffer;
  content_type: string;
  requestId: string;
}

export interface PutArtifactResult {
  storage_key: string;
  sha256: string;
}

export interface ReadAccess {
  url: string;
  expires_at: string;
}

export interface RetentionInput {
  storage_key: string;
  retain_until: Date;
  requestId: string;
}

export interface LegalHoldInput {
  storage_key: string;
  enabled: boolean;
  requestId: string;
}

export interface DocumentStoragePort {
  putArtifact(input: PutArtifactInput): Promise<PutArtifactResult>;
  getArtifact(input: { storage_key: string; requestId: string; maxBytes: number }): Promise<Buffer>;
  createReadAccess(input: {
    storage_key: string;
    requestId: string;
    expires_in_seconds?: number;
  }): Promise<ReadAccess>;
  createWriteAccess(input: { storage_key: string; content_type: string; requestId: string }): Promise<ReadAccess>;
  headArtifact(input: {
    storage_key: string;
    requestId: string;
  }): Promise<{ byte_length: number; content_type: string | undefined } | null>;
  verifyArtifact(input: {
    storage_key: string;
    expected_sha256: string;
    requestId: string;
    maxBytes: number;
  }): Promise<boolean>;
  applyRetention(input: RetentionInput): Promise<void>;
  applyLegalHold(input: LegalHoldInput): Promise<void>;
}
