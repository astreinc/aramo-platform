import type { Decision, PolicyPackage } from '@aramo/policy-engine';
import {
  OFFER_STATES,
  OFFER_RESOURCE,
  OFFER_LIFECYCLE_PACKAGE_NAME,
  OFFER_TRANSITION_ACTIONS,
  governingOfferAction,
  type OfferState,
  type OfferTransitionAction,
} from '@aramo/placement';

// The offer-lifecycle policy package — DATA (ADR-0024 §D2), the SEED payload
// published to policy-store and retrieved at decision time. Mirrors
// requisition-lifecycle.package.ts: a matrix serialized to engine rules, keyed
// on the DECLARED offer state, one predicate per rule. It lives in apps/api
// (composition layer) because authoring an offer policy is an ATS concern.
//
// The MATRIX is DERIVED from the offer lifecycle registry (governingOfferAction),
// so the policy cannot drift from the state machine: a cell (action, state) is
// ALLOW iff that action governs a legal edge OUT of `state`, else DENY
// (fail-closed on the permissive default — a terminal/illegal from-state denies).

// The single target status each governed action lands on (for the ALLOW derivation).
const ACTION_TARGET: Readonly<Record<OfferTransitionAction, OfferState>> = {
  SEND: 'SENT',
  REVISE: 'SENT',
  NEGOTIATE: 'NEGOTIATION',
  ACCEPT: 'ACCEPTED',
  DECLINE: 'DECLINED',
  EXPIRE: 'EXPIRED',
  RESCIND: 'RESCINDED',
};

const REASON_SUFFIX: Readonly<Record<Decision, string>> = {
  ALLOW: 'ALLOWED',
  ALLOW_WITH_AUDIT: 'ALLOWED',
  DENY: 'DENIED',
  REQUIRES_OVERRIDE: 'OVERRIDE_REQUIRED',
};

// One rule per (action, state): ALLOW iff `action` governs the legal edge
// state -> ACTION_TARGET[action]; DENY otherwise.
const TRANSITION_RULES: PolicyPackage['rules'] = OFFER_TRANSITION_ACTIONS.flatMap((action) =>
  OFFER_STATES.map((state) => {
    const decision: Decision =
      governingOfferAction(state, ACTION_TARGET[action]) === action ? 'ALLOW' : 'DENY';
    return {
      id: `offer-transition-${action.toLowerCase()}-${state.toLowerCase()}`,
      resource: OFFER_RESOURCE,
      action,
      when: [{ source: 'declared' as const, key: 'state', op: 'eq' as const, value: state }],
      decision,
      reason_code: `OFFER_TRANSITION_${action}_${REASON_SUFFIX[decision]}`,
    };
  }),
);

export const OFFER_LIFECYCLE_PACKAGE: PolicyPackage = {
  name: OFFER_LIFECYCLE_PACKAGE_NAME,
  // v1.0.0 — the offer aggregate's first governed surface.
  version: '1.0.0',
  registry: {
    resources: [OFFER_RESOURCE],
    actions: [...OFFER_TRANSITION_ACTIONS],
  },
  // A package MUST declare its own no-match disposition. ALLOW (permissive by
  // default; the matrix restricts the specific governed cells).
  default_disposition: {
    decision: 'ALLOW',
    reason_code: 'OFFER_ALLOWED_DEFAULT',
  },
  rules: TRANSITION_RULES,
};
