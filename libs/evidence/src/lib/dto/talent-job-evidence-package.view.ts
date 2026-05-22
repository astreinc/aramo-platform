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

// §2.6 conversation_summary — short prose summary of the recruiter-talent
// conversation. PR-2 lifts this from a bare string to a structured object
// so the builder can validate the recruiter_summary field at the input
// boundary (directive §4.1 step 1: `conversation_summary.recruiter_summary
// non-empty`). The JSONB column stores the object verbatim.
export interface ConversationSummary {
  recruiter_summary: string;
}

// §2.6 "Recruiter Contribution (ats_internal)" — the recruiter-authored
// surfaces. screening_notes is optional free-form; conversation_summary
// is a short prose summary; talent_confirmed is the structured
// confirmation block.
export interface RecruiterContribution {
  screening_notes?: string;
  conversation_summary: ConversationSummary;
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

// =========================================================================
// M4 PR-2 — input-side types for EvidenceRepository.buildPackage
// =========================================================================
//
// The output (read-side) types above are PR-1's substrate; the input
// types below are PR-2's write-side surface. The builder accepts these
// inputs, reads the examination Full projection from libs/examination,
// optionally reads TalentRateExpectation from libs/talent-evidence, and
// composes the five output JSONB payloads.
//
// Directive §4.2 ruling on the input/output split:
//   - skill_match + experience_match: derived from the examination Full
//     view, NEVER taken from input (single source of truth for
//     examination-derived analytical data).
//   - key_work_history + certifications: recruiter-curated; input only.
//   - match_justification fields: optional input overrides on top of the
//     examination Full view's strengths/gaps/risk_flags/why_matched.
//   - recruiter_contribution: input only; no examination derivation.
//   - rate sub-payload of talent_confirmed: optional substrate read,
//     never inline.

// Directive §4.1 step 5: key_work_history is recruiter-curated, certifications
// optional. CapabilitySummaryOverrides supplies these; skill_match and
// experience_match are NEVER input (always derived from the examination
// Full view).
export interface CapabilitySummaryOverrides {
  key_work_history: readonly WorkHistoryExcerpt[];
  certifications?: readonly string[];
}

// Directive §4.1 step 5: match_justification fields default from the
// examination Full view (why_matched_sentence, strengths, gaps,
// risk_flags). The recruiter may polish any of them; an absent override
// means "use the Full view's value verbatim." MatchJustificationOverrides
// is itself optional on BuildPackageInput.
export interface MatchJustificationOverrides {
  why_this_talent?: string;
  strengths?: readonly string[];
  gaps?: readonly string[];
  risk_flags?: readonly MatchJustification['risk_flags'][number][];
}

// Directive §4.1 step 1: talent_confirmed.spoken_to_recruiter is required;
// the other two booleans / strings are optional free fields. The rate
// sub-payload (when provided) is NOT taken as input — it is substrate-
// resolved via input.rate_expectation_id (directive §4.1 step 4). The
// builder forbids inline rate (directive §5 "Inline rate parameter" —
// out of scope).
export interface TalentConfirmedInput {
  spoken_to_recruiter: boolean;
  availability_confirmed?: string;
  // Recruiter-authored free string; explicitly NOT a join to the
  // TalentWorkAuthorization Sensitive entity (F16 deferral to M6).
  work_authorization?: string;
}

// Directive §4.2 RecruiterContributionInput.
export interface RecruiterContributionInput {
  screening_notes?: string;
  conversation_summary: ConversationSummary;
  talent_confirmed: TalentConfirmedInput;
}

// Directive §4.1 BuildPackageInput.
export interface BuildPackageInput {
  // Identity (caller-provided)
  id: string;
  tenant_id: string;
  talent_id: string;
  job_id: string;

  // Cross-schema references
  examination_id: string;
  submittal_record_id?: string | null;
  parent_package_id?: string | null;

  // Recruiter-authored / talent-self-asserted payloads
  talent_identity: TalentIdentity;
  contact_summary: ContactSummary;
  capability_summary_overrides: CapabilitySummaryOverrides;
  match_justification_overrides?: MatchJustificationOverrides;
  recruiter_contribution: RecruiterContributionInput;
  rate_expectation_id?: string | null;
  engagement_event_refs?: readonly string[];
}
