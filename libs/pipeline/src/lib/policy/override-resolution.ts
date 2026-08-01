import type { InsertPolicyDecisionRecordInput } from '@aramo/policy-store';

import type { AddTalentPolicyOutcome } from './add-talent-policy.service.js';
import { isOverrideReasonCode } from './override-reason-codes.js';

// ADR-0024 §D11 (PR-4b) — the two-pass override resolution, shared by BOTH
// command boundaries (PipelineController + SourcingController). Pure: no I/O,
// no writes. Pass 2 (the engine) has already named the required capability(ies)
// and the verdict; this is pass 3 + 4:
//   membership test (does the FROZEN principal scope set already hold the
//   engine-named capability?) -> reason present and valid -> proceed, disposing
//   the ORIGINAL proposal.
//
// RULING 1: NO capability is acquired here. Pass 3 is a MEMBERSHIP TEST against
// authContext.scopes, which the JWT froze at authentication — never a step-up,
// never a mid-request grant. If a required capability is absent the override is
// refused exactly like a DENY.

export type OverrideResolution =
  // Proceed with the write; record `provenance`.
  | { readonly kind: 'ALLOW'; readonly provenance: InsertPolicyDecisionRecordInput }
  | { readonly kind: 'OVERRIDE'; readonly provenance: InsertPolicyDecisionRecordInput }
  // Refuse (403 POLICY_DENIED); record `provenance` (the attempt). `reason_code`
  // is the engine's, the ONLY engine detail exposed on the 403.
  | { readonly kind: 'DENY'; readonly provenance: InsertPolicyDecisionRecordInput; readonly reason_code: string }
  // Reject (422 OVERRIDE_INVALID); NO mutation, NO record — a request-validation
  // refusal at the boundary, mirroring the examination override-type pattern.
  | { readonly kind: 'REASON_REQUIRED' }
  | { readonly kind: 'REASON_INVALID'; readonly value: string };

// Attach the satisfied-override metadata to the record's PII-free `inputs`
// (jsonb; NO schema change). Records the operator reason_code AND the
// capability(ies) that satisfied the engine-named requirement (§D11, SCOPE 7).
function withOverrideSatisfaction(
  provenance: InsertPolicyDecisionRecordInput,
  satisfied: { reason_code: string | null; capabilities: readonly string[] },
): InsertPolicyDecisionRecordInput {
  return {
    ...provenance,
    inputs: {
      ...provenance.inputs,
      override: {
        reason_code: satisfied.reason_code,
        capabilities: [...satisfied.capabilities],
      },
    },
  };
}

export function resolveAddTalentOutcome(
  outcome: AddTalentPolicyOutcome,
  scopes: readonly string[],
  overrideReasonCode: string | undefined,
): OverrideResolution {
  if (outcome.disposition === 'ALLOW') {
    return { kind: 'ALLOW', provenance: outcome.provenance };
  }
  if (outcome.disposition === 'DENY') {
    return {
      kind: 'DENY',
      provenance: outcome.provenance,
      reason_code: outcome.reason_code,
    };
  }

  // REQUIRES_OVERRIDE — pass 3: MEMBERSHIP test against the frozen scope set.
  const held = new Set(scopes);
  const missing = outcome.required_capabilities.filter((c) => !held.has(c));
  if (missing.length > 0) {
    // Operator does not already hold the engine-named override capability →
    // refuse like a DENY. The record still captures the attempt (the recorded
    // decision stays REQUIRES_OVERRIDE — the engine's real verdict).
    return {
      kind: 'DENY',
      provenance: outcome.provenance,
      reason_code: outcome.reason_code,
    };
  }

  // Capability held — pass 4: a reason is REQUIRED (the decision is
  // REQUIRES_OVERRIDE) and must be in the closed set.
  if (overrideReasonCode === undefined || overrideReasonCode.length === 0) {
    return { kind: 'REASON_REQUIRED' };
  }
  if (!isOverrideReasonCode(overrideReasonCode)) {
    return { kind: 'REASON_INVALID', value: overrideReasonCode };
  }

  // Override satisfied — proceed, recording the reason_code + the capability(ies)
  // that satisfied it.
  return {
    kind: 'OVERRIDE',
    provenance: withOverrideSatisfaction(outcome.provenance, {
      reason_code: overrideReasonCode,
      capabilities: outcome.required_capabilities,
    }),
  };
}
