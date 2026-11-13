import { Inject, Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { type PlanPriceUnit, planVersionTerms, priceUnitOf } from '../plan-version.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type ProductKey, openBaseSubscription } from '../product-registry.js';

import { BILLING_PROVIDER_SEAT_PORT, type BillingProviderSeatPort, BillingProviderUnavailableError, isWebBillingProvider } from './billing-provider.port.js';
import { BILLING_GATEWAY_REGISTRY, type BillingGatewayRegistry } from './gateway-registry.js';
import { takeBillingLock } from './governed-subscription.js';
import { MAX_SEATS, validSeatCount } from './subscription-lifecycle.service.js';

// Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) §3.2-§3.3 with Amendment A1.
//
//   seat limit   applies only while the tenant's open BASE subscription of the product is pinned to a
//                version priced per seat (price_unit SEAT) and carries a purchased quantity; the limit is
//                that quantity. Every other tenant (per-account versions, governed subscriptions without
//                a quantity) has no limit. The SEAT COUNT (S-4) lives in identity; the apps compose the two.
//   seat change  owner / admin (the caller checks O-3). Only a Stripe-billed SELF_SERVICE subscription on a
//                per-seat version (store and contract subscriptions are refused, §3.3.3 / §3.3.5).
//                  increase  the provider item quantity is raised with proration (O-2, the provider default)
//                            and the purchased seats change now.
//                  decrease  refused below the seats in use. The provider item quantity is lowered WITHOUT
//                            proration (no refund, O-2), so the next period is billed at the new quantity;
//                            Aramo keeps the paid seats as the limit until the period ends
//                            (seat_pending_quantity, applied when the provider period rolls over, and by
//                            every read once the stored period end has passed).
//                A change while a decrease is scheduled first restores the paid quantity (no proration),
//                so an increase is prorated only above the seats already paid for.
//   The provider calls run outside any DB transaction; the row is written under the billing lock after.

export type SeatChangeRefusal = 'seats_not_applicable' | 'seats_below_usage' | 'seats_unchanged';

export class SeatChangeRefusedError extends Error {
  constructor(
    readonly reason: SeatChangeRefusal,
    readonly details: Record<string, unknown> = {},
  ) {
    super(reason);
    this.name = 'SeatChangeRefusedError';
  }
}

export interface SeatState {
  /** The pinned version's price unit. */
  price_unit: PlanPriceUnit;
  /** The seats the limit applies now (null: no limit). */
  purchased: number | null;
  /** A decrease scheduled for the end of the current period, or null. */
  pending_purchased: number | null;
  /** True when the seat count may be changed online (Stripe-billed SELF_SERVICE per-seat subscription). */
  changeable: boolean;
}

export interface SeatChangeResult {
  purchased: number;
  used: number;
  pending_purchased: number | null;
  effective: 'NOW' | 'PERIOD_END';
}

type SeatRow = {
  source: string;
  billing_provider: string | null;
  billing_subscription_ref: string | null;
  current_period_end: Date | null;
  seat_quantity: number | null;
  seat_pending_quantity: number | null;
};

/** The seats the limit applies at `at`: a scheduled decrease applies once the stored period end has passed. */
export function effectivePurchasedSeats(row: Pick<SeatRow, 'current_period_end' | 'seat_quantity' | 'seat_pending_quantity'>, at: Date): number | null {
  if (row.seat_quantity === null) return null;
  if (row.seat_pending_quantity !== null && row.current_period_end !== null && at.getTime() >= row.current_period_end.getTime()) return row.seat_pending_quantity;
  return row.seat_quantity;
}

// India Billing Regions + Razorpay (directive v1.0 ruling Q7) — a Razorpay-billed (web) row changes its
// seats too, through its own gateway's seat port (the subscription's billing_provider); a store or
// contract row never does.
function changeable(row: SeatRow): boolean {
  return row.source === 'SELF_SERVICE' && isWebBillingProvider(row.billing_provider) && row.billing_subscription_ref !== null && row.seat_quantity !== null;
}

@Injectable()
export class SeatBillingService {
  constructor(
    private readonly prisma: PrismaService,
    // Bound by SubscriptionModule (the Stripe adapter). Unbound: no seat change is possible.
    @Optional() @Inject(BILLING_PROVIDER_SEAT_PORT) private readonly provider?: BillingProviderSeatPort,
    // India Billing §4.3 — the web gateways by key (Razorpay). Unbound: only the bound (Stripe) seat port.
    @Optional() @Inject(BILLING_GATEWAY_REGISTRY) private readonly gateways?: BillingGatewayRegistry,
  ) {}

  /** The seat port of the row's web gateway: the bound port for STRIPE (unchanged), else the registry's. */
  private seatPortFor(billing_provider: string | null): BillingProviderSeatPort | undefined {
    if (billing_provider === 'STRIPE' && this.provider !== undefined) return this.provider;
    if (!isWebBillingProvider(billing_provider) || this.gateways === undefined) return undefined;
    return this.gateways.seats(billing_provider) ?? undefined;
  }

  /** The tenant's seat state (null: no open subscription of the product). */
  async seatState(tenant_id: string, product_key: ProductKey, at: Date = new Date()): Promise<SeatState | null> {
    const row = await this.prisma.tenantSubscription.findFirst({ where: openBaseSubscription(tenant_id, product_key), include: { plan_version: true } });
    if (row === null) return null;
    const price_unit = priceUnitOf(planVersionTerms(row.plan_version));
    if (price_unit !== 'SEAT') return { price_unit, purchased: null, pending_purchased: null, changeable: false };
    const purchased = effectivePurchasedSeats(row, at);
    const pending = purchased !== null && row.seat_pending_quantity !== null && purchased !== row.seat_pending_quantity ? row.seat_pending_quantity : null;
    return { price_unit, purchased, pending_purchased: pending, changeable: changeable(row) };
  }

  /** The seat limit (S-3): the purchased seats, or null when the tenant has no limit. */
  async seatLimit(tenant_id: string, product_key: ProductKey, at: Date = new Date()): Promise<number | null> {
    return (await this.seatState(tenant_id, product_key, at))?.purchased ?? null;
  }

  /** O-2 / O-3 — change the purchased seats (the caller is the owner or an admin, and `used` is the S-4 count). */
  async changeSeats(input: { tenant_id: string; product_key: ProductKey; seats: number; used: number; at?: Date }): Promise<SeatChangeResult> {
    const at = input.at ?? new Date();
    if (!validSeatCount(input.seats)) throw new SeatChangeRefusedError('seats_not_applicable', { max: MAX_SEATS });
    const row = await this.prisma.tenantSubscription.findFirst({ where: openBaseSubscription(input.tenant_id, input.product_key), include: { plan_version: true } });
    if (row === null || priceUnitOf(planVersionTerms(row.plan_version)) !== 'SEAT' || !changeable(row)) throw new SeatChangeRefusedError('seats_not_applicable');
    const port = this.seatPortFor(row.billing_provider);
    if (port === undefined || !port.isConfigured()) throw new BillingProviderUnavailableError('seat changes need the billing provider');
    if (input.seats < input.used) throw new SeatChangeRefusedError('seats_below_usage', { used: input.used });
    // A decrease whose period already ended has taken effect: compare against what is in force now.
    const paid = effectivePurchasedSeats(row, at) as number;
    const pending = paid === row.seat_quantity ? row.seat_pending_quantity : null;
    if ((pending ?? paid) === input.seats) throw new SeatChangeRefusedError('seats_unchanged');
    const ref = row.billing_subscription_ref as string;
    const key = (step: string): string => `aramo-seats-${row.id}-${step}-${uuidv7()}`;
    let next: { seat_quantity: number; seat_pending_quantity: number | null };
    let effective: 'NOW' | 'PERIOD_END';
    if (input.seats >= paid) {
      // Cancel a scheduled decrease first (the paid quantity, no proration), then prorate only above it.
      if (pending !== null) await port.updateSubscriptionQuantity(ref, paid, 'none', key('restore'));
      if (input.seats > paid) await port.updateSubscriptionQuantity(ref, input.seats, 'create_prorations', key('increase'));
      next = { seat_quantity: input.seats, seat_pending_quantity: null };
      effective = 'NOW';
    } else {
      await port.updateSubscriptionQuantity(ref, input.seats, 'none', key('decrease'));
      next = { seat_quantity: paid, seat_pending_quantity: input.seats };
      effective = 'PERIOD_END';
    }
    await this.prisma.$transaction(async (tx) => {
      await takeBillingLock(tx, input.tenant_id);
      await tx.tenantSubscription.update({ where: { id: row.id }, data: next });
    });
    return { purchased: next.seat_quantity, used: input.used, pending_purchased: next.seat_pending_quantity, effective };
  }
}
