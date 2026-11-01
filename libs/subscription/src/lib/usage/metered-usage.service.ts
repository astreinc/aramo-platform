import { Inject, Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { subscriptionSends } from '../allowance.service.js';
import { billingPeriodAt } from '../billing-period.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { openBaseSubscription, type ProductKey } from '../product-registry.js';

import { METERED_UNIT_KEYS, type MeteredUnitKey, isMeteredUnitKey, productOfMeteredUnit, usageBillingEnabled } from './metered-units.js';
import type {
  UsageCheckInput,
  UsageCheckResult,
  UsageRecordInput,
  UsageRecordResult,
  UsageRecorder,
  UsageRefusal,
  UsageRefusalReason,
} from './usage-recorder.port.js';

// Sign usage / metered billing (Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §3 item 2,
// §5 D-2; Amendment A1 §A1.1) — the UsageRecorder implementation, the period aggregation and the
// tenant-visible usage view.
//
//   check / record   the fail-closed gate and the append-only, idempotent ledger write (see
//                    usage-recorder.port.ts for the caller contract). The price, the plan version
//                    and the billing period come from the tenant's OPEN BASE subscription of the
//                    unit's product and its PINNED version (grandfathering, MP-A2 N-18); the
//                    caller never supplies a price. The ledger INSERT trigger re-checks that the
//                    unit is sold on that version at exactly that price.
//   periodSummary    the period aggregation: the tenant's usage per unit in one billing period
//                    (sum of quantity and of the snapshotted amounts) plus every unit sold on the
//                    pinned version. Read only, derived from the ledger.
//   provider report  each new entry gets a PENDING UsageProviderReport row in the same
//                    transaction; UsageProviderReportService delivers it (behind the flag).
//
// Built dark: SIGN_USAGE_BILLING_ENABLED unset ⇒ check and record refuse USAGE_BILLING_DISABLED,
// and no unit is priced on any version until a priced version is published (PLAN_VERSION_PUBLISH).

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** The provider accepts usage up to 35 days old; Aramo records within the same window. */
export const USAGE_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
/** Clock skew tolerated for an occurred_at in the future. */
export const USAGE_MAX_FUTURE_MS = 5 * 60 * 1000;
export const USAGE_MAX_QUANTITY = 100_000;

export interface UsageSummaryUnit {
  readonly unit_key: string;
  readonly name: string;
  readonly quantity_label: string;
  readonly quantity: number;
  /** The unit price on the pinned version; null = not sold on it (usage may still show if it was sold earlier). */
  readonly unit_price_minor: number | null;
  readonly amount_minor: number;
}

export interface UsageSummary {
  readonly product_key: ProductKey;
  readonly period_start: Date;
  readonly period_end: Date;
  readonly plan_version_id: string;
  readonly currency: 'USD';
  readonly units: readonly UsageSummaryUnit[];
  readonly total_amount_minor: number;
}

function refusal(reason: UsageRefusalReason, message: string): UsageRefusal {
  return { ok: false, reason, message };
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return err?.code === 'P2002' || String(err?.message ?? '').includes('duplicate key');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Input validation shared by check and record; returns a refusal or null. */
export function validateUsageInput(input: { tenant_id: unknown; unit: unknown }): UsageRefusal | null {
  if (typeof input.tenant_id !== 'string' || !UUID_RE.test(input.tenant_id)) return refusal('INVALID_INPUT', 'tenant_id must be a UUID');
  if (!isMeteredUnitKey(input.unit)) return refusal('UNKNOWN_UNIT', `unit must be one of ${METERED_UNIT_KEYS.join(', ')}`);
  return null;
}

export function validateRecordInput(input: UsageRecordInput, now: Date): UsageRefusal | null {
  const base = validateUsageInput(input);
  if (base !== null) return base;
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > USAGE_MAX_QUANTITY) {
    return refusal('INVALID_INPUT', `quantity must be an integer 1..${USAGE_MAX_QUANTITY}`);
  }
  if (typeof input.idempotency_key !== 'string' || input.idempotency_key.length < 1 || input.idempotency_key.length > 200) {
    return refusal('INVALID_INPUT', 'idempotency_key must be 1..200 characters');
  }
  if (typeof input.source_ref !== 'string' || input.source_ref.length < 1 || input.source_ref.length > 300) {
    return refusal('INVALID_INPUT', 'source_ref must be 1..300 characters');
  }
  if (input.occurred_at !== undefined) {
    const t = input.occurred_at instanceof Date ? input.occurred_at.getTime() : Number.NaN;
    if (!Number.isFinite(t)) return refusal('INVALID_INPUT', 'occurred_at must be a valid date');
    if (t > now.getTime() + USAGE_MAX_FUTURE_MS) return refusal('INVALID_INPUT', 'occurred_at is in the future');
    if (t < now.getTime() - USAGE_MAX_AGE_MS) return refusal('INVALID_INPUT', 'occurred_at is older than 35 days');
  }
  return null;
}

interface Priced {
  subscription_id: string;
  plan_version_id: string;
  period_anchor: Date;
  unit_price_minor: number;
  currency: string;
}

/** Test seam: the env the flag is read from and the clock (production binds neither). */
export const METERED_USAGE_OPTIONS = 'METERED_USAGE_OPTIONS';
export interface MeteredUsageOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: () => Date;
}

@Injectable()
export class MeteredUsageService implements UsageRecorder {
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(METERED_USAGE_OPTIONS) opts?: MeteredUsageOptions,
  ) {
    this.env = opts?.env ?? process.env;
    this.clock = opts?.clock ?? (() => new Date());
  }

  /** SIGN_USAGE_BILLING_ENABLED=1. */
  enabled(): boolean {
    return usageBillingEnabled(this.env);
  }

  /**
   * The open, sending BASE subscription of the unit's product and the unit's price on its pinned
   * version, or the refusal. A PAST_DUE row past its grace still bills while a support extension
   * overlay covers `at` (as the allowance gate sends).
   */
  private async priced(db: Tx | PrismaService, tenant_id: string, unit: MeteredUnitKey, at: Date): Promise<Priced | UsageRefusal> {
    const product = productOfMeteredUnit(unit);
    const sub = await db.tenantSubscription.findFirst({
      where: openBaseSubscription(tenant_id, product),
      select: { id: true, status: true, grace_until: true, period_anchor: true, plan_version_id: true },
    });
    if (sub === null) return refusal('NOT_SUBSCRIBED', 'the organization has no open subscription for this product');
    if (!subscriptionSends(sub, at)) {
      const overlay =
        sub.status === 'PAST_DUE'
          ? await db.supportExtension.findFirst({ where: { subscription_id: sub.id, removed_at: null, extends_until: { gt: at } }, select: { id: true } })
          : null;
      if (overlay === null) return refusal('NOT_SUBSCRIBED', 'the organization subscription is not in a billable state');
    }
    const price = await db.planVersionUnitPrice.findUnique({
      where: { plan_version_id_unit_key: { plan_version_id: sub.plan_version_id, unit_key: unit } },
      select: { unit_price_minor: true, currency: true },
    });
    if (price === null || price.unit_price_minor === null || price.currency === null) {
      return refusal('UNIT_NOT_SOLD', `${unit} is not sold on the organization's plan`);
    }
    return { subscription_id: sub.id, plan_version_id: sub.plan_version_id, period_anchor: sub.period_anchor, unit_price_minor: price.unit_price_minor, currency: price.currency };
  }

  async check(input: UsageCheckInput): Promise<UsageCheckResult> {
    const bad = validateUsageInput(input);
    if (bad !== null) return bad;
    if (!this.enabled()) return refusal('USAGE_BILLING_DISABLED', 'metered billing is not enabled');
    const unit = input.unit as MeteredUnitKey;
    const p = await this.priced(this.prisma, input.tenant_id, unit, this.clock());
    if ('ok' in p) return p;
    return { ok: true, unit, unit_price_minor: p.unit_price_minor, currency: p.currency, plan_version_id: p.plan_version_id };
  }

  async record(input: UsageRecordInput): Promise<UsageRecordResult> {
    const now = this.clock();
    const bad = validateRecordInput(input, now);
    if (bad !== null) return bad;
    // A replay is answered from the ledger whatever the flag says (it was recorded while enabled).
    const prior = await this.replay(input);
    if (prior !== null) return prior;
    if (!this.enabled()) return refusal('USAGE_BILLING_DISABLED', 'metered billing is not enabled');
    const unit = input.unit as MeteredUnitKey;
    const occurred_at = input.occurred_at ?? now;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const p = await this.priced(tx, input.tenant_id, unit, occurred_at);
        if ('ok' in p) return p;
        const period = billingPeriodAt(p.period_anchor, occurred_at);
        const id = uuidv7();
        const amount = input.quantity * p.unit_price_minor;
        await tx.usageLedgerEntry.create({
          data: {
            id,
            tenant_id: input.tenant_id,
            product_key: productOfMeteredUnit(unit),
            unit_key: unit,
            quantity: input.quantity,
            occurred_at,
            recorded_at: now,
            idempotency_key: input.idempotency_key,
            source_ref: input.source_ref,
            subscription_id: p.subscription_id,
            plan_version_id: p.plan_version_id,
            period_start: period.start,
            period_end: period.end,
            unit_price_minor: p.unit_price_minor,
            currency: p.currency,
            amount_minor: BigInt(amount),
          },
        });
        await tx.usageProviderReport.create({
          data: { ledger_entry_id: id, tenant_id: input.tenant_id, state: 'PENDING', next_attempt_at: now, created_at: now, updated_at: now },
        });
        return {
          ok: true as const,
          entry_id: id,
          replayed: false,
          unit,
          quantity: input.quantity,
          unit_price_minor: p.unit_price_minor,
          amount_minor: amount,
          currency: p.currency,
          period_start: period.start,
          period_end: period.end,
        };
      });
    } catch (e) {
      // A concurrent record of the same key won the unique index: answer as its replay.
      if (isUniqueViolation(e)) {
        const raced = await this.replay(input);
        if (raced !== null) return raced;
      }
      throw e;
    }
  }

  /** The recorded entry of this (tenant, idempotency key): a replay, a conflict, or null (new). */
  private async replay(input: UsageRecordInput): Promise<UsageRecordResult | null> {
    const row = await this.prisma.usageLedgerEntry.findUnique({ where: { tenant_id_idempotency_key: { tenant_id: input.tenant_id, idempotency_key: input.idempotency_key } } });
    if (row === null) return null;
    if (row.unit_key !== input.unit || row.quantity !== input.quantity || row.source_ref !== input.source_ref) {
      return refusal('IDEMPOTENCY_CONFLICT', 'this idempotency_key was already recorded for a different usage event');
    }
    return {
      ok: true,
      entry_id: row.id,
      replayed: true,
      unit: row.unit_key,
      quantity: row.quantity,
      unit_price_minor: row.unit_price_minor,
      amount_minor: Number(row.amount_minor),
      currency: row.currency,
      period_start: row.period_start,
      period_end: row.period_end,
    };
  }

  /**
   * The period aggregation for the tenant's open BASE subscription of `product_key`: the billing
   * period containing `at`, usage per unit (from the ledger) and every unit sold on the pinned
   * version. Null when the tenant has no open subscription of the product.
   */
  async periodSummary(tenant_id: string, product_key: ProductKey, at: Date = this.clock()): Promise<UsageSummary | null> {
    const sub = await this.prisma.tenantSubscription.findFirst({
      where: openBaseSubscription(tenant_id, product_key),
      select: { period_anchor: true, plan_version_id: true },
    });
    if (sub === null) return null;
    const period = billingPeriodAt(sub.period_anchor, at);
    const [units, prices, usage] = await Promise.all([
      this.prisma.meteredUnit.findMany({ where: { product_key }, select: { unit_key: true, name: true, quantity_label: true } }),
      this.prisma.planVersionUnitPrice.findMany({ where: { plan_version_id: sub.plan_version_id }, select: { unit_key: true, unit_price_minor: true } }),
      this.prisma.usageLedgerEntry.groupBy({
        by: ['unit_key'],
        where: { tenant_id, product_key, period_start: period.start },
        _sum: { quantity: true, amount_minor: true },
      }),
    ]);
    const priceOf = new Map(prices.map((p) => [p.unit_key, p.unit_price_minor]));
    const usageOf = new Map(usage.map((u) => [u.unit_key, { quantity: u._sum.quantity ?? 0, amount: Number(u._sum.amount_minor ?? 0n) }]));
    const order = new Map<string, number>(METERED_UNIT_KEYS.map((k, i) => [k, i]));
    const rows: UsageSummaryUnit[] = units
      .filter((u) => (priceOf.get(u.unit_key) ?? null) !== null || usageOf.has(u.unit_key))
      .sort((a, b) => (order.get(a.unit_key) ?? 999) - (order.get(b.unit_key) ?? 999) || a.unit_key.localeCompare(b.unit_key))
      .map((u) => ({
        unit_key: u.unit_key,
        name: u.name,
        quantity_label: u.quantity_label,
        quantity: usageOf.get(u.unit_key)?.quantity ?? 0,
        unit_price_minor: priceOf.get(u.unit_key) ?? null,
        amount_minor: usageOf.get(u.unit_key)?.amount ?? 0,
      }));
    return {
      product_key,
      period_start: period.start,
      period_end: period.end,
      plan_version_id: sub.plan_version_id,
      currency: 'USD',
      units: rows,
      total_amount_minor: rows.reduce((n, r) => n + r.amount_minor, 0),
    };
  }
}
