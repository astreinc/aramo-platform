import type { RequisitionLifecycleOrigin } from '../requisition-lifecycle-event.store.js';

import type { RecruitingStatus } from './requisition-status.js';
import type { TransitionAction } from './requisition-transitions.js';

// L1-D1 (ADR-0030) — the GOVERNED external-lifecycle command contract.
//
// An authoritative external client/VMS lifecycle event NEVER writes
// Requisition.status directly. It issues a GOVERNED command — a mapped
// TransitionAction, never a target status — that traverses the SAME
// gate -> CAS -> atomic lifecycle-event pipeline human PATCH transitions use
// (RequisitionRepository.executeExternalLifecycleCommand). The direct-write
// path (provider status -> Requisition.status = ...) is FORBIDDEN.
//
// This file is the TYPE contract only; the mapping/reconciliation/provenance
// SUBSTRATE lives in libs/integration, and the reconciler that composes them
// lives in apps/api (ADR-0030 — connector-in-app composition; no I15 edge).

// The structured external-event context an external command carries. It is the
// provenance the orchestrator persists (libs/integration) AFTER the seam returns
// the emitted lifecycle-event id — the seam threads external_event_id as the
// lifecycle event + policy-decision correlation id so the audit trail links the
// governed transition back to the exact external event.
export interface ExternalLifecycleProvenanceInput {
  readonly connection_id: string;
  readonly external_event_id: string;
  readonly external_event_at: string; // ISO-8601
  readonly raw_provider_status: string;
  readonly normalized_status: string;
  readonly mapping_version: number;
  readonly mapped_action: TransitionAction;
}

// The governed integration-mode transition command (ADR-0030 seam #1).
export interface ExternalLifecycleTransitionCommand {
  readonly tenant_id: string;
  readonly requisition_id: string;
  // A mapped Aramo lifecycle ACTION (never a target status). The seam resolves
  // the target via ACTION_TARGET_STATUS and re-derives the governing edge.
  readonly action: TransitionAction;
  // The connector service account (never a human) — bound by the apps/api
  // reconciler; stamped honestly into the lifecycle-event audit.
  readonly actor_id: string;
  // MUST be 'integration'. The seam refuses any other origin (the honest-origin
  // invariant — a governed external transition is never stamped 'ui').
  readonly origin: RequisitionLifecycleOrigin;
  // Optional optimistic-concurrency guard (the external event's believed
  // version). When present a stale value routes to reconciliation (no lost
  // update); when absent the write is unguarded but still increments.
  readonly expected_version?: number;
  readonly external_provenance: ExternalLifecycleProvenanceInput;
}

// A bounded refusal token — the governed reason the orchestrator routes to the
// reconciliation queue (never a silent mutation). Not a free-text string.
export type ExternalLifecycleRefusalReason =
  | 'REQUISITION_NOT_FOUND'
  | 'ILLEGAL_FROM_STATE'
  | 'POLICY_DENIED'
  | 'CAS_CONFLICT';

// The EXECUTED result — the governed transition committed atomically.
export interface ExternalLifecycleExecuted {
  readonly outcome: 'EXECUTED';
  readonly previous_status: RecruitingStatus;
  readonly next_status: RecruitingStatus;
  // The emitted requisition.RequisitionLifecycleEvent.id (origin='integration').
  readonly lifecycle_event_id: string;
  // The policy_store.PolicyDecisionRecord.id that permitted the transition.
  readonly policy_decision_id: string;
}

// The REFUSED result — no partial write; the orchestrator records a pending
// reconciliation row keyed on the bounded reason.
export interface ExternalLifecycleRefused {
  readonly outcome: 'REFUSED';
  readonly reason: ExternalLifecycleRefusalReason;
  // The unchanged current Aramo status (null only when the requisition is not
  // found in tenant) — proves NON-mutation on the refusal paths.
  readonly current_status: RecruitingStatus | null;
}

export type ExternalLifecycleCommandResult =
  | ExternalLifecycleExecuted
  | ExternalLifecycleRefused;

// ADR-0030 — external lifecycle authority governs the OPERATIONAL transitions
// only; the human approval sub-workflow (SUBMIT_FOR_APPROVAL / APPROVE / REJECT)
// is NEVER reachable from an external event. A mapping to any of those is an
// illegal external command.
export const EXTERNAL_LIFECYCLE_ACTIONS: readonly TransitionAction[] = [
  'CLOSE',
  'REOPEN',
  'PUT_ON_HOLD',
  'CANCEL',
];

export function isExternalLifecycleAction(action: TransitionAction): boolean {
  return EXTERNAL_LIFECYCLE_ACTIONS.includes(action);
}
