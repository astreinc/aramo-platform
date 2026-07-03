import { randomUUID } from 'node:crypto';

import {
  MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION,
  ROLE_FAMILIES,
  type ConstraintCheckStatus,
  type CriticalSkillExamination,
  type MatchingAnalysisInput,
  type RoleFamily,
} from '@aramo/matching';
import { normalizeSkillSurfaceForm } from '@aramo/talent-extraction';

// Gate-1 G1-B — the DETERMINISTIC matching-analysis derivation (no ai-draft /
// LLM; ADR-0015 Decision 10 + v1.2 G6 keep matching deterministic). It reads a
// talent's DECLARED skill evidence + the confirmed GoldenProfile and builds the
// MatchingAnalysisInput the entrustability engine consumes. Pure + fixture-free
// so the mapping (name↔surface_form overlap, constraint checks, HONEST
// confidence indicators) is unit-testable in isolation.
//
// Keying (G1-B correction — shared-UUID alignment): job_id = GoldenProfile.job_id,
// which confirmProfile now mints equal to the ATS requisition id (R). The minted
// examination IS visible via GET /v1/jobs/:id/matches (that read resolves through
// the job-domain Requisition mirror confirmProfile creates at id = job_id = R).
// The explicit T1 Core/ATS identity bridge stays deferred to external-ATS Phase-B.

export interface DeclaredSkillEvidence {
  surface_form: string;
  source: 'declared' | 'ingested' | 'derived';
  skill_id: string;
}

export interface GoldenConstraints {
  location?: string;
  work_mode?: string;
  rate?: string;
  work_authorization?: string;
}

export interface DerivationTalent {
  city: string | null;
  state: string | null;
  desired_pay: string | null;
  work_authorization: string | null;
  // A declared contact channel exists (email/phone) — the reachability signal.
  has_contact_channel: boolean;
}

export interface BuildMatchingInputParams {
  examination_id: string;
  tenant_id: string;
  talent_id: string;
  job_id: string;
  golden_profile_id: string;
  computed_at: Date;
  role_family: RoleFamily;
  critical_skill_names: readonly string[];
  golden_constraints: GoldenConstraints;
  declared_skills: readonly DeclaredSkillEvidence[];
  talent: DerivationTalent;
}

export function isRoleFamily(v: unknown): v is RoleFamily {
  return typeof v === 'string' && (ROLE_FAMILIES as readonly string[]).includes(v);
}

// A golden-profile constraint that is UNSET imposes no requirement → 'pass'
// (vacuous). A set constraint with no declared talent source we can compare
// against → 'unknown' (NON-BLOCKING per R8; never fabricate 'pass'/'fail').
function checkFreeTextMatch(
  required: string | undefined,
  declared: string | null,
): ConstraintCheckStatus {
  if (required === undefined || required.trim() === '') return 'pass';
  if (declared === null || declared.trim() === '') return 'unknown';
  const r = required.trim().toLowerCase();
  const d = declared.trim().toLowerCase();
  // Deterministic, conservative: a clear substring overlap → 'pass'; otherwise
  // we cannot reliably assert incompatibility from free text → 'unknown'
  // (NOT 'fail' — do not invent conflicts).
  return d.includes(r) || r.includes(d) ? 'pass' : 'unknown';
}

// work_authorization is the one constraint with a structured talent source (the
// R6 stated field). Conflict → 'fail' (REQUIRES_SPONSORSHIP against a
// no-sponsorship requirement); clear match → 'pass'; else 'unknown'.
function checkWorkAuthorization(
  required: string | undefined,
  declared: string | null,
): ConstraintCheckStatus {
  if (required === undefined || required.trim() === '') return 'pass';
  if (declared === null || declared.trim() === '') return 'unknown';
  const r = required.trim().toLowerCase();
  const d = declared.trim().toLowerCase();
  const noSponsorshipRequired =
    r.includes('no sponsorship') ||
    r.includes('without sponsorship') ||
    r.includes('citizen') ||
    r.includes('no_sponsorship');
  if (declared === 'REQUIRES_SPONSORSHIP' && noSponsorshipRequired) return 'fail';
  return d.includes(r) || r.includes(d) ? 'pass' : 'unknown';
}

export function buildMatchingInput(
  params: BuildMatchingInputParams,
): MatchingAnalysisInput {
  // --- critical_skills: name ↔ surface_form NORMALIZED overlap ---
  const normalizedDeclared = params.declared_skills.map((s) => ({
    norm: normalizeSkillSurfaceForm(s.surface_form),
    source: s.source,
  }));
  const critical_skills: CriticalSkillExamination[] = params.critical_skill_names.map(
    (name) => {
      const normName = normalizeSkillSurfaceForm(name);
      const matches = normalizedDeclared.filter((d) => d.norm === normName);
      return {
        name,
        evidence_count: matches.length,
        has_ingested_evidence: matches.some((m) => m.source === 'ingested'),
      };
    },
  );

  // --- constraint_checks_evaluated (R8 vocab: pass/partial/fail/unknown) ---
  const talentLocation = [params.talent.city, params.talent.state]
    .filter((x): x is string => x !== null && x.trim() !== '')
    .join(', ');
  const constraint_checks_evaluated = {
    location: checkFreeTextMatch(
      params.golden_constraints.location,
      talentLocation === '' ? null : talentLocation,
    ),
    // No TalentRecord source for work_mode → 'unknown' unless the job imposes
    // no work_mode requirement ('pass' vacuous).
    work_mode:
      params.golden_constraints.work_mode === undefined ||
      params.golden_constraints.work_mode.trim() === ''
        ? ('pass' as ConstraintCheckStatus)
        : ('unknown' as ConstraintCheckStatus),
    rate: checkFreeTextMatch(params.golden_constraints.rate, params.talent.desired_pay),
    work_authorization: checkWorkAuthorization(
      params.golden_constraints.work_authorization,
      params.talent.work_authorization,
    ),
  };

  const anyUnknownConstraint = Object.values(constraint_checks_evaluated).some(
    (v) => v === 'unknown',
  );

  // --- confidence_indicators (HONEST — never faked high) ---
  const matchedCriticalCount = critical_skills.filter(
    (s) => s.evidence_count > 0,
  ).length;
  const anyIngested = critical_skills.some((s) => s.has_ingested_evidence);
  // Declared-only evidence is never 'high': data_completeness is low whenever a
  // constraint is unknown OR no ingested corroboration exists — this soft-caps
  // ENTRUSTABLE via the engine's confidence rule (the honest reason
  // declared-only tops out at WORTH_CONSIDERING).
  const confidence_indicators_evaluated = {
    evidence_strength:
      matchedCriticalCount === critical_skills.length && critical_skills.length > 0
        ? ('medium' as const)
        : ('low' as const),
    data_completeness:
      anyUnknownConstraint || !anyIngested ? ('low' as const) : ('medium' as const),
    constraint_confidence: anyUnknownConstraint
      ? ('low' as const)
      : ('medium' as const),
  };

  // --- blocking_conditions (HONEST; consent gates CONTACTING not examination) ---
  const blocking_conditions = {
    // A declared contact channel (email/phone) is present → reachable. The
    // trust-layer "cryptographic verification" is a later T-series concern; for
    // intelligence-lite a present declared channel satisfies reachability. No
    // channel at all → false → hard block (cannot act on an unreachable talent).
    has_verified_contact_channel: params.talent.has_contact_channel,
    // The examination is an INTERNAL assessment, not a contact action. Consent
    // gates CONTACTING (consent-at-send), not examination — so it is not the
    // examine-time blocking gate. The send-gate enforces consent downstream.
    consent_state_sufficient: true,
    // No conflict-detection in G1-B — honest default (no known conflict).
    has_conflicting_active_engagement: false,
  };

  // --- honest presentation Json (pass-through; persisted opaquely) ---
  const gaps = critical_skills
    .filter((s) => s.evidence_count === 0)
    .map((s) => s.name);
  const strengths = critical_skills
    .filter((s) => s.evidence_count > 0)
    .map((s) => s.name);
  const why_matched_sentence = `Declared evidence matches ${String(
    matchedCriticalCount,
  )} of ${String(critical_skills.length)} critical skills for ${params.role_family}.`;

  return {
    contract_version: MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION,
    id: params.examination_id,
    tenant_id: params.tenant_id,
    talent_id: params.talent_id,
    job_id: params.job_id,
    golden_profile_id: params.golden_profile_id,
    trigger: 'recruiter_requested',
    rank_ordinal: 0,
    computed_at: params.computed_at,
    role_family: params.role_family,
    critical_skills,
    constraint_checks_evaluated,
    risk_flags_evaluated: [],
    confidence_indicators_evaluated,
    blocking_conditions,
    // §2.4 pass-through Json — honest structured content built from the overlap.
    why_matched_sentence,
    match_summary: why_matched_sentence,
    expanded_reasoning: {
      derivation: 'gate1-g1b-declared-evidence',
      matched_critical_skills: matchedCriticalCount,
      total_critical_skills: critical_skills.length,
    },
    skill_match: { matched_critical_skills: critical_skills },
    experience_match: {},
    constraint_checks: constraint_checks_evaluated,
    strengths,
    gaps,
    risk_flags: [],
    confidence_indicators: confidence_indicators_evaluated,
    freshness_indicator: { computed_at: params.computed_at.toISOString() },
  };
}

// Convenience: mint a fresh examination id (kept here so the controller and
// tests share one source).
export function newExaminationId(): string {
  return randomUUID();
}
