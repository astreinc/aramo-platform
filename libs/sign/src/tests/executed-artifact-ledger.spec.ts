import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EXECUTED_DOCUMENT_RECORDED,
  EXECUTION_CERTIFICATE_RECORDED,
  ExecutedArtifactLedgerMismatchError,
} from '../lib/domain/executed-artifact-integrity.js';
import { resolveArtifactHashes, type ExecutedDocumentRow, type ExecutionCertificateRow } from '../lib/executed-artifact-ledger.js';

// SX-1 item 3 — the evidence manifest's artifact hashes come from the ledger, list
// EVERY executed document, and are refused when ledger and row disagree.

const hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s));

function doc(id: string, envelope_document_id: string, content: string): ExecutedDocumentRow {
  const b = bytes(content);
  return { id, envelope_document_id, source_sha256: `src-${id}`, executed_sha256: hex(b), byte_size: b.byteLength, executed_bytes: b };
}
function cert(id: string, content: string): ExecutionCertificateRow {
  const b = bytes(content);
  return { id, certificate_sha256: hex(b), byte_size: b.byteLength, certificate_bytes: b };
}
const docEvent = (d: ExecutedDocumentRow, over: Record<string, unknown> = {}) => ({
  event_type: EXECUTED_DOCUMENT_RECORDED,
  payload: { sha256: d.executed_sha256, byte_size: d.byte_size, artifact_id: d.id, artifact_kind: 'EXECUTED_DOCUMENT', source_sha256: d.source_sha256, envelope_document_id: d.envelope_document_id, ...over },
});
const certEvent = (c: ExecutionCertificateRow, over: Record<string, unknown> = {}) => ({
  event_type: EXECUTION_CERTIFICATE_RECORDED,
  payload: { sha256: c.certificate_sha256, byte_size: c.byte_size, artifact_id: c.id, artifact_kind: 'EXECUTION_CERTIFICATE', envelope_document_id: null, ...over },
});

const ENV = 'env-1';
const D1 = doc('a1', 'ed-1', 'first executed pdf');
const D2 = doc('a2', 'ed-2', 'second executed pdf');
const C = cert('c1', 'certificate pdf');

function refusal(fn: () => unknown): ExecutedArtifactLedgerMismatchError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ExecutedArtifactLedgerMismatchError);
    return e as ExecutedArtifactLedgerMismatchError;
  }
  throw new Error('expected ExecutedArtifactLedgerMismatchError');
}

describe('resolveArtifactHashes (SX-1 item 3)', () => {
  it('lists EVERY executed document from the ledger, in document ordinal order, plus the certificate', () => {
    const r = resolveArtifactHashes({
      envelope_id: ENV,
      document_order: ['ed-1', 'ed-2'],
      documents: [D2, D1],
      certificate: C,
      events: [docEvent(D1), docEvent(D2), certEvent(C)],
    });
    expect(r.source).toBe('LEDGER');
    expect(r.executed_documents.map((d) => [d.envelope_document_id, d.sha256, d.byte_size, d.artifact_id])).toEqual([
      ['ed-1', D1.executed_sha256, D1.byte_size, 'a1'],
      ['ed-2', D2.executed_sha256, D2.byte_size, 'a2'],
    ]);
    expect(r.certificate).toEqual({ artifact_id: 'c1', envelope_document_id: null, sha256: C.certificate_sha256, byte_size: C.byte_size });
  });

  it('nothing produced yet → NONE, empty list', () => {
    expect(resolveArtifactHashes({ envelope_id: ENV, document_order: ['ed-1'], documents: [], certificate: null, events: [] })).toEqual({
      source: 'NONE',
      executed_documents: [],
      certificate: null,
    });
  });

  it('fails closed when the ledger hash differs from the row hash', () => {
    const e = refusal(() =>
      resolveArtifactHashes({ envelope_id: ENV, document_order: ['ed-1'], documents: [D1], certificate: null, events: [docEvent(D1, { sha256: 'f'.repeat(64) })] }),
    );
    expect(e.reason).toBe('hash_mismatch');
    expect(e.code).toBe('EXECUTED_ARTIFACT_LEDGER_MISMATCH');
    expect(e.artifact_id).toBe('a1');
  });

  it('fails closed when the certificate ledger hash differs', () => {
    const e = refusal(() =>
      resolveArtifactHashes({ envelope_id: ENV, document_order: [], documents: [], certificate: C, events: [certEvent(C, { sha256: '0'.repeat(64) })] }),
    );
    expect([e.artifact_kind, e.reason]).toEqual(['EXECUTION_CERTIFICATE', 'hash_mismatch']);
  });

  it('fails closed on a byte-size mismatch', () => {
    const e = refusal(() =>
      resolveArtifactHashes({ envelope_id: ENV, document_order: ['ed-1'], documents: [D1], certificate: null, events: [docEvent(D1, { byte_size: 1 })] }),
    );
    expect(e.reason).toBe('byte_size_mismatch');
  });

  it('fails closed when the stored bytes no longer digest to the stored hash', () => {
    const tampered = { ...D1, executed_bytes: bytes('tampered bytes') };
    const e = refusal(() => resolveArtifactHashes({ envelope_id: ENV, document_order: ['ed-1'], documents: [tampered], certificate: null, events: [docEvent(D1)] }));
    expect(e.reason).toBe('bytes_digest_mismatch');
  });

  it('fails closed when a row has no ledger record but others do (never treated as legacy)', () => {
    const e = refusal(() =>
      resolveArtifactHashes({ envelope_id: ENV, document_order: ['ed-1', 'ed-2'], documents: [D1, D2], certificate: null, events: [docEvent(D1)] }),
    );
    expect([e.artifact_id, e.reason]).toEqual(['a2', 'row_without_ledger']);
  });

  it('fails closed when a ledger record has no row', () => {
    const e = refusal(() =>
      resolveArtifactHashes({ envelope_id: ENV, document_order: ['ed-1', 'ed-2'], documents: [D1], certificate: null, events: [docEvent(D1), docEvent(D2)] }),
    );
    expect([e.artifact_id, e.reason]).toEqual(['a2', 'ledger_without_row']);
  });

  it('fails closed on a duplicate or unreadable ledger record', () => {
    expect(
      refusal(() => resolveArtifactHashes({ envelope_id: ENV, document_order: ['ed-1'], documents: [D1], certificate: null, events: [docEvent(D1), docEvent(D1)] })).reason,
    ).toBe('duplicate_ledger_record');
    expect(
      refusal(() =>
        resolveArtifactHashes({ envelope_id: ENV, document_order: ['ed-1'], documents: [D1], certificate: null, events: [{ event_type: EXECUTED_DOCUMENT_RECORDED, payload: { sha256: 1 } }] }),
      ).reason,
    ).toBe('ledger_record_unreadable');
  });

  it('a legacy envelope (rows, no ledger record at all) uses the row hashes and says so', () => {
    const r = resolveArtifactHashes({ envelope_id: ENV, document_order: ['ed-1', 'ed-2'], documents: [D2, D1], certificate: C, events: [] });
    expect(r.source).toBe('LEGACY_UNLEDGERED_ROW');
    expect(r.executed_documents.map((d) => d.sha256)).toEqual([D1.executed_sha256, D2.executed_sha256]);
    expect(r.certificate?.sha256).toBe(C.certificate_sha256);
  });

  it('a legacy envelope whose stored bytes do not digest to the row hash is still refused', () => {
    const e = refusal(() =>
      resolveArtifactHashes({ envelope_id: ENV, document_order: ['ed-1'], documents: [{ ...D1, executed_bytes: bytes('x') }], certificate: null, events: [] }),
    );
    expect(e.reason).toBe('bytes_digest_mismatch');
  });
});
