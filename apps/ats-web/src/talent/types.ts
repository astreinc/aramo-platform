// Hand-mirrored from libs/talent-record/src/lib/dto/talent-record.view.ts.
// Source-annotated so a future BE shape change is caught by the failing
// build (the missing field) — not by silent drift at runtime. R2 hand-
// mirrors instead of importing @aramo/talent-record (a forbidden domain
// edge from apps/ats-web). The DTO is a flat field list (no
// enum / matrix logic) so the R1 structural-deep-equal drift-spec
// pattern is not applied here (rule of three — that pattern is for
// mirrored logic, not flat fields).

import type {
  AvailabilityStatus,
  EngagementType,
  WorkAuthorization,
} from './stated-fields';

export interface TalentRecordView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly first_name: string;
  readonly last_name: string;
  readonly email1: string | null;
  readonly email2: string | null;
  readonly phone_home: string | null;
  readonly phone_cell: string | null;
  readonly phone_work: string | null;
  readonly address: string | null;
  readonly address2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly source: string | null;
  readonly key_skills: string | null;
  readonly current_employer: string | null;
  readonly current_pay: string | null;
  readonly desired_pay: string | null;
  // Talent-stated categorical fields (stated-fields amendment). Closed
  // vocabularies; null = not stated (availability null collapses to the UI
  // "Unknown" bucket alongside the explicit 'unknown' member).
  readonly availability_status: AvailabilityStatus | null;
  readonly engagement_type: EngagementType | null;
  readonly work_authorization: WorkAuthorization | null;
  // Segment 3 — list-response enrichment (COMPOSED in apps/api, optional).
  // last_activity_at: ISO timestamp of the most-recent activity, or null.
  // consent_summary: the 3-value contact-consent summary (libs/consent
  //   ConsentSummary); do_not_contact when unlinked/no grant.
  // current_stage: most-advanced ACTIVE pipeline stage (+ which req), or null
  //   ("none" — in no active pipeline).
  readonly last_activity_at?: string | null;
  readonly consent_summary?: 'contactable' | 'expiring_lt_30d' | 'do_not_contact' | null;
  readonly current_stage?: { stage: string; requisition_id: string } | null;
  readonly date_available: string | null;
  readonly can_relocate: boolean;
  readonly is_hot: boolean;
  readonly notes: string | null;
  readonly web_site: string | null;
  readonly best_time_to_call: string | null;
  readonly owner_id: string | null;
  readonly entered_by_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  // Search PR-2 — the résumé-content-match excerpt (ts_headline over the
  // REDACTED résumé text). Present ONLY on items returned by the ?resume_q=
  // content-search path; absent on every other read (the BE omits it).
  // Optional so name-search / LIST responses mirror unchanged.
  readonly resume_snippet?: string | null;
}

export interface TalentRecordListResponse {
  readonly items: readonly TalentRecordView[];
}

// ── Segment 4 — the server-side faceted + keyset-paginated response ──────────
// Hand-mirrored from libs/talent-record dto/talent-search.dto.ts (NativeFacets)
// + dto/talent-cross-facets.port.ts (CrossFacets). Flat shapes — no drift spec
// (rule of three; mirror-of-logic only). The ?paged=true superset of the LIST.
export interface FacetBucket {
  readonly value: string;
  readonly count: number;
}

// 4a — full-set counts for the NATIVE (single-schema) facets the UI renders.
// Skills counts are deliberately NOT here (still within-loaded until Skills
// Taxonomy); location/owner are filters without a count list.
export interface NativeFacets {
  readonly availability: readonly FacetBucket[];
  readonly engagement: readonly FacetBucket[];
  readonly source: readonly FacetBucket[];
  readonly hot: number;
}

// 4b — full-set counts for the CROSS-SCHEMA facets (composed in apps/api),
// bounded by the materialize guard. over_guard ⇒ counts not computed (the UI
// shows the "narrow your filters" message in their place).
export interface CrossFacets {
  readonly over_guard: boolean;
  readonly matched: number;
  readonly guard: number;
  readonly recency: Readonly<Record<string, number>>;
  readonly consent: readonly FacetBucket[];
  readonly stage: readonly FacetBucket[];
}

export interface TalentSearchPage {
  readonly items: readonly TalentRecordView[];
  readonly next_cursor: string | null;
  readonly facets: NativeFacets;
  readonly cross_facets?: CrossFacets;
}

// Hand-mirrored from libs/attachment/src/lib/dto/attachment.view.ts.
// Source-annotated. R3 hand-mirrors instead of importing @aramo/attachment
// (a forbidden domain edge). Flat field list — no drift spec (rule of
// three; mirror-of-logic-only).
//
// Ruling 1 (substrate truth over directive): the BE owner_type enum for
// a talent attachment is 'talent', NOT 'talent_record'. The A4 wire-up
// is authoritative on its own enum.
export type AttachmentOwnerType = 'talent' | 'requisition' | 'company' | 'contact';

export interface AttachmentView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly owner_type: AttachmentOwnerType;
  readonly owner_id: string;
  readonly file_name: string;
  readonly mime: string | null;
  readonly size_bytes: number;
  readonly storage_key: string;
  readonly is_resume: boolean;
  readonly uploaded_by_id: string | null;
  readonly uploaded_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AttachmentListResponse {
  readonly items: readonly AttachmentView[];
}

// TR-3 B2 — email-verification hand-mirrors.
//
// Hand-mirrored from the frozen TR-3 B2 backend contract (the authenticated
// request/status DTOs + the per-slot status projection). Source-annotated so a
// BE shape change surfaces as a failing build, not silent runtime drift. R2
// hand-mirrors rather than importing the domain lib (a forbidden edge from
// apps/ats-web).
//
// The verification request stores a SLOT (email1|email2), never a free-form
// address — the value comes from the stored TalentRecord field. The per-slot
// status is a BAND/LABEL (verified|pending|expired|none), NEVER a numeric value.
export type EmailSlot = 'email1' | 'email2';

// POST /v1/talent-records/:id/email-verifications 200 result. status is fixed
// 'PENDING' on a freshly-issued verification; resent=true when an existing
// pending verification was re-sent rather than newly minted.
export interface EmailVerificationRequestResult {
  readonly verification_id: string;
  readonly slot: EmailSlot;
  readonly status: 'PENDING';
  readonly expires_at: string;
  readonly resent: boolean;
}

// The per-slot displayed verification status (GET status items). A band/label
// vocabulary — never a number. 'none' = no verification exists for the slot.
export type EmailSlotVerificationStatus =
  | 'verified'
  | 'pending'
  | 'expired'
  | 'none';

export interface EmailVerificationStatusItem {
  readonly slot: EmailSlot;
  readonly value_present: boolean;
  readonly status: EmailSlotVerificationStatus;
}

// GET /v1/talent-records/:id/email-verifications 200 body — always two items,
// email1 then email2.
export interface EmailVerificationStatusResponse {
  readonly items: EmailVerificationStatusItem[];
}

// R5 — mutate-side hand-mirrors.

// Hand-mirrored from libs/talent-record/src/lib/dto/create-talent-record-
// request.dto.ts. POST /v1/talent-records body. Required: first_name +
// last_name. Free-text key_skills (NOT structured); free-text current_pay/
// desired_pay (NOT D5-masked — distinct from the requisition's typed
// compensation, Gate-5 confirmed against compensation-field-map.ts).
export interface CreateTalentRecordRequest {
  readonly first_name: string;
  readonly last_name: string;
  readonly site_id?: string;
  readonly email1?: string;
  readonly email2?: string;
  readonly phone_home?: string;
  readonly phone_cell?: string;
  readonly phone_work?: string;
  readonly address?: string;
  readonly address2?: string;
  readonly city?: string;
  readonly state?: string;
  readonly zip?: string;
  readonly source?: string;
  readonly key_skills?: string;
  readonly current_employer?: string;
  readonly current_pay?: string;
  readonly desired_pay?: string;
  readonly date_available?: string;
  readonly can_relocate?: boolean;
  readonly is_hot?: boolean;
  readonly notes?: string;
  readonly web_site?: string;
  readonly best_time_to_call?: string;
  readonly owner_id?: string;
}

// Hand-mirrored from libs/talent-record/src/lib/dto/update-talent-record-
// request.dto.ts. TRUE PATCH semantics (R4 omit-vs-null discipline):
// omitted → unchanged; explicit null → cleared. Contact / employer /
// pay / notes fields are nullable (T | null); flags are non-nullable.
//
// core_talent_id is DELIBERATELY EXCLUDED (PR-A5b-2): the Core-Talent
// link is owned by TalentLinkService and set only via dedicated
// POST/DELETE /v1/talent-records/:id/link routes. The form must NOT
// surface it.
export interface UpdateTalentRecordRequest {
  readonly first_name?: string;
  readonly last_name?: string;
  readonly email1?: string | null;
  readonly email2?: string | null;
  readonly phone_home?: string | null;
  readonly phone_cell?: string | null;
  readonly phone_work?: string | null;
  readonly address?: string | null;
  readonly address2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zip?: string | null;
  readonly source?: string | null;
  readonly key_skills?: string | null;
  readonly current_employer?: string | null;
  readonly current_pay?: string | null;
  readonly desired_pay?: string | null;
  readonly date_available?: string | null;
  readonly can_relocate?: boolean;
  readonly is_hot?: boolean;
  readonly notes?: string | null;
  readonly web_site?: string | null;
  readonly best_time_to_call?: string | null;
  readonly owner_id?: string | null;
}

// Hand-mirrored from libs/resume-parse/src/lib/types/parse-resume.types.ts.
// Closed enum — value-list, no drift spec.
//   - 'parsed':  minimal identity extracted (name + contact channel)
//   - 'partial': text extracted, but no minimal identity set
//   - 'failed':  text extraction itself failed (encrypted/corrupt/unsupported)
// The endpoint NEVER throws on parse failure — always 200 with this shape.
export type ParseStatus = 'parsed' | 'partial' | 'failed';

// Hand-mirrored from libs/resume-parse/src/lib/types/parse-resume.types.ts
// TalentRecordPrefill. Every field optional; unparseable fields are
// absent. The recruiter REVIEWS + CORRECTS — the prefill is convenience,
// not authority. NOTE: prefill omits current_pay/desired_pay/
// date_available/notes/can_relocate/is_hot (recruiter fills those after).
export interface TalentRecordPrefill {
  readonly first_name?: string;
  readonly last_name?: string;
  readonly email1?: string;
  readonly email2?: string;
  readonly phone_home?: string;
  readonly phone_cell?: string;
  readonly phone_work?: string;
  readonly address?: string;
  readonly address2?: string;
  readonly city?: string;
  readonly state?: string;
  readonly zip?: string;
  readonly key_skills?: string;
  readonly current_employer?: string;
  readonly web_site?: string;
}

export interface ParseResumeResult {
  readonly prefill: TalentRecordPrefill;
  readonly parse_status: ParseStatus;
}

// Hand-mirrored from libs/talent-record/src/lib/dto/resume-upload-url-
// request.dto.ts (the request shape) + libs/object-storage/src/lib/types/
// presigned-url.types.ts (the PresignedPutResult response shape).
//
// IMPORTANT: the orphan-pending lifecycle tag is BAKED INTO THE SIGNED
// URL server-side at presign time. The FE PUTs the file directly to S3
// with ONLY a matching Content-Type header — NO x-amz-tagging header
// needed (the tag is in the signature).
export interface ResumeUploadUrlRequest {
  readonly filename: string;
  readonly content_type: string;
}

export interface PresignedPutResult {
  readonly storage_key: string;
  readonly presigned_url: string;
  readonly expires_at: string;
}

export interface DraftFromResumeRequest {
  readonly storage_key: string;
}

// Hand-mirrored from libs/attachment/src/lib/dto/create-attachment-request
// .dto.ts. POST /v1/attachments body. is_resume=true triggers the BE to
// auto-clear the orphan-pending tag (markResumeCommitted) — the FE just
// POSTs; the orphan-tag-clear is server-side.
export interface CreateAttachmentRequest {
  readonly owner_type: AttachmentOwnerType;
  readonly owner_id: string;
  readonly file_name: string;
  readonly mime: string;
  readonly size_bytes: number;
  readonly storage_key: string;
  readonly site_id?: string;
  readonly is_resume?: boolean;
}
