import { describe, expect, it } from 'vitest';

import {
  APPROVAL_REFUSALS,
  CommercialApplyRefusedError,
  type EligibilityActor,
  type EligibilityRequest,
  type RosterEntry,
  assertChainStillSatisfiableAtApply,
  checkApprovalEligibility,
  checkChainSatisfiable,
} from '../lib/commercial/commercial-approval-eligibility.js';
import {
  COMMERCIAL_A3_TRANSITIONS,
  COMMERCIAL_TRANSITIONS,
  COMMERCIAL_ACTIONS,
  COMMERCIAL_ACTION_TYPES,
  COMMERCIAL_CHANGE_REQUEST_STATES,
  type CommercialActionType,
  type CommercialChangeRequestState,
  CommercialPayloadError,
  canTransition,
  parseRequiredChain,
  payloadChecksum,
  resolveRequiredChain,
  validatePayload,
} from '../lib/commercial/commercial-change-request.js';
import { approvalExpiresAt } from '../lib/commercial/commercial-policy-boundaries.js';
import { type CommercialPolicyContent, parseCommercialPolicyContent } from '../lib/commercial/commercial-policy.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';

// CCP-A3 (PBD §5.1 row A3; Charter §6.4) — the PURE engine: the seven refusals (A3-R-*),
// the D6/Q1/Q2 chain table (A3-CH-*), the state machine (A3-SM-*), the 72 h expiry edge
// (A3-EXP-*), chain satisfiability (A3-SAT-*), and the NC-5 apply-time re-check
// (A3-APPLY-*). The policy is the v1 document parsed out of the A2 migration.

const policy: CommercialPolicyContent = parseCommercialPolicyContent(seededPolicyV1().content);
const H = 3_600_000;
const SUBMITTED = new Date('2026-10-25T00:00:00.000Z');
const EXPIRES = approvalExpiresAt(policy, SUBMITTED);
const NOW = new Date(SUBMITTED.getTime() + H);

const REQUESTER = 'u-requester';
const FA = 'u-finance';
const FA2 = 'u-finance-2';
const PO = 'u-owner';
const BOTH = 'u-finance-and-owner';

const FA_SCOPES = ['platform:catalog:approve', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:approve', 'platform:approval:read'];
const PO_SCOPES = [...FA_SCOPES, 'platform:catalog:publish'];

const actor = (user_id: string, roles: string[], scopes: string[], extra: Partial<EligibilityActor> = {}): EligibilityActor => ({
  user_id,
  actor_kind: 'user',
  attested: true,
  role_keys: roles,
  scopes,
  ...extra,
});
const fa = (id = FA) => actor(id, ['finance_admin'], FA_SCOPES);
const po = (id = PO) => actor(id, ['platform_owner'], PO_SCOPES);
const both = () => actor(BOTH, ['finance_admin', 'platform_owner'], PO_SCOPES);

function request(action: CommercialActionType, payload: Record<string, unknown>, extra: Partial<EligibilityRequest> = {}): EligibilityRequest {
  return {
    state: 'PENDING_APPROVAL',
    requested_by: REQUESTER,
    expires_at: EXPIRES,
    required_chain: resolveRequiredChain(action, payload, policy),
    subject_user_id: null,
    ...extra,
  };
}
const credit = (amount_minor: number) => request('CREDIT', { amount_minor, currency: 'USD' }); // ≥ 50000 → finance → owner
const ESCALATED = credit(50_000);
const BELOW = credit(49_999);

describe('CCP-A3 refusal table — checkApprovalEligibility (exactly the seven refusals)', () => {
  it('A3-R-0 the refusal set is exactly the seven approved conditions, in order', () => {
    expect([...APPROVAL_REFUSALS]).toEqual(['NOT_PENDING', 'EXPIRED', 'NOT_HUMAN', 'SELF_APPROVAL', 'USER_ALREADY_APPROVED', 'STEP_SCOPE_MISSING', 'OUT_OF_ORDER']);
  });

  const rows: Array<[string, EligibilityRequest, Array<{ step_index: number; approver_user_id: string }>, EligibilityActor, number | undefined, string]> = [
    ['A3-R-1a NOT_PENDING (DRAFT)', { ...ESCALATED, state: 'DRAFT', expires_at: null }, [], fa(), 0, 'NOT_PENDING'],
    ['A3-R-1b NOT_PENDING (APPROVED)', { ...ESCALATED, state: 'APPROVED' }, [], fa(), 0, 'NOT_PENDING'],
    ['A3-R-1c NOT_PENDING (REJECTED)', { ...ESCALATED, state: 'REJECTED' }, [], fa(), 0, 'NOT_PENDING'],
    ['A3-R-1d NOT_PENDING (WITHDRAWN)', { ...ESCALATED, state: 'WITHDRAWN' }, [], fa(), 0, 'NOT_PENDING'],
    ['A3-R-1e NOT_PENDING (EXPIRED state)', { ...ESCALATED, state: 'EXPIRED' }, [], fa(), 0, 'NOT_PENDING'],
    ['A3-R-2 EXPIRED (now past expires_at)', { ...ESCALATED, expires_at: new Date(NOW.getTime() - 1) }, [], fa(), 0, 'EXPIRED'],
    ['A3-R-3a NOT_HUMAN (service account)', ESCALATED, [], actor(FA, ['finance_admin'], FA_SCOPES, { actor_kind: 'service_account' }), 0, 'NOT_HUMAN'],
    ['A3-R-3b NOT_HUMAN (system)', ESCALATED, [], actor(FA, ['finance_admin'], FA_SCOPES, { actor_kind: 'system' }), 0, 'NOT_HUMAN'],
    ['A3-R-3c NOT_HUMAN (no D9 attestation)', ESCALATED, [], actor(FA, ['finance_admin'], FA_SCOPES, { attested: false }), 0, 'NOT_HUMAN'],
    ['A3-R-4a SELF_APPROVAL (requester holding finance_admin)', ESCALATED, [], fa(REQUESTER), 0, 'SELF_APPROVAL'],
    ['A3-R-4b SELF_APPROVAL (subject of a role change)', { ...request('ROLE_GRANT', { subject_user_id: PO, role_key: 'finance_admin' }), subject_user_id: PO }, [], po(), 0, 'SELF_APPROVAL'],
    ['A3-R-5 USER_ALREADY_APPROVED (finance+owner user after filling step 0, NC-2)', ESCALATED, [{ step_index: 0, approver_user_id: BOTH }], both(), 1, 'USER_ALREADY_APPROVED'],
    ['A3-R-6a STEP_SCOPE_MISSING (commercial_ops)', ESCALATED, [], actor('u-ops', ['commercial_ops'], ['platform:subscription:request', 'platform:approval:read']), 0, 'STEP_SCOPE_MISSING'],
    ['A3-R-6b STEP_SCOPE_MISSING (read_only_auditor)', ESCALATED, [], actor('u-aud', ['read_only_auditor'], ['platform:approval:read']), 0, 'STEP_SCOPE_MISSING'],
    ['A3-R-6c STEP_SCOPE_MISSING (finance_admin role revoked, scopes gone: NC-4 shape)', ESCALATED, [], actor(FA, [], []), 0, 'STEP_SCOPE_MISSING'],
    ['A3-R-6d STEP_SCOPE_MISSING (role held, scope missing)', BELOW, [], actor(FA, ['finance_admin'], ['platform:approval:read']), 0, 'STEP_SCOPE_MISSING'],
    ['A3-R-6e STEP_SCOPE_MISSING (platform_owner on a finance-only chain)', BELOW, [], po(), 0, 'STEP_SCOPE_MISSING'],
    ['A3-R-7a OUT_OF_ORDER (owner before finance)', ESCALATED, [], po(), 0, 'OUT_OF_ORDER'],
    ['A3-R-7b OUT_OF_ORDER (asks for step 1 while step 0 is next)', ESCALATED, [], fa(), 1, 'OUT_OF_ORDER'],
    ['A3-R-7c OUT_OF_ORDER (asks for an already-filled step: the NC-1 loser)', ESCALATED, [{ step_index: 0, approver_user_id: FA }], fa(FA2), 0, 'OUT_OF_ORDER'],
  ];
  for (const [name, req, approvals, who, step, expected] of rows) {
    it(name, () => {
      const v = checkApprovalEligibility(req, approvals, who, NOW, step);
      expect(v.eligible).toBe(false);
      if (!v.eligible) expect(v.refusal).toBe(expected);
    });
  }

  it('A3-R-OK-1 finance_admin approves step 0, then platform_owner approves step 1', () => {
    const v0 = checkApprovalEligibility(ESCALATED, [], fa(), NOW, 0);
    expect(v0).toMatchObject({ eligible: true, step_index: 0, step: { role_key: 'finance_admin' } });
    const v1 = checkApprovalEligibility(ESCALATED, [{ step_index: 0, approver_user_id: FA }], po(), NOW, 1);
    expect(v1).toMatchObject({ eligible: true, step_index: 1, step: { role_key: 'platform_owner' } });
  });

  it('A3-R-OK-2 one user holding finance_admin and platform_owner is eligible for ONE step only (NC-2): step 0 yes, step 1 refused', () => {
    expect(checkApprovalEligibility(ESCALATED, [], both(), NOW, 0).eligible).toBe(true);
    const second = checkApprovalEligibility(ESCALATED, [{ step_index: 0, approver_user_id: BOTH }], both(), NOW, 1);
    expect(second).toMatchObject({ eligible: false, refusal: 'USER_ALREADY_APPROVED' });
  });

  it('A3-R-PREC precedence: a request that is both expired and self-approved reports EXPIRED; not pending beats everything', () => {
    expect(checkApprovalEligibility({ ...ESCALATED, expires_at: SUBMITTED }, [], fa(REQUESTER), NOW, 0)).toMatchObject({ refusal: 'EXPIRED' });
    expect(checkApprovalEligibility({ ...ESCALATED, state: 'DRAFT', expires_at: null }, [], actor(REQUESTER, [], [], { actor_kind: 'system' }), NOW, 0)).toMatchObject({ refusal: 'NOT_PENDING' });
  });
});

describe('CCP-A3 72 h expiry (half-open: expired AT exactly 72 h)', () => {
  const at = (ms: number) => new Date(SUBMITTED.getTime() + ms);
  it('A3-EXP-0 expires_at = submitted + approval_expiry_hours from the policy', () => {
    expect(EXPIRES.toISOString()).toBe('2026-10-28T00:00:00.000Z');
    expect(policy.approval_expiry_hours * H).toBe(EXPIRES.getTime() - SUBMITTED.getTime());
  });
  it('A3-EXP-1 exactly 72 h → EXPIRED', () => {
    expect(checkApprovalEligibility(BELOW, [], fa(), at(72 * H), 0)).toMatchObject({ eligible: false, refusal: 'EXPIRED' });
  });
  it('A3-EXP-2 72 h − 1 ms → still pending (eligible)', () => {
    expect(checkApprovalEligibility(BELOW, [], fa(), at(72 * H - 1), 0).eligible).toBe(true);
  });
  it('A3-EXP-3 72 h + 1 ms → EXPIRED', () => {
    expect(checkApprovalEligibility(BELOW, [], fa(), at(72 * H + 1), 0)).toMatchObject({ eligible: false, refusal: 'EXPIRED' });
  });
});

describe('CCP-A3 chain resolution from the policy (D6, Q1, Q2, Q7) — the chain is a snapshot', () => {
  const rule = (a: CommercialActionType, p: Record<string, unknown>) => {
    const c = resolveRequiredChain(a, p, policy);
    return [c.rule, c.steps.map((s) => s.role_key)];
  };
  const table: Array<[string, CommercialActionType, Record<string, unknown>, string, string[]]> = [
    ['A3-CH-1 credit at the threshold ($500.00) → finance → owner', 'CREDIT', { amount_minor: 50_000, currency: 'USD' }, 'FINANCE_THEN_OWNER', ['finance_admin', 'platform_owner']],
    ['A3-CH-2 credit one cent below → finance', 'CREDIT', { amount_minor: 49_999, currency: 'USD' }, 'FINANCE_ONLY', ['finance_admin']],
    ['A3-CH-3 credit in a non-policy currency → escalates (TD-A2-3)', 'CREDIT', { amount_minor: 1, currency: 'EUR' }, 'FINANCE_THEN_OWNER', ['finance_admin', 'platform_owner']],
    ['A3-CH-4 discount at 20.00% → finance → owner', 'DISCOUNT', { discount_bps: 2000 }, 'FINANCE_THEN_OWNER', ['finance_admin', 'platform_owner']],
    ['A3-CH-5 discount 19.99% → finance', 'DISCOUNT', { discount_bps: 1999 }, 'FINANCE_ONLY', ['finance_admin']],
    ['A3-CH-6 catalog publish → finance → owner', 'PLAN_VERSION_PUBLISH', {}, 'FINANCE_THEN_OWNER', ['finance_admin', 'platform_owner']],
    ['A3-CH-7 plan retire → finance → owner', 'PLAN_RETIRE', {}, 'FINANCE_THEN_OWNER', ['finance_admin', 'platform_owner']],
    ['A3-CH-8 policy activation (Q1) → finance → owner', 'POLICY_ACTIVATE', { policy_version_id: '019a0000-0000-7000-8000-0000000cc299' }, 'FINANCE_THEN_OWNER', ['finance_admin', 'platform_owner']],
    ['A3-CH-9 owner/finance role grant → a distinct platform_owner', 'ROLE_GRANT', { subject_user_id: '019a0000-0000-7000-8000-000000000001', role_key: 'finance_admin' }, 'DISTINCT_PLATFORM_OWNER', ['platform_owner']],
    ['A3-CH-10 other role change (Q2) → a distinct platform_owner', 'ROLE_REVOKE', { subject_user_id: '019a0000-0000-7000-8000-000000000001', role_key: 'support_admin' }, 'DISTINCT_PLATFORM_OWNER', ['platform_owner']],
    ['A3-CH-11 escalated support extension (Q7) → finance', 'SUPPORT_EXTENSION', { requested_days: 20 }, 'FINANCE_ONLY', ['finance_admin']],
    ['A3-CH-12 subscription open (no threshold) → finance', 'SUBSCRIPTION_OPEN', {}, 'FINANCE_ONLY', ['finance_admin']],
    ['A3-CH-13 entitlement grant → finance', 'ENTITLEMENT_GRANT', {}, 'FINANCE_ONLY', ['finance_admin']],
    ['A3-CH-14 conversion → finance', 'CONVERSION', {}, 'FINANCE_ONLY', ['finance_admin']],
  ];
  for (const [name, a, p, r, roles] of table) it(name, () => expect(rule(a, p)).toEqual([r, roles]));

  // CCP-C4 (TD-C4-1): REFUND joins the closed set (14 -> 15).
  it('A3-CH-15 every action type resolves a chain (closed set of 16, CCP-C4 REFUND, CCP-C8-PR PAYMENT_RECORD) and every step names a role and at least one scope', () => {
    expect(COMMERCIAL_ACTION_TYPES).toHaveLength(16);
    for (const a of COMMERCIAL_ACTION_TYPES) {
      const p: Record<string, unknown> =
        a === 'CREDIT' || a === 'REFUND' ? { amount_minor: 1, currency: 'USD' } : a === 'DISCOUNT' ? { discount_bps: 1 } : {};
      const c = resolveRequiredChain(a, p, policy);
      expect(c.steps.length).toBeGreaterThan(0);
      for (const s of c.steps) expect(s.scope_keys.length).toBeGreaterThan(0);
      expect(parseRequiredChain(JSON.parse(JSON.stringify(c)))).toEqual(c);
    }
  });

  it('A3-CH-16 thresholds are DATA: a policy with a $1,000 credit threshold moves the $500 credit to finance only', () => {
    const p2 = { ...policy, credit_escalation_threshold_minor: 100_000 };
    expect(resolveRequiredChain('CREDIT', { amount_minor: 50_000, currency: 'USD' }, p2).rule).toBe('FINANCE_ONLY');
  });

  it('A3-CH-17 step scopes follow the domain: catalog owner step needs catalog:publish; billing needs billing:approve', () => {
    expect(resolveRequiredChain('PLAN_VERSION_PUBLISH', {}, policy).steps.map((s) => s.scope_keys)).toEqual([['platform:catalog:approve'], ['platform:catalog:approve', 'platform:catalog:publish']]);
    expect(resolveRequiredChain('DISCOUNT', { discount_bps: 1 }, policy).steps[0]?.scope_keys).toEqual(['platform:billing:approve']);
  });

  it('A3-CH-18 requester authority per action (A1 §4.1); governance actions have none defined (fail closed, TD-A3-5)', () => {
    expect(COMMERCIAL_ACTIONS.SUBSCRIPTION_OPEN.requester_scope).toBe('platform:subscription:request');
    expect(COMMERCIAL_ACTIONS.PLAN_VERSION_PUBLISH.requester_scope).toBe('platform:catalog:draft');
    expect(COMMERCIAL_ACTIONS.SUPPORT_EXTENSION.requester_scope).toBe('platform:subscription:support');
    expect(COMMERCIAL_ACTIONS.CREDIT.requester_scope).toBe('platform:billing:request');
    expect([COMMERCIAL_ACTIONS.POLICY_ACTIVATE, COMMERCIAL_ACTIONS.ROLE_GRANT, COMMERCIAL_ACTIONS.ROLE_REVOKE].map((d) => d.requester_scope)).toEqual([null, null, null]);
  });
});

describe('CCP-A3 state-machine transition table (A3 transitions only)', () => {
  const allowed = new Set([
    'DRAFT>PENDING_APPROVAL',
    'DRAFT>WITHDRAWN',
    'PENDING_APPROVAL>APPROVED',
    'PENDING_APPROVAL>REJECTED',
    'PENDING_APPROVAL>EXPIRED',
    'PENDING_APPROVAL>WITHDRAWN',
  ]);
  it('A3-SM-1 exactly 6 of the 81 state pairs are A3 transitions; APPLYING/APPLIED/APPLY_FAILED are unreachable', () => {
    let n = 0;
    for (const from of COMMERCIAL_CHANGE_REQUEST_STATES) {
      for (const to of COMMERCIAL_CHANGE_REQUEST_STATES) {
        // CCP-A6 — canTransition now reads the full table; the A3 record is COMMERCIAL_A3_TRANSITIONS.
        const ok = COMMERCIAL_A3_TRANSITIONS[from as CommercialChangeRequestState].includes(to as CommercialChangeRequestState);
        expect(ok, `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
        if (ok) n += 1;
      }
    }
    expect(n).toBe(6);
    for (const s of ['APPLYING', 'APPLIED', 'APPLY_FAILED'] as const) {
      expect(COMMERCIAL_CHANGE_REQUEST_STATES.some((f) => COMMERCIAL_A3_TRANSITIONS[f].includes(s))).toBe(false);
    }
  });
});

describe('CCP-A6 state-machine transition table (A3 + apply)', () => {
  const allowed = new Set([
    'DRAFT>PENDING_APPROVAL',
    'DRAFT>WITHDRAWN',
    'PENDING_APPROVAL>APPROVED',
    'PENDING_APPROVAL>REJECTED',
    'PENDING_APPROVAL>EXPIRED',
    'PENDING_APPROVAL>WITHDRAWN',
    'APPROVED>APPLYING',
    'APPLY_FAILED>APPLYING',
    'APPLYING>APPLIED',
    'APPLYING>APPLY_FAILED',
    // CCP-A6-R (Charter Amendment A1, AD-4)
    'APPROVED>APPLY_EXPIRED',
    'APPLY_FAILED>APPLY_EXPIRED',
    // CCP-A8: a bounded EXCEPTION support extension applies in its creating transaction.
    'DRAFT>APPLYING',
  ]);
  it('A6-SM-1 exactly 13 of the 100 state pairs are transitions (12 + the CCP-A8 bounded DRAFT → APPLYING; merge train); APPLIED and APPLY_EXPIRED are terminal; APPLY_FAILED retries or expires', () => {
    let n = 0;
    for (const from of COMMERCIAL_CHANGE_REQUEST_STATES) {
      for (const to of COMMERCIAL_CHANGE_REQUEST_STATES) {
        const ok = canTransition(from as CommercialChangeRequestState, to as CommercialChangeRequestState);
        expect(ok, `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
        if (ok) n += 1;
      }
    }
    expect(n).toBe(13);
    expect(COMMERCIAL_TRANSITIONS.APPLIED).toEqual([]);
    expect(COMMERCIAL_TRANSITIONS.APPLY_EXPIRED).toEqual([]);
    expect(COMMERCIAL_TRANSITIONS.APPLY_FAILED).toEqual(['APPLYING', 'APPLY_EXPIRED']);
    expect(COMMERCIAL_TRANSITIONS.APPLYING).not.toContain('APPLY_EXPIRED');
  });
});

describe('CCP-A6 payload schemas of the applied actions', () => {
  const V = '019a0000-0000-7000-8000-00000000a601';
  const ok: Array<[CommercialActionType, unknown]> = [
    ['SUBSCRIPTION_OPEN', { plan_key: 'aramo-sign-included-v1', plan_version_id: V, replaces_subscription_id: null }],
    ['SUBSCRIPTION_OPEN', { plan_key: 'aramo-sign-included-v1', plan_version_id: V, replaces_subscription_id: V, period_anchor: '2026-11-01T00:00:00.000Z' }],
    ['SUBSCRIPTION_CHANGE', { subscription_id: V, plan_key: 'aramo-sign-enterprise-v1', plan_version_id: V }],
    ['SUBSCRIPTION_END', { subscription_id: V }],
    ['ENTITLEMENT_GRANT', { capabilities: ['sign'] }],
  ];
  ok.forEach(([a, p], i) => it(`A6-PL-1.${i + 1} ${a} admits ${JSON.stringify(p)}`, () => expect(validatePayload(a, p)).toEqual(p)));
  const bad: Array<[CommercialActionType, unknown]> = [
    ['SUBSCRIPTION_OPEN', {}],
    ['SUBSCRIPTION_OPEN', { plan_key: 'p', plan_version_id: V }], // replaces_subscription_id is required (null or a uuid)
    ['SUBSCRIPTION_OPEN', { plan_key: 'aramo-sign-included-v1', plan_version_id: 'v1', replaces_subscription_id: null }],
    ['SUBSCRIPTION_OPEN', { plan_key: 'aramo-sign-included-v1', plan_version_id: V, replaces_subscription_id: null, period_anchor: '2026-11-01' }],
    ['SUBSCRIPTION_OPEN', { plan_key: 'aramo-sign-included-v1', plan_version_id: V, replaces_subscription_id: null, extra: 1 }],
    ['SUBSCRIPTION_CHANGE', { plan_key: 'aramo-sign-included-v1', plan_version_id: V }],
    ['SUBSCRIPTION_END', {}],
    ['ENTITLEMENT_GRANT', { capabilities: [] }],
    ['ENTITLEMENT_GRANT', { capabilities: ['sign', 'sign'] }],
  ];
  bad.forEach(([a, p], i) => it(`A6-PL-2.${i + 1} ${a} refuses ${JSON.stringify(p)}`, () => expect(() => validatePayload(a, p)).toThrow(CommercialPayloadError)));
});

describe('CCP-A3 payload validation and checksum', () => {
  it('A3-PL-1 checksum is key-order independent and changes with content', () => {
    expect(payloadChecksum({ a: 1, b: 2 })).toBe(payloadChecksum({ b: 2, a: 1 }));
    expect(payloadChecksum({ a: 1 })).not.toBe(payloadChecksum({ a: 2 }));
  });
  const bad: Array<[CommercialActionType, unknown]> = [
    ['CREDIT', { amount_minor: -1, currency: 'USD' }],
    ['CREDIT', { amount_minor: 1.5, currency: 'USD' }],
    ['CREDIT', { amount_minor: 1, currency: 'usd' }],
    ['DISCOUNT', { discount_bps: 10_001 }],
    ['SUPPORT_EXTENSION', { requested_days: 0 }],
    ['ROLE_GRANT', { subject_user_id: 'nope', role_key: 'finance_admin' }],
    ['POLICY_ACTIVATE', {}],
    ['SUBSCRIPTION_OPEN', []],
    ['SUBSCRIPTION_OPEN', null],
  ];
  bad.forEach(([a, p], i) => it(`A3-PL-2.${i + 1} ${a} refuses ${JSON.stringify(p)}`, () => expect(() => validatePayload(a, p)).toThrow(CommercialPayloadError)));
});

describe('CCP-A3 chain satisfiability (A9 gate; per chain, never a user count)', () => {
  const steps = ESCALATED.required_chain.steps;
  const r = (user_id: string, roles: string[], scopes: string[], attested = true): RosterEntry => ({ user_id, role_keys: roles, scopes, attested });
  it('A3-SAT-1 finance + owner as two attested humans → satisfiable', () => {
    expect(checkChainSatisfiable(steps, [r(FA, ['finance_admin'], FA_SCOPES), r(PO, ['platform_owner'], PO_SCOPES)], new Set([REQUESTER])).satisfiable).toBe(true);
  });
  it('A3-SAT-2 one human holding both roles cannot satisfy a two-step chain (NC-2)', () => {
    expect(checkChainSatisfiable(steps, [r(BOTH, ['finance_admin', 'platform_owner'], PO_SCOPES)], new Set([REQUESTER]))).toMatchObject({ satisfiable: false, unfillable_steps: [1] });
  });
  it('A3-SAT-3 an unattested holder does not count (D9)', () => {
    expect(checkChainSatisfiable(steps, [r(FA, ['finance_admin'], FA_SCOPES), r(PO, ['platform_owner'], PO_SCOPES, false)], new Set([REQUESTER])).satisfiable).toBe(false);
  });
  it('A3-SAT-4 the requester does not count, even when eligible', () => {
    expect(checkChainSatisfiable(BELOW.required_chain.steps, [r(REQUESTER, ['finance_admin'], FA_SCOPES)], new Set([REQUESTER])).satisfiable).toBe(false);
  });
  it('A3-SAT-5 two users matter only if they fit: two platform_owners cannot satisfy finance → owner', () => {
    expect(checkChainSatisfiable(steps, [r(PO, ['platform_owner'], PO_SCOPES), r('u-po2', ['platform_owner'], PO_SCOPES)], new Set()).satisfiable).toBe(false);
  });
  it('A3-SAT-6 matching, not greedy: BOTH + FA satisfies (BOTH takes the owner step)', () => {
    expect(checkChainSatisfiable(steps, [r(BOTH, ['finance_admin', 'platform_owner'], PO_SCOPES), r(FA, ['finance_admin'], FA_SCOPES)], new Set()).satisfiable).toBe(true);
  });
});

describe('CCP-A3 NC-5 apply-time re-check (assertChainStillSatisfiableAtApply; ratified 2026-10-25)', () => {
  const r = (user_id: string, roles: string[], scopes: string[], attested = true): RosterEntry => ({ user_id, role_keys: roles, scopes, attested });
  const approved = { id: 'cr', state: 'APPROVED', requested_by: REQUESTER, subject_user_id: null, required_chain: ESCALATED.required_chain, approvals: [{ step_index: 0, approver_user_id: FA }, { step_index: 1, approver_user_id: PO }] };
  const roster = [r(FA, ['finance_admin'], FA_SCOPES), r(PO, ['platform_owner'], PO_SCOPES)];
  const refusal = (fn: () => void): string => {
    try {
      fn();
    } catch (e) {
      if (e instanceof CommercialApplyRefusedError) return e.reason;
      throw e;
    }
    return 'PASSED';
  };
  it('A3-APPLY-U1 every signer still eligible → passes', () => expect(refusal(() => assertChainStillSatisfiableAtApply(approved, roster))).toBe('PASSED'));
  it('A3-APPLY-U2 the owner signer lost platform_owner → APPROVER_NO_LONGER_ELIGIBLE', () =>
    expect(refusal(() => assertChainStillSatisfiableAtApply(approved, [roster[0] as RosterEntry, r(PO, [], [])]))).toBe('APPROVER_NO_LONGER_ELIGIBLE'));
  it('A3-APPLY-U3 a signer lost the D9 attestation → APPROVER_NO_LONGER_ELIGIBLE', () =>
    expect(refusal(() => assertChainStillSatisfiableAtApply(approved, [roster[0] as RosterEntry, r(PO, ['platform_owner'], PO_SCOPES, false)]))).toBe('APPROVER_NO_LONGER_ELIGIBLE'));
  it('A3-APPLY-U4 a signer left the roster → APPROVER_NO_LONGER_ELIGIBLE', () => expect(refusal(() => assertChainStillSatisfiableAtApply(approved, [roster[0] as RosterEntry]))).toBe('APPROVER_NO_LONGER_ELIGIBLE'));
  it('A3-APPLY-U5 not APPROVED (expired / rejected / pending) → NOT_APPROVED', () => {
    for (const state of ['EXPIRED', 'REJECTED', 'PENDING_APPROVAL', 'WITHDRAWN']) expect(refusal(() => assertChainStillSatisfiableAtApply({ ...approved, state }, roster))).toBe('NOT_APPROVED');
  });
  it('A3-APPLY-U6 approvals missing a step → APPROVALS_INCOMPLETE', () =>
    expect(refusal(() => assertChainStillSatisfiableAtApply({ ...approved, approvals: [{ step_index: 0, approver_user_id: FA }] }, roster))).toBe('APPROVALS_INCOMPLETE'));
  it('A3-APPLY-U7 the same user on both steps or the requester signed → APPROVER_NOT_DISTINCT', () => {
    expect(refusal(() => assertChainStillSatisfiableAtApply({ ...approved, approvals: [{ step_index: 0, approver_user_id: BOTH }, { step_index: 1, approver_user_id: BOTH }] }, roster))).toBe('APPROVER_NOT_DISTINCT');
    expect(refusal(() => assertChainStillSatisfiableAtApply({ ...approved, approvals: [{ step_index: 0, approver_user_id: REQUESTER }, { step_index: 1, approver_user_id: PO }] }, roster))).toBe('APPROVER_NOT_DISTINCT');
  });
  it('A3-APPLY-U8 the check takes no policy: revalidation is under the snapshotted chain (finance-only snapshot passes with one finance signer even if a newer policy would escalate)', () => {
    const snapshotBelow = { ...approved, required_chain: BELOW.required_chain, approvals: [{ step_index: 0, approver_user_id: FA }] };
    expect(assertChainStillSatisfiableAtApply.length).toBe(2);
    expect(refusal(() => assertChainStillSatisfiableAtApply(snapshotBelow, roster))).toBe('PASSED');
  });
});
