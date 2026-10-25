import { Injectable } from '@nestjs/common';
import { recordUsage } from '@aramo/metering';
import { v7 as uuidv7 } from 'uuid';

import { billingPeriodAt, type BillingPeriod } from './billing-period.js';
import { PrismaService } from './prisma/prisma.service.js';
import { assertMeteredKeyOf, openBaseSubscription, type ProductKey } from './product-registry.js';

// Multi-Provider directive §B/§C — the tenant allowance authority.
//
// Protocol (dispatch crosses a process/DB boundary, so no distributed transaction):
//   reserve  → under a per-(tenant, allowance) advisory lock, count CONSUMED +
//              RESERVED rows of the current period; refuse at the limit, else
//              insert a RESERVED row keyed by the stable send identity.
//   consume  → RESERVED → CONSUMED once the provider ACCEPTED the send (and the
//              usage event is written to the metering stream in the same tx).
//   release  → RESERVED → RELEASED when the send definitively failed before
//              acceptance. A CONSUMED row is never released (void/decline/expiry
//              after a send still count).
// A RESERVED row past `reserved_until` stays counted until the caller resolves it
// (resolveStale), so an unknown outcome can never let the tenant exceed the limit.
// The send identity is unique per tenant/allowance: retries and duplicate events
// never charge twice.
//
// CCP-A4 (MP-A2 N-11) — every operation takes the product explicitly (a required
// ProductKey, no defaulting overload) and resolves ONLY that product's open BASE
// subscription. The allowance key must belong to that product (sign.envelopes → sign).

// Personal Free v1.1 §4 — DAILY_LIMIT_REACHED: the plan's day-window cap (a plan
// without a window row never returns it).
export type AllowanceUnavailableReason = 'NOT_SUBSCRIBED' | 'LIMIT_REACHED' | 'DAILY_LIMIT_REACHED';

/** Personal Free v1.1 §4 — the day window: any 24 hours, counted from the same ledger. */
export const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AllowanceWindowStatus {
  readonly window: 'DAY';
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  // When the oldest counted send leaves the window (null while under the cap).
  readonly next_available_at: Date | null;
}
export type AllowanceThreshold = 'OK' | 'WARNING' | 'EXHAUSTED';

export interface AllowanceStatus {
  readonly subscribed: true;
  readonly plan_key: string;
  readonly allowance_key: string;
  // A1 — null when the plan is unlimited (no numeric ceiling; usage still metered).
  readonly limit: number | null;
  readonly unlimited: boolean;
  readonly used: number;
  readonly remaining: number | null;
  readonly period_start: Date;
  readonly period_end: Date;
  readonly threshold: AllowanceThreshold;
  // Personal Free v1.1 §4 — present only when the plan has a day-window cap.
  readonly daily?: AllowanceWindowStatus;
}

// Aramo Sign launch — why a tenant cannot send: no open subscription, or the open
// one is not in a sending state (payment past due beyond grace, incomplete, ended).
export type UnsubscribedState = 'NONE' | 'PAST_DUE' | 'INCOMPLETE' | 'CANCELED';

export type AllowanceReadResult =
  | AllowanceStatus
  | { readonly subscribed: false; readonly allowance_key: string; readonly state?: UnsubscribedState };

// Aramo Sign launch — the effective-entitlement rule (Aramo authoritative):
// TRIALING / ACTIVE send; PAST_DUE sends only until its grace ends; INCOMPLETE and
// CANCELED never send. Signing of already-sent envelopes is never gated here.
export function subscriptionSends(sub: { status: string; grace_until: Date | null }, at: Date): boolean {
  if (sub.status === 'TRIALING' || sub.status === 'ACTIVE') return true;
  if (sub.status === 'PAST_DUE') return sub.grace_until !== null && sub.grace_until.getTime() > at.getTime();
  return false;
}

export type ReserveResult =
  | { readonly ok: true; readonly already: boolean; readonly status: AllowanceStatus }
  | { readonly ok: false; readonly reason: AllowanceUnavailableReason; readonly status: AllowanceReadResult };

/** Warning at 80% of the allowance, exhausted at 100%. */
export function thresholdOf(used: number, limit: number): AllowanceThreshold {
  if (used >= limit) return 'EXHAUSTED';
  if (limit > 0 && used * 5 >= limit * 4) return 'WARNING';
  return 'OK';
}

const DEFAULT_RESERVATION_TTL_MS = 10 * 60 * 1000;

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

interface ActivePlan {
  plan_key: string;
  // null = unlimited (Commercial Plans Amendment A1).
  limit: number | null;
  period: BillingPeriod;
  // Personal Free v1.1 — the day-window cap, or null when the plan has none.
  daily_limit: number | null;
}

type PlanLookup = { ok: true; plan: ActivePlan } | { ok: false; state: UnsubscribedState };

@Injectable()
export class AllowanceService {
  constructor(private readonly prisma: PrismaService) {}

  private async activePlan(db: Tx | PrismaService, tenant_id: string, product_key: ProductKey, allowance_key: string, at: Date): Promise<PlanLookup> {
    assertMeteredKeyOf(product_key, allowance_key);
    const sub = await db.tenantSubscription.findFirst({
      where: openBaseSubscription(tenant_id, product_key),
      include: { plan: { include: { allowances: { where: { allowance_key } }, allowance_windows: { where: { allowance_key, window_kind: 'DAY' } } } } },
    });
    const allowance = sub?.plan.allowances[0];
    if (sub === null || sub === undefined || allowance === undefined) return { ok: false, state: 'NONE' };
    if (!subscriptionSends(sub, at)) {
      return { ok: false, state: sub.status === 'PAST_DUE' ? 'PAST_DUE' : sub.status === 'INCOMPLETE' ? 'INCOMPLETE' : 'CANCELED' };
    }
    return {
      ok: true,
      plan: {
        plan_key: sub.plan.key,
        limit: allowance.unlimited ? null : (allowance.included_quantity ?? 0),
        period: billingPeriodAt(sub.period_anchor, at),
        daily_limit: sub.plan.allowance_windows[0]?.limit_quantity ?? null,
      },
    };
  }

  private async used(db: Tx | PrismaService, tenant_id: string, allowance_key: string, period_start: Date): Promise<number> {
    return db.allowanceUsage.count({
      where: { tenant_id, allowance_key, period_start, state: { in: ['RESERVED', 'CONSUMED'] } },
    });
  }

  /** Sends counted in the day window ending at `at` (RESERVED + CONSUMED, any period). */
  private async dailyUsage(db: Tx | PrismaService, tenant_id: string, allowance_key: string, at: Date): Promise<{ used: number; oldest: Date | null }> {
    const since = new Date(at.getTime() - DAY_WINDOW_MS);
    const rows = await db.allowanceUsage.findMany({
      where: { tenant_id, allowance_key, state: { in: ['RESERVED', 'CONSUMED'] }, reserved_at: { gt: since, lte: at } },
      select: { reserved_at: true },
      orderBy: { reserved_at: 'asc' },
    });
    return { used: rows.length, oldest: rows[0]?.reserved_at ?? null };
  }

  private windowOf(limit: number, d: { used: number; oldest: Date | null }): AllowanceWindowStatus {
    return {
      window: 'DAY',
      limit,
      used: d.used,
      remaining: Math.max(0, limit - d.used),
      next_available_at: d.used >= limit && d.oldest !== null ? new Date(d.oldest.getTime() + DAY_WINDOW_MS) : null,
    };
  }

  private statusOf(plan: ActivePlan, allowance_key: string, used: number, daily?: AllowanceWindowStatus): AllowanceStatus {
    return {
      subscribed: true,
      plan_key: plan.plan_key,
      allowance_key,
      limit: plan.limit,
      unlimited: plan.limit === null,
      used,
      remaining: plan.limit === null ? null : Math.max(0, plan.limit - used),
      period_start: plan.period.start,
      period_end: plan.period.end,
      threshold: plan.limit === null ? 'OK' : thresholdOf(used, plan.limit),
      ...(daily !== undefined ? { daily } : {}),
    };
  }

  /** Backend-owned read of the effective plan, period and consumption. */
  async getStatus(tenant_id: string, product_key: ProductKey, allowance_key: string, at: Date = new Date()): Promise<AllowanceReadResult> {
    const found = await this.activePlan(this.prisma, tenant_id, product_key, allowance_key, at);
    if (!found.ok) return { subscribed: false, allowance_key, state: found.state };
    const plan = found.plan;
    const daily = plan.daily_limit === null ? undefined : this.windowOf(plan.daily_limit, await this.dailyUsage(this.prisma, tenant_id, allowance_key, at));
    return this.statusOf(plan, allowance_key, await this.used(this.prisma, tenant_id, allowance_key, plan.period.start), daily);
  }

  async reserve(input: {
    tenant_id: string;
    product_key: ProductKey;
    allowance_key: string;
    send_key: string;
    at?: Date;
    ttl_ms?: number;
  }): Promise<ReserveResult> {
    const at = input.at ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      // Serialize every reservation for this tenant + allowance: two concurrent sends
      // at 99/100 cannot both see a free slot.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.tenant_id}:${input.allowance_key}`}, 0))`;
      const found = await this.activePlan(tx, input.tenant_id, input.product_key, input.allowance_key, at);
      if (!found.ok) {
        return { ok: false, reason: 'NOT_SUBSCRIBED', status: { subscribed: false, allowance_key: input.allowance_key, state: found.state } } as const;
      }
      const plan = found.plan;
      const key = { tenant_id: input.tenant_id, allowance_key: input.allowance_key, send_key: input.send_key };
      const existing = await tx.allowanceUsage.findUnique({ where: { tenant_id_allowance_key_send_key: key } });
      const dailyRaw =
        plan.daily_limit === null ? undefined : await this.dailyUsage(tx, input.tenant_id, input.allowance_key, at);
      const daily = plan.daily_limit === null || dailyRaw === undefined ? undefined : this.windowOf(plan.daily_limit, dailyRaw);
      const used = await this.used(tx, input.tenant_id, input.allowance_key, plan.period.start);
      if (existing !== null && existing.state !== 'RELEASED') {
        // Same send retried: never a second charge.
        return { ok: true, already: true, status: this.statusOf(plan, input.allowance_key, used, daily) } as const;
      }
      // A1 — an unlimited plan has no ceiling; the reservation is still written
      // (metering, capacity planning, abuse detection).
      if (plan.limit !== null && used >= plan.limit) {
        return { ok: false, reason: 'LIMIT_REACHED', status: this.statusOf(plan, input.allowance_key, used, daily) } as const;
      }
      // Personal Free v1.1 §4 — the day-window cap (only plans configured with one).
      if (daily !== undefined && daily.used >= daily.limit) {
        return { ok: false, reason: 'DAILY_LIMIT_REACHED', status: this.statusOf(plan, input.allowance_key, used, daily) } as const;
      }
      const reserved_until = new Date(at.getTime() + (input.ttl_ms ?? DEFAULT_RESERVATION_TTL_MS));
      if (existing !== null) {
        await tx.allowanceUsage.update({
          where: { id: existing.id },
          data: { state: 'RESERVED', period_start: plan.period.start, reserved_at: at, reserved_until, finalized_at: null },
        });
      } else {
        await tx.allowanceUsage.create({
          data: { id: uuidv7(), ...key, period_start: plan.period.start, state: 'RESERVED', reserved_at: at, reserved_until },
        });
      }
      const dailyAfter =
        plan.daily_limit === null || dailyRaw === undefined ? undefined : this.windowOf(plan.daily_limit, { used: dailyRaw.used + 1, oldest: dailyRaw.oldest ?? at });
      return { ok: true, already: false, status: this.statusOf(plan, input.allowance_key, used + 1, dailyAfter) } as const;
    });
  }

  /** The provider accepted the send. Idempotent; writes the usage event once. */
  async consume(input: { tenant_id: string; product_key: ProductKey; allowance_key: string; send_key: string; usage_event_type: string; at?: Date }): Promise<'CONSUMED' | 'ALREADY' | 'MISSING'> {
    assertMeteredKeyOf(input.product_key, input.allowance_key);
    const at = input.at ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const n = await tx.allowanceUsage.updateMany({
        where: { tenant_id: input.tenant_id, allowance_key: input.allowance_key, send_key: input.send_key, state: 'RESERVED' },
        data: { state: 'CONSUMED', finalized_at: at },
      });
      if (n.count === 1) {
        await recordUsage(tx, { tenant_id: input.tenant_id, event_type: input.usage_event_type });
        return 'CONSUMED';
      }
      const row = await tx.allowanceUsage.findUnique({
        where: { tenant_id_allowance_key_send_key: { tenant_id: input.tenant_id, allowance_key: input.allowance_key, send_key: input.send_key } },
      });
      return row?.state === 'CONSUMED' ? 'ALREADY' : 'MISSING';
    });
  }

  /** The send definitively failed before acceptance. Never releases a CONSUMED row. */
  async release(input: { tenant_id: string; product_key: ProductKey; allowance_key: string; send_key: string; at?: Date }): Promise<boolean> {
    assertMeteredKeyOf(input.product_key, input.allowance_key);
    const n = await this.prisma.allowanceUsage.updateMany({
      where: { tenant_id: input.tenant_id, allowance_key: input.allowance_key, send_key: input.send_key, state: 'RESERVED' },
      data: { state: 'RELEASED', finalized_at: input.at ?? new Date() },
    });
    return n.count === 1;
  }

  /** RESERVED rows whose outcome is overdue; the caller resolves each one. */
  async staleReservations(tenant_id: string, product_key: ProductKey, allowance_key: string, at: Date = new Date()): Promise<string[]> {
    assertMeteredKeyOf(product_key, allowance_key);
    const rows = await this.prisma.allowanceUsage.findMany({
      where: { tenant_id, allowance_key, state: 'RESERVED', reserved_until: { lt: at } },
      select: { send_key: true },
    });
    return rows.map((r) => r.send_key);
  }

  /**
   * Resolve overdue reservations against the sender's authoritative record:
   * ACCEPTED → consume, NOT_ACCEPTED → release, UNKNOWN → keep counting it.
   */
  async resolveStale(input: {
    tenant_id: string;
    product_key: ProductKey;
    allowance_key: string;
    usage_event_type: string;
    outcome: (send_key: string) => Promise<'ACCEPTED' | 'NOT_ACCEPTED' | 'UNKNOWN'>;
    at?: Date;
  }): Promise<{ consumed: number; released: number; unknown: number }> {
    const tally = { consumed: 0, released: 0, unknown: 0 };
    for (const send_key of await this.staleReservations(input.tenant_id, input.product_key, input.allowance_key, input.at)) {
      const outcome = await input.outcome(send_key);
      const key = { tenant_id: input.tenant_id, product_key: input.product_key, allowance_key: input.allowance_key, send_key };
      if (outcome === 'ACCEPTED') {
        if ((await this.consume({ ...key, usage_event_type: input.usage_event_type })) === 'CONSUMED') tally.consumed += 1;
      } else if (outcome === 'NOT_ACCEPTED') {
        if (await this.release(key)) tally.released += 1;
      } else {
        tally.unknown += 1;
      }
    }
    return tally;
  }

  /**
   * Reconcile an already-sent record (sent before metering existed) into its own
   * period. Only real sent records may be passed; nothing is invented. Idempotent.
   */
  async recordHistorical(input: { tenant_id: string; product_key: ProductKey; allowance_key: string; send_key: string; sent_at: Date }): Promise<boolean> {
    assertMeteredKeyOf(input.product_key, input.allowance_key);
    const sub = await this.prisma.tenantSubscription.findFirst({ where: openBaseSubscription(input.tenant_id, input.product_key) });
    if (sub === null) return false;
    const period = billingPeriodAt(sub.period_anchor, input.sent_at);
    const res = await this.prisma.allowanceUsage.createMany({
      data: [
        {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          allowance_key: input.allowance_key,
          send_key: input.send_key,
          period_start: period.start,
          state: 'CONSUMED',
          origin: 'HISTORICAL',
          reserved_at: input.sent_at,
          reserved_until: input.sent_at,
          finalized_at: input.sent_at,
        },
      ],
      skipDuplicates: true,
    });
    return res.count === 1;
  }
}
