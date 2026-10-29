// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED SX-1
// items 1 and 3 — executed artifacts (ExecutedDocument, ExecutionCertificate) are
// insert-only, and each one's SHA-256, byte size and id is recorded independently
// in the append-only SignatureEvent ledger at completion. The evidence manifest
// takes artifact hashes from the ledger and fails closed when ledger and row
// disagree.
//
// Not yet mapped to a registered AramoError code at the sign-service HTTP
// boundary: an unmapped error surfaces as INTERNAL_ERROR (500), which is fail
// closed.

export type ExecutedArtifactKind = 'EXECUTED_DOCUMENT' | 'EXECUTION_CERTIFICATE';

// Ledger event types (SignatureEvent.event_type is unconstrained TEXT, so these
// constants are the single source of the names).
export const EXECUTED_DOCUMENT_RECORDED = 'EXECUTED_DOCUMENT_RECORDED';
export const EXECUTION_CERTIFICATE_RECORDED = 'EXECUTION_CERTIFICATE_RECORDED';
export const EXECUTED_ARTIFACT_INTEGRITY_CONFLICT = 'EXECUTED_ARTIFACT_INTEGRITY_CONFLICT';

// The hashed ledger payload of an *_RECORDED event.
export interface ExecutedArtifactRecordedPayload {
  artifact_kind: ExecutedArtifactKind;
  artifact_id: string;
  envelope_document_id: string | null;
  sha256: string;
  byte_size: number;
  source_sha256?: string;
}

// SX-1 item 1 — a second write for an artifact that already exists carried
// DIFFERENT bytes. Nothing is overwritten; an append-only
// EXECUTED_ARTIFACT_INTEGRITY_CONFLICT event has been recorded.
export class ExecutedArtifactIntegrityConflictError extends Error {
  readonly code = 'EXECUTED_ARTIFACT_INTEGRITY_CONFLICT';
  constructor(
    public readonly artifact_kind: ExecutedArtifactKind,
    public readonly artifact_id: string,
    public readonly existing_sha256: string,
    public readonly attempted_sha256: string,
  ) {
    super(`${artifact_kind} ${artifact_id} already exists with a different SHA-256; nothing was overwritten`);
    this.name = 'ExecutedArtifactIntegrityConflictError';
  }
}

// SX-1 item 3 — the ledger record of an executed artifact and the stored row
// disagree (or one exists without the other). The evidence manifest is refused.
export type ExecutedArtifactLedgerMismatchReason =
  | 'hash_mismatch'
  | 'byte_size_mismatch'
  | 'bytes_digest_mismatch'
  | 'ledger_without_row'
  | 'row_without_ledger'
  | 'duplicate_ledger_record'
  | 'ledger_record_unreadable';

export class ExecutedArtifactLedgerMismatchError extends Error {
  readonly code = 'EXECUTED_ARTIFACT_LEDGER_MISMATCH';
  constructor(
    public readonly envelope_id: string,
    public readonly artifact_kind: ExecutedArtifactKind,
    public readonly artifact_id: string,
    public readonly reason: ExecutedArtifactLedgerMismatchReason,
  ) {
    super(`Evidence refused for envelope ${envelope_id}: ${artifact_kind} ${artifact_id} ${reason}`);
    this.name = 'ExecutedArtifactLedgerMismatchError';
  }
}

export function readRecordedPayload(payload: unknown): ExecutedArtifactRecordedPayload | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p['artifact_kind'] !== 'EXECUTED_DOCUMENT' && p['artifact_kind'] !== 'EXECUTION_CERTIFICATE') return null;
  if (typeof p['artifact_id'] !== 'string' || typeof p['sha256'] !== 'string' || typeof p['byte_size'] !== 'number') return null;
  return {
    artifact_kind: p['artifact_kind'],
    artifact_id: p['artifact_id'],
    envelope_document_id: typeof p['envelope_document_id'] === 'string' ? p['envelope_document_id'] : null,
    sha256: p['sha256'],
    byte_size: p['byte_size'],
    ...(typeof p['source_sha256'] === 'string' ? { source_sha256: p['source_sha256'] } : {}),
  };
}
