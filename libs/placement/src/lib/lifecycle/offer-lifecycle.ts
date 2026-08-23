// Offer lifecycle registry — Requisition Workflow slice #2 (Offer Lifecycle).
// Directive: Aramo-Offer-Lifecycle-Subworkflow-Directive-v1_0-LOCKED.
//
// THIS FILE IS THE ONLY SOURCE OF TRUTH for the Offer state machine. The
// migration SQL — the BEFORE UPDATE per-edge transition guard, the BEFORE
// INSERT one-live guard, and the terminal freeze — is a deterministic BUILD
// ARTIFACT generated from this registry (D2). Never edit the emitted SQL; CI
// regenerates it and asserts byte-equality against the committed migration.
//
// The Offer is a DEDICATED aggregate that PRECEDES Placement (Option B): an
// ACCEPTED offer is the precondition for a placement (the placement-create
// re-point, D6). Mirrors the PlacementProcess registry idiom — positions are
// declared as DATA and the terminal / one-live-guard classifications DERIVE
// from position (`satisfies Record<OfferState, …>` forces every state to be
// classified, so adding a state without a treatment is a COMPILE-TIME error).

// ---------------------------------------------------------------------------
// States — the closed 7-value set.
// ---------------------------------------------------------------------------
export const OFFER_STATES = [
  'DRAFT',
  'SENT',
  'NEGOTIATION',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'RESCINDED',
] as const;

export type OfferState = (typeof OFFER_STATES)[number];

// An offer begins as a DRAFT being prepared.
export const OFFER_INITIAL_STATE: OfferState = 'DRAFT';

// ---------------------------------------------------------------------------
// Lifecycle position — a PROPERTY OF THE STATE, encoded as data. The terminal
// and one-live-guard classifications DERIVE from these, never independently
// authored. ACCEPTED is its OWN position (the distinguished placement
// precondition); DECLINED/EXPIRED/RESCINDED are CLOSED (unsuccessful terminals).
// ---------------------------------------------------------------------------
export const OFFER_POSITIONS = ['OPEN', 'ACCEPTED', 'CLOSED'] as const;
export type OfferPosition = (typeof OFFER_POSITIONS)[number];

export const OFFER_STATE_POSITION = {
  DRAFT: 'OPEN',
  SENT: 'OPEN',
  NEGOTIATION: 'OPEN',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'CLOSED',
  EXPIRED: 'CLOSED',
  RESCINDED: 'CLOSED',
} as const satisfies Record<OfferState, OfferPosition>;

// ---------------------------------------------------------------------------
// Legal transitions — the dedicated state machine. Each state declares its
// exact outgoing targets; `satisfies Record<OfferState, …>` forces every state
// to appear, so a new state with no transition treatment fails the build.
// Terminals declare `[]` (frozen). EXPIRED is recorder-driven this slice (no
// scheduler — directive scope fence).
// ---------------------------------------------------------------------------
export const OFFER_TRANSITIONS = {
  DRAFT: ['SENT', 'RESCINDED'],
  SENT: ['NEGOTIATION', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED'],
  NEGOTIATION: ['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED'],
  ACCEPTED: [],
  DECLINED: [],
  EXPIRED: [],
  RESCINDED: [],
} as const satisfies Record<OfferState, readonly OfferState[]>;

// The union of legal target states for a given from-state, as a TYPE — a typed
// call site passing an illegal `to` is a compile-time error.
export type LegalOfferTarget<From extends OfferState> = (typeof OFFER_TRANSITIONS)[From][number];

export type OfferTransition = { readonly from: OfferState; readonly to: OfferState };

// Ordered edge list (from-order then declared target-order) — the canonical
// traversal the SQL generator consumes. Deterministic.
export const LEGAL_OFFER_TRANSITIONS: readonly OfferTransition[] = OFFER_STATES.flatMap((from) =>
  (OFFER_TRANSITIONS[from] as readonly OfferState[]).map((to) => ({ from, to })),
);

// ---------------------------------------------------------------------------
// Derived classifications — NEVER authored as independent lists (computed from
// position, so they cannot drift). For the Offer, terminal-for-transitions and
// one-live-guard-inactive coincide: any terminal (ACCEPTED ∪ CLOSED).
// ---------------------------------------------------------------------------
function isOfferTerminal(state: OfferState): boolean {
  return OFFER_STATE_POSITION[state] !== 'OPEN';
}

// Transition-terminal = every state with no outgoing edge (ACCEPTED ∪ CLOSED).
export const OFFER_TRANSITION_TERMINAL: readonly OfferState[] = OFFER_STATES.filter(isOfferTerminal);

// The distinguished ACCEPTED set — the placement-create precondition (D6): only
// an offer in one of these states may become a placement.
export const OFFER_ACCEPTED_STATES: readonly OfferState[] = OFFER_STATES.filter(
  (s) => OFFER_STATE_POSITION[s] === 'ACCEPTED',
);

// One-live guard: ≤1 NON-terminal offer per (tenant, submittal). Every terminal
// state releases the guard (a new offer may follow a closed one).
export const OFFER_ONE_LIVE_GUARD_INACTIVE: readonly OfferState[] =
  OFFER_STATES.filter(isOfferTerminal);

// Structured pre-check mirror of the DB guard: is `to` a legal edge from `from`?
export function isLegalOfferTransition(from: OfferState, to: OfferState): boolean {
  return (OFFER_TRANSITIONS[from] as readonly OfferState[]).includes(to);
}

// ---------------------------------------------------------------------------
// Governed transition actions (ADR-0024). The offer's edges are policy-governed
// (R-GOVERNED); the action is identified by the (from, to) EDGE (the same idiom
// as requisition governingAction — several edges legitimately share an action:
// ACCEPT / DECLINE / EXPIRE / RESCIND fire from more than one from-state).
// ---------------------------------------------------------------------------
export const OFFER_RESOURCE = 'OFFER';

// The policy-store retrieval key for the offer-lifecycle package (published as
// DATA from apps/api/src/policy/offer-lifecycle.package.ts).
export const OFFER_LIFECYCLE_PACKAGE_NAME = 'offer-lifecycle';

export const OFFER_TRANSITION_ACTIONS = [
  'SEND',
  'NEGOTIATE',
  'REVISE',
  'ACCEPT',
  'DECLINE',
  'EXPIRE',
  'RESCIND',
] as const;
export type OfferTransitionAction = (typeof OFFER_TRANSITION_ACTIONS)[number];

// Edge → governing action. Total over the 12 legal edges; any other (from,to)
// resolves to null (not a governed transition — the DB trigger rejects illegal
// edges independently).
export function governingOfferAction(
  from: OfferState,
  to: OfferState,
): OfferTransitionAction | null {
  if (to === 'ACCEPTED') return from === 'SENT' || from === 'NEGOTIATION' ? 'ACCEPT' : null;
  if (to === 'DECLINED') return from === 'SENT' || from === 'NEGOTIATION' ? 'DECLINE' : null;
  if (to === 'EXPIRED') return from === 'SENT' || from === 'NEGOTIATION' ? 'EXPIRE' : null;
  if (to === 'RESCINDED') {
    return from === 'DRAFT' || from === 'SENT' || from === 'NEGOTIATION' ? 'RESCIND' : null;
  }
  if (to === 'SENT') {
    if (from === 'DRAFT') return 'SEND';
    if (from === 'NEGOTIATION') return 'REVISE';
    return null;
  }
  if (to === 'NEGOTIATION') return from === 'SENT' ? 'NEGOTIATE' : null;
  return null;
}
