// L5-P9 — the provider-integration GUARD / CONTRACT (directive §L5-P9).
//
// No external screening / verification provider is selected yet, so this slice
// ships the provider-neutral translation CONTRACT + guard ONLY (the directive
// explicitly permits a guard/contract-only slice until a provider lands). It
// defines how one external provider observation is routed to a GOVERNED
// requirement command and — by construction — makes a direct READY_TO_START flip
// UNREPRESENTABLE: the command union below has no readiness / lifecycle member,
// so a provider observation cannot express one. The illegal authority is removed
// at the type level, not merely rejected at runtime.
//
// When a provider is selected, its adapter (a) reserves the raw observation in
// the VMS-precedent lifecycle-observation ledger — the idempotency authority
// (UNIQUE tenant_id + connection_id + observation_key) — and (b) applies the
// command this guard returns through the EXISTING governed ops
// (RequirementInstanceRepository.applyStatusMove / .verify), which carry the
// satisfaction-policy, waiver-mode and verifier separation-of-duties floors. This
// module performs no persistence and holds no write authority; it is pure policy.

import type { SatisfactionPolicyValue } from './pre-start-requirement-vocab.js';

// Provider-neutral observed outcome. This is NOT the provider's raw payload and
// NOT the check result / adverse-action content (§4d) — it is the minimal signal
// the domain acts on. PASSED / FAILED are terminal; INCONCLUSIVE yields no command.
export const PROVIDER_OBSERVATION_OUTCOME_VALUES = ['PASSED', 'FAILED', 'INCONCLUSIVE'] as const;
export type ProviderObservationOutcome = (typeof PROVIDER_OBSERVATION_OUTCOME_VALUES)[number];
export function isProviderObservationOutcome(v: unknown): v is ProviderObservationOutcome {
  return typeof v === 'string' && (PROVIDER_OBSERVATION_OUTCOME_VALUES as readonly string[]).includes(v);
}

// One provider observation against a specific materialized requirement instance.
// The idempotency identity (provider_connection_id + observation_key) is carried
// so the VMS observation-ledger reserve() plugs in unchanged when a provider
// lands. evidence_reference is a POINTER ONLY (§4d) — never the result content.
export interface PreStartProviderObservation {
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly requirement_instance_id: string;
  readonly provider_connection_id: string;
  readonly observation_key: string;
  readonly outcome: ProviderObservationOutcome;
  readonly evidence_reference: string | null;
  readonly observed_at: Date;
}

// The GOVERNED command an observation may be routed to. This union contains ONLY
// requirement-scoped commands. There is deliberately NO readiness / lifecycle
// member: a provider observation can never flip READY_TO_START — that authority
// is unrepresentable here. `NONE` routes the observation to reconciliation.
export type GovernedRequirementCommand =
  | { readonly kind: 'STATUS_MOVE'; readonly to: 'SATISFIED' | 'FAILED' }
  | { readonly kind: 'VERIFY' }
  | { readonly kind: 'NONE'; readonly reason: 'inconclusive' };

// The guard / translator (pure). PASSED routes to the governed completion path
// APPROPRIATE to the requirement's satisfaction policy:
//   - SELF_ATTEST           → STATUS_MOVE to SATISFIED
//   - VERIFICATION_REQUIRED → VERIFY (the provider IS the distinct external
//                             verifier; SoD preserved — an observation is never a
//                             blind SATISFIED on a verification-gated requirement)
// FAILED → STATUS_MOVE to FAILED. INCONCLUSIVE → NONE (reconcile, no command).
export function toGovernedRequirementCommand(
  observation: Pick<PreStartProviderObservation, 'outcome'>,
  satisfactionPolicy: SatisfactionPolicyValue,
): GovernedRequirementCommand {
  switch (observation.outcome) {
    case 'PASSED':
      return satisfactionPolicy === 'VERIFICATION_REQUIRED'
        ? { kind: 'VERIFY' }
        : { kind: 'STATUS_MOVE', to: 'SATISFIED' };
    case 'FAILED':
      return { kind: 'STATUS_MOVE', to: 'FAILED' };
    case 'INCONCLUSIVE':
      return { kind: 'NONE', reason: 'inconclusive' };
  }
}
