import type { ActivityType } from './activity-type.js';
import type { NoteCategory } from './note-category.js';
import type { NoteVisibility } from './note-visibility.js';
import type { NoteBodyFormat } from './note-body-format.js';

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
  // RN-1 (LOCKED) enterprise-note attributes. Present (non-null) only when
  // type=note (the 1:1 ActivityNote extension). For call/email_logged/
  // pipeline_status_change these are null / is_pinned=false. The note BODY stays
  // in `notes` (Q2). `body_format` is plain_text in RN-1 (D-5).
  category: NoteCategory | null;
  visibility: NoteVisibility | null;
  body_format: NoteBodyFormat | null;
  is_pinned: boolean;
  pinned_at: string | null;
  pinned_by_id: string | null;
}
