import type { Decision, PolicyPackage } from '@aramo/policy-engine';
import {
  COMMERCIAL_PROPOSAL_STATES,
  COMMERCIAL_APPROVAL_RESOURCE,
  COMMERCIAL_APPROVAL_LIFECYCLE_PACKAGE_NAME,
  COMMERCIAL_APPROVAL_AUTHORITY_ACTIONS,
  governingCommercialProposalAction,
  type CommercialProposalState,
  type CommercialApprovalAction,
} from '@aramo/placement';

// The commercial-approval-lifecycle policy package — DATA (ADR-0024 §D2), the
// SEED payload published to policy-store and retrieved at approval-decision time.
// Mirrors offer-lifecycle.package.ts: a matrix serialized to engine rules, keyed
// on the DECLARED proposal state, one predicate per rule. It lives in apps/api
// (composition layer) because authoring a commercial-approval policy is an ATS
// concern. Only the AUTHORITY actions are governed here (SUBMIT / WITHDRAW are
// proposer scope:write and never reach the policy gate — directive R-POLICY).
//
// The MATRIX is DERIVED from the lifecycle registry (governingCommercialProposal
// Action), so the policy cannot drift from the state machine: a cell (action,
// state) is ALLOW iff that authority action governs a legal edge OUT of `state`,
// else DENY. The default disposition is ALLOW (permissive default; the matrix
// restricts the specific governed cells) — the FAIL-CLOSED posture is the
// NO-PUBLISHED-PACKAGE branch in the policy service, not this package's default.

// The single target state each authority action lands on (for the ALLOW derivation).
const ACTION_TARGET: Readonly<Record<CommercialApprovalAction, CommercialProposalState>> = {
  SUBMIT: 'PENDING_REVIEW',
  MARGIN_APPROVE: 'PENDING_CLIENT_APPROVAL',
  CLIENT_APPROVE: 'APPROVED',
  APPLY: 'APPLIED',
  REJECT: 'REJECTED',
  WITHDRAW: 'WITHDRAWN',
};

const REASON_SUFFIX: Readonly<Record<Decision, string>> = {
  ALLOW: 'ALLOWED',
  ALLOW_WITH_AUDIT: 'ALLOWED',
  DENY: 'DENIED',
  REQUIRES_OVERRIDE: 'OVERRIDE_REQUIRED',
};

// One rule per (authority action, state): ALLOW iff `action` governs the legal
// edge state -> ACTION_TARGET[action]; DENY otherwise. REJECT governs two
// from-states (both review gates), so both its cells are ALLOW.
const TRANSITION_RULES: PolicyPackage['rules'] = COMMERCIAL_APPROVAL_AUTHORITY_ACTIONS.flatMap(
  (action) =>
    COMMERCIAL_PROPOSAL_STATES.map((state) => {
      const decision: Decision =
        governingCommercialProposalAction(state, ACTION_TARGET[action]) === action ? 'ALLOW' : 'DENY';
      return {
        id: `commercial-approval-${action.toLowerCase()}-${state.toLowerCase()}`,
        resource: COMMERCIAL_APPROVAL_RESOURCE,
        action,
        when: [{ source: 'declared' as const, key: 'state', op: 'eq' as const, value: state }],
        decision,
        reason_code: `COMMERCIAL_APPROVAL_${action}_${REASON_SUFFIX[decision]}`,
      };
    }),
);

export const COMMERCIAL_APPROVAL_LIFECYCLE_PACKAGE: PolicyPackage = {
  name: COMMERCIAL_APPROVAL_LIFECYCLE_PACKAGE_NAME,
  // v1.0.0 — the commercial-approval aggregate's first governed surface.
  version: '1.0.0',
  registry: {
    resources: [COMMERCIAL_APPROVAL_RESOURCE],
    actions: [...COMMERCIAL_APPROVAL_AUTHORITY_ACTIONS],
  },
  default_disposition: {
    decision: 'ALLOW',
    reason_code: 'COMMERCIAL_APPROVAL_ALLOWED_DEFAULT',
  },
  rules: TRANSITION_RULES,
};
