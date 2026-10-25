import { createHash } from 'node:crypto';

import type { CommercialPolicyContent } from './commercial-policy.js';
import { canonicalJson } from './commercial-policy.js';
import { creditEscalation, discountEscalates } from './commercial-policy-boundaries.js';
import { CONTRACT_PAYLOAD_KEYS, validateContractBlocks } from './commercial-contract.js';
import { conversionPayloadErrors } from './commercial-conversion.js';

// CCP-A3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A3; Charter §5.1 D6, D8,
// D9, §6.4; Recon Report §1 C2 and §2) — the PURE half of the change-request model: the
// closed action set, the state machine, payload validation and checksum, and the D6 chain
// resolution from a commercial policy version. No I/O and no clock.
//
// The chain is resolved ONCE, when the request is created, from the ACTIVE policy, and
// stored on the request (`required_chain`) with that policy's id and checksum. It is never
// recomputed: a later policy version does not re-threshold an in-flight request (NC-5,
// ratified by the Lead Architect 2026-10-25, doc/ccp/decisions.md TD-A3-0).
//
// The chain SHAPES are the D6 / Q1 / Q2 rulings; the thresholds that choose between them
// (discount, credit) are policy DATA read from the policy document. No policy value is a
// code constant here.

// ---- Closed action set ----------------------------------------------------------------

/**
 * Every commercial act the CCP governs (DDR v1.2 §3.2). The consuming slice is named per
 * entry; A3 records, routes and approves requests of every type but applies none (A6+).
 */
export const COMMERCIAL_ACTION_TYPES = [
  'SUBSCRIPTION_OPEN', // A6 — open a MANUAL / contract subscription
  'SUBSCRIPTION_CHANGE', // A6 — change plan or terms of a governed subscription
  'SUBSCRIPTION_END', // A6 — end a governed subscription
  'ENTITLEMENT_GRANT', // A6 — non-default commercial capability grant (D4)
  'ENTITLEMENT_REVOKE', // A7 — governed revoke (D1)
  'PLAN_VERSION_PUBLISH', // A5 / B2 — publish a catalog plan version
  'PLAN_RETIRE', // A5 / B2 — retire ONE specified plan version (CCP-R3, TD-B2-1: never the whole plan)
  'POLICY_ACTIVATE', // activate (or roll back to) a CommercialPolicyVersion (Q1)
  'SUPPORT_EXTENSION', // A8 — a support extension overlay: bounded EXCEPTION, escalated (Q7), or removed (payload operation)
  'ROLE_GRANT', // A9 — grant a commercial platform role (Q2, D6)
  'ROLE_REVOKE', // A9 — remove a commercial platform role (Q2)
  'CREDIT', // C4 — account credit
  'DISCOUNT', // C4 — discount
  'CONVERSION', // C2 — governed MANUAL ↔ self-service conversion (D2)
] as const;
export type CommercialActionType = (typeof COMMERCIAL_ACTION_TYPES)[number];

export const COMMERCIAL_CHANGE_REQUEST_KINDS = ['NORMAL', 'EXCEPTION', 'MIGRATION'] as const;
export type CommercialChangeRequestKind = (typeof COMMERCIAL_CHANGE_REQUEST_KINDS)[number];

/** A3 interim closed product set; CCP-A4 replaces it with the governed registry (PBD §7.1). */
export const COMMERCIAL_REQUEST_PRODUCT_KEYS = ['sign'] as const;

export type CommercialDomain = 'subscription' | 'entitlement' | 'billing' | 'catalog' | 'governance';

export interface CommercialActionDefinition {
  domain: CommercialDomain;
  /** Carries tenant_id + product_key, and falls under Q14 (one open per tenant × product). */
  tenant_scoped: boolean;
  /**
   * The scope the requester must hold (A1 §4.1 matrix). `null` = no requester scope; the
   * requester authority is then `requester_role` (governance actions), and with neither the
   * request cannot be created (fail closed; TD-A3-5).
   */
  requester_scope: string | null;
  /**
   * CCP-A9 (TD-A3-5, PO 2026-10-25): the CCP role the requester must hold, read LIVE in the
   * create transaction, plus an active D9 attestation. Governance actions only: the A1
   * catalog holds no governance request scope.
   */
  requester_role: 'platform_owner' | 'finance_admin' | null;
}

export const COMMERCIAL_ACTIONS: Readonly<Record<CommercialActionType, CommercialActionDefinition>> = {
  SUBSCRIPTION_OPEN: { domain: 'subscription', tenant_scoped: true, requester_scope: 'platform:subscription:request', requester_role: null },
  SUBSCRIPTION_CHANGE: { domain: 'subscription', tenant_scoped: true, requester_scope: 'platform:subscription:request', requester_role: null },
  SUBSCRIPTION_END: { domain: 'subscription', tenant_scoped: true, requester_scope: 'platform:subscription:request', requester_role: null },
  CONVERSION: { domain: 'subscription', tenant_scoped: true, requester_scope: 'platform:subscription:request', requester_role: null },
  SUPPORT_EXTENSION: { domain: 'subscription', tenant_scoped: true, requester_scope: 'platform:subscription:support', requester_role: null },
  ENTITLEMENT_GRANT: { domain: 'entitlement', tenant_scoped: true, requester_scope: 'platform:entitlement:request', requester_role: null },
  ENTITLEMENT_REVOKE: { domain: 'entitlement', tenant_scoped: true, requester_scope: 'platform:entitlement:request', requester_role: null },
  CREDIT: { domain: 'billing', tenant_scoped: true, requester_scope: 'platform:billing:request', requester_role: null },
  DISCOUNT: { domain: 'billing', tenant_scoped: true, requester_scope: 'platform:billing:request', requester_role: null },
  PLAN_VERSION_PUBLISH: { domain: 'catalog', tenant_scoped: false, requester_scope: 'platform:catalog:draft', requester_role: null },
  PLAN_RETIRE: { domain: 'catalog', tenant_scoped: false, requester_scope: 'platform:catalog:draft', requester_role: null },
  POLICY_ACTIVATE: { domain: 'governance', tenant_scoped: false, requester_scope: null, requester_role: 'finance_admin' }, // TD-A3-5
  ROLE_GRANT: { domain: 'governance', tenant_scoped: false, requester_scope: null, requester_role: 'platform_owner' }, // TD-A3-5 / Q2
  ROLE_REVOKE: { domain: 'governance', tenant_scoped: false, requester_scope: null, requester_role: 'platform_owner' }, // TD-A3-5 / Q2
};

// ---- State machine --------------------------------------------------------------------

export const COMMERCIAL_CHANGE_REQUEST_STATES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'APPLYING',
  'APPLIED',
  'APPLY_FAILED',
  'REJECTED',
  'EXPIRED',
  'WITHDRAWN',
  // Charter Amendment A1 (Apply deadline, LOCKED, AD-4) — terminal; from APPROVED / APPLY_FAILED only.
  'APPLY_EXPIRED',
] as const;
export type CommercialChangeRequestState = (typeof COMMERCIAL_CHANGE_REQUEST_STATES)[number];

export const COMMERCIAL_TERMINAL_STATES: readonly CommercialChangeRequestState[] = ['APPLIED', 'REJECTED', 'EXPIRED', 'WITHDRAWN', 'APPLY_EXPIRED'];

/** States that hold the Q14 slot (one open request per tenant × product). */
export const COMMERCIAL_OPEN_STATES: readonly CommercialChangeRequestState[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLY_FAILED'];

/**
 * The A3 transition table (kept as the A3 record). APPLYING / APPLIED / APPLY_FAILED are
 * reached only through the CCP-A6 additions in COMMERCIAL_TRANSITIONS below.
 */
export const COMMERCIAL_A3_TRANSITIONS: Readonly<Record<CommercialChangeRequestState, readonly CommercialChangeRequestState[]>> = {
  DRAFT: ['PENDING_APPROVAL', 'WITHDRAWN'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'],
  APPROVED: [],
  APPLYING: [],
  APPLIED: [],
  APPLY_FAILED: [],
  REJECTED: [],
  EXPIRED: [],
  WITHDRAWN: [],
  APPLY_EXPIRED: [],
};

/**
 * CCP-A6 — the full transition table (the DB guard trigger replaced by migration
 * 20261025200000 enforces the same): the A3 transitions plus the apply transitions
 * APPROVED → APPLYING, APPLY_FAILED → APPLYING (retry), APPLYING → APPLIED | APPLY_FAILED.
 * APPLYING never commits: the apply, or the recording of its failure, leaves it in the same
 * local transaction (deferred constraint trigger).
 */
export const COMMERCIAL_TRANSITIONS: Readonly<Record<CommercialChangeRequestState, readonly CommercialChangeRequestState[]>> = {
  ...COMMERCIAL_A3_TRANSITIONS,
  // CCP-A8 — a bounded EXCEPTION support extension applies in its creating transaction.
  DRAFT: [...COMMERCIAL_A3_TRANSITIONS.DRAFT, 'APPLYING'],
  APPROVED: ['APPLYING', 'APPLY_EXPIRED'],
  APPLY_FAILED: ['APPLYING', 'APPLY_EXPIRED'],
  APPLYING: ['APPLIED', 'APPLY_FAILED'],
};

export function canTransition(from: CommercialChangeRequestState, to: CommercialChangeRequestState): boolean {
  return COMMERCIAL_TRANSITIONS[from].includes(to);
}

/** CCP-A6 — the action types A6 applies (Aramo-owned operations, Conversion Rule C-21). */
export const A6_APPLICABLE_ACTIONS = ['SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT'] as const;
export type A6ApplicableAction = (typeof A6_APPLICABLE_ACTIONS)[number];
export function isA6Applicable(action_type: string): action_type is A6ApplicableAction {
  return (A6_APPLICABLE_ACTIONS as readonly string[]).includes(action_type);
}

/**
 * CCP-A7 — the governed entitlement revoke (Charter D1), applied through the same transactional
 * apply with the A6 transitions (DB guard, migration 20261026000100).
 */
export const A7_APPLICABLE_ACTIONS = ['ENTITLEMENT_REVOKE'] as const;
export type A7ApplicableAction = (typeof A7_APPLICABLE_ACTIONS)[number];
export function isA7Applicable(action_type: string): action_type is A7ApplicableAction {
  return (A7_APPLICABLE_ACTIONS as readonly string[]).includes(action_type);
}
/**
 * CCP-A7 revoke transitions (DB guard, migration 20261026000100): the A6 apply pairs. Not the
 * A6-R APPLY_EXPIRED pairs: A6-R's guard branch names the A6 + B2-backend action types only, so a
 * revoke never reaches APPLY_EXPIRED (merge train TD-MERGE-26; whether it should is for the Lead).
 */
export const COMMERCIAL_A7_REVOKE_TRANSITIONS: Readonly<Partial<Record<CommercialChangeRequestState, readonly CommercialChangeRequestState[]>>> = {
  APPROVED: ['APPLYING'],
  APPLY_FAILED: ['APPLYING'],
  APPLYING: ['APPLIED', 'APPLY_FAILED'],
};
/** Every action the transactional apply (CommercialApplyService) applies: A6 ∪ A7. */
export type CommercialApplicableAction = A6ApplicableAction | A7ApplicableAction;
export function isCommercialApplicable(action_type: string): action_type is CommercialApplicableAction {
  return isA6Applicable(action_type) || isA7Applicable(action_type);
}

/**
 * CCP-A9 narrow apply path (TD-A9-1): only a governed role change is applied inside A9,
 * APPROVED → APPLYING → APPLIED in one transaction. Every other action keeps the A3 table
 * (its apply belongs to CCP-A6). APPLY_FAILED stays unreachable: a refused role-change apply
 * rolls back and leaves the request APPROVED.
 */
export const COMMERCIAL_ROLE_CHANGE_ACTIONS: readonly CommercialActionType[] = ['ROLE_GRANT', 'ROLE_REVOKE'];
export const COMMERCIAL_A9_ROLE_APPLY_TRANSITIONS: Readonly<Partial<Record<CommercialChangeRequestState, readonly CommercialChangeRequestState[]>>> = {
  APPROVED: ['APPLYING'],
  APPLYING: ['APPLIED'],
};

/** CCP-A6 apply transitions, admitted only for the four A6 action types (DB guard, migration 20261025200000) and, since CCP-A7, ENTITLEMENT_REVOKE (migration 20261026000100). */
export const COMMERCIAL_A6_APPLY_TRANSITIONS: Readonly<Partial<Record<CommercialChangeRequestState, readonly CommercialChangeRequestState[]>>> = {
  // CCP-A6-R (Charter Amendment A1, AD-4) — APPLY_EXPIRED from APPROVED / APPLY_FAILED, never APPLYING.
  APPROVED: ['APPLYING', 'APPLY_EXPIRED'],
  APPLY_FAILED: ['APPLYING', 'APPLY_EXPIRED'],
  APPLYING: ['APPLIED', 'APPLY_FAILED'],
};

/**
 * CCP-B2-backend (Architect disposition TD-A6-13, 2026-10-25) — the governed catalog lifecycle
 * applied on the A6 apply infrastructure: PLAN_VERSION_PUBLISH and PLAN_RETIRE (the CCP-A3 action
 * types, retire = a plan VERSION). Same apply transitions as A6 (migration 20261025220000).
 */
export const B2_CATALOG_APPLY_ACTIONS = ['PLAN_VERSION_PUBLISH', 'PLAN_RETIRE'] as const;
export type B2CatalogApplyAction = (typeof B2_CATALOG_APPLY_ACTIONS)[number];
export function isCatalogApplicable(action_type: string): action_type is B2CatalogApplyAction {
  return (B2_CATALOG_APPLY_ACTIONS as readonly string[]).includes(action_type);
}

/**
 * CCP-C2 apply transitions, admitted only for CONVERSION (DB guard, migration 20261026060000). The
 * same pairs as A6; a CONVERSION may additionally COMMIT in APPLYING while a provider command is
 * pending (self-service → governed, Conversion Rule C-13), and never enters APPLY_FAILED while one
 * is unconfirmed (DB-only rules).
 */
export const COMMERCIAL_C2_CONVERSION_TRANSITIONS: Readonly<Partial<Record<CommercialChangeRequestState, readonly CommercialChangeRequestState[]>>> = {
  APPROVED: ['APPLYING'],
  APPLY_FAILED: ['APPLYING'],
  APPLYING: ['APPLIED', 'APPLY_FAILED'],
};

/**
 * CCP-A8 — a bounded EXCEPTION SUPPORT_EXTENSION (DDR v1.2 §3.2(5)) makes ONLY these two moves,
 * in its creating transaction; it never enters the approval states (DB guard, migration
 * 20261026010000). An escalated or removal SUPPORT_EXTENSION (kind NORMAL) takes the A3 base
 * plus COMMERCIAL_A6_APPLY_TRANSITIONS.
 */
export const COMMERCIAL_A8_EXCEPTION_TRANSITIONS: Readonly<Partial<Record<CommercialChangeRequestState, readonly CommercialChangeRequestState[]>>> = {
  DRAFT: ['APPLYING'],
  APPLYING: ['APPLIED'],
};

/**
 * CCP-B5-R (TD-B5-1, Architect APPROVED 2026-10-25) — POLICY_ACTIVATE applies with the A6 apply
 * pairs: APPROVED | APPLY_FAILED → APPLYING → APPLIED | APPLY_FAILED (DB guard, union block
 * "CCP-B5-R"). The request is APPLIED only in the transaction that activates the policy version.
 */
export const COMMERCIAL_B5R_POLICY_APPLY_TRANSITIONS: Readonly<Partial<Record<CommercialChangeRequestState, readonly CommercialChangeRequestState[]>>> = {
  APPROVED: ['APPLYING'],
  APPLY_FAILED: ['APPLYING'],
  APPLYING: ['APPLIED', 'APPLY_FAILED'],
};

/**
 * Charter Amendment A1 AD-4 (CCP-A6-R; widened by CCP-B5-R to EVERY applyable action type, no
 * action-type exception): an APPROVED or APPLY_FAILED request may become APPLY_EXPIRED — the A6
 * and CCP-B2-backend types (A6-R), and POLICY_ACTIVATE, ROLE_GRANT, ROLE_REVOKE,
 * ENTITLEMENT_REVOKE, CONVERSION and a NORMAL SUPPORT_EXTENSION (B5-R). Never from APPLYING (so a
 * CONVERSION pending its provider command never expires), and never a bounded EXCEPTION (it never
 * sits in APPROVED; any other SUPPORT_EXTENSION kind takes no transition at all).
 */
export const APPLY_EXPIRABLE_ACTIONS: readonly CommercialActionType[] = [
  'SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT', // A6 (A6-R)
  'PLAN_VERSION_PUBLISH', 'PLAN_RETIRE', // CCP-B2-backend (A6-R)
  'POLICY_ACTIVATE', 'ROLE_GRANT', 'ROLE_REVOKE', 'ENTITLEMENT_REVOKE', 'CONVERSION', 'SUPPORT_EXTENSION', // CCP-B5-R
];
export function isApplyExpirable(action_type: string, kind = 'NORMAL'): boolean {
  if (!(APPLY_EXPIRABLE_ACTIONS as readonly string[]).includes(action_type)) return false;
  return action_type !== 'SUPPORT_EXTENSION' || kind === 'NORMAL';
}

/** The action types CommercialApplyService applies: the four A6 actions, CCP-A7's ENTITLEMENT_REVOKE and CCP-A8's SUPPORT_EXTENSION (merge train TD-MERGE-30). */
export const APPLY_SERVICE_ACTIONS = [...A6_APPLICABLE_ACTIONS, ...A7_APPLICABLE_ACTIONS, 'SUPPORT_EXTENSION'] as const;
export type ApplyServiceAction = (typeof APPLY_SERVICE_ACTIONS)[number];
export function isApplyServiceAction(action_type: string): action_type is ApplyServiceAction {
  return (APPLY_SERVICE_ACTIONS as readonly string[]).includes(action_type);
}

/**
 * The per-action transition table, mirroring the DB guard exactly: the A3 base for every
 * action, plus the CCP-A9 role-change apply (role actions only), the CCP-A6 apply (the four A6
 * action types), the CCP-B2-backend catalog apply (publish / retire), the CCP-C2 conversion apply
 * (CONVERSION), the CCP-A7 revoke (ENTITLEMENT_REVOKE), the CCP-A8 NORMAL SUPPORT_EXTENSION, and the
 * CCP-A8 bounded-exception moves (SUPPORT_EXTENSION of kind EXCEPTION, which takes nothing else; a
 * SUPPORT_EXTENSION of any other kind takes no transition at all, as the guard refuses it).
 * `kind` defaults to NORMAL. canTransition above is the action-agnostic union.
 */
export function canTransitionFor(
  action_type: string,
  from: CommercialChangeRequestState,
  to: CommercialChangeRequestState,
  kind: CommercialChangeRequestKind = 'NORMAL',
): boolean {
  if (action_type === 'SUPPORT_EXTENSION' && kind === 'EXCEPTION') return (COMMERCIAL_A8_EXCEPTION_TRANSITIONS[from] ?? []).includes(to);
  // Mirror fix (merge train TD-MERGE-30): the A8 guard refuses every move of a SUPPORT_EXTENSION
  // whose kind is neither EXCEPTION nor NORMAL ("kind % is not applied").
  if (action_type === 'SUPPORT_EXTENSION' && kind !== 'NORMAL') return false;
  if (COMMERCIAL_A3_TRANSITIONS[from].includes(to)) return true;
  // Charter Amendment A1 AD-4 (A6-R; CCP-B5-R for every applyable type): → APPLY_EXPIRED from
  // APPROVED / APPLY_FAILED only.
  if (to === 'APPLY_EXPIRED') return (from === 'APPROVED' || from === 'APPLY_FAILED') && isApplyExpirable(action_type, kind);
  // CCP-B5-R (TD-B5-1): POLICY_ACTIVATE applies with the A6 pairs.
  if (action_type === 'POLICY_ACTIVATE') return (COMMERCIAL_B5R_POLICY_APPLY_TRANSITIONS[from] ?? []).includes(to);
  if ((COMMERCIAL_ROLE_CHANGE_ACTIONS as readonly string[]).includes(action_type)) return (COMMERCIAL_A9_ROLE_APPLY_TRANSITIONS[from] ?? []).includes(to);
  if (isA6Applicable(action_type) || isCatalogApplicable(action_type)) return (COMMERCIAL_A6_APPLY_TRANSITIONS[from] ?? []).includes(to);
  if (action_type === 'CONVERSION') return (COMMERCIAL_C2_CONVERSION_TRANSITIONS[from] ?? []).includes(to);
  // CCP-A8: an escalated or removal SUPPORT_EXTENSION (NORMAL) takes the A6 apply pairs (its
  // APPLY_EXPIRED pairs are the AD-4 branch above, CCP-B5-R).
  if (action_type === 'SUPPORT_EXTENSION' && kind === 'NORMAL') return (COMMERCIAL_A7_REVOKE_TRANSITIONS[from] ?? []).includes(to);
  // CCP-A7: the governed revoke — the A6 apply pairs (its APPLY_EXPIRED pairs: the AD-4 branch above).
  if (isA7Applicable(action_type)) return (COMMERCIAL_A7_REVOKE_TRANSITIONS[from] ?? []).includes(to);
  return false;
}

// ---- Approval chain -------------------------------------------------------------------

// CCP-A8 — BOUNDED_EXCEPTION: the zero-step chain of a bounded EXCEPTION (DDR v1.2 §3.2(5):
// "the only acts that apply without approval"); never resolved by resolveRequiredChain.
export type CommercialChainRule = 'FINANCE_THEN_OWNER' | 'FINANCE_ONLY' | 'DISTINCT_PLATFORM_OWNER' | 'BOUNDED_EXCEPTION';

export interface CommercialChainStep {
  step_index: number;
  /** The CCP role the approver must hold, read live in the approve transaction. */
  role_key: 'finance_admin' | 'platform_owner';
  /** Every scope the approver must hold, read live in the approve transaction. */
  scope_keys: string[];
}

export interface CommercialRequiredChain {
  format_version: 1;
  rule: CommercialChainRule;
  /** Why this rule: the policy facts that selected it (evidence; never re-evaluated). */
  basis: Record<string, unknown>;
  steps: CommercialChainStep[];
}

// The approve scope a step needs, by domain. Catalog publish is owner-only (A1 §4.1).
// The A1 catalog holds no dedicated governance-approve scope: a governance step requires
// the full commercial approve set its role holds (TD-A3-6).
const ALL_APPROVE_SCOPES = ['platform:billing:approve', 'platform:catalog:approve', 'platform:entitlement:approve', 'platform:subscription:approve'];
function stepScopes(domain: CommercialDomain, role: CommercialChainStep['role_key']): string[] {
  switch (domain) {
    case 'subscription':
      return ['platform:subscription:approve'];
    case 'entitlement':
      return ['platform:entitlement:approve'];
    case 'billing':
      return ['platform:billing:approve'];
    case 'catalog':
      return role === 'platform_owner' ? ['platform:catalog:approve', 'platform:catalog:publish'] : ['platform:catalog:approve'];
    case 'governance':
      return [...ALL_APPROVE_SCOPES];
  }
}

function chainOf(rule: CommercialChainRule, domain: CommercialDomain, basis: Record<string, unknown>): CommercialRequiredChain {
  const roles: Array<CommercialChainStep['role_key']> =
    rule === 'FINANCE_THEN_OWNER' ? ['finance_admin', 'platform_owner'] : rule === 'FINANCE_ONLY' ? ['finance_admin'] : ['platform_owner'];
  return {
    format_version: 1,
    rule,
    basis,
    steps: roles.map((role_key, step_index) => ({ step_index, role_key, scope_keys: stepScopes(domain, role_key) })),
  };
}

/**
 * D6 / Q1 / Q2 chain resolution against a policy document (the ACTIVE one at creation):
 *   CREDIT, DISCOUNT          at or above the policy threshold → Finance → Owner; else Finance
 *   PLAN_VERSION_PUBLISH, PLAN_RETIRE (catalog publish)          → Finance → Owner
 *   POLICY_ACTIVATE (Q1)                                         → Finance → Owner
 *   ROLE_GRANT, ROLE_REVOKE (D6 owner/finance grants; Q2 others) → a distinct platform_owner
 *   every other action (no threshold dimension; D6 "below threshold", DDR v1.2 §3.1
 *   finance_admin "approves … subscription terms"; Q7 for an escalated extension) → Finance
 */
export function resolveRequiredChain(
  action_type: CommercialActionType,
  payload: Record<string, unknown>,
  policy: CommercialPolicyContent,
): CommercialRequiredChain {
  const def = COMMERCIAL_ACTIONS[action_type];
  switch (action_type) {
    case 'CREDIT': {
      const credit = { amount_minor: payload['amount_minor'] as number, currency: payload['currency'] as string };
      const e = creditEscalation(policy, credit);
      const basis = {
        amount_minor: credit.amount_minor,
        currency: credit.currency,
        credit_escalation_threshold_minor: policy.credit_escalation_threshold_minor,
        policy_currency: policy.currency,
        escalates: e.escalates,
        ...(e.escalates ? { escalation_reason: e.reason } : {}),
      };
      return chainOf(e.escalates ? 'FINANCE_THEN_OWNER' : 'FINANCE_ONLY', def.domain, basis);
    }
    case 'DISCOUNT': {
      const bps = payload['discount_bps'] as number;
      const escalates = discountEscalates(policy, bps);
      return chainOf(escalates ? 'FINANCE_THEN_OWNER' : 'FINANCE_ONLY', def.domain, {
        discount_bps: bps,
        discount_escalation_threshold_bps: policy.discount_escalation_threshold_bps,
        escalates,
      });
    }
    case 'PLAN_VERSION_PUBLISH':
    case 'PLAN_RETIRE':
      return chainOf('FINANCE_THEN_OWNER', def.domain, { ruling: 'D6 catalog publish' });
    case 'POLICY_ACTIVATE':
      return chainOf('FINANCE_THEN_OWNER', def.domain, { ruling: 'Q1 policy activation' });
    case 'ROLE_GRANT':
    case 'ROLE_REVOKE':
      return chainOf('DISTINCT_PLATFORM_OWNER', def.domain, { ruling: 'D6 / Q2 role change' });
    case 'SUPPORT_EXTENSION':
      // CCP-A8: an escalated extension (Q7) or a removal (TD-A8: Finance-only, as TD-A3-2's
      // no-threshold actions). A bounded EXCEPTION never resolves a chain (boundedExceptionChain).
      return chainOf('FINANCE_ONLY', def.domain, {
        ruling: payload['operation'] === 'REMOVE' ? 'TD-A8 support extension removal' : 'Q7 escalated support extension',
      });
    default:
      return chainOf('FINANCE_ONLY', def.domain, { ruling: 'D6 below threshold' });
  }
}

/**
 * CCP-A8 — the zero-step chain of a bounded EXCEPTION. `basis` carries the policy clause and the
 * counter snapshot that admitted it (evidence; never re-read).
 */
export function boundedExceptionChain(basis: Record<string, unknown>): CommercialRequiredChain {
  return { format_version: 1, rule: 'BOUNDED_EXCEPTION', basis, steps: [] };
}

/** Strict parse of a stored chain snapshot (fail closed on anything unexpected). */
export function parseRequiredChain(raw: unknown): CommercialRequiredChain {
  const fail = (why: string): never => {
    throw new CommercialChangeRequestIntegrityError(`required_chain ${why}`);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('is not an object');
  const c = raw as Record<string, unknown>;
  if (c['format_version'] !== 1) fail('format_version');
  if (c['rule'] !== 'FINANCE_THEN_OWNER' && c['rule'] !== 'FINANCE_ONLY' && c['rule'] !== 'DISTINCT_PLATFORM_OWNER' && c['rule'] !== 'BOUNDED_EXCEPTION') fail('rule');
  // CCP-A8: the bounded EXCEPTION chain has zero steps; every other chain has at least one.
  if (!Array.isArray(c['steps']) || (c['rule'] === 'BOUNDED_EXCEPTION') !== (c['steps'].length === 0)) fail('steps');
  const steps = (c['steps'] as unknown[]).map((s, i) => {
    const st = s as Record<string, unknown>;
    if (st === null || typeof st !== 'object' || st['step_index'] !== i) fail(`step ${i} index`);
    if (st['role_key'] !== 'finance_admin' && st['role_key'] !== 'platform_owner') fail(`step ${i} role_key`);
    if (!Array.isArray(st['scope_keys']) || st['scope_keys'].length === 0 || !(st['scope_keys'] as unknown[]).every((k) => typeof k === 'string')) fail(`step ${i} scope_keys`);
    return { step_index: i, role_key: st['role_key'] as CommercialChainStep['role_key'], scope_keys: [...(st['scope_keys'] as string[])] };
  });
  return { format_version: 1, rule: c['rule'] as CommercialChainRule, basis: (c['basis'] ?? {}) as Record<string, unknown>, steps };
}

// ---- Payload --------------------------------------------------------------------------

export class CommercialChangeRequestIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialChangeRequestIntegrityError';
  }
}

export class CommercialPayloadError extends Error {
  constructor(
    readonly errors: readonly string[],
    /** The stable refusal reason (details.reason); `invalid_payload` unless a specific one applies. */
    readonly reason = 'invalid_payload',
  ) {
    super(`invalid change-request payload: ${errors.join('; ')}`);
    this.name = 'CommercialPayloadError';
  }
}

/** CCP-R3 (TD-B2-1) — PLAN_RETIRE names no plan version: refused; there is no whole-plan retire. */
export const PLAN_VERSION_ID_REQUIRED = 'plan_version_id_required';

const MAX_PAYLOAD_BYTES = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * CCP-A9: the roles a governed role change may name — the 6 CCP A1 platform roles, never
 * super_admin (T2-F1-H3 Amendment A1 A1-1). Pinned to libs/identity PLATFORM_ROLE_KEYS by the
 * platform-admin A9 spec (no identity import here, so no nx edge).
 */
export const COMMERCIAL_ROLE_CHANGE_ROLE_KEYS = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;

/** CCP-B5: the POLICY_ACTIVATE payload key holding the target version's content checksum (NC-5 snapshot). */
export const POLICY_TARGET_CHECKSUM_KEY = 'target_content_checksum';

/**
 * A3 validates only what chain resolution and the eligibility rules read; the applying
 * slice (A4–A9, C1–C4) owns the full payload schema of its action. The payload is frozen
 * at creation either way (DB trigger + checksum).
 */
export function validatePayload(action_type: CommercialActionType, payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new CommercialPayloadError(['payload must be a JSON object']);
  const p = payload as Record<string, unknown>;
  const errors: string[] = [];
  if (Buffer.byteLength(canonicalJson(p), 'utf8') > MAX_PAYLOAD_BYTES) errors.push(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  const int = (k: string, min: number, max: number): void => {
    const v = p[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) errors.push(`${k} must be an integer between ${min} and ${max}`);
  };
  switch (action_type) {
    case 'CREDIT':
      int('amount_minor', 0, Number.MAX_SAFE_INTEGER);
      if (typeof p['currency'] !== 'string' || !/^[A-Z]{3}$/.test(p['currency'])) errors.push('currency must be an ISO 4217 code');
      break;
    case 'DISCOUNT':
      int('discount_bps', 0, 10_000);
      break;
    case 'SUPPORT_EXTENSION':
      // CCP-A8 owns the full schema: EXTEND names the subscription row and the days (the bound
      // is decided by the bounded path, never by the payload); REMOVE names the overlay.
      if (p['operation'] === 'EXTEND') {
        closedKeys(p, ['operation', 'subscription_id', 'requested_days'], errors);
        if (typeof p['subscription_id'] !== 'string' || !UUID.test(p['subscription_id'])) errors.push('subscription_id must be a uuid');
        int('requested_days', 1, 3650);
      } else if (p['operation'] === 'REMOVE') {
        closedKeys(p, ['operation', 'support_extension_id'], errors);
        if (typeof p['support_extension_id'] !== 'string' || !UUID.test(p['support_extension_id'])) errors.push('support_extension_id must be a uuid');
      } else {
        errors.push('operation must be EXTEND or REMOVE');
        if (p['requested_days'] !== undefined) int('requested_days', 1, 3650);
      }
      break;
    case 'ROLE_GRANT':
    case 'ROLE_REVOKE': {
      if (typeof p['subject_user_id'] !== 'string' || !UUID.test(p['subject_user_id'])) errors.push('subject_user_id must be a uuid');
      if (typeof p['role_key'] !== 'string' || p['role_key'].length === 0) errors.push('role_key must be a role key');
      else if (!(COMMERCIAL_ROLE_CHANGE_ROLE_KEYS as readonly string[]).includes(p['role_key'])) errors.push(`role_key must be one of ${COMMERCIAL_ROLE_CHANGE_ROLE_KEYS.join(', ')}`);
      // CCP-A9: a closed key set. human_ref_hash (D9: SHA-256 hex of the attested human
      // reference, no PII) is carried only by a grant, for a subject not yet attested.
      const allowed = action_type === 'ROLE_GRANT' ? ['subject_user_id', 'role_key', 'human_ref_hash'] : ['subject_user_id', 'role_key'];
      for (const k of Object.keys(p)) if (!allowed.includes(k)) errors.push(`${k} is not allowed in a ${action_type} payload`);
      if (p['human_ref_hash'] !== undefined && (typeof p['human_ref_hash'] !== 'string' || !SHA256_HEX.test(p['human_ref_hash']))) errors.push('human_ref_hash must be a lowercase SHA-256 hex digest');
      break;
    }
    case 'POLICY_ACTIVATE': {
      if (typeof p['policy_version_id'] !== 'string' || !UUID.test(p['policy_version_id'])) errors.push('policy_version_id must be a uuid');
      // CCP-B5 (TD-A9-16, pre-execution C-3): a closed key set. target_content_checksum is the
      // NC-5 snapshot of the target version's content (SHA-256 hex); the service fills it from
      // the target row when the client omits it, so every stored request carries it.
      for (const k of Object.keys(p)) if (k !== 'policy_version_id' && k !== POLICY_TARGET_CHECKSUM_KEY) errors.push(`${k} is not allowed in a POLICY_ACTIVATE payload`);
      if (p[POLICY_TARGET_CHECKSUM_KEY] !== undefined && (typeof p[POLICY_TARGET_CHECKSUM_KEY] !== 'string' || !SHA256_HEX.test(p[POLICY_TARGET_CHECKSUM_KEY]))) {
        errors.push(`${POLICY_TARGET_CHECKSUM_KEY} must be a lowercase SHA-256 hex digest`);
      }
      break;
    }
    // CCP-B2-backend — the catalog apply's payloads: the plan VERSION acted on, and for a publish
    // an optional provider price to pin to it (D3; the A5 PlanVersionRepository.pinProviderPrice).
    case 'PLAN_VERSION_PUBLISH':
      closedKeys(p, ['plan_version_id', 'provider_price_ref'], errors);
      if (typeof p['plan_version_id'] !== 'string' || !UUID.test(p['plan_version_id'])) errors.push('plan_version_id must be a uuid');
      if (p['provider_price_ref'] !== undefined && !(typeof p['provider_price_ref'] === 'string' && /^[A-Za-z0-9_]{3,200}$/.test(p['provider_price_ref']))) {
        errors.push('provider_price_ref must be a provider price id');
      }
      break;
    case 'PLAN_RETIRE':
      // CCP-R3 (TD-B2-1, Architect 2026-10-25): version-only retirement. The request retires the ONE
      // plan version it names; without plan_version_id it is refused (stable reason
      // plan_version_id_required). No payload retires a whole plan.
      if (p['plan_version_id'] === undefined || p['plan_version_id'] === null) {
        throw new CommercialPayloadError(['PLAN_RETIRE retires one specified plan version: plan_version_id is required (there is no whole-plan retire)'], PLAN_VERSION_ID_REQUIRED);
      }
      closedKeys(p, ['plan_version_id'], errors);
      if (typeof p['plan_version_id'] !== 'string' || !UUID.test(p['plan_version_id'])) errors.push('plan_version_id must be a uuid');
      break;
    // CCP-A6 — the applying slice owns the full payload schema of its actions. Each names
    // exactly what the approvers approve: the plan VERSION (G3 pin), and the subscription row
    // the change acts on or replaces (G2), so a stale request is refused at apply.
    case 'SUBSCRIPTION_OPEN':
      // CCP-B4: an optional `contract` block records an enterprise contract with the open.
      closedKeys(p, ['plan_key', 'plan_version_id', 'replaces_subscription_id', 'period_anchor', ...CONTRACT_PAYLOAD_KEYS.SUBSCRIPTION_OPEN], errors);
      validateContractBlocks('SUBSCRIPTION_OPEN', p, errors);
      planRef(p, errors);
      if (p['replaces_subscription_id'] !== null && !(typeof p['replaces_subscription_id'] === 'string' && UUID.test(p['replaces_subscription_id']))) {
        errors.push('replaces_subscription_id must be a uuid or null (null: the tenant holds no open subscription of the product)');
      }
      if (p['period_anchor'] !== undefined && !isIsoInstant(p['period_anchor'])) errors.push('period_anchor must be an ISO-8601 UTC instant');
      break;
    case 'SUBSCRIPTION_CHANGE':
      // CCP-B4: an optional `contract` (record) or `contract_amendment` block; with either, the
      // plan version may stay the same (a terms-only amendment).
      closedKeys(p, ['subscription_id', 'plan_key', 'plan_version_id', ...CONTRACT_PAYLOAD_KEYS.SUBSCRIPTION_CHANGE], errors);
      validateContractBlocks('SUBSCRIPTION_CHANGE', p, errors);
      if (typeof p['subscription_id'] !== 'string' || !UUID.test(p['subscription_id'])) errors.push('subscription_id must be a uuid');
      planRef(p, errors);
      break;
    case 'SUBSCRIPTION_END':
      // CCP-B4: `contract_end` names the contract a contract-linked row's end also ends.
      closedKeys(p, ['subscription_id', ...CONTRACT_PAYLOAD_KEYS.SUBSCRIPTION_END], errors);
      validateContractBlocks('SUBSCRIPTION_END', p, errors);
      if (typeof p['subscription_id'] !== 'string' || !UUID.test(p['subscription_id'])) errors.push('subscription_id must be a uuid');
      break;
    case 'ENTITLEMENT_GRANT':
    case 'ENTITLEMENT_REVOKE': {
      // CCP-A7 — the revoke names exactly the capabilities the approvers approve removing.
      closedKeys(p, ['capabilities'], errors);
      const caps = p['capabilities'];
      if (!Array.isArray(caps) || caps.length === 0 || caps.length > 16 || !caps.every((c) => typeof c === 'string' && /^[a-z][a-z_]{0,39}$/.test(c))) {
        errors.push('capabilities must be a non-empty array of capability keys');
      } else if (new Set(caps).size !== caps.length) {
        errors.push('capabilities must not repeat');
      }
      break;
    }
    // CCP-C2 — the conversion payload: a closed direction with a closed key set per direction
    // (commercial-conversion.ts). Validated at create and again at apply.
    case 'CONVERSION':
      errors.push(...conversionPayloadErrors(p));
      break;
    default:
      break;
  }
  if (errors.length > 0) throw new CommercialPayloadError(errors);
  return p;
}

function closedKeys(p: Record<string, unknown>, allowed: readonly string[], errors: string[]): void {
  for (const k of Object.keys(p)) if (!allowed.includes(k)) errors.push(`${k} is not a field of this action`);
}

function planRef(p: Record<string, unknown>, errors: string[]): void {
  if (typeof p['plan_key'] !== 'string' || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(p['plan_key'])) errors.push('plan_key must be a catalog plan key');
  if (typeof p['plan_version_id'] !== 'string' || !UUID.test(p['plan_version_id'])) errors.push('plan_version_id must be a uuid (the version is pinned, G3)');
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
function isIsoInstant(v: unknown): boolean {
  return typeof v === 'string' && ISO_INSTANT.test(v) && !Number.isNaN(new Date(v).getTime());
}

/** SHA-256 (hex) of the canonical JSON of the payload; recomputed on every approve. */
export function payloadChecksum(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/** The user a role change is about (cannot approve their own change: SELF_APPROVAL). */
export function subjectUserOf(action_type: string, payload: unknown): string | null {
  if (action_type !== 'ROLE_GRANT' && action_type !== 'ROLE_REVOKE') return null;
  const v = (payload as Record<string, unknown> | null)?.['subject_user_id'];
  return typeof v === 'string' ? v : null;
}
