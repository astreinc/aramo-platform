import type { PipelineStatus } from '../pipeline-state.js';

export interface PipelineStatusHistoryView {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  // Lane 2 / L2-B — nullable: the birth row (NULL -> no_contact) has no prior state.
  status_from: PipelineStatus | null;
  status_to: PipelineStatus;
  changed_by_id: string | null;
  changed_at: string;
  note: string | null;
}
