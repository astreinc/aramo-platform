// TalentRecordView — read projection for a TalentRecord row.
//
// R10 invariant: this DTO carries identity + contact + recruiter notes
// ONLY. There is NO portal-forbidden numeric / ordinal field. Test
// ats-batch3-talent-record-attachment.integration.spec.ts asserts this
// structurally at runtime.
//
// PR-A5b-2 adds `core_talent_id` — the Core-Talent link (nullable; null
// for unlinked records, populated by TalentLinkService when the record
// has been associated with a Core Talent identity). The PATCH update
// surface deliberately excludes this field so the link can only be
// set via the dedicated /link routes (which run the in-tenant gate).
import type {
  AvailabilityStatus,
  EngagementType,
} from './stated-fields.js';

export interface TalentRecordView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  first_name: string;
  last_name: string;
  email1: string | null;
  email2: string | null;
  phone_home: string | null;
  phone_cell: string | null;
  phone_work: string | null;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  source: string | null;
  key_skills: string | null;
  current_employer: string | null;
  current_pay: string | null;
  desired_pay: string | null;
  date_available: string | null;
  can_relocate: boolean;
  is_hot: boolean;
  notes: string | null;
  web_site: string | null;
  best_time_to_call: string | null;
  // Talent-stated categorical fields (stated-fields amendment §4). Closed
  // vocabularies; null = not captured (availability also has an explicit
  // 'unknown' member — distinct from null at the data layer).
  availability_status: AvailabilityStatus | null;
  engagement_type: EngagementType | null;
  owner_id: string | null;
  entered_by_id: string | null;
  core_talent_id: string | null;
  created_at: string;
  updated_at: string;

  // Segment 3 — list-response enrichment (COMPOSED in apps/api, never stored;
  // optional so the lib's own reads + unit tests stay byte-identical). The
  // talent-record lib does not own these — it carries neutral shapes so it
  // imports nothing from libs/activity, libs/consent, or libs/pipeline.
  //   last_activity_at: most-recent activity timestamp (ISO), or null.
  //   consent_summary:  3-value contact-consent summary (do_not_contact when
  //                     unlinked/no grant); null only on un-enriched paths.
  //   current_stage:    most-advanced ACTIVE pipeline stage (+ which req), or
  //                     null = "none" (in no active pipeline).
  last_activity_at?: string | null;
  consent_summary?: 'contactable' | 'expiring_lt_30d' | 'do_not_contact' | null;
  current_stage?: { stage: string; requisition_id: string } | null;

  // Search PR-2 — the résumé-content-match excerpt (ts_headline over the
  // REDACTED résumé text — D2 snippet, never an SSN). Present ONLY on items
  // returned by the ?resume_q= content-search path; OMITTED (undefined) on
  // every other read, so a normal list response is byte-identical to today
  // (backward-compat). NOT a portal-forbidden numeric/ordinal field (R10).
  resume_snippet?: string | null;
}
