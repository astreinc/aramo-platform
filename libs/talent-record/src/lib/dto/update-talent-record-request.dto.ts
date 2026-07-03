// UpdateTalentRecordRequestDto — PATCH /v1/talent-records/:id payload.
//
// PR-A5b-2: `core_talent_id` is DELIBERATELY EXCLUDED. The Core-Talent
// link is owned by TalentLinkService and set only via the dedicated
// POST/DELETE /v1/talent-records/:id/link routes (which run the
// in-tenant gate via TalentRepository.findOverlayByTenant). The
// allowlist-walk in TalentRecordRepository.update structurally
// prevents any free-form column update from setting the link.
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
  // Talent-stated categorical fields (stated-fields amendment §4). Nullable to
  // allow clearing back to "not stated". Closed-vocabulary guard in the repo.
  availability_status?: AvailabilityStatus | null;
  engagement_type?: EngagementType | null;
  work_authorization?: WorkAuthorization | null;
  owner_id?: string | null;
}
