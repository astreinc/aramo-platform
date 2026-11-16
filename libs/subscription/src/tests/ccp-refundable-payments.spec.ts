import { describe, expect, it, vi } from 'vitest';

import type { ProviderPaymentPicture } from '../lib/billing/billing-provider.port.js';
import type { BillingStatusInvoice, BillingStatusReadService, TenantBillingStatus } from '../lib/billing/billing-status-read.service.js';
import { RefundRemainderRefusedError, type RefundRemainderGate } from '../lib/commercial/refund-remainder.gate.js';
import { REFUNDABLE_PAYMENTS_INVOICE_LIMIT, RefundablePaymentsService, refundablePaymentRow } from '../lib/commercial/refundable-payments.service.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED §2 item 1 — the refundable-payments read
// applies NO new rule: the existing refundableRemainder over the provider picture and the outstanding
// Aramo reservations. Q2 (a): an ended subscription lists nothing (NO_OPEN_SUBSCRIPTION). A failed
// provider read is a per-invoice REFUND_REMAINDER_UNVERIFIABLE with a null remainder, never a guess.

const T = new Date('2026-11-16T12:00:00.000Z');
const INV = (over: Partial<BillingStatusInvoice> = {}): BillingStatusInvoice => ({
  provider: 'STRIPE',
  invoice_ref: 'in_1',
  number: 'ARAMO-0001',
  account_ref: 'acct_1',
  subscription_ref: 'sub_1',
  provider_status: 'paid',
  currency: 'usd',
  total_minor: 1000,
  amount_due_minor: 1000,
  amount_paid_minor: 1000,
  amount_remaining_minor: 0,
  created_at: T,
  due_at: null,
  period_start: T,
  period_end: T,
  attempt_count: 1,
  next_attempt_at: null,
  hosted_url: null,
  document_url: null,
  live: true,
  payment_state: 'PAID',
  ...over,
});
const PIC = (over: Partial<ProviderPaymentPicture> = {}): ProviderPaymentPicture => ({
  provider: 'STRIPE',
  invoice_ref: 'in_1',
  account_ref: 'acct_1',
  payment_ref: 'pi_1',
  currency: 'usd',
  captured_minor: 1000,
  refunds: [],
  disputes: [],
  complete: true,
  live: true,
  ...over,
});
const STATUS = (over: Partial<TenantBillingStatus> = {}): TenantBillingStatus => ({
  tenant_id: 't1',
  product_key: 'sign',
  availability: 'AVAILABLE',
  provider: 'STRIPE',
  mode: 'live',
  subscription: { id: 'row-1', source: 'SELF_SERVICE', status: 'ACTIVE', open: true, account_ref: 'acct_1', subscription_ref: 'sub_1' },
  provider_subscription: null,
  invoices: [INV()],
  tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' },
  detail: null,
  read_at: T,
  ...over,
});

function service(status: TenantBillingStatus, readPicture: (ref: string) => Promise<ProviderPaymentPicture>, reservations: Array<{ id: string; payload: object }> = []) {
  const tenantBillingStatus = vi.fn(async () => status);
  const prisma = {
    commercialChangeRequest: { findMany: vi.fn(async () => reservations) },
    billingProviderCommand: { findMany: vi.fn(async () => []) },
  };
  const svc = new RefundablePaymentsService({ tenantBillingStatus } as unknown as BillingStatusReadService, { readPicture: vi.fn(readPicture) } as unknown as RefundRemainderGate, prisma as unknown as PrismaService);
  return { svc, tenantBillingStatus, prisma };
}

describe('refundablePaymentRow (pure)', () => {
  it('full remainder; currency upper-cased', () => {
    const r = refundablePaymentRow(INV(), 'acct_1', { picture: PIC(), outstanding: [] });
    expect(r).toMatchObject({ payment_ref: 'pi_1', currency: 'USD', remainder_minor: 1000, refunded_minor: 0, reserved_minor: 0, refusal: null });
  });
  it('provider refunds and outstanding Aramo requests reduce the remainder (counted once)', () => {
    const picture = PIC({ refunds: [{ object_ref: 're_1', amount_minor: 300, status: 'succeeded', command_id: null }] });
    const r = refundablePaymentRow(INV(), 'acct_1', { picture, outstanding: [{ change_request_id: 'cr', amount_minor: 200, command_ids: [], provider_object_refs: [] }] });
    expect(r).toMatchObject({ refunded_minor: 300, reserved_minor: 200, remainder_minor: 500, refusal: null });
  });
  it('an open dispute, another paying account, and a provider read refusal are refusals with a null remainder', () => {
    expect(refundablePaymentRow(INV(), 'acct_1', { picture: PIC({ disputes: [{ object_ref: 'dp', amount_minor: 1000, status: 'needs_response' }] }), outstanding: [] })).toMatchObject({ refusal: 'REFUND_PAYMENT_DISPUTED', remainder_minor: null });
    expect(refundablePaymentRow(INV(), 'acct_OTHER', { picture: PIC(), outstanding: [] })).toMatchObject({ refusal: 'REFUND_PAYMENT_MISMATCH', remainder_minor: null });
    expect(refundablePaymentRow(INV(), 'acct_1', { refusal: 'REFUND_REMAINDER_UNVERIFIABLE' })).toMatchObject({ refusal: 'REFUND_REMAINDER_UNVERIFIABLE', remainder_minor: null, payment_ref: null });
    expect(refundablePaymentRow(INV(), 'acct_1', { picture: PIC({ payment_ref: null }), outstanding: [] })).toMatchObject({ refusal: 'REFUND_REMAINDER_UNVERIFIABLE' });
  });
});

describe('RefundablePaymentsService.list', () => {
  it('reads the newest invoices (fixed window) and lists only paid ones with a picture each', async () => {
    const { svc, tenantBillingStatus } = service(STATUS({ invoices: [INV(), INV({ invoice_ref: 'in_2', provider_status: 'open', amount_paid_minor: 0 }), INV({ invoice_ref: 'in_3', amount_paid_minor: 0 })] }), async (ref) => PIC({ invoice_ref: ref }));
    const out = await svc.list('t1', 'sign');
    expect(tenantBillingStatus).toHaveBeenCalledWith('t1', 'sign', { invoice_limit: REFUNDABLE_PAYMENTS_INVOICE_LIMIT });
    expect(out.availability).toBe('AVAILABLE');
    expect(out.subscription_id).toBe('row-1');
    expect(out.payments.map((p) => p.invoice_ref)).toEqual(['in_1']);
    expect(out.payments[0]?.remainder_minor).toBe(1000);
  });
  it('Q2 (a): an ended subscription → NO_OPEN_SUBSCRIPTION with no payments and no provider read', async () => {
    const read = vi.fn(async () => PIC());
    const { svc } = service(STATUS({ subscription: { id: 'row-1', source: 'SELF_SERVICE', status: 'CANCELED', open: false, account_ref: 'acct_1', subscription_ref: 'sub_1' } }), read);
    const out = await svc.list('t1', 'sign');
    expect(out.availability).toBe('NO_OPEN_SUBSCRIPTION');
    expect(out.payments).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
  it('a non-AVAILABLE billing read passes through unchanged', async () => {
    const { svc } = service(STATUS({ availability: 'LIVE_MODE_HELD', subscription: null, invoices: [], detail: 'held' }), async () => PIC());
    expect(await svc.list('t1', 'sign')).toMatchObject({ availability: 'LIVE_MODE_HELD', payments: [], detail: 'held' });
  });
  it('a failed provider read is that invoice’s REFUND_REMAINDER_UNVERIFIABLE; other errors propagate', async () => {
    const { svc } = service(STATUS(), async () => {
      throw new RefundRemainderRefusedError('REFUND_REMAINDER_UNVERIFIABLE', { basis: 'provider_read_failed' });
    });
    expect((await svc.list('t1', 'sign')).payments[0]).toMatchObject({ refusal: 'REFUND_REMAINDER_UNVERIFIABLE', remainder_minor: null });
    const { svc: boom } = service(STATUS(), async () => {
      throw new Error('boom');
    });
    await expect(boom.list('t1', 'sign')).rejects.toThrow('boom');
  });
  it('an outstanding Aramo REFUND on the payment is subtracted', async () => {
    const { svc } = service(STATUS(), async () => PIC(), [{ id: 'cr-9', payload: { amount_minor: 400, provider_payment_ref: 'pi_1', provider_invoice_ref: 'in_1' } }]);
    expect((await svc.list('t1', 'sign')).payments[0]).toMatchObject({ reserved_minor: 400, remainder_minor: 600 });
  });
});
