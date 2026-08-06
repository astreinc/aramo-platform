// PlacementProcess lifecycle registry — Track 3 / E1-a (THE SPINE).
// Directive: Aramo-Track3-E1a-PlacementProcess-Directive v1.3 LOCKED.
//
// THIS FILE IS THE ONLY SOURCE OF TRUTH for the PlacementProcess state
// machine (§5c). The migration SQL — the 14-edge BEFORE UPDATE transition
// guard and the BEFORE INSERT duplicate-live-attempt guard — is a
// deterministic BUILD ARTIFACT generated from this registry
// (src/lib/generator). Never edit the emitted SQL; never author the two
// state classifications as independent SQL literals. CI regenerates the SQL
// and asserts byte-equality against the committed migration.
//
// Typed & exhaustive (§6b): positions and transitions are declared with
// `satisfies Record<PlacementState, …>`, so adding a state without a
// lifecycle position OR without a transition treatment is a COMPILE-TIME
// error, not a runtime surprise. Illegal transitions are compile-time
// errors at typed call sites via LegalTarget<From> (see canTransitionTyped).

// ---------------------------------------------------------------------------
// States — the closed 10-value set (§4).
// ---------------------------------------------------------------------------

export const PLACEMENT_STATES = [
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

export type PlacementState = (typeof PLACEMENT_STATES)[number];

// A placement process exists because an offer was made (§4).
export const INITIAL_STATE: PlacementState = 'OFFER_EXTENDED';

// ---------------------------------------------------------------------------
// Lifecycle position — a PROPERTY OF THE STATE, encoded as data (§4c).
// Not inferred from edges, not described in prose. §5's two classifications
// DERIVE from these positions rather than being independently authored.
// ---------------------------------------------------------------------------

export const LIFECYCLE_POSITIONS = ['PRE_COMMITMENT', 'COMMITTED', 'ENGAGED', 'TERMINAL'] as const;

export type LifecyclePosition = (typeof LIFECYCLE_POSITIONS)[number];

// Every state MUST declare a position. `satisfies Record<PlacementState, …>`
// makes an undeclared state a compile-time error (§4c, §6b, §8).
export const STATE_POSITION = {
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
} as const satisfies Record<PlacementState, LifecyclePosition>;

// ---------------------------------------------------------------------------
// Legal transitions — the 14 edges (§4). Each state declares its exact
// outgoing targets as string literals; `satisfies Record<PlacementState, …>`
// forces every state to appear, so a new state with no transition treatment
// fails the build (§6b, §8). Terminal- and engaged-position states declare
// `[]` — they have no outgoing edge (§4c: STARTED is ENGAGED, terminal for
// transitions).
// ---------------------------------------------------------------------------

export const TRANSITIONS = {
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
} as const satisfies Record<PlacementState, readonly PlacementState[]>;

// The union of legal target states for a given from-state, as a TYPE. A
// typed call site passing an illegal `to` is a compile-time error (§6b, §8).
// e.g. LegalTarget<'OFFER_ACCEPTED'> = 'PRE_START' | 'OFFER_RESCINDED' |
// 'FELL_THROUGH' — 'READY_TO_START' is NOT assignable (§4d).
export type LegalTarget<From extends PlacementState> = (typeof TRANSITIONS)[From][number];

// Ordered edge list (from-order then declared target-order) — the canonical
// traversal the SQL generator consumes. Deterministic: it walks
// PLACEMENT_STATES then each state's declared targets, never object-key or
// insertion order incidental to the runtime.
export type PlacementTransition = { readonly from: PlacementState; readonly to: PlacementState };

export const LEGAL_TRANSITIONS: readonly PlacementTransition[] = PLACEMENT_STATES.flatMap((from) =>
  (TRANSITIONS[from] as readonly PlacementState[]).map((to) => ({ from, to })),
);

// ---------------------------------------------------------------------------
// Derived classifications (§4c, §5). NEVER authored as independent lists —
// both are computed from lifecycle position, so they cannot drift from it or
// from each other. STARTED (ENGAGED) is terminal-for-transitions yet active
// for the duplicate guard; that single fact falls out of the derivation.
// ---------------------------------------------------------------------------

// Position → true when a state has NO outgoing transition.
function isTransitionTerminal(state: PlacementState): boolean {
  const position = STATE_POSITION[state];
  return position === 'TERMINAL' || position === 'ENGAGED';
}

// Position → true when a NEW placement may be created after this state
// (the first attempt is no longer live). ONLY the TERMINAL position.
function isDuplicateGuardInactive(state: PlacementState): boolean {
  return STATE_POSITION[state] === 'TERMINAL';
}

// TRANSITION_TERMINAL = TERMINAL ∪ ENGAGED (no outgoing edge).
export const TRANSITION_TERMINAL: readonly PlacementState[] =
  PLACEMENT_STATES.filter(isTransitionTerminal);

// DUPLICATE_GUARD_INACTIVE = TERMINAL only. A first attempt in any of these
// states releases the one-live-attempt guard; STARTED does NOT (§5, §9).
export const DUPLICATE_GUARD_INACTIVE: readonly PlacementState[] =
  PLACEMENT_STATES.filter(isDuplicateGuardInactive);

// ---------------------------------------------------------------------------
// Runtime guard (defense-in-depth atop the DB trigger; §6). The DB trigger is
// the authority — this returns a structured answer before the SQL UPDATE.
// ---------------------------------------------------------------------------

export function canTransition(from: PlacementState, to: PlacementState): boolean {
  return (TRANSITIONS[from] as readonly PlacementState[]).includes(to);
}

// Typed variant: `to` is constrained to the legal targets of `from`, so an
// illegal transition is rejected by the compiler at the call site (§6b).
export function canTransitionTyped<From extends PlacementState>(
  from: From,
  to: LegalTarget<From>,
): boolean {
  return canTransition(from, to as PlacementState);
}

export function lifecyclePositionOf(state: PlacementState): LifecyclePosition {
  return STATE_POSITION[state];
}

// ---------------------------------------------------------------------------
// Authority class of an edge (E1-b Approval Record §2) — DERIVED from the target
// state's lifecycle POSITION, not independently authored. The transition route
// requires the placement:<class> scope this returns.
//   TERMINAL target  -> 'terminate'  (terminal / irreversible termination)
//   ENGAGED target   -> 'activate'   (asserts the placement has STARTED — the
//                                      live/committed start assertion,
//                                      READY_TO_START->STARTED. Capacity wiring
//                                      is currently DEFERRED / not implemented:
//                                      this edge is capacity-inert today — it
//                                      does not decrement requisition openings
//                                      or call any capacity path. The scope
//                                      follows the business meaning of asserting
//                                      a start, not a present side effect.)
//   otherwise        -> 'transition' (ordinary non-terminal progression)
// This is a total function over the 14 legal edges; deriving it is applying a
// ratified classification to grounded facts (Execution Model §13), not policy.
// ---------------------------------------------------------------------------
export const PLACEMENT_AUTHORITY_CLASSES = ['transition', 'activate', 'terminate'] as const;
export type PlacementAuthorityClass = (typeof PLACEMENT_AUTHORITY_CLASSES)[number];

export function edgeAuthorityClass(_from: PlacementState, to: PlacementState): PlacementAuthorityClass {
  const pos = STATE_POSITION[to];
  if (pos === 'TERMINAL') return 'terminate';
  if (pos === 'ENGAGED') return 'activate';
  return 'transition';
}
