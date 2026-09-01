// FROZEN byte-for-byte snapshot of the PlacementProcess lifecycle AS IT WAS at the
// init migration 20260803180000_init_placement_model (Track 3 / E1-a): the 10-value
// machine + its 14 edges + the init duplicate-guard-inactive (TERMINAL) set.
//
// L4-0 (Hiring Commitment) collapsed the LIVE lifecycle (../lifecycle/placement-lifecycle.ts)
// to the canonical 6 states, removing the 4 legacy OFFER_* Placement states. This snapshot
// exists ONLY so the ALREADY-APPLIED init migration keeps regenerating BYTE-IDENTICAL from
// the generator (generator-owned, never hand-authored) while the live source evolves — the
// init is historical and its bytes/checksum must not change. The evolution is carried by a
// SEPARATE generator-owned forward migration produced from the LIVE 6-state source
// (see generatePlacementOfferStateCollapseSql). verify-placement-sql proves both:
// {this frozen snapshot → committed init} and {live source → committed collapse migration}.
//
// DO NOT edit these values. They are pinned to an immutable historical migration; changing
// them would break the init byte-equality verification and rewrite deploy history.
// Ordering mirrors the original registry exactly (states, per-state target order, filter
// order) so the derived arrays reproduce the committed init verbatim.

export const PLACEMENT_STATES_INIT = [
  'OFFER_EXTENDED',
  'OFFER_ACCEPTED',
  'PRE_START',
  'BLOCKED',
  'READY_TO_START',
  'STARTED',
  'OFFER_DECLINED',
  'OFFER_RESCINDED',
  'NO_SHOW',
  'FELL_THROUGH',
] as const;

type InitPosition = 'PRE_COMMITMENT' | 'COMMITTED' | 'ENGAGED' | 'TERMINAL';

const STATE_POSITION_INIT: Record<(typeof PLACEMENT_STATES_INIT)[number], InitPosition> = {
  OFFER_EXTENDED: 'PRE_COMMITMENT',
  OFFER_ACCEPTED: 'COMMITTED',
  PRE_START: 'COMMITTED',
  BLOCKED: 'COMMITTED',
  READY_TO_START: 'COMMITTED',
  STARTED: 'ENGAGED',
  OFFER_DECLINED: 'TERMINAL',
  OFFER_RESCINDED: 'TERMINAL',
  NO_SHOW: 'TERMINAL',
  FELL_THROUGH: 'TERMINAL',
};

const TRANSITIONS_INIT: Record<(typeof PLACEMENT_STATES_INIT)[number], readonly string[]> = {
  OFFER_EXTENDED: ['OFFER_ACCEPTED', 'OFFER_DECLINED', 'OFFER_RESCINDED'],
  OFFER_ACCEPTED: ['PRE_START', 'OFFER_RESCINDED', 'FELL_THROUGH'],
  PRE_START: ['READY_TO_START', 'BLOCKED', 'FELL_THROUGH'],
  BLOCKED: ['PRE_START', 'FELL_THROUGH'],
  READY_TO_START: ['STARTED', 'NO_SHOW', 'FELL_THROUGH'],
  STARTED: [],
  OFFER_DECLINED: [],
  OFFER_RESCINDED: [],
  NO_SHOW: [],
  FELL_THROUGH: [],
};

// Derived exactly as the original registry did (flatMap over states, then targets).
export const LEGAL_TRANSITIONS_INIT: readonly { from: string; to: string }[] =
  PLACEMENT_STATES_INIT.flatMap((from) =>
    TRANSITIONS_INIT[from].map((to) => ({ from, to })),
  );

// TERMINAL-position states only (the init duplicate-guard-inactive set), in state order.
export const DUPLICATE_GUARD_INACTIVE_INIT: readonly string[] = PLACEMENT_STATES_INIT.filter(
  (s) => STATE_POSITION_INIT[s] === 'TERMINAL',
);
