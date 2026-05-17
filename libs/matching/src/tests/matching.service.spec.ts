import { describe, expect, it, vi } from 'vitest';
import type {
  ExaminationRepository,
  TalentJobExaminationRow,
  CreateExaminationSnapshotInput,
} from '@aramo/examination';

import { MatchingService } from '../lib/matching.service.js';
import {
  EXAMINATION_VERSION,
  MATCHING_MODEL_VERSION,
  TAXONOMY_VERSION,
} from '../lib/dto/version-pins.js';

import { entrustablePass } from './_input-factory.js';

// MatchingService unit tests with a stubbed ExaminationRepository. The
// integration spec exercises the real Prisma path against a Postgres
// testcontainer; here we assert the orchestration contract:
//   - delta_to_entrustable is null when the engine returns ENTRUSTABLE
//   - delta_to_entrustable carries blockers + recommended_actions when
//     soft-only (WORTH_CONSIDERING → next ENTRUSTABLE)
//   - delta_to_entrustable carries blockers from hard failures when
//     STRETCH (→ next WORTH_CONSIDERING)
//   - the three §3.4 version pins are supplied from typed constants on
//     every snapshot
//   - all nine §2.4 Json analysis-product fields are forwarded verbatim
//     from the input contract into createSnapshot

function makeStubRepo(): {
  repo: ExaminationRepository;
  createSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn(async (input: CreateExaminationSnapshotInput) => {
    // Return a row shape the caller can read back. Lifecycle defaults
    // mirror PR-1's schema defaults.
    return {
      ...input,
      delta_to_entrustable: input.delta_to_entrustable ?? null,
      lifecycle_state: 'active' as const,
      archived_at: null,
      superseded_by_examination_id: null,
    } as TalentJobExaminationRow;
  });
  return {
    createSpy,
    repo: { createSnapshot: createSpy } as unknown as ExaminationRepository,
  };
}

describe('MatchingService.evaluate', () => {
  it('returns null delta_to_entrustable when tier is ENTRUSTABLE', () => {
    const { repo } = makeStubRepo();
    const svc = new MatchingService(repo);
    const { examination, delta_to_entrustable } = svc.evaluate(entrustablePass());
    expect(examination.tier).toBe('ENTRUSTABLE');
    expect(delta_to_entrustable).toBeNull();
  });

  it('builds delta_to_entrustable from soft failures when tier is WORTH_CONSIDERING (next=ENTRUSTABLE)', () => {
    const { repo } = makeStubRepo();
    const svc = new MatchingService(repo);
    const { examination, delta_to_entrustable } = svc.evaluate(
      entrustablePass({
        confidence_indicators_evaluated: {
          evidence_strength: 'low',
          data_completeness: 'high',
          constraint_confidence: 'high',
        },
      }),
    );
    expect(examination.tier).toBe('WORTH_CONSIDERING');
    expect(delta_to_entrustable).not.toBeNull();
    expect(delta_to_entrustable?.current_tier).toBe('WORTH_CONSIDERING');
    expect(delta_to_entrustable?.next_tier_target).toBe('ENTRUSTABLE');
    expect(delta_to_entrustable?.blockers).toContain('evidence_strength');
    expect(delta_to_entrustable?.recommended_actions.length).toBeGreaterThan(0);
  });

  it('builds delta_to_entrustable from hard failures when tier is STRETCH (next=WORTH_CONSIDERING)', () => {
    const { repo } = makeStubRepo();
    const svc = new MatchingService(repo);
    const { examination, delta_to_entrustable } = svc.evaluate(
      entrustablePass({
        constraint_checks_evaluated: {
          location: 'fail',
          work_mode: 'pass',
          rate: 'pass',
          work_authorization: 'pass',
        },
      }),
    );
    expect(examination.tier).toBe('STRETCH');
    expect(delta_to_entrustable?.current_tier).toBe('STRETCH');
    expect(delta_to_entrustable?.next_tier_target).toBe('WORTH_CONSIDERING');
    expect(delta_to_entrustable?.blockers).toContain('constraint_location');
  });
});

describe('MatchingService.evaluateAndPersist — orchestration contract', () => {
  it('supplies all three §3.4 version pins from typed constants', async () => {
    const { repo, createSpy } = makeStubRepo();
    const svc = new MatchingService(repo);
    await svc.evaluateAndPersist(entrustablePass());
    expect(createSpy).toHaveBeenCalledOnce();
    const call = createSpy.mock.calls[0]?.[0] as CreateExaminationSnapshotInput;
    expect(call.examination_version).toBe(EXAMINATION_VERSION);
    expect(call.model_version).toBe(MATCHING_MODEL_VERSION);
    expect(call.taxonomy_version).toBe(TAXONOMY_VERSION);
  });

  it('forwards all nine §2.4 Json analysis-product fields verbatim from the input', async () => {
    const { repo, createSpy } = makeStubRepo();
    const svc = new MatchingService(repo);
    const marker = Symbol('json-marker');
    const distinct = {
      expanded_reasoning: ['er', marker],
      skill_match: { sm: marker },
      experience_match: { em: marker },
      constraint_checks: { cc: marker },
      strengths: ['s', marker],
      gaps: ['g', marker],
      risk_flags: ['rf', marker],
      confidence_indicators: { ci: marker },
      freshness_indicator: { fi: marker },
    };
    await svc.evaluateAndPersist(entrustablePass(distinct as never));
    const call = createSpy.mock.calls[0]?.[0] as CreateExaminationSnapshotInput;
    expect(call.expanded_reasoning).toBe(distinct.expanded_reasoning);
    expect(call.skill_match).toBe(distinct.skill_match);
    expect(call.experience_match).toBe(distinct.experience_match);
    expect(call.constraint_checks).toBe(distinct.constraint_checks);
    expect(call.strengths).toBe(distinct.strengths);
    expect(call.gaps).toBe(distinct.gaps);
    expect(call.risk_flags).toBe(distinct.risk_flags);
    expect(call.confidence_indicators).toBe(distinct.confidence_indicators);
    expect(call.freshness_indicator).toBe(distinct.freshness_indicator);
  });

  it('does NOT supply lifecycle_state (PR-1 schema defaults it)', async () => {
    const { repo, createSpy } = makeStubRepo();
    const svc = new MatchingService(repo);
    await svc.evaluateAndPersist(entrustablePass());
    const call = createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.lifecycle_state).toBeUndefined();
    expect(call.archived_at).toBeUndefined();
    expect(call.superseded_by_examination_id).toBeUndefined();
  });
});
