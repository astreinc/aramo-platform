// M4 PR-1 §4.3 — typed view projection for TalentJobEvidencePackage.
//
// The Prisma model stores five nested structured payloads as JSONB
// (talent_identity, contact_summary, capability_summary,
// match_justification, recruiter_contribution). Repository reads
// deserialize those JSONB columns into the structured TypeScript
// types defined here, mirroring the M3 PR-6 projection pattern
// (TalentJobExaminationFullView).
//
// PROJECT-ONLY: these types describe the on-read view shape. They are
// not Prisma-generated; the JSONB columns are stored opaquely and the
// repository casts them to these shapes at the boundary. Writes (not
// in PR-1's scope) will enforce the same shape at the create boundary
// in the builder PR.
//
// Vocabulary discipline (F17 / Vocabulary Amendment v1.0): Group 2
// §2.6 names talent identity / confirmation with the `talent_*` prefix
// per the locked Vocabulary Amendment rename. The M4 PR-1 directive §7
// attests this; the names below follow the locked discipline.
//
// Shared types reused from PR-6's projection (@aramo/examination):
//   - SkillMatchSummary, ExperienceMatchSummary — used inside
//     CapabilitySummary.
//   - RiskFlag — used inside MatchJustification.risk_flags[].
//
// Locally-defined types (Group 2 §2.6 entity shape; not present in
// PR-6's projection because §2.6 introduces them):
//   - TalentIdentity, ContactSummary, CapabilitySummary,
//     MatchJustification, RecruiterContribution, TalentConfirmed,
//     WorkHistoryExcerpt.

import type {
  ExperienceMatchSummary,
  RiskFlag,
  SkillMatchSummary,
} from '@aramo/examination';

// §2.6 "Talent Identity (client_visible)" — name + location surface
// the talent's own identity (no PII beyond what they consent to share).
export interface TalentIdentity {
  full_name: string;
  preferred_name?: string;
  location: string;
}

// §2.6 "Contact Summary (ats_internal)" — contact availability marker
// + a list of verified channels (kept abstract; channel detail lives
// in libs/talent-evidence's TalentContactMethod).
export interface ContactSummary {
  contact_available: boolean;
  channels_verified: string[];
}

// §2.6 capability_summary.key_work_history[] entry. Spec field-shape
// reflects a work-history excerpt suitable for the client_visible
// summary surface. WorkHistoryExcerpt is NOT exported from
// @aramo/examination (PR-6 projects EvidenceReference.entity_type as
// the string literal 'TalentWorkHistoryEntry' but does not define a
// separate WorkHistoryExcerpt summary type). PR-1 defines it here as
// a §2.6-shape projection on the JSONB column.
export interface WorkHistoryExcerpt {
  employer_name: string;
  role_title: string;
  start_date?: string;
  end_date?: string;
}

// §2.6 "Capability Summary (client_visible)" — the analytical surface
// the recruiter pitches with. Reuses PR-6's SkillMatchSummary and
// ExperienceMatchSummary verbatim (same shape as the examination's
// projected view). key_work_history is a §2.6-introduced array;
// certifications is an optional string[].
export interface CapabilitySummary {
  skill_match: SkillMatchSummary;
  experience_match: ExperienceMatchSummary;
  key_work_history: WorkHistoryExcerpt[];
  certifications?: string[];
}

// §2.6 "Match Justification (client_visible)" — strengths, gaps, and
// risk_flags carry the same per-flag shape as PR-6's RiskFlag. The
// why_this_talent is a short prose summary distinct from
// examination.why_matched_sentence.
export interface MatchJustification {
  why_this_talent: string;
  strengths: string[];
  gaps: string[];
  risk_flags: RiskFlag[];
}

// §2.6 recruiter_contribution.talent_confirmed sub-shape — the
// recruiter-authored confirmation that the talent has been spoken to.
// work_authorization here is a recruiter-authored string status,
// NOT a join to the libs/talent-evidence TalentWorkAuthorization
// Sensitive entity (per directive §3 line 85; F16 deferral to M6
// continues — PR-1 surfaces no Sensitive content).
export interface TalentConfirmed {
  spoken_to_recruiter: boolean;
  rate_confirmed?: boolean;
  availability_confirmed?: boolean;
  work_authorization?: string;
}

// §2.6 "Recruiter Contribution (ats_internal)" — the recruiter-authored
// surfaces. screening_notes is optional free-form; conversation_summary
// is a short prose summary; talent_confirmed is the structured
// confirmation block.
export interface RecruiterContribution {
  screening_notes?: string;
  conversation_summary: string;
  talent_confirmed: TalentConfirmed;
}

// §2.6 — top-level view projection. Mirrors the Prisma row shape with
// the five JSONB columns typed and engagement_event_refs typed as
// string[] (the underlying JSONB array of UUIDs).
export interface TalentJobEvidencePackageView {
  id: string;
  tenant_id: string;
  talent_id: string;
  job_id: string;
  examination_id: string;
  submittal_record_id: string | null;
  parent_package_id: string | null;
  talent_identity: TalentIdentity;
  contact_summary: ContactSummary;
  capability_summary: CapabilitySummary;
  match_justification: MatchJustification;
  recruiter_contribution: RecruiterContribution;
  engagement_event_refs: string[];
  created_at: Date;
}
