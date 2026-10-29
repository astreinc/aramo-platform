// Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §2 R-1/R-3, §4 D-2/D-3 —
// the talent-erasure engine's view of Aramo Sign. Sign owns the sign schema: the engine
// never reads or writes it, it asks Sign through this port (the CLI binds the HTTP
// client of the Sign-owned contract; specs bind a fake), exactly as it asks object
// storage to purge through ErasureObjectStore.

export interface SignErasureScope {
  tenant_id: string;
  record_ids: string[];
  /** The talent's documents (documents."DocumentAssociation"): Sign blocks when an envelope covers one. */
  document_refs: string[];
}

export interface SignErasureHolder {
  holder: string;
  classification: 'LEGAL_HOLD' | 'PENDING_PO_LEGAL' | 'PENDING_OUTBOX_DRAIN';
  count: number;
  reason: string;
}

export interface SignErasureCounts {
  idempotency_keys: number;
  api_idempotency_keys: number;
  outbox_events: number;
}

export type SignEraseResult =
  | { status: 'erased'; counts: SignErasureCounts }
  | { status: 'blocked'; holders: SignErasureHolder[] };

export interface SignErasurePort {
  /** Read-only: the Sign holders that block this erasure, and what erase() would delete. */
  preflight(scope: SignErasureScope): Promise<{ holders: SignErasureHolder[]; erasable: SignErasureCounts }>;
  /** Sign erases what it may (idempotent by run). A throw is a failed attempt, never success. */
  erase(scope: SignErasureScope & { run_id: string }): Promise<SignEraseResult>;
}
