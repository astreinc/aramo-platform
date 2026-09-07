import type { RequisitionAnalysisContextV1 } from './requisition-analysis-context.js';

// CI-B2 — the read-side projection of a RequisitionAnalysisContextSnapshot
// row. The `context` is deserialized to the typed
// RequisitionAnalysisContextV1 shape on read. This is what a future CI
// run binds to by stable `id`.
export interface RequisitionAnalysisContextSnapshotView {
  id: string;
  tenant_id: string;
  requisition_id: string;
  source_requisition_version: number;
  golden_profile_id: string | null;
  snapshot_schema_version: string;
  context: RequisitionAnalysisContextV1;
  captured_at: Date;
  created_at: Date;
}
