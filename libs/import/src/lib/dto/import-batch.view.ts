import type {
  ImportBatchStatus,
  ImportTargetEntity,
} from './import-target-entity.js';

// PR-A8-1 — public shape of the ImportBatch row, returned on POST
// /v1/imports (the run outcome) and GET /v1/imports/:id.

export interface ImportBatchView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  imported_by_id: string;
  target_entity: ImportTargetEntity;
  source_filename: string;
  row_count: number;
  success_count: number;
  failure_count: number;
  status: ImportBatchStatus;
  created_at: string;
  committed_at: string | null;
  reverted_at: string | null;
}

// PR-A8-1 — the failed-rows artifact (GET /v1/imports/:id/failures).
// One entry per failed row; the recruiter fixes the source and
// re-imports. row_number is 1-based.
export interface ImportFailureView {
  id: string;
  tenant_id: string;
  import_batch_id: string;
  row_number: number;
  failure_reason: string;
  offending_fields: string[];
  original_row_data: Record<string, unknown>;
  created_at: string;
}
