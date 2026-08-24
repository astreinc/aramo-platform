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
  // Requisition-expander enrichment (LOCKED Aramo-Requisition-Expander-Talent-
  // Rate-Columns v1.0). Present ONLY on the enriched GET /v1/pipelines list read
  // (composed in apps/api, never stored/projected by this lib). R-LAYERING:
  // authz (`talent:read`) gates whether these exist at all; consent
  // (`do_not_contact`) suppresses email+phone only (never location/work_auth/
  // desired_rate). null = absent or suppressed.
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  work_auth?: string | null;
  desired_rate?: string | null;
}
