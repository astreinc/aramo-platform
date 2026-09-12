// UpdateTalentRecordRequestDto — PATCH /v1/talent-records/:id payload.
//
// PR-A5b-2: the identity link is DELIBERATELY EXCLUDED from this PATCH. The
// cluster link is owned by TalentLinkService and set only via the dedicated
// POST/DELETE /v1/talent-records/:id/link routes (which run the cluster-exists
// gate). The allowlist-walk in TalentRecordRepository.update structurally
// prevents any free-form column update from setting the link.
import type { ResumeDraftWorkHistory } from '@aramo/talent-extraction';

import type {
  AvailabilityStatus,
  EngagementType,
  WorkAuthorization,
} from './stated-fields.js';

export interface UpdateTalentRecordRequestDto {
  first_name?: string;
  last_name?: string;
  email1?: string | null;
  email2?: string | null;
  phone_home?: string | null;
  phone_cell?: string | null;
  phone_work?: string | null;
  address?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string; // B2 — non-null column (defaults 'US'); cannot be cleared to null
  source?: string | null;
  key_skills?: string | null;
  current_employer?: string | null;
  current_pay?: string | null;
  desired_pay?: string | null;
  date_available?: string | null;
  can_relocate?: boolean;
  is_hot?: boolean;
  notes?: string | null;
  web_site?: string | null;
  best_time_to_call?: string | null;
  title?: string | null; // B1
  // Talent-stated categorical fields (stated-fields amendment §4). Nullable to
  // allow clearing back to "not stated". Closed-vocabulary guard in the repo.
  availability_status?: AvailabilityStatus | null;
  engagement_type?: EngagementType | null;
  work_authorization?: WorkAuthorization | null;
  owner_id?: string | null;
  // Full-profile edit (LOCKED scope expansion). REPLACE-SET semantics: when
  // present, the reviewed set BECOMES the talent's declared ('resume'-sourced)
  // work-history — the controller replaces the prior rows via
  // TalentExtractionService.replaceDeclaredWorkHistory (NOT a TalentRecord
  // scalar; the repository allowlist-walk ignores it). An empty array clears the
  // declared set; ABSENT (undefined) leaves work-history untouched (scalar-only
  // PATCH — e.g. the quick-edit drawer). Declared, recruiter-edited; not verified.
  work_history?: ResumeDraftWorkHistory[];
}
