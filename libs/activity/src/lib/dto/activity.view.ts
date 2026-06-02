import type { ActivityType } from './activity-type.js';

export interface ActivityView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  type: ActivityType;
  subject_type: string | null;
  subject_id: string | null;
  notes: string | null;
  created_by_id: string | null;
  created_at: string;
}
