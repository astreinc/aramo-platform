import { Injectable } from '@nestjs/common';
import { recordUsage } from '@aramo/metering';
import { v7 as uuidv7 } from 'uuid';

import { billingPeriodAt, type BillingPeriod } from './billing-period.js';
import { PrismaService } from './prisma/prisma.service.js';

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

export type AllowanceUnavailableReason = 'NOT_SUBSCRIBED' | 'LIMIT_REACHED';
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
}

type PlanLookup = { ok: true; plan: ActivePlan } | { ok: false; state: UnsubscribedState };

@Injectable()
export class AllowanceService {
  constructor(private readonly prisma: PrismaService) {}

  private async activePlan(db: Tx | PrismaService, tenant_id: string, allowance_key: string, at: Date): Promise<PlanLookup> {
    const sub = await db.tenantSubscription.findFirst({
      where: { tenant_id, ended_at: null },
      include: { plan: { include: { allowances: { where: { allowance_key } } } } },
    });
    const allowance = sub?.plan.allowances[0];
    if (sub === null || sub === undefined || allowance === undefined) return { ok: false, state: 'NONE' };
    if (!subscriptionSends(sub, at)) {
      return { ok: false, state: sub.status === 'PAST_DUE' ? 'PAST_DUE' : sub.status === 'INCOMPLETE' ? 'INCOMPLETE' : 'CANCELED' };
    }
    return {
      ok: true,
      plan: { plan_key: sub.plan.key, limit: allowance.unlimited ? null : (allowance.included_quantity ?? 0), period: billingPeriodAt(sub.period_anchor, at) },
    };
  }

  private async used(db: Tx | PrismaService, tenant_id: string, allowance_key: string, period_start: Date): Promise<number> {
    return db.allowanceUsage.count({
      where: { tenant_id, allowance_key, period_start, state: { in: ['RESERVED', 'CONSUMED'] } },
    });
  }

  private statusOf(plan: ActivePlan, allowance_key: string, used: number): AllowanceStatus {
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
    };
  }

  /** Backend-owned read of the effective plan, period and consumption. */
  async getStatus(tenant_id: string, allowance_key: string, at: Date = new Date()): Promise<AllowanceReadResult> {
    const found = await this.activePlan(this.prisma, tenant_id, allowance_key, at);
    if (!found.ok) return { subscribed: false, allowance_key, state: found.state };
    const plan = found.plan;
    return this.statusOf(plan, allowance_key, await this.used(this.prisma, tenant_id, allowance_key, plan.period.start));
  }

  async reserve(input: {
    tenant_id: string;
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
      const found = await this.activePlan(tx, input.tenant_id, input.allowance_key, at);
      if (!found.ok) {
        return { ok: false, reason: 'NOT_SUBSCRIBED', status: { subscribed: false, allowance_key: input.allowance_key, state: found.state } } as const;
      }
      const plan = found.plan;
      const key = { tenant_id: input.tenant_id, allowance_key: input.allowance_key, send_key: input.send_key };
      const existing = await tx.allowanceUsage.findUnique({ where: { tenant_id_allowance_key_send_key: key } });
      if (existing !== null && existing.state !== 'RELEASED') {
        // Same send retried: never a second charge.
        const used = await this.used(tx, input.tenant_id, input.allowance_key, plan.period.start);
        return { ok: true, already: true, status: this.statusOf(plan, input.allowance_key, used) } as const;
      }
      const used = await this.used(tx, input.tenant_id, input.allowance_key, plan.period.start);
      // A1 — an unlimited plan has no ceiling; the reservation is still written
      // (metering, capacity planning, abuse detection).
      if (plan.limit !== null && used >= plan.limit) {
        return { ok: false, reason: 'LIMIT_REACHED', status: this.statusOf(plan, input.allowance_key, used) } as const;
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
      return { ok: true, already: false, status: this.statusOf(plan, input.allowance_key, used + 1) } as const;
    });
  }

  /** The provider accepted the send. Idempotent; writes the usage event once. */
  async consume(input: { tenant_id: string; allowance_key: string; send_key: string; usage_event_type: string; at?: Date }): Promise<'CONSUMED' | 'ALREADY' | 'MISSING'> {
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
  async release(input: { tenant_id: string; allowance_key: string; send_key: string; at?: Date }): Promise<boolean> {
    const n = await this.prisma.allowanceUsage.updateMany({
      where: { tenant_id: input.tenant_id, allowance_key: input.allowance_key, send_key: input.send_key, state: 'RESERVED' },
      data: { state: 'RELEASED', finalized_at: input.at ?? new Date() },
    });
    return n.count === 1;
  }

  /** RESERVED rows whose outcome is overdue; the caller resolves each one. */
  async staleReservations(tenant_id: string, allowance_key: string, at: Date = new Date()): Promise<string[]> {
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
    allowance_key: string;
    usage_event_type: string;
    outcome: (send_key: string) => Promise<'ACCEPTED' | 'NOT_ACCEPTED' | 'UNKNOWN'>;
    at?: Date;
  }): Promise<{ consumed: number; released: number; unknown: number }> {
    const tally = { consumed: 0, released: 0, unknown: 0 };
    for (const send_key of await this.staleReservations(input.tenant_id, input.allowance_key, input.at)) {
      const outcome = await input.outcome(send_key);
      const key = { tenant_id: input.tenant_id, allowance_key: input.allowance_key, send_key };
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
  async recordHistorical(input: { tenant_id: string; allowance_key: string; send_key: string; sent_at: Date }): Promise<boolean> {
    const sub = await this.prisma.tenantSubscription.findFirst({ where: { tenant_id: input.tenant_id, ended_at: null } });
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
