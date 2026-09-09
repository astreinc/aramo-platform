// CI-B6 — the immutable Requisition-snapshot read seam. B6 grounds against the
// B2 RequisitionAnalysisContextSnapshot ONLY (never the mutable Requisition /
// GoldenProfile). The composition root binds this to the B2 snapshot service;
// the lib depends on the narrow read, so the processing service stays testable.

export interface RequisitionSnapshotView {
  readonly id: string;
  readonly source_requisition_version: number;
  /** The immutable, typed recruiting-context payload (B2 RequisitionAnalysisContextV1). */
  readonly context: unknown;
}

export interface RequisitionSnapshotSource {
  getSnapshot(tenantId: string, snapshotId: string): Promise<RequisitionSnapshotView | null>;
}

export const REQUISITION_SNAPSHOT_SOURCE = 'CI_REQUISITION_SNAPSHOT_SOURCE';
