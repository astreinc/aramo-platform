import { describe, expect, it } from 'vitest';

import { evaluateEntrustability, EVIDENCE_THRESHOLDS } from '../lib/engine.js';
import { ROLE_FAMILIES } from '../lib/dto/matching-analysis-input.dto.js';
import { MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION } from '../lib/dto/version-pins.js';

import { entrustablePass } from './_input-factory.js';

// Exhaustive engine unit tests covering the M3 PR-2 §3.2 surface:
//
//   - The baseline factory produces ENTRUSTABLE with empty
//     failed_criteria (sanity).
//   - Each of the five §2.5 rule groups (Skill Evidence, Constraint,
//     Risk, Confidence, Blocking Conditions) fails the way §2.5
//     describes.
//   - Tier boundaries: all-pass → ENTRUSTABLE; soft-only →
//     WORTH_CONSIDERING; ≥1 hard → STRETCH.
//   - Hard / soft distinction matches §2.5 (the four enumerated soft
//     failures; everything else hard).
//   - Role-family calibration table: every row's threshold (Architect
//     ≥3, Engineering ≥2 with ingested, PM/BA ≥2 no-ingested).
//   - failed_criteria[] shape: every entry has the §2.5-named four keys
//     (criterion, field_path, observed_value, expected_threshold).
//   - Determinism: same input → same output on repeated invocations.
//   - Contract-version check: an incompatible contract_version throws.
//   - §2.5 Anita Sharma Worked Example reproduces tier=WORTH_CONSIDERING
//     with two failed_criteria entries (insufficient AWS evidence_count,
//     low evidence_strength).

describe('evaluateEntrustability — baseline', () => {
  it('produces ENTRUSTABLE with empty failed_criteria when every rule passes', () => {
    const result = evaluateEntrustability(entrustablePass());
    expect(result.tier).toBe('ENTRUSTABLE');
    expect(result.failed_criteria).toEqual([]);
    expect(result.hard_failures).toEqual([]);
    expect(result.soft_failures).toEqual([]);
  });
});

describe('evaluateEntrustability — Skill Evidence Rule (§2.5)', () => {
  it('0 evidence on a critical skill is a Blocking Condition (HARD) and tier=STRETCH', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        critical_skills: [
          { name: 'Java', evidence_count: 0, has_ingested_evidence: false },
        ],
      }),
    );
    expect(result.tier).toBe('STRETCH');
    expect(result.hard_failures.map((f) => f.criterion)).toContain(
      'missing_critical_skill (Java)',
    );
  });

  it('insufficient evidence_count (>=1 but below threshold) is SOFT (Anita-class case) → WORTH_CONSIDERING when no hard failures', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        // Backend Engineer: threshold = 2. With 1 evidence and ingested
        // satisfied, only the soft "insufficient count" applies.
        critical_skills: [
          { name: 'Java', evidence_count: 1, has_ingested_evidence: true },
        ],
      }),
    );
    expect(result.tier).toBe('WORTH_CONSIDERING');
    expect(result.hard_failures).toEqual([]);
    expect(result.soft_failures.map((f) => f.criterion)).toContain(
      'skill_evidence_count (Java)',
    );
  });

  // Gate-1 R7 — declared-only (no ingested) on a requires_ingested family is a
  // SOFT criterion now: caps at WORTH_CONSIDERING (submittable-with-vouching),
  // never STRETCH. The ENTRUSTABLE moat stays: the soft blocks ENTRUSTABLE.
  it('R7: missing-ingested for an engineering role is SOFT → WORTH_CONSIDERING (never STRETCH), and blocks ENTRUSTABLE', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        critical_skills: [
          // count satisfied (2) but no ingested evidence → R7 soft, not hard.
          { name: 'Java', evidence_count: 2, has_ingested_evidence: false },
        ],
      }),
    );
    expect(result.tier).toBe('WORTH_CONSIDERING');
    expect(result.tier).not.toBe('STRETCH');
    expect(result.tier).not.toBe('ENTRUSTABLE');
    expect(result.hard_failures.map((f) => f.criterion)).not.toContain(
      'skill_ingested_evidence (Java)',
    );
    expect(result.soft_failures.map((f) => f.criterion)).toContain(
      'skill_ingested_evidence (Java)',
    );
  });

  it('PM/BA roles do NOT require ingested evidence — count-only passes', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        role_family: 'product_project_manager',
        critical_skills: [
          { name: 'Stakeholder Management', evidence_count: 2, has_ingested_evidence: false },
        ],
      }),
    );
    expect(result.tier).toBe('ENTRUSTABLE');
  });
});

describe('evaluateEntrustability — Constraint Rule (Gate-1 R8 per-value)', () => {
  for (const field of ['location', 'work_mode', 'rate', 'work_authorization'] as const) {
    // 'fail' → HARD (STRETCH) — a genuine incompatibility still blocks.
    it(`R8: constraint_${field}='fail' is HARD → STRETCH`, () => {
      const result = evaluateEntrustability(
        entrustablePass({
          constraint_checks_evaluated: {
            location: 'pass',
            work_mode: 'pass',
            rate: 'pass',
            work_authorization: 'pass',
            [field]: 'fail',
          },
        }),
      );
      expect(result.tier).toBe('STRETCH');
      expect(result.hard_failures.map((f) => f.criterion)).toContain(
        `constraint_${field}`,
      );
    });

    // 'partial' → SOFT (WORTH_CONSIDERING) — partially satisfied, caps not sinks.
    it(`R8: constraint_${field}='partial' is SOFT → WORTH_CONSIDERING`, () => {
      const result = evaluateEntrustability(
        entrustablePass({
          constraint_checks_evaluated: {
            location: 'pass',
            work_mode: 'pass',
            rate: 'pass',
            work_authorization: 'pass',
            [field]: 'partial',
          },
        }),
      );
      expect(result.tier).toBe('WORTH_CONSIDERING');
      expect(result.hard_failures).toEqual([]);
      expect(result.soft_failures.map((f) => f.criterion)).toContain(
        `constraint_${field}`,
      );
    });

    // 'unknown' → NON-BLOCKING — no criterion; honest signal is carried by
    // confidence_indicators.data_completeness (not this loop).
    it(`R8: constraint_${field}='unknown' is NON-BLOCKING (no criterion, tier unchanged)`, () => {
      const result = evaluateEntrustability(
        entrustablePass({
          constraint_checks_evaluated: {
            location: 'pass',
            work_mode: 'pass',
            rate: 'pass',
            work_authorization: 'pass',
            [field]: 'unknown',
          },
        }),
      );
      expect(result.tier).toBe('ENTRUSTABLE');
      expect(
        result.failed_criteria.map((f) => f.criterion),
      ).not.toContain(`constraint_${field}`);
    });
  }
});

describe('evaluateEntrustability — Risk Rule (§2.5)', () => {
  it('a single risk_flag with severity=high is HARD → STRETCH', () => {
    const result = evaluateEntrustability(
      entrustablePass({ risk_flags_evaluated: [{ severity: 'high' }] }),
    );
    expect(result.tier).toBe('STRETCH');
    expect(result.hard_failures.map((f) => f.criterion)).toContain(
      'risk_flag_high_severity',
    );
  });

  it('risk_flags of severity low or medium do NOT fail the Risk Rule', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        risk_flags_evaluated: [{ severity: 'low' }, { severity: 'medium' }],
      }),
    );
    expect(result.tier).toBe('ENTRUSTABLE');
  });
});

describe('evaluateEntrustability — Confidence Rule (§2.5)', () => {
  for (const field of ['evidence_strength', 'data_completeness', 'constraint_confidence'] as const) {
    it(`confidence_indicators.${field}='low' is SOFT → WORTH_CONSIDERING`, () => {
      const result = evaluateEntrustability(
        entrustablePass({
          confidence_indicators_evaluated: {
            evidence_strength: 'high',
            data_completeness: 'high',
            constraint_confidence: 'high',
            [field]: 'low',
          },
        }),
      );
      expect(result.tier).toBe('WORTH_CONSIDERING');
      expect(result.soft_failures.map((f) => f.criterion)).toContain(field);
    });

    it(`confidence_indicators.${field}='medium' does NOT fail`, () => {
      const result = evaluateEntrustability(
        entrustablePass({
          confidence_indicators_evaluated: {
            evidence_strength: 'high',
            data_completeness: 'high',
            constraint_confidence: 'high',
            [field]: 'medium',
          },
        }),
      );
      expect(result.tier).toBe('ENTRUSTABLE');
    });
  }
});

describe('evaluateEntrustability — Blocking Conditions Rule (§2.5)', () => {
  it('no verified contact channel is HARD → STRETCH', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        blocking_conditions: {
          has_verified_contact_channel: false,
          consent_state_sufficient: true,
          has_conflicting_active_engagement: false,
        },
      }),
    );
    expect(result.tier).toBe('STRETCH');
    expect(result.hard_failures.map((f) => f.criterion)).toContain(
      'no_verified_contact_channel',
    );
  });

  it('consent state insufficient is HARD → STRETCH', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        blocking_conditions: {
          has_verified_contact_channel: true,
          consent_state_sufficient: false,
          has_conflicting_active_engagement: false,
        },
      }),
    );
    expect(result.tier).toBe('STRETCH');
    expect(result.hard_failures.map((f) => f.criterion)).toContain(
      'consent_state_insufficient',
    );
  });

  it('conflicting active engagement is HARD → STRETCH', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        blocking_conditions: {
          has_verified_contact_channel: true,
          consent_state_sufficient: true,
          has_conflicting_active_engagement: true,
        },
      }),
    );
    expect(result.tier).toBe('STRETCH');
    expect(result.hard_failures.map((f) => f.criterion)).toContain(
      'conflicting_active_engagement',
    );
  });
});

describe('evaluateEntrustability — tier boundaries', () => {
  it('all-pass → ENTRUSTABLE', () => {
    expect(evaluateEntrustability(entrustablePass()).tier).toBe('ENTRUSTABLE');
  });

  it('soft-only → WORTH_CONSIDERING', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        confidence_indicators_evaluated: {
          evidence_strength: 'low',
          data_completeness: 'high',
          constraint_confidence: 'high',
        },
      }),
    );
    expect(result.tier).toBe('WORTH_CONSIDERING');
    expect(result.hard_failures).toEqual([]);
    expect(result.soft_failures.length).toBeGreaterThan(0);
  });

  it('≥1 hard → STRETCH (even alongside soft failures)', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        // One hard (constraint fail) + one soft (low evidence_strength).
        constraint_checks_evaluated: {
          location: 'fail',
          work_mode: 'pass',
          rate: 'pass',
          work_authorization: 'pass',
        },
        confidence_indicators_evaluated: {
          evidence_strength: 'low',
          data_completeness: 'high',
          constraint_confidence: 'high',
        },
      }),
    );
    expect(result.tier).toBe('STRETCH');
    expect(result.hard_failures.length).toBeGreaterThan(0);
    expect(result.soft_failures.length).toBeGreaterThan(0);
  });
});

describe('evaluateEntrustability — role-family calibration table (§2.5)', () => {
  // Every row of the §2.5 calibration table — Architect requires 3,
  // everyone else 2; PM/BA do not require ingested.
  for (const family of ROLE_FAMILIES) {
    const threshold = EVIDENCE_THRESHOLDS[family];
    it(`${family}: count=${String(threshold.count)} requires_ingested=${String(threshold.requires_ingested)} reflected in the engine`, () => {
      // At threshold + ingested-as-required → pass.
      const okIngested = threshold.requires_ingested;
      const okResult = evaluateEntrustability(
        entrustablePass({
          role_family: family,
          critical_skills: [
            { name: 'CriticalSkill', evidence_count: threshold.count, has_ingested_evidence: okIngested },
          ],
        }),
      );
      expect(okResult.tier).toBe('ENTRUSTABLE');

      // Below threshold (but ≥1) → soft "insufficient evidence_count".
      const belowResult = evaluateEntrustability(
        entrustablePass({
          role_family: family,
          critical_skills: [
            { name: 'CriticalSkill', evidence_count: threshold.count - 1, has_ingested_evidence: okIngested },
          ],
        }),
      );
      expect(belowResult.soft_failures.map((f) => f.criterion)).toContain(
        'skill_evidence_count (CriticalSkill)',
      );
    });
  }

  it('Architect explicitly requires ≥3 evidence (not ≥2)', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        role_family: 'architect',
        critical_skills: [
          { name: 'SystemDesign', evidence_count: 2, has_ingested_evidence: true },
        ],
      }),
    );
    // 2 < threshold(3) but ≥1 → soft.
    expect(result.soft_failures.map((f) => f.criterion)).toContain(
      'skill_evidence_count (SystemDesign)',
    );
    expect(result.tier).toBe('WORTH_CONSIDERING');
  });

  it('business_analyst explicitly does NOT fail on missing ingested', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        role_family: 'business_analyst',
        critical_skills: [
          { name: 'RequirementsElicitation', evidence_count: 2, has_ingested_evidence: false },
        ],
      }),
    );
    expect(result.tier).toBe('ENTRUSTABLE');
  });
});

describe('evaluateEntrustability — failed_criteria[] shape (§2.5)', () => {
  it('every failed_criteria entry has the four §2.5-named keys', () => {
    const result = evaluateEntrustability(
      entrustablePass({
        critical_skills: [
          { name: 'Java', evidence_count: 0, has_ingested_evidence: false },
        ],
        constraint_checks_evaluated: {
          location: 'fail',
          work_mode: 'pass',
          rate: 'pass',
          work_authorization: 'pass',
        },
        confidence_indicators_evaluated: {
          evidence_strength: 'low',
          data_completeness: 'high',
          constraint_confidence: 'high',
        },
      }),
    );
    expect(result.failed_criteria.length).toBeGreaterThan(0);
    for (const entry of result.failed_criteria) {
      expect(entry).toHaveProperty('criterion');
      expect(entry).toHaveProperty('field_path');
      expect(entry).toHaveProperty('observed_value');
      expect(entry).toHaveProperty('expected_threshold');
      expect(typeof entry.criterion).toBe('string');
      expect(typeof entry.field_path).toBe('string');
      expect(typeof entry.observed_value).toBe('string');
      expect(typeof entry.expected_threshold).toBe('string');
    }
  });
});

describe('evaluateEntrustability — determinism', () => {
  it('produces byte-identical results on repeated invocations of the same input', () => {
    const input = entrustablePass({
      critical_skills: [
        { name: 'Java', evidence_count: 1, has_ingested_evidence: true },
      ],
      confidence_indicators_evaluated: {
        evidence_strength: 'low',
        data_completeness: 'high',
        constraint_confidence: 'high',
      },
    });
    const a = evaluateEntrustability(input);
    const b = evaluateEntrustability(input);
    const c = evaluateEntrustability(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(b)).toBe(JSON.stringify(c));
  });
});

describe('evaluateEntrustability — contract version check (§3.1 coupling)', () => {
  it('throws when contract_version does not match the engine-expected version', () => {
    const input = entrustablePass();
    // Intentionally pass an incompatible value; the runtime check is the
    // protection against silent shape-drift.
    const incompatible = {
      ...input,
      contract_version: 'matching-input-vNEXT' as unknown as typeof input.contract_version,
    };
    expect(() => evaluateEntrustability(incompatible)).toThrow(
      new RegExp(`contract_version mismatch.*${MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION}`),
    );
  });
});

describe('evaluateEntrustability — §2.5 Anita Sharma Worked Example', () => {
  it('Anita Sharma (Backend Engineer; AWS evidence_count=1; evidence_strength=low) → WORTH_CONSIDERING', () => {
    // §2.5 worked example, reproduced verbatim:
    //   "Skill evidence: AWS evidence_count = 1 → FAIL"
    //   "Confidence: evidence_strength = low → FAIL"
    //   "All hard criteria passed"
    //   "Tier: Worth Considering"
    // Java is listed but the example only details AWS — assume Java
    // meets the threshold (the worked example asserts WORTH_CONSIDERING,
    // not STRETCH, so no hard skill failure).
    const result = evaluateEntrustability(
      entrustablePass({
        role_family: 'backend_engineer',
        critical_skills: [
          { name: 'Java', evidence_count: 3, has_ingested_evidence: true },
          { name: 'AWS', evidence_count: 1, has_ingested_evidence: true },
        ],
        confidence_indicators_evaluated: {
          evidence_strength: 'low',
          data_completeness: 'high',
          constraint_confidence: 'high',
        },
      }),
    );
    expect(result.tier).toBe('WORTH_CONSIDERING');
    expect(result.hard_failures).toEqual([]);
    expect(result.soft_failures.map((f) => f.criterion).sort()).toEqual(
      ['evidence_strength', 'skill_evidence_count (AWS)'].sort(),
    );
    // Spot-check field_path on the AWS soft failure matches §2.5's
    // example shape: skill_match.matched_critical_skills[AWS].evidence_count
    const awsFailure = result.soft_failures.find(
      (f) => f.criterion === 'skill_evidence_count (AWS)',
    );
    expect(awsFailure?.field_path).toBe(
      'skill_match.matched_critical_skills[AWS].evidence_count',
    );
    expect(awsFailure?.observed_value).toBe('1');
    expect(awsFailure?.expected_threshold).toBe('>= 2 with >=1 ingested');
  });
});
