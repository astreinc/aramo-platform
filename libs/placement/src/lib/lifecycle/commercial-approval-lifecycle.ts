// Commercial Approval lifecycle registry — Requisition Workflow slice #4.
// Directive: Aramo-Commercial-Approval-Directive-v1_0-LOCKED.
//
// THIS FILE IS THE SINGLE SOURCE OF TRUTH for the CommercialRevisionProposal
// state machine. The migration's per-edge BEFORE UPDATE transition guard, the
// terminal freeze, and the one-live partial-unique are hand-authored to match
// this registry (the Assignment-Extension hand-sync precedent — NOT the offer
// byte-check generator; a second generator target is unwarranted here). Any edit
// to LEGAL_PROPOSAL_TRANSITIONS MUST be mirrored in the migration edge list.
//
// THE GOVERNING INVARIANT (directive): a commercial proposal is INTENT, an
// approval is AUTHORITY, an AssignmentRateVersion is APPLIED FINANCIAL TRUTH.
// This aggregate is INTENT + AUTHORITY; it NEVER writes AssignmentRateVersion
// until APPLIED, at which point it reuses createCommercialRevision (R-APPLY).
//
// STATE-EVOLUTION GUARD (directive / Architect): the review/approval stages are
// the v1 workflow, NOT permanent domain law. Approval requirements may later
// evolve (Finance / Director / VMS routing, amount-based authority, or no margin
// review) WITHOUT changing the applied AssignmentRateVersion truth model. The
// aggregate keeps INTENT and AUTHORITY separable so those chains stay possible.

// ---------------------------------------------------------------------------
// States — the closed 7-value set. APPROVED (authority granted) and APPLIED
// (materialised into an AssignmentRateVersion) are DELIBERATELY DISTINCT facts.
// ---------------------------------------------------------------------------
export const COMMERCIAL_PROPOSAL_STATES = [
  'DRAFT',
  'PENDING_REVIEW',
  'PENDING_CLIENT_APPROVAL',
  'APPROVED',
  'APPLIED',
  'REJECTED',
  'WITHDRAWN',
] as const;

export type CommercialProposalState = (typeof COMMERCIAL_PROPOSAL_STATES)[number];

// A proposal begins as a DRAFT being prepared.
export const COMMERCIAL_PROPOSAL_INITIAL_STATE: CommercialProposalState = 'DRAFT';

// ---------------------------------------------------------------------------
// Lifecycle position — a PROPERTY of the state, encoded as data. Terminal and
// one-live classifications DERIVE from position, never independently authored.
// OPEN = still live (incl. APPROVED, which is authority-granted but not yet
// applied); APPLIED = the distinguished terminal-success; CLOSED = REJECTED /
// WITHDRAWN (unsuccessful terminals). `satisfies Record<…>` forces every state
// to be classified, so a new state without a treatment is a COMPILE-TIME error.
// ---------------------------------------------------------------------------
export const COMMERCIAL_PROPOSAL_POSITIONS = ['OPEN', 'APPLIED', 'CLOSED'] as const;
export type CommercialProposalPosition = (typeof COMMERCIAL_PROPOSAL_POSITIONS)[number];

export const COMMERCIAL_PROPOSAL_STATE_POSITION = {
  DRAFT: 'OPEN',
  PENDING_REVIEW: 'OPEN',
  PENDING_CLIENT_APPROVAL: 'OPEN',
  APPROVED: 'OPEN',
  APPLIED: 'APPLIED',
  REJECTED: 'CLOSED',
  WITHDRAWN: 'CLOSED',
} as const satisfies Record<CommercialProposalState, CommercialProposalPosition>;

// ---------------------------------------------------------------------------
// Legal transitions — the dedicated state machine. Each state declares its exact
// outgoing targets; `satisfies Record<…>` forces every state to appear, so a new
// state with no treatment fails the build. Terminals declare `[]` (frozen).
// ---------------------------------------------------------------------------
export const COMMERCIAL_PROPOSAL_TRANSITIONS = {
  DRAFT: ['PENDING_REVIEW', 'WITHDRAWN'],
  PENDING_REVIEW: ['PENDING_CLIENT_APPROVAL', 'REJECTED', 'WITHDRAWN'],
  PENDING_CLIENT_APPROVAL: ['APPROVED', 'REJECTED', 'WITHDRAWN'],
  APPROVED: ['APPLIED', 'WITHDRAWN'],
  APPLIED: [],
  REJECTED: [],
  WITHDRAWN: [],
} as const satisfies Record<CommercialProposalState, readonly CommercialProposalState[]>;

export type CommercialProposalTransition = {
  readonly from: CommercialProposalState;
  readonly to: CommercialProposalState;
};

// Ordered edge list (from-order then declared target-order) — the canonical
// traversal used by the hand-synced migration edge list + the pre-check.
export const LEGAL_COMMERCIAL_PROPOSAL_TRANSITIONS: readonly CommercialProposalTransition[] =
  COMMERCIAL_PROPOSAL_STATES.flatMap((from) =>
    (COMMERCIAL_PROPOSAL_TRANSITIONS[from] as readonly CommercialProposalState[]).map((to) => ({
      from,
      to,
    })),
  );

// ---------------------------------------------------------------------------
// Derived classifications — computed from position, never independently listed.
// ---------------------------------------------------------------------------
function isProposalTerminal(state: CommercialProposalState): boolean {
  return COMMERCIAL_PROPOSAL_STATE_POSITION[state] !== 'OPEN';
}

// Transition-terminal = every state with no outgoing edge (APPLIED ∪ CLOSED).
export const COMMERCIAL_PROPOSAL_TERMINAL_STATES: readonly CommercialProposalState[] =
  COMMERCIAL_PROPOSAL_STATES.filter(isProposalTerminal);

// One-live guard: ≤1 NON-terminal proposal per (tenant, contract_assignment).
// Every terminal state releases the guard (a new proposal may follow a closed
// one). Identical set to the terminals — kept as its own named export so the
// migration's partial-unique predicate reads from the same source concept.
export const COMMERCIAL_PROPOSAL_ONE_LIVE_INACTIVE: readonly CommercialProposalState[] =
  COMMERCIAL_PROPOSAL_STATES.filter(isProposalTerminal);

// Structured pre-check mirror of the DB guard: is `to` a legal edge from `from`?
export function isLegalCommercialProposalTransition(
  from: CommercialProposalState,
  to: CommercialProposalState,
): boolean {
  return (
    COMMERCIAL_PROPOSAL_TRANSITIONS[from] as readonly CommercialProposalState[]
  ).includes(to);
}

// ---------------------------------------------------------------------------
// Governed transition actions (ADR-0024). Only the AUTHORITY transitions go
// through the policy engine + segregation-of-duties (directive R-POLICY / R-SOD):
//   MARGIN_APPROVE  PENDING_REVIEW           -> PENDING_CLIENT_APPROVAL
//   CLIENT_APPROVE  PENDING_CLIENT_APPROVAL  -> APPROVED
//   APPLY           APPROVED                 -> APPLIED   (reuses createCommercialRevision)
//   REJECT          PENDING_REVIEW | PENDING_CLIENT_APPROVAL -> REJECTED
// SUBMIT (DRAFT->PENDING_REVIEW) and WITHDRAW (proposer-only) are NOT authority
// acts — they are scope:write, no policy, no SoD.
// ---------------------------------------------------------------------------
export const COMMERCIAL_APPROVAL_RESOURCE = 'COMMERCIAL_REVISION_PROPOSAL';

// The policy-store retrieval key for the commercial-approval package (published
// as DATA from apps/api/src/policy/commercial-approval-lifecycle.package.ts).
export const COMMERCIAL_APPROVAL_LIFECYCLE_PACKAGE_NAME = 'commercial-approval-lifecycle';

export const COMMERCIAL_APPROVAL_ACTIONS = [
  'SUBMIT',
  'MARGIN_APPROVE',
  'CLIENT_APPROVE',
  'APPLY',
  'REJECT',
  'WITHDRAW',
] as const;
export type CommercialApprovalAction = (typeof COMMERCIAL_APPROVAL_ACTIONS)[number];

// The authority subset: exactly the actions gated by commercials:approve + SoD +
// ADR-0024 (directive R-POLICY). SUBMIT / WITHDRAW are proposer (commercials:write).
export const COMMERCIAL_APPROVAL_AUTHORITY_ACTIONS: readonly CommercialApprovalAction[] = [
  'MARGIN_APPROVE',
  'CLIENT_APPROVE',
  'APPLY',
  'REJECT',
];

export function isCommercialApprovalAuthorityAction(
  action: CommercialApprovalAction,
): boolean {
  return COMMERCIAL_APPROVAL_AUTHORITY_ACTIONS.includes(action);
}

// Edge → governing action. Total over the legal edges; any other (from,to)
// resolves to null (not a governed transition — the DB trigger rejects illegal
// edges independently). WITHDRAWN is reachable from several open states; APPLIED
// only from APPROVED; REJECTED from the two review gates.
export function governingCommercialProposalAction(
  from: CommercialProposalState,
  to: CommercialProposalState,
): CommercialApprovalAction | null {
  if (to === 'WITHDRAWN') {
    return from === 'DRAFT' ||
      from === 'PENDING_REVIEW' ||
      from === 'PENDING_CLIENT_APPROVAL' ||
      from === 'APPROVED'
      ? 'WITHDRAW'
      : null;
  }
  if (to === 'PENDING_REVIEW') return from === 'DRAFT' ? 'SUBMIT' : null;
  if (to === 'PENDING_CLIENT_APPROVAL') return from === 'PENDING_REVIEW' ? 'MARGIN_APPROVE' : null;
  if (to === 'APPROVED') return from === 'PENDING_CLIENT_APPROVAL' ? 'CLIENT_APPROVE' : null;
  if (to === 'APPLIED') return from === 'APPROVED' ? 'APPLY' : null;
  if (to === 'REJECTED') {
    return from === 'PENDING_REVIEW' || from === 'PENDING_CLIENT_APPROVAL' ? 'REJECT' : null;
  }
  return null;
}

// Client-approval provenance (R-CLIENT-APPROVAL-EVIDENCE). MANUAL is the first
// producer today; VMS / API / CLIENT_PORTAL populate the SAME evidence model
// later (T8 connector seam). Kept as a registry constant so the enum, the DTO
// and the migration read from one list.
export const COMMERCIAL_APPROVAL_SOURCES = [
  'MANUAL',
  'EMAIL',
  'VMS',
  'CLIENT_PORTAL',
  'API',
] as const;
export type CommercialApprovalSource = (typeof COMMERCIAL_APPROVAL_SOURCES)[number];
