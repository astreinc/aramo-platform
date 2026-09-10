import { Injectable } from '@nestjs/common';
import { RequisitionAnalysisContextSnapshotService } from '@aramo/conversation-intelligence';
import type {
  RequisitionSnapshotSource,
  RequisitionSnapshotView,
} from '@aramo/conversation-intelligence';

// CI-B6P §18 — binds the CI processing port REQUISITION_SNAPSHOT_SOURCE to the
// immutable B2 snapshot service. Tenant-scoped read only; returns the narrow
// CI view ({id, source_requisition_version, context}). The run analyses the
// IMMUTABLE snapshot — never the mutable Requisition/GoldenProfile.
@Injectable()
export class B2RequisitionSnapshotSource implements RequisitionSnapshotSource {
  constructor(private readonly snapshots: RequisitionAnalysisContextSnapshotService) {}

  async getSnapshot(tenantId: string, snapshotId: string): Promise<RequisitionSnapshotView | null> {
    const view = await this.snapshots.getSnapshot(tenantId, snapshotId);
    if (view === null) return null;
    return {
      id: view.id,
      source_requisition_version: view.source_requisition_version,
      context: view.context,
    };
  }
}
