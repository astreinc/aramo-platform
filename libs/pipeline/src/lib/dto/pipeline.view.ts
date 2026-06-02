import type { PipelineStatus } from '../pipeline-state.js';

export interface PipelineView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  talent_record_id: string;
  requisition_id: string;
  status: PipelineStatus;
  created_at: string;
  updated_at: string;
}
