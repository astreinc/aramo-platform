import { describe, expect, it } from 'vitest';

import {
  projectFullView,
  projectSummaryView,
} from '../lib/examination-full.projection.js';
import type {
  TalentJobExaminationRow,
} from '../lib/examination.repository.js';

// M3 PR-6 §4.4 unit tests for the read-side projection. Exercise
// projectFullView / projectSummaryView against representative
// TalentJobExamination rows with the kind of Json shapes the analysis
// layer is expected to persist. The projection is project-only
// (PR-6 §2 Ruling 2) — these tests assert structural typing and
// EvidenceReference forwarding only; no libs/talent-evidence dereference
// is exercised because none is performed.
//
// Defensive-Json discipline: the projection is tolerant of underspecified
// or partially-populated columns (the analysis layer is not yet on
// substrate; PR-3 forwards whatever its caller supplied). Tests cover the
// happy path AND the partial-row path so the projection's tolerant
// behaviour is pinned.

const BASE_ROW: TalentJobExaminationRow = {
  id: '00000000-0000-7000-8000-000000000001',
  tenant_id: '11111111-1111-7111-8111-111111111111',
  talent_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  job_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
  golden_profile_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
  trigger: 'initial_match',
  tier: 'WORTH_CONSIDERING',
  rank_ordinal: 4,
  why_matched_sentence: 'Strong Java/Spring match with recent AWS exposure.',
  match_summary: 'Strong fit across required dimensions.',
  expanded_reasoning: [
    {
      category: 'skill',
      statement: 'TypeScript evidence is multi-source.',
      evidence_refs: [
        {
          entity_type: 'TalentSkillEvidence',
          entity_id: '22222222-2222-7222-8222-222222222222',
          field_path: 'surface_form',
          excerpt: 'TypeScript',
        },
      ],
    },
    {
      category: 'experience',
      statement: 'Eight years of backend experience.',
      evidence_refs: [
        {
          entity_type: 'TalentWorkHistoryEntry',
          entity_id: '33333333-3333-7333-8333-333333333333',
        },
      ],
    },
  ],
  skill_match: {
    matched_count: 2,
    missing_count: 0,
    per_skill: [
      { name: 'TypeScript', evidence_count: 4, has_ingested_evidence: true },
      { name: 'AWS', evidence_count: 2, has_ingested_evidence: true },
    ],
  },
  experience_match: { years: 8, summary: 'backend, AWS' },
  constraint_checks: {
    location: 'pass',
    work_mode: 'pass',
    rate: 'partial',
    work_authorization: 'pass',
  },
  strengths: ['typescript', 'backend'],
  gaps: ['kubernetes'],
  risk_flags: [
    { type: 'rate_mismatch', severity: 'medium', message: 'Target rate slightly above band' },
  ],
  confidence_indicators: {
    evidence_strength: { level: 'high', basis: 'multi-source' },
    data_completeness: { level: 'high', basis: 'all fields present' },
    constraint_confidence: { level: 'medium', basis: 'rate not yet confirmed' },
  },
  freshness_indicator: { profile_age_days: 14 },
  delta_to_entrustable: {
    current_tier: 'WORTH_CONSIDERING',
    next_tier_target: 'ENTRUSTABLE',
    blockers: ['rate_mismatch'],
    recommended_actions: ['Confirm rate'],
  },
  examination_version: 'examination-v1.0.0',
  model_version: 'matching-model-v1.0.0',
  taxonomy_version: 'taxonomy-v1.0.0',
  computed_at: new Date('2026-05-19T22:00:00Z'),
  lifecycle_state: 'active',
  archived_at: null,
  superseded_by_examination_id: null,
};

describe('projectSummaryView — happy path', () => {
  it('projects the 10-field Summary view from a typed row', () => {
    const v = projectSummaryView(BASE_ROW);
    expect(v.examination_id).toBe(BASE_ROW.id);
    expect(v.talent_id).toBe(BASE_ROW.talent_id);
    expect(v.job_id).toBe(BASE_ROW.job_id);
    expect(v.tier).toBe('WORTH_CONSIDERING');
    expect(v.rank_ordinal).toBe(4);
    expect(v.why_matched_sentence).toBe(BASE_ROW.why_matched_sentence);
    expect(v.top_skills).toEqual(['TypeScript', 'AWS']);
    expect(v.confidence_summary.evidence_strength.level).toBe('high');
    expect(v.freshness_indicator.profile_age_days).toBe(14);
    expect(v.computed_at).toEqual(BASE_ROW.computed_at);
  });
});

describe('projectFullView — fully-specified types (Group 2 §2.4 byte-faithful)', () => {
  it('projects expanded_reasoning with the 6-value category enum and nested evidence_refs', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.expanded_reasoning).toHaveLength(2);
    expect(v.expanded_reasoning[0]?.category).toBe('skill');
    expect(v.expanded_reasoning[0]?.statement).toContain('TypeScript');
    expect(v.expanded_reasoning[0]?.evidence_refs).toHaveLength(1);
    expect(v.expanded_reasoning[0]?.evidence_refs[0]?.entity_type).toBe('TalentSkillEvidence');
    expect(v.expanded_reasoning[0]?.evidence_refs[0]?.field_path).toBe('surface_form');
    expect(v.expanded_reasoning[0]?.evidence_refs[0]?.excerpt).toBe('TypeScript');
  });

  it('flattens evidence_references across all reasoning entries (project-only — no dereference)', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.evidence_references).toHaveLength(2);
    expect(v.evidence_references.map((r) => r.entity_type)).toEqual([
      'TalentSkillEvidence',
      'TalentWorkHistoryEntry',
    ]);
    // Verify project-only — entity_id is forwarded verbatim, NOT replaced
    // with looked-up content.
    expect(v.evidence_references[0]?.entity_id).toBe('22222222-2222-7222-8222-222222222222');
    expect(v.evidence_references[1]?.entity_id).toBe('33333333-3333-7333-8333-333333333333');
  });

  it('projects risk_flags with the 8-value type enum and 3-value severity enum', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.risk_flags).toHaveLength(1);
    expect(v.risk_flags[0]?.type).toBe('rate_mismatch');
    expect(v.risk_flags[0]?.severity).toBe('medium');
    expect(v.risk_flags[0]?.message).toContain('Target rate');
  });

  it('projects confidence_indicators with { level, basis } per dimension', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.confidence_summary.evidence_strength).toEqual({ level: 'high', basis: 'multi-source' });
    expect(v.confidence_summary.constraint_confidence).toEqual({
      level: 'medium',
      basis: 'rate not yet confirmed',
    });
  });

  it('projects delta_to_entrustable with the closed tier enums', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.delta_to_entrustable).not.toBeNull();
    expect(v.delta_to_entrustable?.current_tier).toBe('WORTH_CONSIDERING');
    expect(v.delta_to_entrustable?.next_tier_target).toBe('ENTRUSTABLE');
    expect(v.delta_to_entrustable?.blockers).toEqual(['rate_mismatch']);
    expect(v.delta_to_entrustable?.recommended_actions).toEqual(['Confirm rate']);
  });

  it('projects strengths and gaps as string arrays', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.strengths).toEqual(['typescript', 'backend']);
    expect(v.gaps).toEqual(['kubernetes']);
  });

  it('forwards lifecycle metadata (already PR-1 columns)', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.lifecycle_state).toBe('active');
    expect(v.archived_at).toBeNull();
    expect(v.superseded_by_examination_id).toBeNull();
  });
});

describe('projectFullView — named-only projection shapes (Ruling 1)', () => {
  it('SkillMatchSummary is name-keyed (no skill_id) and forwards CriticalSkillExamination-shaped per-skill data', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.skill_match.matched_count).toBe(2);
    expect(v.skill_match.missing_count).toBe(0);
    expect(v.skill_match.per_skill).toHaveLength(2);
    // Name-keyed — the per-skill identifier is `name`, not `skill_id`.
    expect(v.skill_match.per_skill[0]?.name).toBe('TypeScript');
    // No invented metadata — only what CriticalSkillExamination already
    // carries (PR-2/3): name, evidence_count, has_ingested_evidence.
    expect(Object.keys(v.skill_match.per_skill[0] ?? {}).sort()).toEqual(
      ['evidence_count', 'has_ingested_evidence', 'name'],
    );
  });

  it('ExperienceMatchSummary projects { years?, summary? } minimally', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.experience_match.years).toBe(8);
    expect(v.experience_match.summary).toBe('backend, AWS');
  });

  it('ConstraintCheckSummary projects the four §2.5 constraint dimensions', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.constraint_checks).toEqual({
      location: 'pass',
      work_mode: 'pass',
      rate: 'partial',
      work_authorization: 'pass',
    });
  });

  it('FreshnessIndicator projects { profile_age_days? } minimally', () => {
    const v = projectFullView(BASE_ROW);
    expect(v.freshness_indicator).toEqual({ profile_age_days: 14 });
  });
});

describe('projectFullView — tolerant projection of partial / older Json shapes', () => {
  it('tolerates a simpler SkillMatchSummary shape ({ matched, missing }) — empty per_skill list', () => {
    const v = projectFullView({
      ...BASE_ROW,
      skill_match: { matched: 5, missing: 1 },
    });
    expect(v.skill_match.matched_count).toBe(5);
    expect(v.skill_match.missing_count).toBe(1);
    expect(v.skill_match.per_skill).toEqual([]);
  });

  it('returns delta_to_entrustable null when not persisted (§2.4 optional field)', () => {
    const v = projectFullView({ ...BASE_ROW, delta_to_entrustable: null });
    expect(v.delta_to_entrustable).toBeNull();
  });

  it('returns empty arrays for missing list-shaped columns', () => {
    const v = projectFullView({
      ...BASE_ROW,
      expanded_reasoning: null,
      strengths: null,
      gaps: null,
      risk_flags: null,
    });
    expect(v.expanded_reasoning).toEqual([]);
    expect(v.strengths).toEqual([]);
    expect(v.gaps).toEqual([]);
    expect(v.risk_flags).toEqual([]);
    expect(v.evidence_references).toEqual([]);
  });

  it('drops malformed evidence_refs entries — unknown entity_type or missing entity_id', () => {
    const v = projectFullView({
      ...BASE_ROW,
      expanded_reasoning: [
        {
          category: 'skill',
          statement: 's',
          evidence_refs: [
            { entity_type: 'TalentSkillEvidence', entity_id: '00000000-0000-7000-8000-000000000001' },
            { entity_type: 'NotARealType', entity_id: '00000000-0000-7000-8000-000000000002' },
            { entity_type: 'TalentDocument' /* missing entity_id */ },
          ],
        },
      ],
    });
    expect(v.expanded_reasoning[0]?.evidence_refs).toHaveLength(1);
    expect(v.evidence_references).toHaveLength(1);
  });

  it('drops reasoning entries with unknown category or missing statement', () => {
    const v = projectFullView({
      ...BASE_ROW,
      expanded_reasoning: [
        { category: 'not_a_category', statement: 's' },
        { category: 'skill' /* missing statement */ },
        { category: 'risk', statement: 'ok' },
      ],
    });
    expect(v.expanded_reasoning).toHaveLength(1);
    expect(v.expanded_reasoning[0]?.category).toBe('risk');
  });

  it('drops malformed risk_flags — unknown type or severity', () => {
    const v = projectFullView({
      ...BASE_ROW,
      risk_flags: [
        { type: 'not_a_type', severity: 'medium', message: 'x' },
        { type: 'other', severity: 'urgent', message: 'x' },
        { type: 'stale_profile', severity: 'high', message: 'ok' },
      ],
    });
    expect(v.risk_flags).toHaveLength(1);
    expect(v.risk_flags[0]?.type).toBe('stale_profile');
  });

  it('produces a usable ConfidenceIndicators value when the column shape is missing', () => {
    const v = projectFullView({ ...BASE_ROW, confidence_indicators: null });
    expect(v.confidence_summary.evidence_strength.level).toBe('low');
    expect(v.confidence_summary.evidence_strength.basis).toBe('');
  });
});
