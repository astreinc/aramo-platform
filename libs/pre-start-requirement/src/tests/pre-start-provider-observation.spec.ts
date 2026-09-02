import { describe, expect, it } from 'vitest';

import {
  PROVIDER_OBSERVATION_OUTCOME_VALUES,
  isProviderObservationOutcome,
  toGovernedRequirementCommand,
  type GovernedRequirementCommand,
} from '../lib/pre-start-provider-observation.js';

// L5-P9 — the provider-integration guard/contract. Proves: an external provider
// observation is routed to a GOVERNED requirement command appropriate to the
// requirement's satisfaction policy, and NEVER to a direct READY_TO_START flip.

describe('L5-P9 provider observation → governed command', () => {
  it('PASSED on a SELF_ATTEST requirement → STATUS_MOVE to SATISFIED', () => {
    const cmd = toGovernedRequirementCommand({ outcome: 'PASSED' }, 'SELF_ATTEST');
    expect(cmd).toEqual({ kind: 'STATUS_MOVE', to: 'SATISFIED' });
  });

  it('PASSED on a VERIFICATION_REQUIRED requirement → VERIFY (provider is the distinct verifier; SoD, never a blind SATISFIED)', () => {
    const cmd = toGovernedRequirementCommand({ outcome: 'PASSED' }, 'VERIFICATION_REQUIRED');
    expect(cmd).toEqual({ kind: 'VERIFY' });
  });

  it('FAILED → STATUS_MOVE to FAILED (regardless of policy)', () => {
    expect(toGovernedRequirementCommand({ outcome: 'FAILED' }, 'SELF_ATTEST')).toEqual({
      kind: 'STATUS_MOVE',
      to: 'FAILED',
    });
    expect(toGovernedRequirementCommand({ outcome: 'FAILED' }, 'VERIFICATION_REQUIRED')).toEqual({
      kind: 'STATUS_MOVE',
      to: 'FAILED',
    });
  });

  it('INCONCLUSIVE → NONE (routed to reconciliation, no command)', () => {
    expect(toGovernedRequirementCommand({ outcome: 'INCONCLUSIVE' }, 'SELF_ATTEST')).toEqual({
      kind: 'NONE',
      reason: 'inconclusive',
    });
  });

  // The load-bearing invariant: NO observation, under ANY satisfaction policy, can
  // ever produce a readiness / lifecycle command. A STATUS_MOVE only ever targets a
  // requirement status (SATISFIED | FAILED) — never a placement state. The union
  // has no READY_TO_START member, so this holds structurally as well as here.
  it('no observation × policy combination yields a readiness flip', () => {
    const policies = ['SELF_ATTEST', 'VERIFICATION_REQUIRED'] as const;
    const requirementStatusTargets = new Set(['SATISFIED', 'FAILED']);
    for (const outcome of PROVIDER_OBSERVATION_OUTCOME_VALUES) {
      for (const policy of policies) {
        const cmd: GovernedRequirementCommand = toGovernedRequirementCommand({ outcome }, policy);
        expect(['STATUS_MOVE', 'VERIFY', 'NONE']).toContain(cmd.kind);
        if (cmd.kind === 'STATUS_MOVE') {
          // Structurally impossible to target a placement lifecycle state.
          expect(requirementStatusTargets.has(cmd.to)).toBe(true);
        }
      }
    }
  });

  it('isProviderObservationOutcome accepts the closed set and rejects anything else', () => {
    expect(isProviderObservationOutcome('PASSED')).toBe(true);
    expect(isProviderObservationOutcome('FAILED')).toBe(true);
    expect(isProviderObservationOutcome('INCONCLUSIVE')).toBe(true);
    expect(isProviderObservationOutcome('READY_TO_START')).toBe(false);
    expect(isProviderObservationOutcome('SATISFIED')).toBe(false);
    expect(isProviderObservationOutcome(null)).toBe(false);
  });
});
