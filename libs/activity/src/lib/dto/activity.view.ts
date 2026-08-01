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
  // Redaction (Charter §4 Amendment). redacted_at is the predicate: non-null
  // means the note body was redacted and cleared. redaction_reason is present
  // for the recruiter-facing audit but MUST NOT be rendered on any
  // talent-facing surface (§8).
  redacted_at: string | null;
  redacted_by: string | null;
  redaction_reason_code: string | null;
  redaction_reason: string | null;
}
