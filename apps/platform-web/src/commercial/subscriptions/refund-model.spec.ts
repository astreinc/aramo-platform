import { describe, expect, it } from 'vitest';

import { activeRefundPolicyRef, moneyLabel, parseAmount, paymentBlockedWhy, refundDraftError, refundPayload, type RefundDraft } from './refund-model';
import type { RefundablePayment } from './subscriptions-api';
import { tenantActions } from './subscriptions-model';
import { STRIPE_ROW, NOW, product } from './subscriptions-test-data';

// Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED §2 item 5 — the pure dialog model.

const PAY = (over: Partial<RefundablePayment> = {}): RefundablePayment => ({
  invoice_ref: 'in_1abc',
  number: 'ARAMO-0001',
  payment_ref: 'pi_1abc',
  currency: 'USD',
  amount_paid_minor: 1000,
  created_at: '2026-11-15T10:00:00.000Z',
  period_start: '2026-11-15T10:00:00.000Z',
  period_end: '2026-12-15T10:00:00.000Z',
  refunded_minor: 0,
  reserved_minor: 0,
  disputed_lost_minor: 0,
  remainder_minor: 1000,
  refusal: null,
  live: true,
  ...over,
});
const DRAFT = (over: Partial<RefundDraft> = {}): RefundDraft => ({ payment: PAY(), amountText: '10.00', category: 'R7_GOODWILL', basis: 'launch proof', ...over });
const REF = 'ARAMO-COM-REFUND-POL-001@1.0';

describe('refund-model', () => {
  it('parseAmount: two-decimal amounts only', () => {
    expect(parseAmount('10')).toBe(1000);
    expect(parseAmount('10.5')).toBe(1050);
    expect(parseAmount(' 0.01 ')).toBe(1);
    for (const bad of ['', '-1', '1.234', 'abc', '1,000']) expect(parseAmount(bad), bad).toBeNull();
  });

  it('moneyLabel', () => {
    expect(moneyLabel(1000, 'USD')).toBe('$10.00');
    expect(moneyLabel(99900, 'inr')).toBe('₹999.00');
    expect(moneyLabel(null, 'USD')).toBe('—');
  });

  it('paymentBlockedWhy: refusal, unverifiable, nothing left', () => {
    expect(paymentBlockedWhy(PAY())).toBeNull();
    expect(paymentBlockedWhy(PAY({ refusal: 'REFUND_PAYMENT_DISPUTED', remainder_minor: null }))).toMatch(/dispute/);
    expect(paymentBlockedWhy(PAY({ payment_ref: null, remainder_minor: null }))).toMatch(/couldn’t confirm/);
    expect(paymentBlockedWhy(PAY({ remainder_minor: 0 }))).toMatch(/fully refunded/);
  });

  it('refundDraftError: bounds, category, basis', () => {
    expect(refundDraftError(DRAFT())).toBeNull();
    expect(refundDraftError(DRAFT({ payment: null }))).toBe('Choose a payment.');
    expect(refundDraftError(DRAFT({ amountText: '0' }))).toMatch(/at least/);
    expect(refundDraftError(DRAFT({ amountText: '10.01' }))).toMatch(/most that can be refunded is \$10\.00/);
    expect(refundDraftError(DRAFT({ category: '' }))).toMatch(/category/);
    expect(refundDraftError(DRAFT({ basis: '  ' }))).toMatch(/basis/);
    expect(refundDraftError(DRAFT({ basis: 'x'.repeat(2001) }))).toMatch(/2000/);
  });

  it('refundPayload: exactly the server closed REFUND key set; ref from the policy', () => {
    const p = refundPayload(DRAFT({ amountText: '4.50' }), REF, 'sub-1');
    expect(p).toEqual({
      amount_minor: 450,
      currency: 'USD',
      provider_invoice_ref: 'in_1abc',
      provider_payment_ref: 'pi_1abc',
      category: 'R7_GOODWILL',
      basis: 'launch proof',
      refund_policy_ref: REF,
      subscription_id: 'sub-1',
    });
    expect(Object.keys(refundPayload(DRAFT(), REF, null) ?? {}).sort()).toEqual(['amount_minor', 'basis', 'category', 'currency', 'provider_invoice_ref', 'provider_payment_ref', 'refund_policy_ref']);
    expect(refundPayload(DRAFT({ amountText: '11' }), REF, null)).toBeNull();
  });

  it('activeRefundPolicyRef: only an ACTIVE policy that enables refunds', () => {
    const v = (status: string, content: object | null) => ({ id: status, status, content });
    expect(activeRefundPolicyRef({ versions: [v('ACTIVE', { refund_execution_enabled: true, refund_policy_ref: REF })], active_version_id: 'ACTIVE' })).toBe(REF);
    expect(activeRefundPolicyRef({ versions: [v('ACTIVE', { refund_execution_enabled: false, refund_policy_ref: REF })], active_version_id: 'ACTIVE' })).toBeNull();
    expect(activeRefundPolicyRef({ versions: [v('ACTIVE', {})], active_version_id: 'ACTIVE' })).toBeNull();
    expect(activeRefundPolicyRef({ versions: [v('DRAFT', { refund_execution_enabled: true, refund_policy_ref: REF })], active_version_id: null })).toBeNull();
    expect(activeRefundPolicyRef(null)).toBeNull();
  });

  it('tenantActions: "Request refund…" only on an open self-service row, for a refund requester, with a policy ref', () => {
    const base = { tenantKind: 'BUSINESS', canSubscription: false, canEntitlement: false, canSupport: false, human: true, now: NOW };
    const self = product({ subscription: STRIPE_ROW() });
    const keys = (refund?: { canRequest: boolean; policyRef: string | null }, p = self) => tenantActions({ ...base, product: p, ...(refund ? { refund } : {}) }).map((a) => a.key);
    expect(keys({ canRequest: true, policyRef: REF })).toContain('refund');
    expect(keys({ canRequest: true, policyRef: null })).not.toContain('refund');
    expect(keys({ canRequest: false, policyRef: REF })).not.toContain('refund');
    expect(keys()).not.toContain('refund');
    expect(keys({ canRequest: true, policyRef: REF }, product())).not.toContain('refund');
  });
});
