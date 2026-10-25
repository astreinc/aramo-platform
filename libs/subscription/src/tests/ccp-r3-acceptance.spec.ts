import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BillingStatusReadService } from '../lib/billing/billing-status-read.service.js';
import type { BillingProviderReadPort, ProviderInvoiceState } from '../lib/billing/billing-provider.port.js';
import { entitlementGapSubject, entitlementGaps } from '../lib/billing/entitlement-subscription-gap.js';
import {
  FINANCE_AMOUNT_WITHHELD,
  MONETARY_ACTION_TYPES,
  financeAmountAccess,
  paymentFlags,
  withholdAuditPayloadAmounts,
  withholdChangeRequestAmounts,
  withholdTenantAmounts,
} from '../lib/billing/finance-amount-withholding.js';
import { CommercialPayloadError, PLAN_VERSION_ID_REQUIRED, validatePayload } from '../lib/commercial/commercial-change-request.js';
import { buildAuditCsv } from '../lib/commercial/commercial-audit-export.service.js';
import type { CommercialAuditEventRow } from '../lib/commercial/commercial-audit.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// CCP-R3 (acceptance reconciliation) — the pure halves, no database:
//   item 1  CCP-A1 Amendment A1 (LOCKED) FA-1 / FA-4 / FA-5 / FA-6: the field-authorization rule,
//           the derived booleans, the audit-export column, and the C3 service's log lines;
//   item 3  TD-A7-5: the entitlement-without-subscription rule shared by C6 and D3;
//   item 5  TD-B2-1: PLAN_RETIRE without plan_version_id is refused with a stable reason.

const HOLDER = ['platform:billing:read', 'platform:billing:amount:read'];

describe('CCP-R3 item 1 — Finance amount field authorization (CCP-A1 Amendment A1)', () => {
  it('R3-FA-1 access needs BOTH platform:billing:read and platform:billing:amount:read (billing read alone never authorizes a figure)', () => {
    expect(financeAmountAccess(HOLDER)).toBe(true);
    expect(financeAmountAccess(['platform:billing:read'])).toBe(false);
    expect(financeAmountAccess(['platform:billing:amount:read'])).toBe(false);
    expect(financeAmountAccess([])).toBe(false);
    expect(financeAmountAccess(undefined)).toBe(false);
    expect(FINANCE_AMOUNT_WITHHELD).toBe('FINANCE_SCOPE_REQUIRED');
  });

  it('R3-FA-5 without access every amount_minor is omitted (recursively) and its object carries the marker; with access a deep copy is returned; the input is never mutated; policy thresholds and catalog prices are kept', () => {
    const p = { amount_minor: 35000, currency: 'USD', basis: { amount_minor: 35000, credit_escalation_threshold_minor: 50000 }, list: [{ amount_minor: 1 }], list_price_minor: 5900 };
    const frozen = JSON.stringify(p);
    expect(withholdTenantAmounts(p, false)).toEqual({
      currency: 'USD',
      basis: { credit_escalation_threshold_minor: 50000, amount_withheld: 'FINANCE_SCOPE_REQUIRED' },
      list: [{ amount_withheld: 'FINANCE_SCOPE_REQUIRED' }],
      list_price_minor: 5900,
      amount_withheld: 'FINANCE_SCOPE_REQUIRED',
    });
    const copy = withholdTenantAmounts(p, true);
    expect(copy).toEqual(p);
    expect(copy).not.toBe(p);
    expect(JSON.stringify(p)).toBe(frozen);
    expect(withholdTenantAmounts({ discount_bps: 3000 }, false)).toEqual({ discount_bps: 3000 });
  });

  it('R3-FA-7 (TD-C4-7) the ONE change-request / audit redaction is keyed on the monetary action types CREDIT, DISCOUNT and REFUND: every amount-like key is withheld (REFUND\'s, though REFUND is not in this base); policy thresholds stay; DISCOUNT bps stay (a percentage is not a tenant amount, D-R3-7); holders get a deep copy', () => {
    expect(MONETARY_ACTION_TYPES).toEqual(['CREDIT', 'DISCOUNT', 'REFUND']);
    expect(withholdChangeRequestAmounts('CREDIT', { amount_minor: 35000, currency: 'USD' }, false)).toEqual({ currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' });
    expect(withholdChangeRequestAmounts('CREDIT', { amount_minor: 35000, currency: 'USD', credit_escalation_threshold_minor: 50000, escalates: false }, false)).toEqual({ currency: 'USD', credit_escalation_threshold_minor: 50000, escalates: false, amount_withheld: 'FINANCE_SCOPE_REQUIRED' });
    expect(withholdChangeRequestAmounts('REFUND', { refund_amount_minor: 1200, amount: 12, invoice_ref: 'in_1', currency: 'USD' }, false)).toEqual({ invoice_ref: 'in_1', currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' });
    expect(withholdChangeRequestAmounts('DISCOUNT', { discount_bps: 3000 }, false)).toEqual({ discount_bps: 3000 });
    expect(withholdChangeRequestAmounts('DISCOUNT', { discount_bps: 3000, amount_minor: 5 }, false)).toEqual({ discount_bps: 3000, amount_withheld: 'FINANCE_SCOPE_REQUIRED' });
    // A non-monetary action is untouched (fail closed on a stray amount_minor only).
    expect(withholdChangeRequestAmounts('SUBSCRIPTION_OPEN', { plan_key: 'p', plan_version_id: 'v' }, false)).toEqual({ plan_key: 'p', plan_version_id: 'v' });
    const p = { amount_minor: 35000, currency: 'USD' };
    const copy = withholdChangeRequestAmounts('CREDIT', p, true);
    expect(copy).toEqual(p);
    expect(copy).not.toBe(p);
    // The audit body is keyed on the action type it names (the A3 CREATED event).
    const created = { action_type: 'CREDIT', payload_checksum: 'x', chain_basis: { amount_minor: 35000, currency: 'USD' } };
    expect(withholdAuditPayloadAmounts(created, false)).toEqual({ action_type: 'CREDIT', payload_checksum: 'x', chain_basis: { currency: 'USD', amount_withheld: 'FINANCE_SCOPE_REQUIRED' } });
    expect(withholdAuditPayloadAmounts(created, true)).toEqual(created);
    expect(withholdAuditPayloadAmounts({ action_type: 'REFUND', amount_minor: 1 }, false)).toEqual({ action_type: 'REFUND', amount_withheld: 'FINANCE_SCOPE_REQUIRED' });
  });

  it('R3-FA-4 the derived booleans: OVERDUE → due + overdue; DUE / PAYMENT_FAILED → due; anything else → neither; two booleans only', () => {
    expect(paymentFlags(['OVERDUE'])).toEqual({ payment_due: true, payment_overdue: true });
    expect(paymentFlags(['DUE'])).toEqual({ payment_due: true, payment_overdue: false });
    expect(paymentFlags(['PAYMENT_FAILED', 'PAID'])).toEqual({ payment_due: true, payment_overdue: false });
    expect(paymentFlags(['PAID', 'VOID', 'DRAFT', 'UNCOLLECTIBLE', 'UNKNOWN'])).toEqual({ payment_due: false, payment_overdue: false });
    expect(Object.keys(paymentFlags([]))).toEqual(['payment_due', 'payment_overdue']);
  });

  it('R3-FA-1 invoice exports — the audit CSV detail column carries a CREDIT amount only with access', () => {
    const row: CommercialAuditEventRow = {
      id: '019a0000-0000-7000-8000-0000000r3e01',
      actor_id: null,
      actor_type: 'system',
      actor_role_keys: [],
      event_type: 'COMMERCIAL_CHANGE_REQUEST_CREATED',
      is_exception: false,
      tenant_id: null,
      subject: 'commercial_change_request:x',
      change_request_id: null,
      policy_version_id: '019a0000-0000-7000-8000-0000000cc201',
      payload: { action_type: 'CREDIT', chain_basis: { amount_minor: 35000, currency: 'USD' } },
      correlation_id: 'c',
      created_at: new Date('2026-10-25T00:00:00.000Z'),
    };
    const names = { actors: new Map<string, string>(), tenants: new Map<string, string>() };
    expect(buildAuditCsv([row], { ...names, amount_access: true })).toContain('35000');
    const withheld = buildAuditCsv([row], { ...names, amount_access: false });
    expect(withheld).not.toContain('35000');
    expect(withheld).toContain('FINANCE_SCOPE_REQUIRED');
    // Fail closed: no flag = no access.
    expect(buildAuditCsv([row], names)).not.toContain('35000');
  });

  describe('R3-FA-6 logs — the C3 read service never logs an amount', () => {
    afterEach(() => vi.restoreAllMocks());
    const inv = (o: Partial<ProviderInvoiceState> = {}): ProviderInvoiceState => ({
      provider: 'STRIPE',
      invoice_ref: 'in_r3',
      number: 'R3-1',
      account_ref: 'acct_other',
      subscription_ref: 'sub_r3',
      provider_status: 'open',
      currency: 'usd',
      total_minor: 987654,
      amount_due_minor: 987654,
      amount_paid_minor: 0,
      amount_remaining_minor: 987654,
      created_at: null,
      due_at: null,
      period_start: null,
      period_end: null,
      attempt_count: 0,
      next_attempt_at: null,
      hosted_url: 'https://invoice.test/in_r3',
      document_url: null,
      live: false,
      ...o,
    });
    it('a tenant-mismatched invoice is logged by ref and tenant only (no figure, currency or link)', async () => {
      const lines: string[] = [];
      vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)));
      vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
      vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void lines.push(String(m)));
      const row = { id: 'row', source: 'SELF_SERVICE', status: 'PAST_DUE', ended_at: null, billing_account_ref: 'acct_r3', billing_subscription_ref: 'sub_r3' };
      const prisma = { tenantSubscription: { findFirst: async () => row } } as unknown as PrismaService;
      const reader: BillingProviderReadPort = {
        provider: 'STRIPE',
        isConfigured: () => true,
        mode: () => 'test',
        retrieveSubscription: async () => ({ tenant_id: 't-r3', account_ref: 'acct_r3', subscription_ref: 'sub_r3', provider_status: 'past_due', current_period_start: new Date(0), current_period_end: new Date(0), cancel_at_period_end: false }) as never,
        listSubscriptionInvoices: async () => [inv()],
        retrievePortalConfiguration: async () => null,
      };
      const out = await new BillingStatusReadService(prisma, reader).tenantBillingStatus('t-r3', 'sign');
      expect(out.availability).toBe('TENANT_MISMATCH');
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const l of lines) expect(l).not.toMatch(/987654|9876\.54|usd|invoice\.test/);
    });
  });
});

describe('CCP-R3 item 3 — TD-A7-5: one entitlement-without-subscription rule (C6 report and D3 alert)', () => {
  const at = new Date('2026-10-25T12:00:00.000Z');
  const later = new Date(at.getTime() + 3_600_000);
  const earlier = new Date(at.getTime() - 1);
  const base = { products: ['sign'] as const, at };
  it('R3-GAP-1 a live sign capability with no open BASE row is a gap; core alone, or an open row of the product, is not', () => {
    expect(entitlementGaps({ ...base, entitlements: [{ tenant_id: 'a', capability: 'sign' }, { tenant_id: 'a', capability: 'core' }], open_base: [], residual: [] })).toEqual([
      { tenant_id: 'a', product_key: 'sign', capabilities: ['sign'], residual_authority: null, residual_authority_until: null },
    ]);
    expect(entitlementGaps({ ...base, entitlements: [{ tenant_id: 'a', capability: 'core' }], open_base: [], residual: [] })).toEqual([]);
    expect(entitlementGaps({ ...base, entitlements: [{ tenant_id: 'a', capability: 'sign' }], open_base: [{ tenant_id: 'a', product_key: 'sign' }], residual: [] })).toEqual([]);
  });
  it('R3-GAP-2 residual authority (half-open): grace or a live overlay after `at` bounds the gap (not the alert condition); at or before `at` it does not; the latest wins', () => {
    const g = (residual: Parameters<typeof entitlementGaps>[0]['residual']) => entitlementGaps({ ...base, entitlements: [{ tenant_id: 'a', capability: 'sign' }], open_base: [], residual })[0];
    expect(g([{ tenant_id: 'a', product_key: 'sign', kind: 'GRACE', until: later }])).toMatchObject({ residual_authority: 'GRACE', residual_authority_until: later });
    expect(g([{ tenant_id: 'a', product_key: 'sign', kind: 'GRACE', until: at }])).toMatchObject({ residual_authority: null });
    expect(g([{ tenant_id: 'a', product_key: 'sign', kind: 'SUPPORT_OVERLAY', until: earlier }])).toMatchObject({ residual_authority: null });
    expect(
      g([
        { tenant_id: 'a', product_key: 'sign', kind: 'GRACE', until: later },
        { tenant_id: 'a', product_key: 'sign', kind: 'SUPPORT_OVERLAY', until: new Date(later.getTime() + 1) },
        { tenant_id: 'b', product_key: 'sign', kind: 'GRACE', until: new Date(later.getTime() + 9) },
      ]),
    ).toMatchObject({ residual_authority: 'SUPPORT_OVERLAY' });
    expect(entitlementGapSubject({ tenant_id: 'a', product_key: 'sign' })).toBe('a:sign');
  });
});

describe('CCP-R3 item 5 — TD-B2-1: PLAN_RETIRE retires one specified plan version', () => {
  it('R3-RETIRE-1 a PLAN_RETIRE without plan_version_id (absent or null, or a whole-plan payload) is refused with the stable reason plan_version_id_required; a malformed id stays invalid_payload; a valid one passes', () => {
    for (const payload of [{}, { plan_version_id: null }, { plan_id: '019a0000-0000-7000-8000-000000000001' }]) {
      try {
        validatePayload('PLAN_RETIRE', payload);
        throw new Error('expected a refusal');
      } catch (e) {
        expect(e).toBeInstanceOf(CommercialPayloadError);
        expect((e as CommercialPayloadError).reason).toBe(PLAN_VERSION_ID_REQUIRED);
      }
    }
    try {
      validatePayload('PLAN_RETIRE', { plan_version_id: 'not-a-uuid' });
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as CommercialPayloadError).reason).toBe('invalid_payload');
    }
    expect(validatePayload('PLAN_RETIRE', { plan_version_id: '019a0000-0000-7000-8000-000000000001' })).toEqual({ plan_version_id: '019a0000-0000-7000-8000-000000000001' });
    expect(PLAN_VERSION_ID_REQUIRED).toBe('plan_version_id_required');
  });
});
