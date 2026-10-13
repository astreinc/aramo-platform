// TIP-E2E INC-2 — AuthorizedTalentRetrievalReadPort (ARAMO-TIP-E2E-INC-2-v1.0-LOCKED §3.2).
//
// Tenant-scoped pool-open Talent retrieval (NOT global discovery; DEF-6). The lib
// owns the interface + token + neutral shape; the apps/api adapter composes
// TalentRecordRepository and MUST apply the existing authoritative do_not_contact
// suppression BEFORE returning (Correction A) — contact channels are nulled for
// do_not_contact; non-contact attributes remain governed by existing authorization
// (talent:read), NOT by contactability. The projection is intentionally limited to
// the fields the existing consumer needs — it is NOT a general raw-PII interface.
export const AUTHORIZED_TALENT_RETRIEVAL_READ_PORT = Symbol(
  'AUTHORIZED_TALENT_RETRIEVAL_READ_PORT',
);

// Neutral authorized-talent projection (the consumer's core-field subset). The
// two contact channels (email1 / phone_cell) are SUPPRESSED (null) unless the
// consent authority marks the talent contactable; every other field is a
// non-contact attribute governed by talent:read.
export interface AuthorizedTalentRecord {
  readonly id: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly title: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly email1: string | null;
  readonly phone_cell: string | null;
  readonly work_authorization: string | null;
  readonly desired_pay: string | null;
  readonly current_pay: string | null;
  readonly engagement_type: string | null;
  readonly availability_status: string | null;
  readonly date_available: string | null;
  readonly key_skills: string | null;
  readonly source: string | null;
  readonly owner_id: string | null;
  readonly created_at: string;
  readonly recruiting_ready: boolean;
  readonly record_status: 'live' | 'superseded';
  readonly superseded_by_record_id: string | null;
  // Contactability OUTCOME from the consent authority (presentation only). Does NOT
  // gate the non-contact fields above.
  readonly contactable: boolean;
}

export interface AuthorizedTalentRetrievalReadPort {
  // Single authorized-talent retrieval within the tenant (pool-open; site is
  // enforced by the consuming surface's @RequireSiteMatch, not here). Returns null
  // when absent / cross-tenant. Contact-PII suppression is applied by the adapter
  // before returning (Correction A).
  getTalent(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<AuthorizedTalentRecord | null>;
}
