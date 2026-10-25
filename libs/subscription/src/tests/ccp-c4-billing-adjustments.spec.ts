import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADJUSTMENT_PARAM_KEYS, BILLING_COMMAND_KINDS, BILLING_COMMAND_KINDS_BY_ACTION, adjustmentParamErrors, adjustmentRequestOf } from '../lib/billing/billing-provider-command.js';
import { StripeBillingProvider } from '../lib/billing/stripe-billing.provider.js';
import {
  ADJUSTMENT_STEP,
  AMOUNT_WITHHELD_MARKER,
  REFUND_EXECUTION_FLAG,
  adjustmentOperationOf,
  discountCouponRef,
  REFUND_AUDIT_EVENTS,
  adjustmentAuditEvent,
  refundCannotComplete,
  refundExecutionEnabled,
  refundReconciliationOutcome,
  withholdAmounts,
} from '../lib/commercial/commercial-billing-adjustment.js';
import { APPLY_EXPLANATIONS } from '../lib/commercial/commercial-apply-records.js';
import {
  COMMERCIAL_ACTIONS,
  COMMERCIAL_ACTION_TYPES,
  REFUND_CATEGORIES,
  REFUND_POLICY_REF,
  CommercialPayloadError,
  canTransitionFor,
  isApplyExpirable,
  resolveRequiredChain,
  validatePayload,
} from '../lib/commercial/commercial-change-request.js';
import type { CommercialPolicyContent } from '../lib/commercial/commercial-policy.js';
import { accountingPeriodOf, canReadFinanceAmounts, refundReportState } from '../lib/commercial/commercial-refund-report.service.js';
import { assessRefundAmount, refundableRemainder } from '../lib/commercial/refund-remainder.js';
import type { ProviderPaymentPicture } from '../lib/billing/billing-provider.port.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';

// CCP-C4 — the pure half (payloads, chains, the state mirror, the Finance amount interim, the refund
// flag) and the Stripe adapter against a STUBBED fetch (no network, no key: a `sk_test_` placeholder).
// Test IDs are cited by doc/ccp/slices/CCP-C4-acceptance.md.

const policy = seededPolicyV1().content as CommercialPolicyContent;
const U = '019a0000-0000-7000-8000-0000000c4001';

const payloadErrors = (action: Parameters<typeof validatePayload>[0], p: unknown): string[] => {
  try {
    validatePayload(action, p);
    return [];
  } catch (e) {
    return (e as CommercialPayloadError).errors as string[];
  }
};

describe('CCP-C4 pure model', () => {
  it('C4-U-1 REFUND joins the closed set (TD-C4-1) with the billing requester scope; CREDIT / DISCOUNT keep the A3 definitions', () => {
    expect(COMMERCIAL_ACTION_TYPES).toContain('REFUND');
    for (const a of ['CREDIT', 'DISCOUNT', 'REFUND'] as const) expect(COMMERCIAL_ACTIONS[a]).toEqual({ domain: 'billing', tenant_scoped: true, requester_scope: 'platform:billing:request', requester_role: null });
  });

  it('C4-U-2 payloads are closed key sets; amounts are at least one minor unit; a refund names a provider invoice and has no compensation', () => {
    expect(payloadErrors('CREDIT', { amount_minor: 1, currency: 'USD' })).toEqual([]);
    expect(payloadErrors('CREDIT', { amount_minor: 1, currency: 'USD', subscription_id: U, compensates_change_request_id: U })).toEqual([]);
    expect(payloadErrors('CREDIT', { amount_minor: 0, currency: 'USD' })).toEqual(['amount_minor must be an integer between 1 and 9007199254740991']);
    expect(payloadErrors('CREDIT', { amount_minor: 1, currency: 'USD', note: 'x' })).toEqual(['note is not a field of this action']);
    expect(payloadErrors('DISCOUNT', { discount_bps: 0 })).toEqual(['discount_bps must be an integer between 1 and 10000']);
    expect(payloadErrors('DISCOUNT', { discount_bps: 10_000 })).toEqual([]);
    expect(payloadErrors('DISCOUNT', { discount_bps: 10_001 })).toHaveLength(1);
    // CCP-C4-P: a REFUND names the invoice AND the payment, and carries its provenance (category, basis, policy ref).
    const R = { amount_minor: 5, currency: 'USD', provider_invoice_ref: 'in_abc123', provider_payment_ref: 'pi_abc123', category: 'R2_OVERCHARGE', basis: 'Billed twice for October', refund_policy_ref: 'aramo-refund-policy@v1-draft' };
    expect(payloadErrors('REFUND', R)).toEqual([]);
    expect(payloadErrors('REFUND', { ...R, provider_invoice_ref: 'ch_abc123' })).toEqual(['provider_invoice_ref must be a provider invoice id']);
    expect(payloadErrors('REFUND', { ...R, compensates_change_request_id: U })).toEqual(['compensates_change_request_id is not a field of this action']);
    expect(payloadErrors('CREDIT', { amount_minor: 1, currency: 'USD', subscription_id: 'not-a-uuid' })).toEqual(['subscription_id must be a uuid']);
  });

  it('C4-U-3 chains: thresholds are DATA from the policy, inclusive at the exact values (credit 50 000 minor USD, discount 2 000 bps); a refund is always Finance → Owner', () => {
    const rule = (a: 'CREDIT' | 'DISCOUNT' | 'REFUND', p: Record<string, unknown>, pol = policy) => resolveRequiredChain(a, p, pol).rule;
    expect(policy).toMatchObject({ credit_escalation_threshold_minor: 50_000, discount_escalation_threshold_bps: 2_000, currency: 'USD' });
    expect(rule('CREDIT', { amount_minor: 49_999, currency: 'USD' })).toBe('FINANCE_ONLY');
    expect(rule('CREDIT', { amount_minor: 50_000, currency: 'USD' })).toBe('FINANCE_THEN_OWNER');
    expect(rule('CREDIT', { amount_minor: 50_001, currency: 'USD' })).toBe('FINANCE_THEN_OWNER');
    expect(rule('DISCOUNT', { discount_bps: 1_999 })).toBe('FINANCE_ONLY');
    expect(rule('DISCOUNT', { discount_bps: 2_000 })).toBe('FINANCE_THEN_OWNER');
    expect(rule('REFUND', { amount_minor: 1, currency: 'USD' })).toBe('FINANCE_THEN_OWNER');
    expect(rule('REFUND', { amount_minor: 1, currency: 'USD' }, { ...policy, credit_escalation_threshold_minor: 1_000_000 })).toBe('FINANCE_THEN_OWNER');
    // A different policy moves the boundary (the values are never code constants).
    expect(rule('CREDIT', { amount_minor: 50_000, currency: 'USD' }, { ...policy, credit_escalation_threshold_minor: 50_001 })).toBe('FINANCE_ONLY');
    expect(rule('DISCOUNT', { discount_bps: 2_000 }, { ...policy, discount_escalation_threshold_bps: 2_001 })).toBe('FINANCE_ONLY');
  });

  it('C4-U-4 transitions mirror the guard union CCP-C4 block: the C2 apply pairs plus AD-4 expiry from APPROVED / APPLY_FAILED only', () => {
    for (const a of ['CREDIT', 'DISCOUNT', 'REFUND']) {
      expect(canTransitionFor(a, 'APPROVED', 'APPLYING')).toBe(true);
      expect(canTransitionFor(a, 'APPLY_FAILED', 'APPLYING')).toBe(true);
      expect(canTransitionFor(a, 'APPLYING', 'APPLIED')).toBe(true);
      expect(canTransitionFor(a, 'APPLYING', 'APPLY_FAILED')).toBe(true);
      expect(canTransitionFor(a, 'APPROVED', 'APPLY_EXPIRED')).toBe(true);
      expect(canTransitionFor(a, 'APPLYING', 'APPLY_EXPIRED')).toBe(false);
      expect(canTransitionFor(a, 'DRAFT', 'APPLYING')).toBe(false);
      expect(canTransitionFor(a, 'PENDING_APPROVAL', 'APPLYING')).toBe(false);
      expect(canTransitionFor(a, 'APPROVED', 'APPLIED')).toBe(false);
      expect(canTransitionFor(a, 'APPLYING', 'APPLYING', 'EXCEPTION')).toBe(false);
      expect(isApplyExpirable(a)).toBe(true);
    }
  });

  it('C4-U-5 operations, steps and the deterministic coupon: a compensation reverses its original', () => {
    expect(adjustmentOperationOf('CREDIT', { amount_minor: 1 })).toBe('CREDIT_GRANT');
    expect(adjustmentOperationOf('CREDIT', { amount_minor: 1, compensates_change_request_id: U })).toBe('CREDIT_REVERSE');
    expect(adjustmentOperationOf('DISCOUNT', { discount_bps: 1 })).toBe('DISCOUNT_APPLY');
    expect(adjustmentOperationOf('DISCOUNT', { discount_bps: 1, compensates_change_request_id: U })).toBe('DISCOUNT_REMOVE');
    expect(adjustmentOperationOf('REFUND', { amount_minor: 1 })).toBe('REFUND_CREATE');
    expect(ADJUSTMENT_STEP).toEqual({ CREDIT_GRANT: 'credit_grant', CREDIT_REVERSE: 'credit_reverse', DISCOUNT_APPLY: 'discount_apply', DISCOUNT_REMOVE: 'discount_remove', REFUND_CREATE: 'refund_create' });
    expect(discountCouponRef(U)).toBe(`aramo-ccp-${U}-discount_apply`);
    expect(BILLING_COMMAND_KINDS).toEqual(['SUBSCRIPTION_CANCEL', 'CHECKOUT_SESSION_EXPIRE', 'CREDIT_GRANT', 'CREDIT_REVERSE', 'DISCOUNT_APPLY', 'DISCOUNT_REMOVE', 'REFUND_CREATE']);
    expect(BILLING_COMMAND_KINDS_BY_ACTION).toEqual({ CONVERSION: ['SUBSCRIPTION_CANCEL', 'CHECKOUT_SESSION_EXPIRE'], CREDIT: ['CREDIT_GRANT', 'CREDIT_REVERSE'], DISCOUNT: ['DISCOUNT_APPLY', 'DISCOUNT_REMOVE'], REFUND: ['REFUND_CREATE'] });
  });

  it('C4-U-6 command params are closed per kind (TS mirror of BillingProviderCommand_c4_params_check)', () => {
    expect(adjustmentParamErrors('CREDIT_GRANT', { subscription_id: U, amount_minor: 1, currency: 'USD' })).toEqual([]);
    expect(adjustmentParamErrors('CREDIT_GRANT', { subscription_id: U, amount_minor: 0, currency: 'USD' })).toEqual(['amount_minor must be a positive integer']);
    expect(adjustmentParamErrors('DISCOUNT_REMOVE', { subscription_id: U, coupon_ref: 'c', discount_bps: 1 })).toEqual(['discount_bps is not a DISCOUNT_REMOVE param']);
    expect(adjustmentParamErrors('REFUND_CREATE', { subscription_id: U, amount_minor: 1, currency: 'USD' })).toEqual(['account_ref is required for REFUND_CREATE']);
    expect(adjustmentParamErrors('SUBSCRIPTION_CANCEL', { mode: 'IMMEDIATE' })).toEqual([]);
    expect(Object.keys(ADJUSTMENT_PARAM_KEYS)).toEqual(['CREDIT_GRANT', 'CREDIT_REVERSE', 'DISCOUNT_APPLY', 'DISCOUNT_REMOVE', 'REFUND_CREATE']);
  });

  it('C4-U-7 Finance amount interim: every amount key is removed and marked FINANCE_SCOPE_PENDING; a percentage stays; an object without amounts is unchanged', () => {
    expect(withholdAmounts({ amount_minor: 35_000, currency: 'USD', subscription_id: U })).toEqual({ currency: 'USD', subscription_id: U, amount_withheld: AMOUNT_WITHHELD_MARKER });
    expect(withholdAmounts({ amount_minor: 1, credit_escalation_threshold_minor: 50_000, escalates: false })).toEqual({ escalates: false, amount_withheld: 'FINANCE_SCOPE_PENDING' });
    expect(withholdAmounts({ discount_bps: 2_000 })).toEqual({ discount_bps: 2_000 });
  });

  it('C4-U-8 the refund designed disabled state: OFF unless the flag is exactly "1"; a stable code with an operator explanation', () => {
    expect(REFUND_EXECUTION_FLAG).toBe('CCP_REFUND_EXECUTION_ENABLED');
    expect(refundExecutionEnabled({})).toBe(false);
    expect(refundExecutionEnabled({ CCP_REFUND_EXECUTION_ENABLED: 'true' })).toBe(false);
    expect(refundExecutionEnabled({ CCP_REFUND_EXECUTION_ENABLED: '0' })).toBe(false);
    expect(refundExecutionEnabled({ CCP_REFUND_EXECUTION_ENABLED: '1' })).toBe(true);
    for (const c of ['REFUND_POLICY_NOT_APPROVED', 'TARGET_NOT_SELF_SERVICE', 'COMPENSATION_TARGET_INVALID', 'COMPENSATION_MISMATCH', 'ALREADY_COMPENSATED']) expect(APPLY_EXPLANATIONS[c]).toBeTruthy();
  });
});

describe('CCP-C4-P refund provenance and remainder (Amendment A1 RF-3…RF-5)', () => {
  const R = { amount_minor: 5, currency: 'USD', provider_invoice_ref: 'in_abc123', provider_payment_ref: 'pi_abc123', category: 'R2_OVERCHARGE', basis: 'Billed twice', refund_policy_ref: 'aramo-refund-policy@v1-draft' };
  const pic = (o: Partial<ProviderPaymentPicture> = {}): ProviderPaymentPicture => ({ provider: 'STRIPE', invoice_ref: 'in_1', account_ref: 'acct_1', payment_ref: 'pi_1', currency: 'usd', captured_minor: 100_000, refunds: [], disputes: [], complete: true, live: false, ...o });
  const expected = { account_ref: 'acct_1', payment_ref: 'pi_1', currency: 'USD' };
  const rem = (o: Partial<ProviderPaymentPicture> = {}, outstanding: Parameters<typeof refundableRemainder>[0]['outstanding'] = []) => refundableRemainder({ picture: pic(o), expected, outstanding });

  it('C4P-U-1 the eight closed categories; stable codes for an unknown category, a missing basis, a missing or malformed policy ref and a missing payment', () => {
    expect(REFUND_CATEGORIES).toEqual(['R1_DUPLICATE', 'R2_OVERCHARGE', 'R3_UNAUTHORIZED', 'R4_SERVICE_FAILURE', 'R5_COMMITMENT_CANCELLATION', 'R6_NONCOMMITTED_CANCELLATION', 'R7_GOODWILL', 'R8_TAX']);
    for (const c of REFUND_CATEGORIES) expect(payloadErrors('REFUND', { ...R, category: c })).toEqual([]);
    const code = (p: Record<string, unknown>) => payloadErrors('REFUND', p).map((x) => x.split(':')[0]);
    expect(code({ ...R, category: 'R0' })).toEqual(['REFUND_CATEGORY_INVALID']);
    expect(code({ ...R, basis: '' })).toEqual(['REFUND_BASIS_REQUIRED']);
    expect(code({ ...R, basis: 'x'.repeat(2001) })).toEqual(['REFUND_BASIS_REQUIRED']);
    const { refund_policy_ref: _r, ...noRef } = R;
    expect(code(noRef)).toEqual(['REFUND_POLICY_REF_REQUIRED']);
    expect(code({ ...R, refund_policy_ref: 'policy' })).toEqual(['REFUND_POLICY_REF_REQUIRED']);
    const { provider_payment_ref: _p, ...noPay } = R;
    expect(code(noPay)).toEqual(['REFUND_PAYMENT_REF_INVALID']);
    expect(REFUND_POLICY_REF.test('aramo-refund-policy@v1-draft')).toBe(true);
  });

  it('C4P-U-2 remainder = captured − (succeeded + pending) refunds − lost disputes − outstanding reservations, each counted once; RF-4 example', () => {
    const r = rem({ refunds: [{ object_ref: 're_1', amount_minor: 30_000, status: 'succeeded', command_id: 'c-1' }] });
    expect(r).toMatchObject({ ok: true, remainder_minor: 70_000 });
    expect(assessRefundAmount({ picture: pic({ refunds: [{ object_ref: 're_1', amount_minor: 30_000, status: 'succeeded', command_id: null }] }), expected, outstanding: [] }, 70_001)).toMatchObject({ ok: false, refusal: 'REFUND_EXCEEDS_REMAINDER' });
    expect(rem({ refunds: [{ object_ref: 're_1', amount_minor: 30_000, status: 'pending', command_id: null }, { object_ref: 're_2', amount_minor: 5_000, status: 'failed', command_id: null }] })).toMatchObject({ remainder_minor: 70_000 });
    // an uncertain held reservation (no provider refund) reserves its amount
    expect(rem({}, [{ change_request_id: 'a', amount_minor: 20_000, command_ids: ['c-9'], provider_object_refs: [] }])).toMatchObject({ remainder_minor: 80_000, local_reserved_minor: 20_000 });
    // matched by command id → once; matched by object ref → once; a mismatched amount counts the larger
    expect(rem({ refunds: [{ object_ref: 're_9', amount_minor: 20_000, status: 'succeeded', command_id: 'c-9' }] }, [{ change_request_id: 'a', amount_minor: 20_000, command_ids: ['c-9'], provider_object_refs: [] }])).toMatchObject({ remainder_minor: 80_000, provider_held_minor: 0 });
    expect(rem({ refunds: [{ object_ref: 're_9', amount_minor: 20_000, status: 'pending', command_id: null }] }, [{ change_request_id: 'a', amount_minor: 20_000, command_ids: [], provider_object_refs: ['re_9'] }])).toMatchObject({ remainder_minor: 80_000 });
    expect(rem({ refunds: [{ object_ref: 're_9', amount_minor: 15_000, status: 'succeeded', command_id: 'c-9' }] }, [{ change_request_id: 'a', amount_minor: 20_000, command_ids: ['c-9'], provider_object_refs: [] }])).toMatchObject({ remainder_minor: 80_000 });
    // lost dispute reduces; won does not
    expect(rem({ disputes: [{ object_ref: 'dp', amount_minor: 30_000, status: 'lost' }] })).toMatchObject({ remainder_minor: 70_000 });
    expect(rem({ disputes: [{ object_ref: 'dp', amount_minor: 30_000, status: 'won' }] })).toMatchObject({ remainder_minor: 100_000 });
  });

  it('C4P-U-3 refused, never guessed: open dispute, truncated list, unknown statuses, no payment, binding mismatches', () => {
    expect(rem({ disputes: [{ object_ref: 'dp', amount_minor: 1, status: 'needs_response' }] })).toMatchObject({ ok: false, refusal: 'REFUND_PAYMENT_DISPUTED' });
    expect(rem({ complete: false })).toMatchObject({ ok: false, refusal: 'REFUND_REMAINDER_UNVERIFIABLE' });
    expect(rem({ refunds: [{ object_ref: 're', amount_minor: 1, status: 'mystery', command_id: null }] })).toMatchObject({ ok: false, refusal: 'REFUND_REMAINDER_UNVERIFIABLE' });
    expect(rem({ disputes: [{ object_ref: 'dp', amount_minor: 1, status: null }] })).toMatchObject({ ok: false, refusal: 'REFUND_REMAINDER_UNVERIFIABLE' });
    expect(rem({ payment_ref: null })).toMatchObject({ ok: false, refusal: 'REFUND_REMAINDER_UNVERIFIABLE' });
    expect(rem({ payment_ref: 'pi_2' })).toMatchObject({ ok: false, refusal: 'REFUND_PAYMENT_MISMATCH' });
    expect(rem({ account_ref: 'acct_2' })).toMatchObject({ ok: false, refusal: 'REFUND_PAYMENT_MISMATCH' });
    expect(rem({ currency: 'eur' })).toMatchObject({ ok: false, refusal: 'REFUND_CURRENCY_MISMATCH' });
    // refusals carry no amount (RF-10)
    for (const x of [rem({ complete: false }), assessRefundAmount({ picture: pic(), expected, outstanding: [] }, 100_001)]) expect(JSON.stringify(x)).not.toMatch(/100000|100001/);
  });

  it('C4P-U-4 refund report projection: states, reconciliation status and the UTC accounting month', () => {
    expect(refundReportState('PENDING_APPROVAL', [], false)).toEqual({ refund_state: 'requested', reconciliation_status: 'NOT_SENT' });
    expect(refundReportState('APPROVED', [], false)).toEqual({ refund_state: 'approved', reconciliation_status: 'NOT_SENT' });
    expect(refundReportState('APPLYING', [{ state: 'PENDING_PROVIDER', confirmed_at: null }], false)).toEqual({ refund_state: 'pending', reconciliation_status: 'PENDING_PROVIDER' });
    expect(refundReportState('APPLYING', [{ state: 'FAILED', confirmed_at: null }], false)).toEqual({ refund_state: 'pending', reconciliation_status: 'COMMAND_FAILED' });
    expect(refundReportState('APPLIED', [{ state: 'CONFIRMED', confirmed_at: new Date() }], false)).toEqual({ refund_state: 'confirmed', reconciliation_status: 'CONFIRMED' });
    expect(refundReportState('APPLY_FAILED', [], false)).toEqual({ refund_state: 'failed', reconciliation_status: 'NOT_SENT' });
    expect(refundReportState('WITHDRAWN', [{ state: 'FAILED', confirmed_at: null }], true)).toEqual({ refund_state: 'reconciled', reconciliation_status: 'RESOLVED_NOT_EXECUTED' });
    expect(refundReportState('REJECTED', [], false).refund_state).toBe('closed');
    expect(accountingPeriodOf(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10');
    expect(accountingPeriodOf(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11');
    expect(accountingPeriodOf(null)).toBeNull();
    expect(canReadFinanceAmounts(['platform:billing:read'])).toBe(false);
    expect(canReadFinanceAmounts(['platform:billing:read', 'platform:billing:amount:read'])).toBe(true);
  });
});

describe('CCP-C4-R refund identity', () => {
  it('C4R-U-1 reconciliation outcomes from an authoritative read: CONFIRMED only for a succeeded refund of exactly the approved amount; NOT_FOUND and FAILED_AT_PROVIDER are the only outcomes proving no refund can still complete', () => {
    const e = (object_ref: string | null, provider_status: string | null, observed_amount_minor: number | null) => ({ object_ref, provider_status, observed_amount_minor });
    expect(refundReconciliationOutcome(e(null, null, null), 30_000)).toBe('NOT_FOUND');
    expect(refundReconciliationOutcome(e('re_1', 'succeeded', 30_000), 30_000)).toBe('CONFIRMED');
    expect(refundReconciliationOutcome(e('re_1', 'pending', 30_000), 30_000)).toBe('PENDING');
    expect(refundReconciliationOutcome(e('re_1', 'requires_action', 30_000), 30_000)).toBe('PENDING');
    expect(refundReconciliationOutcome(e('re_1', 'succeeded', 29_999), 30_000)).toBe('PARTIAL');
    expect(refundReconciliationOutcome(e('re_1', 'failed', 30_000), 30_000)).toBe('FAILED_AT_PROVIDER');
    expect(refundReconciliationOutcome(e('re_1', 'canceled', 1), 30_000)).toBe('FAILED_AT_PROVIDER');
    expect((['CONFIRMED', 'PENDING', 'PARTIAL', 'FAILED_AT_PROVIDER', 'NOT_FOUND'] as const).filter(refundCannotComplete)).toEqual(['FAILED_AT_PROVIDER', 'NOT_FOUND']);
  });

  it('C4R-U-2 REFUND has its own audit event names; the other C4 types keep COMMERCIAL_BILLING_ADJUSTMENT_*; the resolution is REFUND-only in the transition mirror', () => {
    expect(REFUND_AUDIT_EVENTS).toEqual({ PENDING_PROVIDER: 'COMMERCIAL_REFUND_PENDING_PROVIDER', CONFIRMED: 'COMMERCIAL_REFUND_CONFIRMED', REARMED: 'COMMERCIAL_REFUND_REARMED', RESOLVED_NOT_EXECUTED: 'COMMERCIAL_REFUND_RESOLVED_NOT_EXECUTED' });
    expect(adjustmentAuditEvent('REFUND', 'CONFIRMED')).toBe('COMMERCIAL_REFUND_CONFIRMED');
    expect(adjustmentAuditEvent('CREDIT', 'CONFIRMED')).toBe('COMMERCIAL_BILLING_ADJUSTMENT_CONFIRMED');
    expect(canTransitionFor('REFUND', 'APPLYING', 'WITHDRAWN')).toBe(true);
    for (const a of ['CREDIT', 'DISCOUNT', 'CONVERSION']) expect(canTransitionFor(a, 'APPLYING', 'WITHDRAWN')).toBe(false);
    expect(canTransitionFor('REFUND', 'APPLY_FAILED', 'WITHDRAWN')).toBe(false);
    expect(canTransitionFor('REFUND', 'APPROVED', 'WITHDRAWN')).toBe(false);
  });
});

describe('CCP-C4 Stripe adapter (stubbed fetch; no network)', () => {
  const env = { ...process.env };
  let calls: { method: string; url: string; body: string | undefined; idem: string | undefined }[] = [];
  let replies: Array<{ status: number; json: unknown }> = [];
  const p = new StripeBillingProvider();
  const req = (o: Partial<Parameters<typeof p.executeAdjustment>[0]> = {}) =>
    adjustmentRequestOf({ id: U, command_kind: 'CREDIT_GRANT', tenant_id: 'ten-1', target_ref: 'acct_1', params: { subscription_id: U, amount_minor: 35_000, currency: 'USD' }, ...(o as object) });

  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_c4_placeholder';
    process.env['STRIPE_API_BASE'] = 'http://stripe.c4.invalid';
    calls = [];
    replies = [];
    vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
      calls.push({ method: init.method, url, body: init.body, idem: init.headers['idempotency-key'] });
      const r = replies.shift() ?? { status: 200, json: {} };
      return { ok: r.status < 400, status: r.status, json: async () => r.json } as unknown as Response;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...env };
  });

  it('C4-U-9 credit: ONE POST of a negative balance adjustment on the account with the command key and metadata; the re-read matches by command id, amount and currency', async () => {
    replies.push({ status: 200, json: { id: 'cbtxn_1' } });
    expect(await p.executeAdjustment(req(), 'aramo-ccp-x-credit_grant')).toEqual({ object_ref: 'cbtxn_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', idem: 'aramo-ccp-x-credit_grant' });
    expect(calls[0]?.url).toMatch(/\/acct_1\/balance_transactions$/);
    expect(new URLSearchParams(calls[0]?.body)).toEqual(new URLSearchParams({ amount: '-35000', currency: 'usd', 'metadata[aramo_command_id]': U, 'metadata[tenant_id]': 'ten-1' }));
    replies.push({ status: 200, json: { data: [{ id: 'cbtxn_0', amount: -35_000, currency: 'usd', metadata: { aramo_command_id: 'other' } }, { id: 'cbtxn_1', amount: -35_000, currency: 'usd', metadata: { aramo_command_id: U, tenant_id: 'ten-1' } }] } });
    expect(await p.readAdjustmentEffect(req(), null)).toMatchObject({ object_ref: 'cbtxn_1', present: true, tenant_id: 'ten-1' });
    expect(calls[1]).toMatchObject({ method: 'GET' });
  });

  it('C4-U-10 discount: a coupon with the deterministic id (duration once) then the subscription update, both keyed; an existing coupon (a retry) is not an error; removal is a DELETE of the subscription discount', async () => {
    const r = adjustmentRequestOf({ id: U, command_kind: 'DISCOUNT_APPLY', tenant_id: 'ten-1', target_ref: 'sub_1', params: { subscription_id: U, discount_bps: 1_999, coupon_ref: 'aramo-ccp-cr-discount_apply' } });
    replies.push({ status: 400, json: { error: { message: 'Coupon already exists.' } } }, { status: 200, json: { id: 'sub_1', discount: { id: 'di_1', coupon: { id: 'aramo-ccp-cr-discount_apply' } } } });
    expect(await p.executeAdjustment(r, 'k1')).toEqual({ object_ref: 'di_1' });
    expect(calls.map((c) => [c.method, c.url.replace('http://stripe.c4.invalid', ''), c.idem])).toEqual([
      ['POST', '/v1/coupons', 'k1-coupon'],
      ['POST', '/v1/subscriptions/sub_1', 'k1'],
    ]);
    expect(new URLSearchParams(calls[0]?.body).get('percent_off')).toBe('19.99');
    expect(new URLSearchParams(calls[0]?.body).get('duration')).toBe('once');
    expect(new URLSearchParams(calls[1]?.body).get('discounts[0][coupon]')).toBe('aramo-ccp-cr-discount_apply');
    const rm = adjustmentRequestOf({ id: U, command_kind: 'DISCOUNT_REMOVE', tenant_id: 'ten-1', target_ref: 'sub_1', params: { subscription_id: U, coupon_ref: 'aramo-ccp-cr-discount_apply' } });
    await p.executeAdjustment(rm, 'k2');
    expect(calls[2]).toMatchObject({ method: 'DELETE', idem: 'k2' });
    expect(calls[2]?.url).toMatch(/\/v1\/subscriptions\/sub_1\/discount$/);
  });

  // C4-U-11 (refund: the invoice ownership read, then one keyed refund POST) lives in stripe-wire.spec.ts:
  // its fixtures are Stripe-shaped invoice objects (the vocabulary-exempt boundary spec).

  it('C4-U-12 webhook envelope: an event about a non-subscription, non-session object carries its object_ref; subscription and checkout envelopes are unchanged', () => {
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_c4';
    const sign = (body: string) => {
      const t = Math.floor(Date.now() / 1000);
      return { t, header: `t=${t},v1=${createHmac('sha256', 'whsec_c4').update(`${t}.${body}`).digest('hex')}` };
    };
    const ev = (type: string, object: Record<string, unknown>) => {
      const body = JSON.stringify({ id: 'evt_1', type, created: 1, data: { object } });
      const s = sign(body);
      return p.verifyWebhook(Buffer.from(body), s.header, s.t);
    };
    expect(ev('refund.updated', { id: 're_1' })).toEqual({ id: 'evt_1', type: 'refund.updated', created: new Date(1000), subscription_ref: null, object_ref: 're_1' });
    expect(ev('invoice.paid', { id: 'in_1', subscription: 'sub_1' })).toEqual({ id: 'evt_1', type: 'invoice.paid', created: new Date(1000), subscription_ref: 'sub_1' });
    expect(ev('checkout.session.expired', { id: 'cs_1' })).toEqual({ id: 'evt_1', type: 'checkout.session.expired', created: new Date(1000), subscription_ref: null, checkout_session_ref: 'cs_1' });
  });
});

describe('CCP-C4 module wiring', () => {
  it('C4-U-14 SubscriptionModule (and .forRoot()) binds the adjustment port and the completion ledger into the lifecycle and the command service, and provides the requester-only apply service', async () => {
    await import('reflect-metadata');
    const { Test } = await import('@nestjs/testing');
    const { SubscriptionModule } = await import('../lib/subscription.module.js');
    const { SubscriptionLifecycleService } = await import('../lib/billing/subscription-lifecycle.service.js');
    const { BillingCommandService } = await import('../lib/billing/billing-command.service.js');
    const { BILLING_PROVIDER_ADJUSTMENT_PORT } = await import('../lib/billing/billing-provider.port.js');
    const { CommercialBillingAdjustmentLedger } = await import('../lib/commercial/commercial-billing-adjustment.ledger.js');
    const { CommercialBillingAdjustmentService } = await import('../lib/commercial/commercial-billing-adjustment.service.js');
    for (const mod of [SubscriptionModule, SubscriptionModule.forRoot()]) {
      const ref = await Test.createTestingModule({ imports: [mod] }).compile();
      const lifecycle = ref.get(SubscriptionLifecycleService) as unknown as { adjustments?: unknown; adjustmentLedger?: unknown };
      expect(lifecycle.adjustments).toBeInstanceOf(StripeBillingProvider);
      expect(lifecycle.adjustmentLedger).toBeInstanceOf(CommercialBillingAdjustmentLedger);
      expect((ref.get(BillingCommandService) as unknown as { adjustments?: unknown }).adjustments).toBeInstanceOf(StripeBillingProvider);
      expect(ref.get(BILLING_PROVIDER_ADJUSTMENT_PORT)).toBeInstanceOf(StripeBillingProvider);
      expect(ref.get(CommercialBillingAdjustmentService)).toBeInstanceOf(CommercialBillingAdjustmentService);
      await ref.close();
    }
  }, 60_000); // cold Nest + module imports exceed the 5 s default under host load
});
