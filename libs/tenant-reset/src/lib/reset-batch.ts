// Track-0 (Tenant Reset & Archive, Directive v1.0 LOCKED §2.1) — the
// shared types for the append-only ResetBatch administrative record and
// the reset run itself.

/** The frozen reason code for the enterprise requisition-model reset (§2). */
export const RESET_REASON = 'ENTERPRISE_REQUISITION_MODEL_RESET' as const;

/** The terminal disposition of a single ResetBatch append (§2.1). */
export type ResetResult = 'COMPLETED' | 'FAILED' | 'ABORTED';

/** Per-entity before/after row counts. `after` is null for a dry run. */
export interface EntityCount {
  readonly before: number;
  readonly after: number | null;
}

/**
 * `rows_by_entity` payload (§2.1): exact counts before and after, for the
 * deleted entities AND the preserved entities. Two maps so the preserve
 * invariant (§6 — every preserved count identical) is machine-checkable
 * from the record alone.
 */
export interface RowsByEntity {
  readonly deleted: Record<string, EntityCount>;
  readonly preserved: Record<string, EntityCount>;
}

/** One ResetBatch to append (§2.1). Append-only — never mutated. */
export interface RecordResetBatchInput {
  readonly tenant_id: string;
  readonly reason: string;
  /** The human who authorised — NOT the executing process (§2.1). */
  readonly approved_by: string;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly archive_location: string | null;
  readonly archive_checksum: string | null;
  readonly rows_by_entity: RowsByEntity;
  /** The SHA the tool ran at (§2.1). */
  readonly execution_commit: string;
  readonly dry_run: boolean;
  readonly result: ResetResult;
}

/** A persisted ResetBatch, read back. */
export interface ResetBatch extends RecordResetBatchInput {
  readonly id: string;
  readonly created_at: Date;
}
