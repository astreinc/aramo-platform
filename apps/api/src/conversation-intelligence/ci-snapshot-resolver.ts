import { Injectable } from '@nestjs/common';
import {
  RequisitionAnalysisContextSnapshotService,
  type RequisitionAnalysisContextSnapshotView,
} from '@aramo/conversation-intelligence';

// CI-B6P §18 — capture/reuse of the immutable B2 Requisition snapshot at
// scheduling time. To keep scheduling IDEMPOTENT (a duplicate normalized-ready
// signal must converge to one run), the resolver DETERMINISTICALLY reuses the
// latest existing snapshot for the requisition; only when none exists does it
// capture a new one through the B2 service. A run then binds to that immutable
// snapshot id — later Requisition/GoldenProfile edits never alter its evidence.
// (Explicit re-analysis against a fresh snapshot is a distinct future operation,
// directive §AI-consent-revocation / re-analysis note.)
@Injectable()
export class CiSnapshotResolver {
  constructor(private readonly snapshots: RequisitionAnalysisContextSnapshotService) {}

  async resolveSnapshotId(
    tenantId: string,
    requisitionId: string,
    actor?: { request_id?: string },
  ): Promise<string> {
    const existing = await this.snapshots.listSnapshotsForRequisition(tenantId, requisitionId);
    const latest = pickLatest(existing);
    if (latest !== null) return latest.id;

    const captured = await this.snapshots.captureSnapshot({
      tenant_id: tenantId,
      requisition_id: requisitionId,
      ...(actor !== undefined ? { actor } : {}),
    });
    return captured.id;
  }
}

/** Latest by source_requisition_version, then captured_at (both descending). */
function pickLatest(
  views: RequisitionAnalysisContextSnapshotView[],
): RequisitionAnalysisContextSnapshotView | null {
  if (views.length === 0) return null;
  return [...views].sort((a, b) => {
    if (b.source_requisition_version !== a.source_requisition_version) {
      return b.source_requisition_version - a.source_requisition_version;
    }
    return b.captured_at.getTime() - a.captured_at.getTime();
  })[0] as RequisitionAnalysisContextSnapshotView;
}
