import type { TalentJobExaminationRow } from './examination.repository.js';
import type {
  ConfidenceIndicators,
  ConstraintCheckSummary,
  EvidenceReference,
  ExaminationReasoning,
  ExperienceMatchSummary,
  FreshnessIndicator,
  RiskFlag,
  SkillMatchSummary,
  SkillMatchSummaryPerSkill,
  TalentJobExaminationFullView,
  TalentJobExaminationSummaryView,
} from './examination-full.types.js';

// M3 PR-6 read-side projection logic. Types the opaque `Json` analytical
// columns on PR-1's TalentJobExamination row into the structured shapes
// declared in examination-full.types.ts.
//
// PR-6 is project-only (directive §2 Ruling 2): no query against
// libs/talent-evidence, no dereferencing of EvidenceReference targets.
// `evidence_references` is computed by flattening the `evidence_refs` from
// each ExaminationReasoning entry (per Group 2 §2.4 — every reasoning
// statement carries its evidence_refs; Full's "complete evidence
// references" is the union across the reasoning list).
//
// Tolerant Json typing: the analysis layer that writes the persisted Json
// is not yet on substrate; PR-3's MatchingService.evaluateAndPersist
// forwards whatever its caller supplied. The projection here therefore
// validates structure defensively and treats missing/wrong-shaped values
// as their type's empty/minimal form rather than throwing — the read
// surface is responsible for typing a snapshot regardless of how the
// analysis layer evolves. This is the same "trust the persisted shape,
// type it honestly" posture PR-1 took with its Json columns (§3.1 ruling).

// ----- Defensive Json readers (no third-party dependency) ----------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function asStringArray(v: unknown): readonly string[] {
  return isStringArray(v) ? v : [];
}

// ----- Fully-specified projections (Group 2 §2.4 byte-faithful) ----------

const REASONING_CATEGORIES = new Set([
  'skill',
  'experience',
  'constraint',
  'freshness',
  'engagement',
  'risk',
]);
const EVIDENCE_ENTITY_TYPES = new Set([
  'TalentSkillEvidence',
  'TalentWorkHistoryEntry',
  'TalentContactMethod',
  'TalentRateExpectation',
  'TalentWorkAuthorization',
  'TalentEngagementEvent',
  'TalentDocument',
  'TalentDerivedSnapshot',
]);
const RISK_TYPES = new Set([
  'unverified_contact',
  'stale_profile',
  'low_data_completeness',
  'conflicting_evidence',
  'rate_mismatch',
  'authorization_unknown',
  'low_reachability',
  'other',
]);
const RISK_SEVERITIES = new Set(['low', 'medium', 'high']);
const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);

function projectEvidenceReference(v: unknown): EvidenceReference | null {
  if (!isRecord(v)) return null;
  const entity_type = v['entity_type'];
  const entity_id = v['entity_id'];
  if (typeof entity_type !== 'string' || !EVIDENCE_ENTITY_TYPES.has(entity_type)) return null;
  if (typeof entity_id !== 'string') return null;
  const ref: EvidenceReference = {
    entity_type: entity_type as EvidenceReference['entity_type'],
    entity_id,
  };
  const fp = asString(v['field_path']);
  if (fp !== undefined) ref.field_path = fp;
  const ex = asString(v['excerpt']);
  if (ex !== undefined) ref.excerpt = ex;
  return ref;
}

function projectExpandedReasoning(v: unknown): readonly ExaminationReasoning[] {
  if (!Array.isArray(v)) return [];
  const out: ExaminationReasoning[] = [];
  for (const entry of v) {
    if (!isRecord(entry)) continue;
    const category = entry['category'];
    const statement = entry['statement'];
    if (typeof category !== 'string' || !REASONING_CATEGORIES.has(category)) continue;
    if (typeof statement !== 'string') continue;
    const refsRaw = entry['evidence_refs'];
    const evidence_refs: EvidenceReference[] = [];
    if (Array.isArray(refsRaw)) {
      for (const r of refsRaw) {
        const projected = projectEvidenceReference(r);
        if (projected !== null) evidence_refs.push(projected);
      }
    }
    out.push({
      category: category as ExaminationReasoning['category'],
      statement,
      evidence_refs,
    });
  }
  return out;
}

function projectRiskFlags(v: unknown): readonly RiskFlag[] {
  if (!Array.isArray(v)) return [];
  const out: RiskFlag[] = [];
  for (const entry of v) {
    if (!isRecord(entry)) continue;
    const type = entry['type'];
    const severity = entry['severity'];
    const message = entry['message'];
    if (typeof type !== 'string' || !RISK_TYPES.has(type)) continue;
    if (typeof severity !== 'string' || !RISK_SEVERITIES.has(severity)) continue;
    if (typeof message !== 'string') continue;
    const flag: RiskFlag = {
      type: type as RiskFlag['type'],
      severity: severity as RiskFlag['severity'],
      message,
    };
    const sub = asString(entry['subtype']);
    if (sub !== undefined) flag.subtype = sub;
    out.push(flag);
  }
  return out;
}

function projectConfidenceIndicator(v: unknown): { level: 'high' | 'medium' | 'low'; basis: string } | null {
  if (!isRecord(v)) return null;
  const level = v['level'];
  const basis = v['basis'];
  if (typeof level !== 'string' || !CONFIDENCE_LEVELS.has(level)) return null;
  if (typeof basis !== 'string') return null;
  return { level: level as 'high' | 'medium' | 'low', basis };
}

const ZERO_CI = { level: 'low', basis: '' } as const;
function projectConfidenceIndicators(v: unknown): ConfidenceIndicators {
  if (!isRecord(v)) {
    return {
      evidence_strength: { ...ZERO_CI },
      data_completeness: { ...ZERO_CI },
      constraint_confidence: { ...ZERO_CI },
    };
  }
  return {
    evidence_strength: projectConfidenceIndicator(v['evidence_strength']) ?? { ...ZERO_CI },
    data_completeness: projectConfidenceIndicator(v['data_completeness']) ?? { ...ZERO_CI },
    constraint_confidence: projectConfidenceIndicator(v['constraint_confidence']) ?? { ...ZERO_CI },
  };
}

const DELTA_CURRENT_TIERS = new Set(['WORTH_CONSIDERING', 'STRETCH']);
const DELTA_NEXT_TARGETS = new Set(['WORTH_CONSIDERING', 'ENTRUSTABLE']);
function projectDeltaToEntrustable(v: unknown): TalentJobExaminationFullView['delta_to_entrustable'] {
  if (v === null || v === undefined) return null;
  if (!isRecord(v)) return null;
  const current_tier = v['current_tier'];
  const next_tier_target = v['next_tier_target'];
  if (typeof current_tier !== 'string' || !DELTA_CURRENT_TIERS.has(current_tier)) return null;
  if (typeof next_tier_target !== 'string' || !DELTA_NEXT_TARGETS.has(next_tier_target)) return null;
  return {
    current_tier: current_tier as 'WORTH_CONSIDERING' | 'STRETCH',
    next_tier_target: next_tier_target as 'WORTH_CONSIDERING' | 'ENTRUSTABLE',
    blockers: asStringArray(v['blockers']),
    recommended_actions: asStringArray(v['recommended_actions']),
  };
}

// ----- Named-only projections (PR-6-defined, name-keyed; Ruling 1) -------

function projectSkillMatchSummary(v: unknown): SkillMatchSummary {
  // Two persistence shapes are tolerated honestly:
  //
  //   (a) The analysis-layer-eventual shape — `{ matched_count, missing_count,
  //       per_skill: Array<{ name, evidence_count, has_ingested_evidence }> }`.
  //       Project byte-faithful.
  //
  //   (b) An older/simpler shape (per PR-3 fixtures) — `{ matched: number,
  //       missing: number }` — derived counts only, no per-skill detail.
  //       Project with an empty per_skill list.
  //
  // No skill_id keying (Ruling 1); the per-skill view is keyed by NAME.
  if (!isRecord(v)) {
    return { matched_count: 0, missing_count: 0, per_skill: [] };
  }
  const matched_count = asNumber(v['matched_count']) ?? asNumber(v['matched']) ?? 0;
  const missing_count = asNumber(v['missing_count']) ?? asNumber(v['missing']) ?? 0;
  const per_skill: SkillMatchSummaryPerSkill[] = [];
  const rawPer = v['per_skill'];
  if (Array.isArray(rawPer)) {
    for (const entry of rawPer) {
      if (!isRecord(entry)) continue;
      const name = entry['name'];
      const evidence_count = entry['evidence_count'];
      const has_ingested_evidence = entry['has_ingested_evidence'];
      if (typeof name !== 'string') continue;
      if (typeof evidence_count !== 'number') continue;
      if (typeof has_ingested_evidence !== 'boolean') continue;
      per_skill.push({ name, evidence_count, has_ingested_evidence });
    }
  }
  return { matched_count, missing_count, per_skill };
}

function projectExperienceMatchSummary(v: unknown): ExperienceMatchSummary {
  if (!isRecord(v)) return {};
  const out: ExperienceMatchSummary = {};
  const years = asNumber(v['years']);
  if (years !== undefined) out.years = years;
  const summary = asString(v['summary']);
  if (summary !== undefined) out.summary = summary;
  return out;
}

function projectConstraintCheckSummary(v: unknown): ConstraintCheckSummary {
  if (!isRecord(v)) return {};
  const out: ConstraintCheckSummary = {};
  const loc = asString(v['location']);
  if (loc !== undefined) out.location = loc;
  const wm = asString(v['work_mode']);
  if (wm !== undefined) out.work_mode = wm;
  const rate = asString(v['rate']);
  if (rate !== undefined) out.rate = rate;
  const wa = asString(v['work_authorization']);
  if (wa !== undefined) out.work_authorization = wa;
  return out;
}

function projectFreshnessIndicator(v: unknown): FreshnessIndicator {
  if (!isRecord(v)) return {};
  const out: FreshnessIndicator = {};
  const pad = asNumber(v['profile_age_days']);
  if (pad !== undefined) out.profile_age_days = pad;
  return out;
}

// ----- Summary-view-only projections (also Ruling-1-style) ---------------

function projectTopSkills(skillMatch: SkillMatchSummary): readonly string[] {
  return skillMatch.per_skill.map((s) => s.name);
}

// ----- Top-level projection: Row → Summary view --------------------------

export function projectSummaryView(row: TalentJobExaminationRow): TalentJobExaminationSummaryView {
  const skill_match = projectSkillMatchSummary(row.skill_match);
  return {
    examination_id: row.id,
    talent_id: row.talent_id,
    job_id: row.job_id,
    tier: row.tier,
    rank_ordinal: row.rank_ordinal,
    why_matched_sentence: row.why_matched_sentence,
    top_skills: projectTopSkills(skill_match),
    confidence_summary: projectConfidenceIndicators(row.confidence_indicators),
    freshness_indicator: projectFreshnessIndicator(row.freshness_indicator),
    computed_at: row.computed_at,
  };
}

// ----- Top-level projection: Row → Full view -----------------------------

export function projectFullView(row: TalentJobExaminationRow): TalentJobExaminationFullView {
  const summary = projectSummaryView(row);
  const expanded_reasoning = projectExpandedReasoning(row.expanded_reasoning);

  // "Complete evidence references" (Group 2 §2.4 / API Contracts v1.0 L437)
  // — the union of evidence_refs across all reasoning entries. Project-only:
  // no dereferencing (Ruling 2).
  const evidence_references: EvidenceReference[] = [];
  for (const r of expanded_reasoning) {
    for (const ref of r.evidence_refs) evidence_references.push(ref);
  }

  return {
    ...summary,
    expanded_reasoning,
    skill_match: projectSkillMatchSummary(row.skill_match),
    experience_match: projectExperienceMatchSummary(row.experience_match),
    constraint_checks: projectConstraintCheckSummary(row.constraint_checks),
    strengths: asStringArray(row.strengths),
    gaps: asStringArray(row.gaps),
    risk_flags: projectRiskFlags(row.risk_flags),
    delta_to_entrustable: projectDeltaToEntrustable(row.delta_to_entrustable),
    evidence_references,
    lifecycle_state: row.lifecycle_state,
    archived_at: row.archived_at,
    superseded_by_examination_id: row.superseded_by_examination_id,
  };
}
