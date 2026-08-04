import { Injectable } from '@nestjs/common';
import { RequirementInstanceRepository, type BlockingAssessment } from '@aramo/pre-start-requirement';

// Track 3 / E2 (§14 A2-R) — the readiness gate consumes an INJECTED evaluator,
// never an environment-controlled bypass. There is no SKIP_READINESS_GATE, no env
// flag, no build-time toggle: the gate-less state is unreachable in the shipped
// artifact because production ALWAYS binds the real evaluator. A test module may
// override this token with a permissive double to demonstrate gate-less behaviour
// — that override lives in test wiring, never in production code.
//
// Proving with a stub (not a flag) proves MORE: a flag shows one conditional
// refuses; a permissive double shows that ANY implementation not performing the
// check fails the specs — i.e. the gate is load-bearing.
export const READINESS_EVALUATOR = 'PRE_START_READINESS_EVALUATOR';

export interface ReadinessEvaluator {
  assess(tenant_id: string, placement_process_id: string): Promise<BlockingAssessment>;
}

// The production evaluator: delegates to the domain assessment. No env reads.
@Injectable()
export class RealReadinessEvaluator implements ReadinessEvaluator {
  constructor(private readonly requirements: RequirementInstanceRepository) {}

  assess(tenant_id: string, placement_process_id: string): Promise<BlockingAssessment> {
    return this.requirements.assessBlocking(tenant_id, placement_process_id);
  }
}
