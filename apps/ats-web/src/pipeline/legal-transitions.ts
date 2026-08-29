// LEGAL_TRANSITIONS — hand-mirrored from libs/pipeline/src/lib/pipeline-
// state.ts (the BE source of truth). Q4 ruling: hand-mirror (importing
// @aramo/pipeline is a forbidden domain edge; a BE endpoint is a
// backend change R1 halts on). Drift is caught by the structural
// deep-equal smoke spec in ./legal-transitions-drift.spec.ts — it
// reads the BE source as text, regex-extracts LEGAL_TRANSITIONS,
// normalizes both sides into Record<status, Set<status>>, and asserts
// matrix equality. Any edge added/removed/changed fails the spec.

import type { PipelineStatus } from './types';

export const LEGAL_TRANSITIONS: Record<
  PipelineStatus,
  readonly PipelineStatus[]
> = {
  no_status: ['no_contact', 'contacted', 'not_in_consideration'],
  no_contact: ['contacted', 'talent_responded', 'not_in_consideration'],
  contacted: ['talent_responded', 'no_contact', 'not_in_consideration'],
  talent_responded: ['qualifying', 'contacted', 'not_in_consideration'],
  // L2-C — forward edge is `qualified` (the QUALIFY milestone). L2-E (SB-5) —
  // `submitted` is no longer a Pipeline transition target (client submit-to-ats is
  // Submittal-owned); the legacy `qualifying → submitted` edge is removed.
  qualifying: ['qualified', 'talent_responded', 'not_in_consideration'],
  // L2-C — the recruiter rests the episode at `qualified`. `qualified → completed`
  // is legal ONLY so the system COMPLETE precondition validates; NEVER a recruiter
  // "Move to…" option (§5). L2-E — `qualified → submitted` removed.
  qualified: ['qualifying', 'not_in_consideration', 'completed'],
  // L2-F3 — `interviewing` + `client_declined` are RETIRED as Pipeline transition
  // targets (the interview + client-decline truths are owned by ClientSelectionProcess/
  // InterviewSession, Lane2-DDR §4). Enum values kept; source keys keep their still-valid
  // outgoing edges for legacy rows. Mirrors libs/pipeline/src/lib/pipeline-state.ts.
  submitted: ['qualifying', 'not_in_consideration'],
  interviewing: ['offered', 'not_in_consideration'],
  offered: ['placed', 'not_in_consideration'],
  not_in_consideration: [],
  client_declined: [],
  placed: [],
  // L2-C — the canonical SUCCESSFUL terminal (system-only COMPLETE, SB-3).
  completed: [],
};

// L2-C (§5) — statuses a recruiter can NEVER select as a move target, even
// though the legal-transition matrix lists them (they are reached only by a
// system command). `completed` is legal from `qualified` ONLY so the system
// COMPLETE precondition validates; it must not appear in the "Move to…" menu.
// This filter is FE-affordance only — it does NOT alter LEGAL_TRANSITIONS, so
// the BE↔FE matrix drift guard (legal-transitions-drift.spec.ts) is unaffected.
export const SYSTEM_ONLY_TARGET_STATUSES: readonly PipelineStatus[] = [
  'completed',
];

// legalNextStates — the raw matrix row (BE mirror). Not the menu source; use
// recruiterNextStates for the affordance so system-only targets are excluded.
export function legalNextStates(
  from: PipelineStatus,
): readonly PipelineStatus[] {
  return LEGAL_TRANSITIONS[from];
}

// recruiterNextStates — the UI affordance helper. Returns the legal targets a
// recruiter is permitted to CHOOSE from `from`: the matrix row minus the
// system-only targets. The "Move to…" Popover renders ONLY these.
export function recruiterNextStates(
  from: PipelineStatus,
): readonly PipelineStatus[] {
  return LEGAL_TRANSITIONS[from].filter(
    (to) => !SYSTEM_ONLY_TARGET_STATUSES.includes(to),
  );
}
