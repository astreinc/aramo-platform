import { createHash } from 'node:crypto';

import type { CommercialPolicyContent } from './commercial-policy.js';
import { canonicalJson } from './commercial-policy.js';
import { creditEscalation, discountEscalates } from './commercial-policy-boundaries.js';

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
  'PLAN_RETIRE', // A5 / B2 — retire a plan or plan version
  'POLICY_ACTIVATE', // activate (or roll back to) a CommercialPolicyVersion (Q1)
  'SUPPORT_EXTENSION', // A8 — an out-of-limit support extension, escalated (Q7)
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
   * The scope the requester must hold (A1 §4.1 matrix). `null` = no requester authority is
   * defined by an instrument yet: the request cannot be created (fail closed; TD-A3-5).
   */
  requester_scope: string | null;
}

export const COMMERCIAL_ACTIONS: Readonly<Record<CommercialActionType, CommercialActionDefinition>> = {
  SUBSCRIPTION_OPEN: { domain: 'subscription', tenant_scoped: true, requester_scope: 'platform:subscription:request' },
  SUBSCRIPTION_CHANGE: { domain: 'subscription', tenant_scoped: true, requester_scope: 'platform:subscription:request' },
  SUBSCRIPTION_END: { domain: 'subscription', tenant_scoped: true, requester_scope: 'platform:subscription:request' },
  CONVERSION: { domain: 'subscription', tenant_scoped: true, requester_scope: 'platform:subscription:request' },
  SUPPORT_EXTENSION: { domain: 'subscription', tenant_scoped: true, requester_scope: 'platform:subscription:support' },
  ENTITLEMENT_GRANT: { domain: 'entitlement', tenant_scoped: true, requester_scope: 'platform:entitlement:request' },
  ENTITLEMENT_REVOKE: { domain: 'entitlement', tenant_scoped: true, requester_scope: 'platform:entitlement:request' },
  CREDIT: { domain: 'billing', tenant_scoped: true, requester_scope: 'platform:billing:request' },
  DISCOUNT: { domain: 'billing', tenant_scoped: true, requester_scope: 'platform:billing:request' },
  PLAN_VERSION_PUBLISH: { domain: 'catalog', tenant_scoped: false, requester_scope: 'platform:catalog:draft' },
  PLAN_RETIRE: { domain: 'catalog', tenant_scoped: false, requester_scope: 'platform:catalog:draft' },
  POLICY_ACTIVATE: { domain: 'governance', tenant_scoped: false, requester_scope: null },
  ROLE_GRANT: { domain: 'governance', tenant_scoped: false, requester_scope: null },
  ROLE_REVOKE: { domain: 'governance', tenant_scoped: false, requester_scope: null },
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
] as const;
export type CommercialChangeRequestState = (typeof COMMERCIAL_CHANGE_REQUEST_STATES)[number];

export const COMMERCIAL_TERMINAL_STATES: readonly CommercialChangeRequestState[] = ['APPLIED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'];

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
  APPROVED: ['APPLYING'],
  APPLY_FAILED: ['APPLYING'],
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

// ---- Approval chain -------------------------------------------------------------------

export type CommercialChainRule = 'FINANCE_THEN_OWNER' | 'FINANCE_ONLY' | 'DISTINCT_PLATFORM_OWNER';

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
    default:
      return chainOf('FINANCE_ONLY', def.domain, { ruling: action_type === 'SUPPORT_EXTENSION' ? 'Q7 escalated support extension' : 'D6 below threshold' });
  }
}

/** Strict parse of a stored chain snapshot (fail closed on anything unexpected). */
export function parseRequiredChain(raw: unknown): CommercialRequiredChain {
  const fail = (why: string): never => {
    throw new CommercialChangeRequestIntegrityError(`required_chain ${why}`);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('is not an object');
  const c = raw as Record<string, unknown>;
  if (c['format_version'] !== 1) fail('format_version');
  if (c['rule'] !== 'FINANCE_THEN_OWNER' && c['rule'] !== 'FINANCE_ONLY' && c['rule'] !== 'DISTINCT_PLATFORM_OWNER') fail('rule');
  if (!Array.isArray(c['steps']) || c['steps'].length === 0) fail('steps');
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
  constructor(readonly errors: readonly string[]) {
    super(`invalid change-request payload: ${errors.join('; ')}`);
    this.name = 'CommercialPayloadError';
  }
}

const MAX_PAYLOAD_BYTES = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      int('requested_days', 1, 3650);
      break;
    case 'ROLE_GRANT':
    case 'ROLE_REVOKE':
      if (typeof p['subject_user_id'] !== 'string' || !UUID.test(p['subject_user_id'])) errors.push('subject_user_id must be a uuid');
      if (typeof p['role_key'] !== 'string' || p['role_key'].length === 0) errors.push('role_key must be a role key');
      break;
    case 'POLICY_ACTIVATE':
      if (typeof p['policy_version_id'] !== 'string' || !UUID.test(p['policy_version_id'])) errors.push('policy_version_id must be a uuid');
      break;
    // CCP-A6 — the applying slice owns the full payload schema of its actions. Each names
    // exactly what the approvers approve: the plan VERSION (G3 pin), and the subscription row
    // the change acts on or replaces (G2), so a stale request is refused at apply.
    case 'SUBSCRIPTION_OPEN':
      closedKeys(p, ['plan_key', 'plan_version_id', 'replaces_subscription_id', 'period_anchor'], errors);
      planRef(p, errors);
      if (p['replaces_subscription_id'] !== null && !(typeof p['replaces_subscription_id'] === 'string' && UUID.test(p['replaces_subscription_id']))) {
        errors.push('replaces_subscription_id must be a uuid or null (null: the tenant holds no open subscription of the product)');
      }
      if (p['period_anchor'] !== undefined && !isIsoInstant(p['period_anchor'])) errors.push('period_anchor must be an ISO-8601 UTC instant');
      break;
    case 'SUBSCRIPTION_CHANGE':
      closedKeys(p, ['subscription_id', 'plan_key', 'plan_version_id'], errors);
      if (typeof p['subscription_id'] !== 'string' || !UUID.test(p['subscription_id'])) errors.push('subscription_id must be a uuid');
      planRef(p, errors);
      break;
    case 'SUBSCRIPTION_END':
      closedKeys(p, ['subscription_id'], errors);
      if (typeof p['subscription_id'] !== 'string' || !UUID.test(p['subscription_id'])) errors.push('subscription_id must be a uuid');
      break;
    case 'ENTITLEMENT_GRANT': {
      closedKeys(p, ['capabilities'], errors);
      const caps = p['capabilities'];
      if (!Array.isArray(caps) || caps.length === 0 || caps.length > 16 || !caps.every((c) => typeof c === 'string' && /^[a-z][a-z_]{0,39}$/.test(c))) {
        errors.push('capabilities must be a non-empty array of capability keys');
      } else if (new Set(caps).size !== caps.length) {
        errors.push('capabilities must not repeat');
      }
      break;
    }
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
