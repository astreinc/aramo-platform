import { describe, expect, it, vi } from 'vitest';
import type {
  CreateExaminationSnapshotInput,
  ExaminationRepository,
  TalentJobExaminationRow,
} from '@aramo/examination';

import { evaluateEntrustability, EVIDENCE_THRESHOLDS } from '../lib/engine.js';
import { ROLE_FAMILIES } from '../lib/dto/matching-analysis-input.dto.js';
import {
  DEFAULT_EVIDENCE_THRESHOLDS,
  DEFAULT_MATCHING_POLICY,
  parseEvidenceThresholds,
  type MatchingPolicy,
  type MatchingPolicySource,
} from '../lib/matching-policy.js';
import { MatchingService } from '../lib/matching.service.js';

import { entrustablePass } from './_input-factory.js';

// ATI-SEP-1 A2 A-c (P1) — the platform-owned MatchingPolicy.
//   - The compiled defaults are the PRE-POLICY §2.5 constants exactly (the literal
//     below is the table engine.ts hard-coded before P1; behaviour is unchanged).
//   - The engine reads the thresholds of the policy it is handed (pure; same
//     input + same policy → same output) and defaults to the compiled policy.
//   - parseEvidenceThresholds is strict (every family, no unknown family/field,
//     integer count in bounds, boolean requires_ingested).
//   - MatchingService resolves the ACTIVE policy through the port, falls back to the
//     compiled defaults only when the store is empty / unbound, and propagates a
//     store read error.

// The table engine.ts carried as EVIDENCE_THRESHOLDS before P1 (frozen literal —
// never derived from the code under test).
const PRE_POLICY_CONSTANTS = {
  backend_engineer: { count: 2, requires_ingested: true },
  frontend_engineer: { count: 2, requires_ingested: true },
  fullstack_engineer: { count: 2, requires_ingested: true },
  devops_sre: { count: 2, requires_ingested: true },
  data_engineer: { count: 2, requires_ingested: true },
  architect: { count: 3, requires_ingested: true },
  qa_test_engineer: { count: 2, requires_ingested: true },
  product_project_manager: { count: 2, requires_ingested: false },
  business_analyst: { count: 2, requires_ingested: false },
};

function policyWith(overrides: Partial<Record<string, { count: number; requires_ingested: boolean }>>): MatchingPolicy {
  return {
    version_number: 2,
    evidence_thresholds: { ...DEFAULT_EVIDENCE_THRESHOLDS, ...overrides } as MatchingPolicy['evidence_thresholds'],
  };
}

describe('MatchingPolicy compiled defaults', () => {
  it('equal the pre-policy §2.5 constants exactly', () => {
    expect(DEFAULT_EVIDENCE_THRESHOLDS).toEqual(PRE_POLICY_CONSTANTS);
    expect(EVIDENCE_THRESHOLDS).toEqual(PRE_POLICY_CONSTANTS);
    expect(DEFAULT_MATCHING_POLICY.version_number).toBeNull();
  });

  it('cover every role family', () => {
    expect(Object.keys(DEFAULT_EVIDENCE_THRESHOLDS).sort()).toEqual([...ROLE_FAMILIES].sort());
  });

  it('are frozen', () => {
    expect(Object.isFrozen(DEFAULT_EVIDENCE_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EVIDENCE_THRESHOLDS.architect)).toBe(true);
  });
});

describe('evaluateEntrustability — policy parameter', () => {
  const twoIngested = entrustablePass({
    role_family: 'backend_engineer',
    critical_skills: [{ name: 'Go', evidence_count: 2, has_ingested_evidence: true }],
  });

  it('omitting the policy is identical to passing the compiled defaults', () => {
    expect(evaluateEntrustability(twoIngested)).toEqual(
      evaluateEntrustability(twoIngested, DEFAULT_MATCHING_POLICY),
    );
  });

  it('a raised count turns a passing skill into a soft insufficient-count criterion', () => {
    const raised = policyWith({ backend_engineer: { count: 4, requires_ingested: true } });
    const result = evaluateEntrustability(twoIngested, raised);
    expect(result.tier).toBe('WORTH_CONSIDERING');
    expect(result.soft_failures).toEqual([
      {
        criterion: 'skill_evidence_count (Go)',
        field_path: 'skill_match.matched_critical_skills[Go].evidence_count',
        observed_value: '2',
        expected_threshold: '>= 4 with >=1 ingested',
      },
    ]);
  });

  it('dropping requires_ingested removes the ingested criterion', () => {
    const declaredOnly = entrustablePass({
      role_family: 'backend_engineer',
      critical_skills: [{ name: 'Go', evidence_count: 2, has_ingested_evidence: false }],
    });
    expect(evaluateEntrustability(declaredOnly).tier).toBe('WORTH_CONSIDERING');
    const relaxed = policyWith({ backend_engineer: { count: 2, requires_ingested: false } });
    const result = evaluateEntrustability(declaredOnly, relaxed);
    expect(result.tier).toBe('ENTRUSTABLE');
    expect(result.failed_criteria).toEqual([]);
  });

  it('is deterministic for the same input and policy', () => {
    const raised = policyWith({ architect: { count: 5, requires_ingested: true } });
    const input = entrustablePass({ role_family: 'architect' });
    const a = evaluateEntrustability(input, raised);
    const b = evaluateEntrustability(input, raised);
    expect(a).toEqual(b);
  });
});

describe('parseEvidenceThresholds', () => {
  it('accepts the compiled defaults', () => {
    const r = parseEvidenceThresholds(JSON.parse(JSON.stringify(PRE_POLICY_CONSTANTS)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.thresholds).toEqual(PRE_POLICY_CONSTANTS);
  });

  it('refuses a non-object document', () => {
    expect(parseEvidenceThresholds(null).ok).toBe(false);
    expect(parseEvidenceThresholds([]).ok).toBe(false);
    expect(parseEvidenceThresholds('x').ok).toBe(false);
  });

  it('refuses a missing family, an unknown family and an unknown field', () => {
    const missing: Record<string, unknown> = { ...PRE_POLICY_CONSTANTS };
    delete missing['architect'];
    const r1 = parseEvidenceThresholds(missing);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors).toContain('architect: missing threshold');

    const r2 = parseEvidenceThresholds({ ...PRE_POLICY_CONSTANTS, astronaut: { count: 2, requires_ingested: true } });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors).toContain('unknown role family: astronaut');

    const r3 = parseEvidenceThresholds({
      ...PRE_POLICY_CONSTANTS,
      architect: { count: 3, requires_ingested: true, weight: 1 },
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.errors).toContain('architect: unknown field(s) weight');
  });

  it('refuses an out-of-bounds or non-integer count and a non-boolean requires_ingested', () => {
    for (const count of [0, 21, 2.5, '2']) {
      const r = parseEvidenceThresholds({
        ...PRE_POLICY_CONSTANTS,
        devops_sre: { count, requires_ingested: true },
      });
      expect(r.ok).toBe(false);
    }
    const r = parseEvidenceThresholds({
      ...PRE_POLICY_CONSTANTS,
      devops_sre: { count: 2, requires_ingested: 'yes' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('devops_sre.requires_ingested must be a boolean');
  });
});

function stubRepo(): { repo: ExaminationRepository; createSpy: ReturnType<typeof vi.fn> } {
  const createSpy = vi.fn(async (input: CreateExaminationSnapshotInput) => ({
    ...input,
    delta_to_entrustable: input.delta_to_entrustable ?? null,
    lifecycle_state: 'active' as const,
    archived_at: null,
    superseded_by_examination_id: null,
  }) as TalentJobExaminationRow);
  return { createSpy, repo: { createSnapshot: createSpy } as unknown as ExaminationRepository };
}

describe('MatchingService — ACTIVE policy resolution', () => {
  const input = entrustablePass({
    role_family: 'backend_engineer',
    critical_skills: [{ name: 'Go', evidence_count: 2, has_ingested_evidence: true }],
  });

  it('uses the compiled defaults when no source is bound', async () => {
    const { repo } = stubRepo();
    const svc = new MatchingService(repo);
    expect(await svc.resolvePolicy()).toBe(DEFAULT_MATCHING_POLICY);
  });

  it('uses the compiled defaults when the store holds no ACTIVE version', async () => {
    const { repo } = stubRepo();
    const source: MatchingPolicySource = { getActivePolicy: async () => null };
    const svc = new MatchingService(repo, source);
    expect(await svc.resolvePolicy()).toBe(DEFAULT_MATCHING_POLICY);
    const row = await svc.evaluateAndPersist(input);
    expect(row.tier).toBe('ENTRUSTABLE');
  });

  it('persists the tier the ACTIVE policy yields', async () => {
    const { repo, createSpy } = stubRepo();
    const raised = policyWith({ backend_engineer: { count: 3, requires_ingested: true } });
    const source: MatchingPolicySource = { getActivePolicy: async () => raised };
    const svc = new MatchingService(repo, source);
    await svc.evaluateAndPersist(input);
    const written = createSpy.mock.calls[0]?.[0] as CreateExaminationSnapshotInput;
    expect(written.tier).toBe('WORTH_CONSIDERING');
  });

  it('propagates a store read error instead of falling back to defaults', async () => {
    const { repo, createSpy } = stubRepo();
    const source: MatchingPolicySource = {
      getActivePolicy: async () => {
        throw new Error('store unavailable');
      },
    };
    const svc = new MatchingService(repo, source);
    await expect(svc.evaluateAndPersist(input)).rejects.toThrow('store unavailable');
    expect(createSpy).not.toHaveBeenCalled();
  });
});
