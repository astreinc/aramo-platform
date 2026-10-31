import { createHash } from 'node:crypto';

import {
  EXECUTED_DOCUMENT_RECORDED,
  EXECUTION_CERTIFICATE_RECORDED,
  ExecutedArtifactLedgerMismatchError,
  readRecordedPayload,
  type ExecutedArtifactKind,
  type ExecutedArtifactRecordedPayload,
} from './domain/executed-artifact-integrity.js';
import { type EvidenceArtifactHash, type EvidenceArtifactHashSource } from './ports/evidence-manifest-signer.port.js';

// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED SX-1
// item 3 — the evidence manifest's artifact hashes come from the append-only
// ledger (EXECUTED_DOCUMENT_RECORDED / EXECUTION_CERTIFICATE_RECORDED), never from
// the mutable-by-superuser row alone. Every ledger record must match its row (hash,
// byte size, and the digest of the stored bytes) and every row must have exactly
// one ledger record, or the manifest is refused (fail closed).
//
// Legacy: an envelope completed before SX-1 has rows but no ledger records at all.
// Its hashes are taken from the rows (after the stored bytes are re-digested and
// match), and the manifest says so: artifact_hash_source = LEGACY_UNLEDGERED_ROW.
// A MIX (some rows recorded, some not) is never legacy and is refused.
//
// Purged (Retention and Purge directive W3/LD-4): a purged row keeps its hashes but
// not its bytes (NULL). Its bytes cannot be re-digested; its hash still has to match
// the ledger record, which is unchanged by a purge.

export const ARTIFACT_LEDGER_EVENT_TYPES: readonly string[] = [EXECUTED_DOCUMENT_RECORDED, EXECUTION_CERTIFICATE_RECORDED];

export interface ExecutedDocumentRow {
  id: string;
  envelope_document_id: string;
  source_sha256: string;
  executed_sha256: string;
  byte_size: number;
  executed_bytes: Uint8Array | null; // NULL once purged
}

export interface ExecutionCertificateRow {
  id: string;
  certificate_sha256: string;
  byte_size: number;
  certificate_bytes: Uint8Array | null; // NULL once purged
}

export interface ArtifactLedgerEvent {
  event_type: string;
  payload: unknown;
}

export interface ResolvedArtifactHashes {
  source: EvidenceArtifactHashSource;
  executed_documents: EvidenceArtifactHash[];
  certificate: EvidenceArtifactHash | null;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function resolveArtifactHashes(input: {
  envelope_id: string;
  // EnvelopeDocument ids in ordinal order; the manifest lists documents in it.
  document_order: readonly string[];
  documents: readonly ExecutedDocumentRow[];
  certificate: ExecutionCertificateRow | null;
  events: readonly ArtifactLedgerEvent[];
}): ResolvedArtifactHashes {
  const { envelope_id } = input;
  const refuse = (kind: ExecutedArtifactKind, id: string, reason: ConstructorParameters<typeof ExecutedArtifactLedgerMismatchError>[3]): never => {
    throw new ExecutedArtifactLedgerMismatchError(envelope_id, kind, id, reason);
  };

  // Ledger records by artifact id; a duplicate or unreadable record is refused.
  const ledger = new Map<string, ExecutedArtifactRecordedPayload>();
  for (const e of input.events) {
    if (!ARTIFACT_LEDGER_EVENT_TYPES.includes(e.event_type)) continue;
    const kind: ExecutedArtifactKind = e.event_type === EXECUTED_DOCUMENT_RECORDED ? 'EXECUTED_DOCUMENT' : 'EXECUTION_CERTIFICATE';
    const p = readRecordedPayload(e.payload);
    if (p === null || p.artifact_kind !== kind) return refuse(kind, 'unknown', 'ledger_record_unreadable');
    if (ledger.has(p.artifact_id)) return refuse(kind, p.artifact_id, 'duplicate_ledger_record');
    ledger.set(p.artifact_id, p);
  }

  // Every stored artifact's bytes must digest to its recorded hash (purged rows have none left).
  for (const d of input.documents) if (d.executed_bytes !== null && sha256Hex(d.executed_bytes) !== d.executed_sha256) refuse('EXECUTED_DOCUMENT', d.id, 'bytes_digest_mismatch');
  const c = input.certificate;
  if (c !== null && c.certificate_bytes !== null && sha256Hex(c.certificate_bytes) !== c.certificate_sha256) refuse('EXECUTION_CERTIFICATE', c.id, 'bytes_digest_mismatch');

  const order = new Map(input.document_order.map((id, i) => [id, i]));
  const byOrdinal = (a: { envelope_document_id: string | null; artifact_id: string }, b: { envelope_document_id: string | null; artifact_id: string }): number =>
    (order.get(a.envelope_document_id ?? '') ?? Number.MAX_SAFE_INTEGER) - (order.get(b.envelope_document_id ?? '') ?? Number.MAX_SAFE_INTEGER) ||
    a.artifact_id.localeCompare(b.artifact_id);

  if (ledger.size === 0) {
    if (input.documents.length === 0 && c === null) return { source: 'NONE', executed_documents: [], certificate: null };
    return {
      source: 'LEGACY_UNLEDGERED_ROW',
      executed_documents: input.documents
        .map((d): EvidenceArtifactHash => ({ artifact_id: d.id, envelope_document_id: d.envelope_document_id, sha256: d.executed_sha256, byte_size: d.byte_size, source_sha256: d.source_sha256 }))
        .sort(byOrdinal),
      certificate: c === null ? null : { artifact_id: c.id, envelope_document_id: null, sha256: c.certificate_sha256, byte_size: c.byte_size },
    };
  }

  const matched = new Set<string>();
  const check = (kind: ExecutedArtifactKind, id: string, envelope_document_id: string | null, sha256: string, byte_size: number): ExecutedArtifactRecordedPayload => {
    const rec = ledger.get(id);
    if (rec === undefined || rec.artifact_kind !== kind) return refuse(kind, id, 'row_without_ledger');
    if (rec.envelope_document_id !== envelope_document_id) return refuse(kind, id, 'hash_mismatch');
    if (rec.sha256 !== sha256) return refuse(kind, id, 'hash_mismatch');
    if (rec.byte_size !== byte_size) return refuse(kind, id, 'byte_size_mismatch');
    matched.add(id);
    return rec;
  };

  const executed_documents = input.documents
    .map((d): EvidenceArtifactHash => {
      const rec = check('EXECUTED_DOCUMENT', d.id, d.envelope_document_id, d.executed_sha256, d.byte_size);
      if (rec.source_sha256 !== undefined && rec.source_sha256 !== d.source_sha256) refuse('EXECUTED_DOCUMENT', d.id, 'hash_mismatch');
      // Hashes are the LEDGER's (equal to the row's by the checks above).
      return { artifact_id: rec.artifact_id, envelope_document_id: d.envelope_document_id, sha256: rec.sha256, byte_size: rec.byte_size, source_sha256: rec.source_sha256 ?? d.source_sha256 };
    })
    .sort(byOrdinal);
  let certificate: EvidenceArtifactHash | null = null;
  if (c !== null) {
    const rec = check('EXECUTION_CERTIFICATE', c.id, null, c.certificate_sha256, c.byte_size);
    certificate = { artifact_id: rec.artifact_id, envelope_document_id: null, sha256: rec.sha256, byte_size: rec.byte_size };
  }
  for (const [id, rec] of ledger) if (!matched.has(id)) refuse(rec.artifact_kind, id, 'ledger_without_row');

  return { source: 'LEDGER', executed_documents, certificate };
}
