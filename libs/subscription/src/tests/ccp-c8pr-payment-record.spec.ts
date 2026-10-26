import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RosterEntry } from '../lib/commercial/commercial-approval-eligibility.js';
import {
  COMMERCIAL_ACTIONS,
  COMMERCIAL_ACTION_TYPES,
  CommercialPayloadError,
  canTransitionFor,
  resolveRequiredChain,
  validatePayload,
} from '../lib/commercial/commercial-change-request.js';
import { resolvePaymentRecordChain } from '../lib/commercial/commercial-payment-record.js';
import { addCalendarDays, calendarDateIn, isIanaTimeZone, obligationPaymentStatus, paymentStatusFlags } from '../lib/commercial/commercial-payment-terms.js';
import { MONETARY_ACTION_TYPES, withholdChangeRequestAmounts } from '../lib/billing/finance-amount-withholding.js';

// CCP-C8-PR (Aramo-CCP-Program-Build-Directive-Amendment-A2-Payment-Record-v1_0-LOCKED) — the pure half:
// catalog row 16, the payload schema (PR-5, PR-9), the payment terms (PR-1), the PR-3 chain resolution,
// PR-10 at every boundary (calendar dates in the contract timezone) and PR-11 redaction.

const SHA = 'a'.repeat(64);
const EVIDENCE = { external_invoice_ref: 'INV-2026-0042', amount_minor: 1_200_000, currency: 'USD', received_on: '2026-10-20', payment_method: 'BANK_TRANSFER', payment_reference: 'WIRE-88231', verification: 'Matched on the bank statement of 2026-10-20', evidence_documents: [{ name: 'Remittance.pdf', sha256: SHA }], origin: 'MANUAL' };
const RECORD = { operation: 'RECORD', target: { kind: 'CONTRACT_OBLIGATION', contract_ref: 'CT-2026-501', obligation_ref: 'Q2' }, ...EVIDENCE };
const PROVISIONAL = { operation: 'RECORD', target: { kind: 'PROVISIONAL_INITIAL', contract_ref: 'CT-2026-502', obligation_ref: 'INITIAL', expected_amount_minor: 1_200_000, expected_currency: 'USD' }, ...EVIDENCE };
const errorsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CommercialPayloadError) return [...e.errors];
    throw e;
  }
  return [];
};
const V = '0190aaaa-0000-7000-8000-000000000001';
const open = (payment_terms: unknown) => ({ plan_key: 'aramo-sign-enterprise-v1', plan_version_id: V, replaces_subscription_id: null, contract: { contract_ref: 'CT-2026-503', terms: ['Net 30'], documents: [], ...(payment_terms === undefined ? {} : { payment_terms }) } });
const PREPAID = { billing_mode: 'PREPAID', currency: 'USD', timezone: 'America/New_York', obligations: [{ obligation_ref: 'INITIAL', due_date: '2026-11-01', amount_minor: 1_200_000, description: 'Year 1 prepaid' }] };

describe('CCP-C8-PR PAYMENT_RECORD (pure)', () => {
  it('C8PR-U-1 catalog row 16: PAYMENT_RECORD is billing, tenant-scoped, requested through platform:payment:request (PS-6); the closed set is 16', () => {
    expect(COMMERCIAL_ACTION_TYPES).toHaveLength(16);
    expect(COMMERCIAL_ACTIONS.PAYMENT_RECORD).toEqual({ domain: 'billing', tenant_scoped: true, requester_scope: 'platform:payment:request', requester_role: null });
    // No other action reads the new scope (PS-1: it authorizes PAYMENT_RECORD only).
    expect(Object.entries(COMMERCIAL_ACTIONS).filter(([, d]) => d.requester_scope === 'platform:payment:request').map(([a]) => a)).toEqual(['PAYMENT_RECORD']);
    // PS-3: platform:billing:request still governs CREDIT / DISCOUNT / REFUND only.
    expect(Object.entries(COMMERCIAL_ACTIONS).filter(([, d]) => d.requester_scope === 'platform:billing:request').map(([a]) => a).sort()).toEqual(['CREDIT', 'DISCOUNT', 'REFUND']);
  });

  it('C8PR-U-2 the transition mirror: the A6 apply pairs + AD-4 expiry, nothing else (DB guard block "CCP-C8-PR")', () => {
    const states = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLIED', 'APPLY_FAILED', 'REJECTED', 'EXPIRED', 'WITHDRAWN', 'APPLY_EXPIRED'] as const;
    const pairs: string[] = [];
    for (const f of states) for (const t of states) if (canTransitionFor('PAYMENT_RECORD', f, t)) pairs.push(`${f}->${t}`);
    expect(pairs.sort()).toEqual(
      ['DRAFT->PENDING_APPROVAL', 'DRAFT->WITHDRAWN', 'PENDING_APPROVAL->APPROVED', 'PENDING_APPROVAL->REJECTED', 'PENDING_APPROVAL->EXPIRED', 'PENDING_APPROVAL->WITHDRAWN', 'APPROVED->APPLYING', 'APPLY_FAILED->APPLYING', 'APPLYING->APPLIED', 'APPLYING->APPLY_FAILED', 'APPROVED->APPLY_EXPIRED', 'APPLY_FAILED->APPLY_EXPIRED'].sort(),
    );
    const union = readFileSync(resolve(__dirname, '../../prisma/migrations/20261027000000_ccp_guard_union/migration.sql'), 'utf8');
    expect(union.match(/==== BEGIN CCP-C8-PR/g)).toHaveLength(2);
    expect(union.match(/==== END CCP-C8-PR/g)).toHaveLength(2);
  });

  it('C8PR-U-3 the RECORD / CORRECT payloads are closed per operation (PR-5, PR-9)', () => {
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', RECORD))).toEqual([]);
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', PROVISIONAL))).toEqual([]);
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { operation: 'CORRECT', corrects_receipt_id: V, correction: 'REPLACE', correction_reason: 'Wrong wire reference', ...EVIDENCE }))).toEqual([]);
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { operation: 'CORRECT', corrects_receipt_id: V, correction: 'VOID', correction_reason: 'Deal cancelled', no_contract_will_follow: true }))).toEqual([]);
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { ...RECORD, operation: 'FORGIVE' }))).toContain('operation must be RECORD or CORRECT');
    // PAYMENT_RECORD can never change obligations, forgive, credit or override eligibility (§2): no such field.
    for (const k of ['obligations', 'balance', 'credit_minor', 'status', 'subscription_status', 'grace_days']) {
      expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { ...RECORD, [k]: 1 }))).toContain(`${k} is not a field of this action`);
    }
    // VOID carries no evidence.
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { operation: 'CORRECT', corrects_receipt_id: V, correction: 'VOID', correction_reason: 'x', amount_minor: 1 }))).toContain('amount_minor is not a field of this action');
  });

  it('C8PR-U-4 PR-5 methods: the closed set; OTHER needs a non-empty verification; ACCT origin is reserved (PR-13)', () => {
    const { verification: _v, ...noVerification } = RECORD;
    for (const m of ['BANK_TRANSFER', 'CHEQUE', 'CARD_EXTERNAL']) expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { ...noVerification, payment_method: m }))).toEqual([]);
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { ...RECORD, payment_method: 'CRYPTO' }))).toContain('payment_method must be one of BANK_TRANSFER, CHEQUE, CARD_EXTERNAL, OTHER');
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { ...noVerification, payment_method: 'OTHER' }))).toContain('PAYMENT_VERIFICATION_REQUIRED: payment_method OTHER requires a non-empty explanation in verification');
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { ...RECORD, payment_method: 'OTHER', verification: 'Paid by an escrow agent; confirmed by phone with the agent' }))).toEqual([]);
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { ...RECORD, origin: 'ACCT' }))).toContain('PAYMENT_ORIGIN_RESERVED: origin ACCT is reserved (PR-13); only MANUAL is recorded');
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { ...RECORD, received_on: '2026-02-30' }))).toContain('received_on must be a calendar date (YYYY-MM-DD)');
    // §4.2: the provisional identity is INITIAL only.
    expect(errorsOf(() => validatePayload('PAYMENT_RECORD', { ...PROVISIONAL, target: { ...PROVISIONAL.target, obligation_ref: 'Q2' } }))).toContain('target.obligation_ref must be INITIAL (the provisional identity is prepaid INITIAL only, §4.2)');
  });

  it('C8PR-U-5 PR-1 payment terms on a contract record: required; billing_mode never assumed; POSTPAID needs its marker; PREPAID needs INITIAL; IANA timezone; grace optional', () => {
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open(PREPAID)))).toEqual([]);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open(undefined)))).toEqual(['PAYMENT_TERMS_REQUIRED: contract.payment_terms is required (billing_mode, currency, timezone, obligations; PR-1)']);
    const { billing_mode: _b, ...noMode } = PREPAID;
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open(noMode)))).toContain('BILLING_MODE_REQUIRED: contract.payment_terms.billing_mode is required (PREPAID or POSTPAID; never assumed)');
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ ...PREPAID, billing_mode: 'POSTPAID' })))).toContain(
      'POSTPAID_APPROVAL_REQUIRED: contract.payment_terms.postpaid_approval is required for POSTPAID (never inferred from a missing payment)',
    );
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ ...PREPAID, billing_mode: 'POSTPAID', postpaid_approval: { statement: 'Postpaid, net 30', evidence_ref: 'MSA §4' } })))).toEqual([]);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ ...PREPAID, postpaid_approval: { statement: 'x', evidence_ref: 'y' } })))).toContain('contract.payment_terms.postpaid_approval is carried only by a POSTPAID contract');
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ ...PREPAID, obligations: [{ ...PREPAID.obligations[0], obligation_ref: 'Q1' }] })))).toContain(
      'INITIAL_OBLIGATION_REQUIRED: contract.payment_terms.obligations must include obligation_ref INITIAL for a PREPAID contract',
    );
    for (const tz of ['EST', '+05:00', 'Mars/Olympus', '']) expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ ...PREPAID, timezone: tz }))), tz).toContain('PAYMENT_TIMEZONE_INVALID: contract.payment_terms.timezone must be an IANA time zone (e.g. America/New_York)');
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ ...PREPAID, currency: 'EUR' })))).toContain('contract.payment_terms.currency must be USD (v1)');
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ ...PREPAID, grace_days: -1 })))).toContain('contract.payment_terms.grace_days must be an integer between 0 and 3650 (absent = 0)');
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ ...PREPAID, grace_days: 0 })))).toEqual([]);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ ...PREPAID, obligations: [PREPAID.obligations[0], PREPAID.obligations[0]] })))).toContain('contract.payment_terms.obligations[1].obligation_ref repeats another obligation (unique within the contract)');
    expect(isIanaTimeZone('UTC')).toBe(true);
    expect(isIanaTimeZone('Pacific/Auckland')).toBe(true);
  });

  it('C8PR-U-6 PR-3 chain, resolved from the requester and the roster: commercial_ops → Finance; finance_admin → a different finance_admin, else the Platform Owner exception; CORRECT → Finance → Owner', () => {
    const fa = (user_id: string): RosterEntry => ({ user_id, attested: true, role_keys: ['finance_admin'], scopes: ['platform:billing:approve'] });
    const po: RosterEntry = { user_id: 'po', attested: true, role_keys: ['platform_owner'], scopes: ['platform:billing:approve'] };
    const at = new Date('2026-10-25T12:00:00Z');
    const ops = resolvePaymentRecordChain(RECORD, { user_id: 'ops', role_keys: ['commercial_ops'] }, [fa('fa1'), po], at);
    expect(ops?.rule).toBe('FINANCE_ONLY');
    expect(ops?.steps.map((s) => [s.role_key, s.scope_keys])).toEqual([['finance_admin', ['platform:billing:approve']]]);
    const fin = resolvePaymentRecordChain(RECORD, { user_id: 'fa1', role_keys: ['finance_admin'] }, [fa('fa1'), fa('fa2'), po], at);
    expect(fin?.rule).toBe('FINANCE_ONLY');
    expect(fin?.basis).toMatchObject({ requester_role: 'finance_admin', finance_chain_fulfillable: true });
    // The requester never counts as the other finance_admin; an unattested one does not either.
    const alone = resolvePaymentRecordChain(RECORD, { user_id: 'fa1', role_keys: ['finance_admin'] }, [fa('fa1'), { ...fa('fa2'), attested: false }, po], at);
    expect(alone?.rule).toBe('DISTINCT_PLATFORM_OWNER');
    expect(alone?.steps.map((s) => s.role_key)).toEqual(['platform_owner']);
    expect(alone?.basis).toMatchObject({ exception: true, finance_chain_fulfillable: false, evaluated_at: at.toISOString() });
    for (const who of [{ user_id: 'ops', role_keys: ['commercial_ops'] }, { user_id: 'fa1', role_keys: ['finance_admin'] }]) {
      const c = resolvePaymentRecordChain({ operation: 'CORRECT' }, who, [fa('fa1')], at);
      expect(c?.rule).toBe('FINANCE_THEN_OWNER');
      expect(c?.steps.map((s) => s.role_key)).toEqual(['finance_admin', 'platform_owner']);
    }
    // No defined chain for a holder of the scope with neither role (fail closed).
    expect(resolvePaymentRecordChain(RECORD, { user_id: 'x', role_keys: ['support_admin'] }, [fa('fa1')], at)).toBeNull();
    // No monetary threshold: a very large RECORD keeps the same chain.
    const big = resolvePaymentRecordChain({ ...RECORD, amount_minor: 9_000_000_000 }, { user_id: 'ops', role_keys: ['commercial_ops'] }, [fa('fa1')], at);
    expect(big?.rule).toBe('FINANCE_ONLY');
    // The generic resolver (pre-transaction default) agrees on the shape.
    expect(resolveRequiredChain('PAYMENT_RECORD', { operation: 'CORRECT' }, {} as never).rule).toBe('FINANCE_THEN_OWNER');
  });

  it('C8PR-U-7 PR-10 at every boundary: due 2026-10-25, g = 0 → DUE on the 25th, PAST_DUE from the 26th; g = 3 → DUE through the 28th; PAID whatever the date', () => {
    const o = { due_date: '2026-10-25', paid: false };
    expect(obligationPaymentStatus(o, null, '2026-10-24')).toBe('NOT_DUE');
    expect(obligationPaymentStatus(o, null, '2026-10-25')).toBe('DUE');
    expect(obligationPaymentStatus(o, null, '2026-10-26')).toBe('PAST_DUE');
    expect(obligationPaymentStatus(o, 0, '2026-10-26')).toBe('PAST_DUE');
    expect(obligationPaymentStatus(o, 3, '2026-10-28')).toBe('DUE');
    expect(obligationPaymentStatus(o, 3, '2026-10-29')).toBe('PAST_DUE');
    expect(obligationPaymentStatus({ ...o, paid: true }, 0, '2027-01-01')).toBe('PAID');
    expect(obligationPaymentStatus({ ...o, paid: true }, 0, '2026-01-01')).toBe('PAID');
    // Month and leap-year boundaries are calendar arithmetic.
    expect(addCalendarDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(paymentStatusFlags(['PAID', 'NOT_DUE'])).toEqual({ payment_due: false, payment_overdue: false });
    expect(paymentStatusFlags(['DUE'])).toEqual({ payment_due: true, payment_overdue: false });
    expect(paymentStatusFlags(['PAID', 'PAST_DUE'])).toEqual({ payment_due: true, payment_overdue: true });
  });

  it('C8PR-U-8 PR-10 timezone: "today" is the calendar date in the contract timezone, not UTC', () => {
    // 2026-10-26T03:30Z is still the 25th in New York (EDT, UTC-4) but the 26th in UTC and in Auckland.
    const instant = new Date('2026-10-26T03:30:00Z');
    expect(calendarDateIn('America/New_York', instant)).toBe('2026-10-25');
    expect(calendarDateIn('UTC', instant)).toBe('2026-10-26');
    expect(calendarDateIn('Pacific/Auckland', instant)).toBe('2026-10-26');
    const o = { due_date: '2026-10-25', paid: false };
    expect(obligationPaymentStatus(o, 0, calendarDateIn('America/New_York', instant))).toBe('DUE');
    expect(obligationPaymentStatus(o, 0, calendarDateIn('UTC', instant))).toBe('PAST_DUE');
    // Auckland reaches the 25th 13 h before UTC: 2026-10-24T11:00Z is the 25th there, NOT_DUE in UTC.
    const early = new Date('2026-10-24T11:00:00Z');
    expect(obligationPaymentStatus(o, 0, calendarDateIn('Pacific/Auckland', early))).toBe('DUE');
    expect(obligationPaymentStatus(o, 0, calendarDateIn('UTC', early))).toBe('NOT_DUE');
  });

  it('C8PR-U-9 PR-11 (W-3): PAYMENT_RECORD is a monetary action type; the received and expected amounts are withheld from a non-holder, nothing else', () => {
    expect(MONETARY_ACTION_TYPES).toContain('PAYMENT_RECORD');
    const out = withholdChangeRequestAmounts('PAYMENT_RECORD', PROVISIONAL, false);
    expect(JSON.stringify(out)).not.toMatch(/1200000|amount_minor/);
    expect(out).toMatchObject({ operation: 'RECORD', currency: 'USD', payment_method: 'BANK_TRANSFER', amount_withheld: 'FINANCE_SCOPE_REQUIRED', target: { contract_ref: 'CT-2026-502', amount_withheld: 'FINANCE_SCOPE_REQUIRED' } });
    expect(withholdChangeRequestAmounts('PAYMENT_RECORD', PROVISIONAL, true)).toEqual(PROVISIONAL);
    // A SUBSCRIPTION_OPEN's obligation amounts are withheld too (fail closed on amount_minor).
    expect(JSON.stringify(withholdChangeRequestAmounts('SUBSCRIPTION_OPEN', open(PREPAID), false))).not.toMatch(/1200000/);
  });

  it('C8PR-U-10 TenantSubscription.status is never written by the payment module (static scan; PR-10 "payment status is not access status")', () => {
    for (const f of ['commercial-payment-record.ts', 'commercial-payment-terms.ts']) {
      const src = readFileSync(resolve(__dirname, '../lib/commercial', f), 'utf8');
      expect(src, f).not.toMatch(/tenantSubscription\.(update|create|upsert|delete)|UPDATE subscription\."TenantSubscription"|INSERT INTO subscription\."TenantSubscription"/);
    }
  });
});
