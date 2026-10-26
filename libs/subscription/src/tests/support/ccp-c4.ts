import { BillingCommandService } from '../../lib/billing/billing-command.service.js';
import {
  type BillingProviderAdjustmentPort,
  BillingProviderUnavailableError,
  type ProviderAdjustmentEffect,
  type ProviderAdjustmentRequest,
  type ProviderPaymentPicture,
} from '../../lib/billing/billing-provider.port.js';
import { BillingWebhookInboxService } from '../../lib/billing/billing-webhook-inbox.service.js';
import { SubscriptionLifecycleService } from '../../lib/billing/subscription-lifecycle.service.js';
import { CapacityService } from '../../lib/capacity.service.js';
import { CommercialAuditRepository } from '../../lib/commercial/commercial-audit.repository.js';
import { CommercialBillingAdjustmentLedger } from '../../lib/commercial/commercial-billing-adjustment.ledger.js';
import { CommercialBillingAdjustmentService } from '../../lib/commercial/commercial-billing-adjustment.service.js';
import { CommercialConversionLedger } from '../../lib/commercial/commercial-conversion.ledger.js';
import { CommercialConversionService } from '../../lib/commercial/commercial-conversion.service.js';
import { CommercialChangeRequestService } from '../../lib/commercial/commercial-change-request.service.js';
import { RefundRemainderGate } from '../../lib/commercial/refund-remainder.gate.js';
import { CommercialOperatorRepository } from '../../lib/commercial/commercial-operator.repository.js';
import { CommercialPolicyRepository } from '../../lib/commercial/commercial-policy.repository.js';
import type { PrismaService } from '../../lib/prisma/prisma.service.js';

import { type C1Harness, FakeStripe, type ProviderFailure, c1Harness } from './ccp-c1.js';
import { TEST_REFUND_POLICY_REF } from './ccp-dg.js';

// CCP-C4 — ONE shared harness for the C4 specs (CLAUDE.md: one shared test helper): the C1 harness
// (change requests, the fake Stripe with its no-transaction probe) with a fake that ALSO implements
// the billing-adjustment port, and the lifecycle, command service and inbox re-wired to the
// adjustment ledger exactly as SubscriptionModule binds them, plus the requester-only apply. All on
// one Prisma client; no network, no key.
//
// The fake keeps Stripe's semantics that matter here: a write with an idempotency key already seen
// returns the first result and makes NO second effect; every effect carries the command id metadata;
// reads never change state. `writes` counts every money-moving call (executeAdjustment), the oracle of
// "no money movement before the chain completes".

/** CCP-C4-P — the fake's default payment of an invoice: `pi_` + the invoice id's body. */
export function paymentRefOf(invoice_ref: string): string {
  return `pi_${invoice_ref.replace(/^in_/, '')}`;
}

/**
 * CCP-C4-P — the provenance every test REFUND payload carries. CCP-DG (RX-8): the reference is the test
 * refund-policy identity, so a REFUND raised while a test policy declaring that identity is ACTIVE is
 * bound to it; under v1 (no refund keys) it stays a proposal only.
 */
export const REFUND_PROVENANCE = { category: 'R4_SERVICE_FAILURE', basis: 'Service outage credit under section 4.2 of the order form', refund_policy_ref: TEST_REFUND_POLICY_REF } as const;
/** A complete REFUND payload for an invoice the fake knows. */
export function refundPayload(amount_minor: number, invoice_ref: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { amount_minor, currency: 'USD', provider_invoice_ref: invoice_ref, provider_payment_ref: paymentRefOf(invoice_ref), ...REFUND_PROVENANCE, ...extra };
}

interface BalanceTxn {
  id: string;
  account_ref: string;
  amount: number;
  currency: string;
  command_id: string;
  tenant_id: string;
}
interface FakeRefund {
  id: string;
  invoice_ref: string;
  amount: number;
  status: string;
  command_id: string;
  tenant_id: string;
}

export class FakeAdjustmentStripe extends FakeStripe implements BillingProviderAdjustmentPort {
  balance: BalanceTxn[] = [];
  discounts = new Map<string, { coupon_ref: string; discount_ref: string; tenant_id: string }>();
  refunds: FakeRefund[] = [];
  /** invoice_ref → the account that paid it, its payment, the amount paid and its currency (defaults: pi_<invoice>, 1 000 000 USD minor). */
  invoices = new Map<string, { account_ref: string; payment_ref?: string; amount_paid?: number; currency?: string }>();
  /** CCP-C4-P — invoice_ref → its disputes (Stripe statuses). */
  disputes = new Map<string, Array<{ status: string; amount: number }>>();
  /** CCP-C4-P — invoices whose payment-picture READ fails, or whose lists are reported truncated. */
  pictureFailures = new Set<string>();
  pictureTruncated = new Set<string>();
  /** CCP-C4-R — command ids whose provider READ fails (an uncertain reconciliation). */
  readFailures = new Set<string>();
  /** The status a new refund reports (Stripe: pending | succeeded | failed). */
  refundStatus = 'succeeded';
  adjustmentCalls: { op: 'executeAdjustment' | 'readAdjustmentEffect' | 'readPaymentPicture'; operation: string; ref: string; command_id: string; idempotency_key?: string }[] = [];
  adjustmentFailures = new Map<string, ProviderFailure>();
  /** Per command id: the next N executeAdjustment calls succeed at the provider but the response is lost. */
  lostResponses = new Map<string, number>();
  private byKey = new Map<string, { object_ref: string }>();
  private n = 0;

  /** Money-moving provider calls so far (every executeAdjustment that reached the provider). */
  get writes(): number {
    return this.adjustmentCalls.filter((c) => c.op === 'executeAdjustment').length;
  }

  async executeAdjustment(req: ProviderAdjustmentRequest, idempotency_key: string): Promise<{ object_ref: string }> {
    await this.probe(`executeAdjustment ${req.operation} ${req.target_ref}`);
    this.adjustmentCalls.push({ op: 'executeAdjustment', operation: req.operation, ref: req.target_ref, command_id: req.command_id, idempotency_key });
    const f = this.adjustmentFailures.get(req.command_id);
    if (f !== undefined && f.times > 0) {
      f.times -= 1;
      if (f.kind === 'transient') throw new BillingProviderUnavailableError('stripe POST: HTTP 503', true);
      throw new BillingProviderUnavailableError('stripe POST: invalid request', false);
    }
    const seen = this.byKey.get(idempotency_key);
    const out = seen ?? this.effect(req);
    if (seen === undefined) this.byKey.set(idempotency_key, out);
    const lost = this.lostResponses.get(req.command_id) ?? 0;
    if (lost > 0) {
      this.lostResponses.set(req.command_id, lost - 1);
      throw new BillingProviderUnavailableError('network: socket hang up', true);
    }
    return out;
  }

  private effect(req: ProviderAdjustmentRequest): { object_ref: string } {
    this.n += 1;
    switch (req.operation) {
      case 'CREDIT_GRANT':
      case 'CREDIT_REVERSE': {
        const id = `cbtxn_c4_${this.n}`;
        this.balance.push({ id, account_ref: req.target_ref, amount: (req.operation === 'CREDIT_GRANT' ? -1 : 1) * (req.amount_minor as number), currency: (req.currency as string).toLowerCase(), command_id: req.command_id, tenant_id: req.tenant_id });
        return { object_ref: id };
      }
      case 'DISCOUNT_APPLY': {
        const discount_ref = `di_c4_${this.n}`;
        this.discounts.set(req.target_ref, { coupon_ref: req.coupon_ref as string, discount_ref, tenant_id: req.tenant_id });
        return { object_ref: discount_ref };
      }
      case 'DISCOUNT_REMOVE':
        this.discounts.delete(req.target_ref);
        return { object_ref: req.target_ref };
      case 'REFUND_CREATE': {
        const inv = this.invoices.get(req.target_ref);
        if (inv === undefined || inv.account_ref !== req.account_ref) throw new BillingProviderUnavailableError('the invoice was not paid from the tenant billing account', false);
        const id = `re_c4_${this.n}`;
        this.refunds.push({ id, invoice_ref: req.target_ref, amount: req.amount_minor as number, status: this.refundStatus, command_id: req.command_id, tenant_id: req.tenant_id });
        return { object_ref: id };
      }
    }
  }

  async readAdjustmentEffect(req: ProviderAdjustmentRequest, object_ref: string | null): Promise<ProviderAdjustmentEffect> {
    await this.probe(`readAdjustmentEffect ${req.operation} ${req.target_ref}`);
    this.adjustmentCalls.push({ op: 'readAdjustmentEffect', operation: req.operation, ref: req.target_ref, command_id: req.command_id });
    if (this.readFailures.has(req.command_id)) throw new BillingProviderUnavailableError('stripe GET: HTTP 503', true);
    const base: ProviderAdjustmentEffect = { provider: 'STRIPE', operation: req.operation, object_ref: null, present: false, provider_status: null, tenant_id: null, live: false };
    switch (req.operation) {
      case 'CREDIT_GRANT':
      case 'CREDIT_REVERSE': {
        const t = this.balance.find((b) => (object_ref !== null ? b.id === object_ref : b.command_id === req.command_id));
        if (t === undefined) return base;
        const signed = (req.operation === 'CREDIT_GRANT' ? -1 : 1) * (req.amount_minor as number);
        return { ...base, object_ref: t.id, present: t.amount === signed && t.command_id === req.command_id, provider_status: 'applied', tenant_id: t.tenant_id };
      }
      case 'DISCOUNT_APPLY':
      case 'DISCOUNT_REMOVE': {
        const d = this.discounts.get(req.target_ref);
        const has = d?.coupon_ref === req.coupon_ref;
        return { ...base, object_ref: d?.discount_ref ?? (req.operation === 'DISCOUNT_REMOVE' ? req.target_ref : null), present: req.operation === 'DISCOUNT_APPLY' ? has : !has, tenant_id: d?.tenant_id ?? null };
      }
      case 'REFUND_CREATE': {
        const inv = this.invoices.get(req.target_ref);
        const committed = this.refunds.filter((x) => x.invoice_ref === req.target_ref && (x.status === 'succeeded' || x.status === 'pending')).reduce((n, x) => n + x.amount, 0);
        const facts = { refundable_remainder_minor: inv === undefined ? 0 : Math.max((inv.amount_paid ?? 1_000_000) - committed, 0), payment_currency: inv === undefined ? null : (inv.currency ?? 'usd') };
        const r = this.refunds.find((x) => (object_ref !== null ? x.id === object_ref : x.command_id === req.command_id));
        if (r === undefined) return { ...base, ...facts, observed_amount_minor: null };
        return { ...base, ...facts, object_ref: r.id, present: r.status === 'succeeded' && r.amount === req.amount_minor, provider_status: r.status, tenant_id: r.tenant_id, observed_amount_minor: r.amount };
      }
    }
  }

  /** CCP-C4-P — the payment picture of one invoice (a read; counted in adjustmentCalls). */
  async readPaymentPicture(invoice_ref: string): Promise<ProviderPaymentPicture> {
    await this.probe(`readPaymentPicture ${invoice_ref}`);
    this.adjustmentCalls.push({ op: 'readPaymentPicture', operation: 'REFUND_CREATE', ref: invoice_ref, command_id: '' });
    if (this.pictureFailures.has(invoice_ref)) throw new BillingProviderUnavailableError('stripe GET: HTTP 503', true);
    const inv = this.invoices.get(invoice_ref);
    if (inv === undefined) throw new BillingProviderUnavailableError('No such invoice', false);
    return {
      provider: 'STRIPE',
      invoice_ref,
      account_ref: inv.account_ref,
      payment_ref: inv.payment_ref ?? paymentRefOf(invoice_ref),
      currency: inv.currency ?? 'usd',
      captured_minor: inv.amount_paid ?? 1_000_000,
      refunds: this.refunds.filter((r) => r.invoice_ref === invoice_ref).map((r) => ({ object_ref: r.id, amount_minor: r.amount, status: r.status, command_id: r.command_id })),
      disputes: (this.disputes.get(invoice_ref) ?? []).map((d, i) => ({ object_ref: `dp_${String(i)}`, amount_minor: d.amount, status: d.status })),
      complete: !this.pictureTruncated.has(invoice_ref),
      live: false,
    };
  }

  adjustmentCount(op: 'executeAdjustment' | 'readAdjustmentEffect', command_id?: string): number {
    return this.adjustmentCalls.filter((c) => c.op === op && (command_id === undefined || c.command_id === command_id)).length;
  }
}

export interface C4Harness extends Omit<C1Harness, 'billing'> {
  billing: FakeAdjustmentStripe;
  adjustmentLedger: CommercialBillingAdjustmentLedger;
  adjustments: CommercialBillingAdjustmentService;
  /** CCP-C4-R (TD-C4-18) — the C2 conversion on the same services. */
  conversions: CommercialConversionService;
  /** CCP-C4-P — the refundable-remainder gate. */
  refundGate: RefundRemainderGate;
}

export function c4Harness(prisma: PrismaService, now: () => Date): C4Harness {
  const base = c1Harness(prisma, now);
  const billing = new FakeAdjustmentStripe();
  const audit = new CommercialAuditRepository(prisma);
  const policies = new CommercialPolicyRepository(prisma);
  const operators = new CommercialOperatorRepository(prisma, audit, policies);
  const adjustmentLedger = new CommercialBillingAdjustmentLedger(audit);
  // CCP-C4-P — the change-request service with the refundable-remainder gate bound (as the module does).
  const refundGate = new RefundRemainderGate(billing);
  const changeRequests = new CommercialChangeRequestService(prisma, audit, policies, operators, now, refundGate);
  const conversionLedger = new CommercialConversionLedger(audit);
  const lifecycle = new SubscriptionLifecycleService(prisma, base.allowance, billing, new CapacityService(prisma), undefined, undefined, base.orgProfile, billing, conversionLedger, billing, adjustmentLedger);
  const commands = new BillingCommandService(prisma, billing, lifecycle, billing, billing);
  const inbox = new BillingWebhookInboxService(prisma, billing, lifecycle);
  const adjustments = new CommercialBillingAdjustmentService(prisma, audit, operators, changeRequests, commands, now, lifecycle, billing, refundGate);
  const conversions = new CommercialConversionService(prisma, audit, operators, changeRequests, conversionLedger, commands, lifecycle, now);
  return { ...base, changeRequests, billing, lifecycle, commands, inbox, adjustmentLedger, adjustments, conversions, refundGate };
}
