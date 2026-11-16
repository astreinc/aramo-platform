import { Injectable } from '@nestjs/common';

import type { ProviderPaymentPicture } from '../billing/billing-provider.port.js';
import {
  BillingStatusReadService,
  type BillingStatusAvailability,
  type BillingStatusInvoice,
} from '../billing/billing-status-read.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { type RefundRemainderRefusal, refundableRemainder } from './refund-remainder.js';
import {
  RefundRemainderGate,
  RefundRemainderRefusedError,
  refundReservations,
} from './refund-remainder.gate.js';

// Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED §2 item 1 — the READ-ONLY list of a
// tenant's refundable Stripe payments, for the console "Request refund" dialog. It applies NO new
// rule: each paid invoice of the tenant's self-service subscription is read through the existing
// RefundRemainderGate.readPicture (the provider's payment picture) and decided by the existing pure
// refundableRemainder rule against the existing outstanding Aramo REFUND reservations — the same
// rule the server runs again at create, apply and dispatch (Amendment A1 RF-3..RF-5). No write.
//
// Q2 (a): a refund binds the tenant's OPEN self-service subscription (RF-5), so with no open row the
// list is empty with availability NO_OPEN_SUBSCRIPTION (refunds after cancellation stay in the
// Stripe Dashboard under ARAMO-COM-REFUND-POL-001 §7.6). A failed provider read is reported per
// invoice as REFUND_REMAINDER_UNVERIFIABLE with a null remainder — never a guessed one.

/** At most this many newest invoices are examined (one provider read each). */
export const REFUNDABLE_PAYMENTS_INVOICE_LIMIT = 12;

export type RefundablePaymentsAvailability = BillingStatusAvailability | 'NO_OPEN_SUBSCRIPTION';

export interface RefundablePayment {
  invoice_ref: string;
  number: string | null;
  payment_ref: string | null;
  currency: string | null;
  amount_paid_minor: number;
  created_at: Date | null;
  period_start: Date | null;
  period_end: Date | null;
  /** Provider refunds (confirmed or pending) not tracked by an outstanding Aramo request. */
  refunded_minor: number | null;
  /** Outstanding Aramo REFUND requests on this payment (counted once with their provider refund). */
  reserved_minor: number | null;
  /** Funds lost to a dispute. */
  disputed_lost_minor: number | null;
  /** What a new refund may still take; null when it could not be decided. */
  remainder_minor: number | null;
  /** Why no refund can be requested on this payment (null = refundable when remainder > 0). */
  refusal: RefundRemainderRefusal | null;
  live: boolean;
}

export interface RefundablePayments {
  tenant_id: string;
  product_key: string;
  availability: RefundablePaymentsAvailability;
  mode: 'test' | 'live' | null;
  subscription_id: string | null;
  payments: RefundablePayment[];
  detail: string | null;
  read_at: Date;
}

/** Pure: one paid invoice + its picture + the reservations → the row the console shows. */
export function refundablePaymentRow(
  invoice: Pick<
    BillingStatusInvoice,
    | 'invoice_ref'
    | 'number'
    | 'currency'
    | 'amount_paid_minor'
    | 'created_at'
    | 'period_start'
    | 'period_end'
    | 'live'
  >,
  account_ref: string,
  read:
    | {
        picture: ProviderPaymentPicture;
        outstanding: Parameters<typeof refundableRemainder>[0]['outstanding'];
      }
    | { refusal: RefundRemainderRefusal },
): RefundablePayment {
  const base = {
    invoice_ref: invoice.invoice_ref,
    number: invoice.number,
    currency: invoice.currency === null ? null : invoice.currency.toUpperCase(),
    amount_paid_minor: invoice.amount_paid_minor,
    created_at: invoice.created_at,
    period_start: invoice.period_start,
    period_end: invoice.period_end,
    live: invoice.live,
  };
  const none = {
    refunded_minor: null,
    reserved_minor: null,
    disputed_lost_minor: null,
    remainder_minor: null,
  };
  if ('refusal' in read) return { ...base, payment_ref: null, ...none, refusal: read.refusal };
  const p = read.picture;
  if (p.payment_ref === null)
    return { ...base, payment_ref: null, ...none, refusal: 'REFUND_REMAINDER_UNVERIFIABLE' };
  const currency = p.currency === null ? null : p.currency.toUpperCase();
  const r = refundableRemainder({
    picture: p,
    expected: { account_ref, payment_ref: p.payment_ref, currency: currency ?? '' },
    outstanding: read.outstanding,
  });
  if (!r.ok)
    return {
      ...base,
      currency: currency ?? base.currency,
      payment_ref: p.payment_ref,
      ...none,
      refusal: r.refusal,
    };
  return {
    ...base,
    currency: currency ?? base.currency,
    payment_ref: p.payment_ref,
    refunded_minor: r.provider_held_minor,
    reserved_minor: r.local_reserved_minor,
    disputed_lost_minor: r.disputed_lost_minor,
    remainder_minor: r.remainder_minor,
    refusal: null,
  };
}

@Injectable()
export class RefundablePaymentsService {
  constructor(
    private readonly status: BillingStatusReadService,
    private readonly gate: RefundRemainderGate,
    private readonly prisma: PrismaService,
  ) {}

  async list(
    tenant_id: string,
    product_key: unknown,
    opts: { now?: Date } = {},
  ): Promise<RefundablePayments> {
    const s = await this.status.tenantBillingStatus(tenant_id, product_key, {
      invoice_limit: REFUNDABLE_PAYMENTS_INVOICE_LIMIT,
      ...(opts.now ? { now: opts.now } : {}),
    });
    const base: RefundablePayments = {
      tenant_id,
      product_key: s.product_key,
      availability: s.availability,
      mode: s.mode,
      subscription_id: s.subscription?.id ?? null,
      payments: [],
      detail: s.detail,
      read_at: s.read_at,
    };
    if (s.availability !== 'AVAILABLE' || s.subscription === null) return base;
    if (!s.subscription.open) {
      return {
        ...base,
        availability: 'NO_OPEN_SUBSCRIPTION',
        detail:
          'a refund binds the open self-service subscription; this subscription has ended (refund it in the Stripe Dashboard under the refund policy §7.6)',
      };
    }
    const account_ref = s.subscription.account_ref;
    const paid = s.invoices.filter((i) => i.provider_status === 'paid' && i.amount_paid_minor > 0);
    const payments: RefundablePayment[] = [];
    for (const inv of paid) {
      let picture: ProviderPaymentPicture;
      try {
        picture = await this.gate.readPicture(inv.invoice_ref);
      } catch (e) {
        if (e instanceof RefundRemainderRefusedError) {
          payments.push(refundablePaymentRow(inv, account_ref, { refusal: e.refusal }));
          continue;
        }
        throw e;
      }
      const outstanding =
        picture.payment_ref === null
          ? []
          : await refundReservations(this.prisma, {
              provider_payment_ref: picture.payment_ref,
              provider_invoice_ref: inv.invoice_ref,
            });
      payments.push(refundablePaymentRow(inv, account_ref, { picture, outstanding }));
    }
    return { ...base, payments };
  }
}
