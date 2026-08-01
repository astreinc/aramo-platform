import { describe, expect, it } from 'vitest';

import type { AddTalentPolicyOutcome } from '../lib/policy/add-talent-policy.service.js';
import { resolveAddTalentOutcome } from '../lib/policy/override-resolution.js';

// ADR-0024 §D11 (PR-4b) — the pure two-pass resolution. Membership test against
// the frozen scope set (NO acquisition), then reason capture. Exercised here
// without HTTP; the E2E (apps/api) proves the boundary wiring.

const CAP = 'requisition.override.submittal_closed';

function outcome(partial: Partial<AddTalentPolicyOutcome>): AddTalentPolicyOutcome {
  return {
    disposition: 'REQUIRES_OVERRIDE',
    reason_code: 'SUBMITTAL_CLOSED_OVERRIDE_REQUIRED',
    required_capabilities: [CAP],
    provenance: {
      tenant_id: 't',
      decision: 'REQUIRES_OVERRIDE',
      policy_version: '1.0.0',
      rule_id: 'add-talent-full',
      reason_code: 'SUBMITTAL_CLOSED_OVERRIDE_REQUIRED',
      resource: 'REQUISITION_TALENT',
      action: 'ADD',
      inputs: {
        resource: 'REQUISITION_TALENT',
        action: 'ADD',
        declared: { status: 'full' },
        derived: {},
        capabilities: {},
      },
      actor_id: 'a',
      origin: 'ui',
      correlation_id: 'c',
    },
    ...partial,
  };
}

describe('resolveAddTalentOutcome (§D11 two-pass override)', () => {
  it('ALLOW disposition -> ALLOW (proceed, base provenance)', () => {
    const r = resolveAddTalentOutcome(
      outcome({ disposition: 'ALLOW', required_capabilities: [] }),
      [],
      undefined,
    );
    expect(r.kind).toBe('ALLOW');
  });

  it('DENY disposition -> DENY carrying the engine reason_code', () => {
    const r = resolveAddTalentOutcome(
      outcome({ disposition: 'DENY', required_capabilities: [] }),
      [],
      undefined,
    );
    expect(r).toMatchObject({
      kind: 'DENY',
      reason_code: 'SUBMITTAL_CLOSED_OVERRIDE_REQUIRED',
    });
  });

  it('REQUIRES_OVERRIDE + capability ABSENT -> DENY (membership fails; nothing is acquired)', () => {
    const r = resolveAddTalentOutcome(outcome({}), ['pipeline:add'], 'replacement');
    expect(r.kind).toBe('DENY'); // scope set does not hold CAP
  });

  it('REQUIRES_OVERRIDE + capability present + NO reason -> REASON_REQUIRED', () => {
    const r = resolveAddTalentOutcome(outcome({}), [CAP], undefined);
    expect(r.kind).toBe('REASON_REQUIRED');
  });

  it('REQUIRES_OVERRIDE + capability + INVALID reason code -> REASON_INVALID (echoes the bad value)', () => {
    const r = resolveAddTalentOutcome(outcome({}), [CAP], 'not_a_real_code');
    expect(r).toMatchObject({ kind: 'REASON_INVALID', value: 'not_a_real_code' });
  });

  it('REQUIRES_OVERRIDE + capability + valid reason -> OVERRIDE; provenance.inputs.override carries reason_code + capability', () => {
    const r = resolveAddTalentOutcome(outcome({}), [CAP, 'pipeline:add'], 'replacement');
    expect(r.kind).toBe('OVERRIDE');
    if (r.kind === 'OVERRIDE') {
      expect(r.provenance.inputs.override).toEqual({
        reason_code: 'replacement',
        capabilities: [CAP],
      });
      // The engine's decision + reason_code columns are untouched (the engine's
      // real verdict); the override metadata rides the PII-free inputs.
      expect(r.provenance.decision).toBe('REQUIRES_OVERRIDE');
    }
  });
});
