import { Inject, Injectable, Optional } from '@nestjs/common';

import { BILLING_PROVIDER_ADJUSTMENT_PORT, type BillingProviderAdjustmentPort, type ProviderPaymentPicture } from '../billing/billing-provider.port.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { openBaseSubscription, type ProductKey } from '../product-registry.js';

import { type LocalRefundReservation, type RefundRemainderRefusal, assessRefundAmount } from './refund-remainder.js';

// CCP-C4-P (Amendment A1 RF-3, RF-4, RF-5) — the refundable-remainder gate, run at REFUND create, at
// apply and at dispatch:
//   readPicture  the provider's payment picture, read OUTSIDE any local transaction (PBD §12); a failed
//                read is REFUND_REMAINDER_UNVERIFIABLE (never guessed);
//   assertInTx   in the caller's transaction, under the tenant's billing lock: binds the tenant's open
//                self-service row (paying account), the payment and the currency (RF-5), loads every
//                OUTSTANDING Aramo REFUND reservation on the same payment (any tenant; APPROVED,
//                APPLYING, APPLY_FAILED), and applies the pure rule (refund-remainder.ts).
// Q14 (one open request per tenant × product) serializes REFUNDs of one tenant; the billing lock and
// the outstanding reservations serialize the rest. No amount is ever put in a refusal detail.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
type ReadClient = Pick<Tx, 'commercialChangeRequest' | 'billingProviderCommand' | 'tenantSubscription'>;

export class RefundRemainderRefusedError extends Error {
  constructor(
    readonly refusal: RefundRemainderRefusal,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`refund refused (${refusal})`);
    this.name = 'RefundRemainderRefusedError';
  }
}

export const REFUND_OUTSTANDING_STATES: readonly string[] = ['APPROVED', 'APPLYING', 'APPLY_FAILED'];

export interface RefundBinding {
  tenant_id: string;
  product_key: ProductKey;
  amount_minor: number;
  currency: string;
  provider_invoice_ref: string;
  provider_payment_ref: string;
  /** The request being decided (excluded from the reservations: it is the amount under test). */
  exclude_change_request_id?: string;
}

@Injectable()
export class RefundRemainderGate {
  constructor(@Optional() @Inject(BILLING_PROVIDER_ADJUSTMENT_PORT) private readonly port?: BillingProviderAdjustmentPort) {}

  /** Outside any local transaction. */
  async readPicture(invoice_ref: string): Promise<ProviderPaymentPicture> {
    if (this.port === undefined || !this.port.isConfigured()) throw new RefundRemainderRefusedError('REFUND_REMAINDER_UNVERIFIABLE', { basis: 'provider_not_configured' });
    try {
      return await this.port.readPaymentPicture(invoice_ref);
    } catch (e) {
      throw new RefundRemainderRefusedError('REFUND_REMAINDER_UNVERIFIABLE', { basis: 'provider_read_failed', error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }

  async reservations(client: ReadClient, b: Pick<RefundBinding, 'provider_payment_ref' | 'provider_invoice_ref' | 'exclude_change_request_id'>): Promise<LocalRefundReservation[]> {
    return refundReservations(client, b);
  }

  /** In the caller's transaction (billing lock held). Throws RefundRemainderRefusedError. */
  async assertInTx(tx: ReadClient, picture: ProviderPaymentPicture, b: RefundBinding): Promise<{ remainder_minor: number }> {
    if (picture.invoice_ref !== b.provider_invoice_ref) throw new RefundRemainderRefusedError('REFUND_PAYMENT_MISMATCH', { basis: 'invoice' });
    const row = await tx.tenantSubscription.findFirst({ where: openBaseSubscription(b.tenant_id, b.product_key), select: { source: true, billing_account_ref: true } });
    if (row === null || row.source !== 'SELF_SERVICE' || row.billing_account_ref === null) throw new RefundRemainderRefusedError('REFUND_PAYMENT_MISMATCH', { basis: 'no_self_service_account' });
    const outstanding = await this.reservations(tx, b);
    const r = assessRefundAmount({ picture, expected: { account_ref: row.billing_account_ref, payment_ref: b.provider_payment_ref, currency: b.currency }, outstanding }, b.amount_minor);
    if (!r.ok) throw new RefundRemainderRefusedError(r.refusal, r.detail);
    return { remainder_minor: r.remainder_minor };
  }
}

/** The binding a REFUND payload carries (validated by validatePayload before this is read). */
export function refundBindingOf(tenant_id: string, product_key: ProductKey, payload: Record<string, unknown>, exclude_change_request_id?: string): RefundBinding {
  return {
    tenant_id,
    product_key,
    amount_minor: Number(payload['amount_minor']),
    currency: String(payload['currency']),
    provider_invoice_ref: String(payload['provider_invoice_ref']),
    provider_payment_ref: String(payload['provider_payment_ref']),
    ...(exclude_change_request_id !== undefined ? { exclude_change_request_id } : {}),
  };
}

/** The outstanding Aramo REFUND reservations on one payment (any tenant), excluding `exclude`. */
export async function refundReservations(client: ReadClient, b: Pick<RefundBinding, 'provider_payment_ref' | 'provider_invoice_ref' | 'exclude_change_request_id'>): Promise<LocalRefundReservation[]> {
  const reqs = await client.commercialChangeRequest.findMany({
    where: {
      action_type: 'REFUND',
      state: { in: [...REFUND_OUTSTANDING_STATES] },
      OR: [{ payload: { path: ['provider_payment_ref'], equals: b.provider_payment_ref } }, { payload: { path: ['provider_invoice_ref'], equals: b.provider_invoice_ref } }],
      ...(b.exclude_change_request_id !== undefined ? { id: { not: b.exclude_change_request_id } } : {}),
    },
    select: { id: true, payload: true },
  });
  const out: LocalRefundReservation[] = [];
  for (const r of reqs) {
    const cmds = await client.billingProviderCommand.findMany({ where: { change_request_id: r.id }, select: { id: true, provider_object_ref: true } });
    out.push({
      change_request_id: r.id,
      amount_minor: Number((r.payload as Record<string, unknown>)['amount_minor']),
      command_ids: cmds.map((c) => c.id),
      provider_object_refs: cmds.map((c) => c.provider_object_ref).filter((x): x is string => x !== null),
    });
  }
  return out;
  }
