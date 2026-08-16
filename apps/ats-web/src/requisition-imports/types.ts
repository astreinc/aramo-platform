// T8-P3 — hand-mirrored read DTOs for the provider-neutral requisition-ingestion
// monitoring surface (VMS Integration §16). ats-web stays a leaf HTTP consumer
// (the no-@aramo/* backend-import rule): this re-declares the public read shape
// libs/import owns. If a backend field lands, this file follows in lock-step.
//
// STATUS uses the CANONICAL backend values (libs/import ImportBatchStatus), NOT
// the stale settings/admin-types aliases (`partial`/`failed`) — directive §13.

export type RequisitionImportStatus =
  | 'pending'
  | 'committed'
  | 'partially_committed'
  | 'rejected'
  | 'reverted';

export const REQUISITION_IMPORT_STATUS_VALUES: readonly RequisitionImportStatus[] = [
  'pending',
  'committed',
  'partially_committed',
  'rejected',
  'reverted',
];

// Mirror of libs/import dto/import-batch.view.ts (ImportBatchView). Only the
// fields P3 renders + the identity/site fields needed for keys/context. Internal
// identifiers (tenant_id, imported_by_id) are intentionally NOT displayed (§7).
export interface ImportBatchView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly imported_by_id: string;
  readonly target_entity: string; // 'requisition' for this surface
  readonly source_filename: string; // the non-secret source label
  readonly row_count: number;
  readonly success_count: number;
  readonly failure_count: number;
  readonly status: RequisitionImportStatus;
  readonly created_at: string;
  readonly committed_at: string | null;
  readonly reverted_at: string | null;
}
