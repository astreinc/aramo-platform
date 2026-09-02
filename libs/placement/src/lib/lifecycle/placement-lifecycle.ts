// PlacementProcess lifecycle registry — Track 3 / E1-a (THE SPINE).
// Directive: Aramo-Track3-E1a-PlacementProcess-Directive v1.3 LOCKED.
//
// THIS FILE IS THE ONLY SOURCE OF TRUTH for the PlacementProcess state
// machine (§5c). The migration SQL — the BEFORE UPDATE transition guard
// (8 edges post-L4-0: frozen-init emitted 14, the forward collapse migration
// narrows to 8) and the BEFORE INSERT duplicate-live-attempt guard — is a
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
// States — the closed 6-value set (§4). L4-0: the four OFFER_* states
// (OFFER_EXTENDED/OFFER_ACCEPTED/OFFER_DECLINED/OFFER_RESCINDED) were collapsed
// out of the machine — Hiring-Commitment (offer extension/acceptance/decline/
// rescission) is now the sole authority of the dedicated offer aggregate
// (offer."Offer", Lane 4). The forward collapse migration
// (20260901120000_l4_placement_offer_state_collapse) narrows the enum fail-loud.
// ---------------------------------------------------------------------------

export const PLACEMENT_STATES = [
  'PRE_START',
  'BLOCKED',
  'READY_TO_START',
  'STARTED',
  'NO_SHOW',
  'FELL_THROUGH',
] as const;

export type PlacementState = (typeof PLACEMENT_STATES)[number];

// A placement process is created DOWNSTREAM of an ACCEPTED offer (Offer
// Lifecycle, D6/R-PRECEDENCE) — offer extension/acceptance lives in the
// dedicated offer aggregate (offer."Offer"), so the placement is born at
// PRE_START, the create-birth state.
export const INITIAL_STATE: PlacementState = 'PRE_START';

// ---------------------------------------------------------------------------
// Lifecycle position — a PROPERTY OF THE STATE, encoded as data (§4c).
// Not inferred from edges, not described in prose. §5's two classifications
// DERIVE from these positions rather than being independently authored.
// ---------------------------------------------------------------------------

export const LIFECYCLE_POSITIONS = ['COMMITTED', 'ENGAGED', 'TERMINAL'] as const;

export type LifecyclePosition = (typeof LIFECYCLE_POSITIONS)[number];

// Every state MUST declare a position. `satisfies Record<PlacementState, …>`
// makes an undeclared state a compile-time error (§4c, §6b, §8).
export const STATE_POSITION = {
  PRE_START: 'COMMITTED',
  BLOCKED: 'COMMITTED',
  READY_TO_START: 'COMMITTED',
  STARTED: 'ENGAGED',
  NO_SHOW: 'TERMINAL',
  FELL_THROUGH: 'TERMINAL',
} as const satisfies Record<PlacementState, LifecyclePosition>;

// ---------------------------------------------------------------------------
// Legal transitions — the 8 edges (§4). Each state declares its exact
// outgoing targets as string literals; `satisfies Record<PlacementState, …>`
// forces every state to appear, so a new state with no transition treatment
// fails the build (§6b, §8). Terminal- and engaged-position states declare
// `[]` — they have no outgoing edge (§4c: STARTED is ENGAGED, terminal for
// transitions).
// ---------------------------------------------------------------------------

export const TRANSITIONS = {
  PRE_START: ['READY_TO_START', 'BLOCKED', 'FELL_THROUGH'],
  BLOCKED: ['PRE_START', 'FELL_THROUGH'],
  READY_TO_START: ['STARTED', 'NO_SHOW', 'FELL_THROUGH'],
  STARTED: [],
  NO_SHOW: [],
  FELL_THROUGH: [],
} as const satisfies Record<PlacementState, readonly PlacementState[]>;

// The union of legal target states for a given from-state, as a TYPE. A
// typed call site passing an illegal `to` is a compile-time error (§6b, §8).
// e.g. LegalTarget<'PRE_START'> = 'READY_TO_START' | 'BLOCKED' | 'FELL_THROUGH'
// — 'STARTED' is NOT assignable (§4d: no direct PRE_START→STARTED shortcut).
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
// This set ALSO defines E4 replacement-predecessor eligibility (placement.repository
// §5). Track 4 / G2 (§3.2) deliberately does NOT widen it — see
// isPlacementGuardReleased below for the SEPARATE one-live release predicate.
export const DUPLICATE_GUARD_INACTIVE: readonly PlacementState[] =
  PLACEMENT_STATES.filter(isDuplicateGuardInactive);

// Track 4 / T4-C (G2, §3.2) — THE PREDICATE SPLIT. The one-live GUARD-RELEASE
// predicate is SEPARATE from E4 eligibility (DUPLICATE_GUARD_INACTIVE). A placement
// releases the (tenant, submittal) one-live guard when it is pre-start TERMINAL,
// OR when it is STARTED and its authoritative ContractAssignment has ENDED. E4
// eligibility does NOT release on the latter — STARTED stays E4-ineligible. Sharing
// one predicate would widen E4 as a side effect (the default outcome, forbidden).
// The DB trigger (migration 20260810110000) is the authority; this mirrors it for
// the structured pre-check.
export function isPlacementGuardReleased(state: PlacementState, hasEndedAssignment: boolean): boolean {
  if ((DUPLICATE_GUARD_INACTIVE as readonly PlacementState[]).includes(state)) return true;
  return state === 'STARTED' && hasEndedAssignment;
}

// Track 4 / T4-C — the ContractAssignment lifecycle registry. One ratified edge:
// ACTIVE -> ENDED (post-start completion or attrition). ENDED is terminal.
export const CONTRACT_ASSIGNMENT_TRANSITIONS: Record<'ACTIVE' | 'ENDED', readonly ('ACTIVE' | 'ENDED')[]> = {
  ACTIVE: ['ENDED'],
  ENDED: [],
};

// ---------------------------------------------------------------------------
// Track 7 / T7-P1 — the PermanentPlacement guarantee lifecycle registry.
// This typed map is the CANONICAL source of truth for the guarantee state
// machine. Lane 6 / L6-C added DB-level parity: a generated BEFORE UPDATE trigger
// (migration 20260901180000, emitted from THIS map via the placement SQL
// generator — placement:sql:check byte-equality) now enforces transition legality
// + terminal immutability at the database too. The app-layer runtime guard
// (canTransitionPermanentPlacement) remains defense-in-depth; the map stays the
// single source both derive from.
//
// P1 ships EXACTLY the happy path: GUARANTEE_ACTIVE -> GUARANTEE_SATISFIED.
// GUARANTEE_SATISFIED is terminal. FELL_OFF and the remedy states are T7-P2 and
// land here as additive members with their ratified edges — mirroring the
// ContractAssignment "ships ACTIVE only" precedent. `satisfies Record<…>` forces
// every P1 state to declare a treatment, so adding a state without an edge list
// is a compile-time error.
// ---------------------------------------------------------------------------

// Track 7 / T7-P1 — the closed permanent-vs-contract branch vocabulary (the
// runtime companion of the PlacementKind type / Postgres enum), for wire
// validation (@IsIn) and seed/parity surfaces.
export const PLACEMENT_KINDS = ['CONTRACT', 'PERMANENT'] as const;

// Track 7 / T7-P2 — the guarantee lifecycle grows to the full falloff + remedy
// machine (T7-P2 directive §4). Additive states; the typed map stays canonical
// (and, since L6-C, the generated DB trigger derives from it). GUARANTEE_ACTIVE, GUARANTEE_SATISFIED
// ship in P1; FELL_OFF + the three remedy-due states + REMEDY_COMPLETED are P2.
export const PERMANENT_PLACEMENT_STATES = [
  'GUARANTEE_ACTIVE',
  'GUARANTEE_SATISFIED',
  'FELL_OFF',
  'REPLACEMENT_DUE',
  'REFUND_DUE',
  'PRORATED_CREDIT_DUE',
  'REMEDY_COMPLETED',
] as const;

export type PermanentPlacementState = (typeof PERMANENT_PLACEMENT_STATES)[number];

// A PermanentPlacement is materialised (at the permanent STARTED handoff) already
// inside its guarantee window — GUARANTEE_ACTIVE is the birth state.
export const PERMANENT_PLACEMENT_INITIAL_STATE: PermanentPlacementState = 'GUARANTEE_ACTIVE';

// The three remedy-due obligation states. FELL_OFF is atomically traversed into
// exactly one of these in the falloff transaction (§3.2) — never a stable
// externally-observable adjudication-pending state.
export const REMEDY_DUE_STATES = ['REPLACEMENT_DUE', 'REFUND_DUE', 'PRORATED_CREDIT_DUE'] as const;
export type RemedyDueState = (typeof REMEDY_DUE_STATES)[number];

// T7-P2 lifecycle edges (§4). GUARANTEE_ACTIVE branches to SATISFIED (P1 happy
// path) OR FELL_OFF (P2); FELL_OFF → exactly one *_DUE; each *_DUE → REMEDY_COMPLETED.
// GUARANTEE_SATISFIED and REMEDY_COMPLETED are terminal (§3.7). No other P2 edges.
export const PERMANENT_PLACEMENT_TRANSITIONS = {
  GUARANTEE_ACTIVE: ['GUARANTEE_SATISFIED', 'FELL_OFF'],
  GUARANTEE_SATISFIED: [],
  FELL_OFF: ['REPLACEMENT_DUE', 'REFUND_DUE', 'PRORATED_CREDIT_DUE'],
  REPLACEMENT_DUE: ['REMEDY_COMPLETED'],
  REFUND_DUE: ['REMEDY_COMPLETED'],
  PRORATED_CREDIT_DUE: ['REMEDY_COMPLETED'],
  REMEDY_COMPLETED: [],
} as const satisfies Record<PermanentPlacementState, readonly PermanentPlacementState[]>;

// Runtime guard (defense-in-depth in application code; the typed map is authority
// — §3.7). Returns the structured answer before the UPDATE.
export function canTransitionPermanentPlacement(
  from: PermanentPlacementState,
  to: PermanentPlacementState,
): boolean {
  return (PERMANENT_PLACEMENT_TRANSITIONS[from] as readonly PermanentPlacementState[]).includes(to);
}

// Track 7 — the closed, terms-driven remedy policy the guarantee snapshot commits
// to at activation (snapshotted in P1, executed in P2). Exactly one is chosen
// from governed terms — never heuristically among several (T7-PRE §8).
export const REMEDY_POLICIES = ['REPLACEMENT', 'REFUND', 'PRORATED_CREDIT'] as const;

export type RemedyPolicy = (typeof REMEDY_POLICIES)[number];

// Track 7 / T7-P2 — the EXACT, TOTAL, deterministic map from the immutable snapshot
// RemedyPolicy to the single remedy-due state (§6). No priority order, no heuristic,
// no caller choice; a value outside the three fails closed at the call site.
export const REMEDY_POLICY_TO_DUE_STATE = {
  REPLACEMENT: 'REPLACEMENT_DUE',
  REFUND: 'REFUND_DUE',
  PRORATED_CREDIT: 'PRORATED_CREDIT_DUE',
} as const satisfies Record<RemedyPolicy, RemedyDueState>;

// The due-state for a snapshot remedy policy, or null if the policy is not one of
// the three governed values (fail-closed — the caller raises PERMANENT_PLACEMENT_REMEDY_INVALID).
export function dueStateForRemedyPolicy(policy: string): RemedyDueState | null {
  return (REMEDY_POLICY_TO_DUE_STATE as Record<string, RemedyDueState>)[policy] ?? null;
}

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
// This is a total function over the 8 legal edges; deriving it is applying a
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
