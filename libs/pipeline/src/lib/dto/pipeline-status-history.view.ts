import type { PipelineStatus } from '../pipeline-state.js';

export interface PipelineStatusHistoryView {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  status_from: PipelineStatus;
  status_to: PipelineStatus;
  changed_by_id: string | null;
  changed_at: string;
  note: string | null;
}
