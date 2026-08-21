import { describe, expect, it } from 'vitest';

import {
  deriveWindowStatus,
  evaluateEligibility,
  type EligibilityContext,
  type SubmittalPolicyInputs,
} from '../lib/submittal-eligibility.port';

// L8-B1 — the pure eligibility decision (the safety semantics; the DB-level
// serialized-consumption concurrency proof lands with the orchestrator).
// Gate order (base R5, steps 3–6): status OPEN → deadline → slot → restriction.

const NOW = new Date('2026-08-22T12:00:00Z');

function inputs(over: Partial<SubmittalPolicyInputs> = {}): SubmittalPolicyInputs {
  return {
    submittal_deadline: null,
    submittal_limit: null,
    manual_override: null,
    submittal_authority: 'ARAMO',
    ...over,
  };
}
function ctx(over: Partial<EligibilityContext> = {}): EligibilityContext {
  return { now: NOW, consumed_count: 0, restriction_active: false, ...over };
}

describe('evaluateEligibility (pure gate)', () => {
  it('default policy (no deadline, no limit) → OPEN + eligible', () => {
    const d = evaluateEligibility(inputs(), ctx());
    expect(d).toEqual({ eligible: true, status: 'OPEN' });
  });

  it('deadline in the past → CLOSED + SUBMITTAL_WINDOW_PASSED', () => {
    const d = evaluateEligibility(
      inputs({ submittal_deadline: new Date('2026-08-22T11:59:59Z') }),
      ctx(),
    );
    expect(d.eligible).toBe(false);
    expect(d.status).toBe('CLOSED');
    expect(d.deny).toBe('SUBMITTAL_WINDOW_PASSED');
  });

  it('deadline in the future → OPEN + eligible', () => {
    const d = evaluateEligibility(
      inputs({ submittal_deadline: new Date('2026-08-22T12:00:01Z') }),
      ctx(),
    );
    expect(d.eligible).toBe(true);
    expect(d.status).toBe('OPEN');
  });

  it('slots exhausted (consumed >= limit) → CLOSED + SUBMITTAL_LIMIT_REACHED', () => {
    const d = evaluateEligibility(
      inputs({ submittal_limit: 1 }),
      ctx({ consumed_count: 1 }),
    );
    expect(d.eligible).toBe(false);
    expect(d.deny).toBe('SUBMITTAL_LIMIT_REACHED');
  });

  it('slots remaining (consumed < limit) → OPEN + eligible', () => {
    const d = evaluateEligibility(
      inputs({ submittal_limit: 2 }),
      ctx({ consumed_count: 1 }),
    );
    expect(d.eligible).toBe(true);
  });

  it('manual_override CLOSED → deny SUBMITTALS_CLOSED (wins over an open window)', () => {
    const d = evaluateEligibility(inputs({ manual_override: 'CLOSED' }), ctx());
    expect(d).toEqual({
      eligible: false,
      status: 'CLOSED',
      deny: 'SUBMITTALS_CLOSED',
    });
  });

  it('manual_override PAUSED → deny SUBMITTALS_CLOSED', () => {
    const d = evaluateEligibility(inputs({ manual_override: 'PAUSED' }), ctx());
    expect(d.status).toBe('PAUSED');
    expect(d.deny).toBe('SUBMITTALS_CLOSED');
  });

  it('manual_override OPEN overrides a passed deadline → OPEN + eligible', () => {
    const d = evaluateEligibility(
      inputs({
        manual_override: 'OPEN',
        submittal_deadline: new Date('2020-01-01T00:00:00Z'),
      }),
      ctx(),
    );
    expect(d).toEqual({ eligible: true, status: 'OPEN' });
  });

  it('OPEN window but an active client restriction → TALENT_RESTRICTED_AT_CLIENT', () => {
    const d = evaluateEligibility(inputs(), ctx({ restriction_active: true }));
    expect(d.eligible).toBe(false);
    expect(d.status).toBe('OPEN');
    expect(d.deny).toBe('TALENT_RESTRICTED_AT_CLIENT');
  });

  it('deriveWindowStatus surfaces the closed_by discriminator for provenance', () => {
    expect(deriveWindowStatus(inputs(), ctx()).closed_by).toBeNull();
    expect(
      deriveWindowStatus(inputs({ submittal_limit: 1 }), ctx({ consumed_count: 1 }))
        .closed_by,
    ).toBe('QUOTA');
  });
});
