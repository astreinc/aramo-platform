import { Inject, Injectable } from '@nestjs/common';

import { planVersionTerms, type PlanVersionContent } from '../plan-version.js';
import { PRODUCT_KEYS, assertProductKey, type ProductKey } from '../product-registry.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { FINANCE_CURRENCY, FINANCE_SOURCES, priceFigure } from './billing-finance-report.service.js';
import { BILLING_PROVIDER_PORT, type BillingProviderPort } from './billing-provider.port.js';

// CCP-D2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.4 row D2; ruling A0-C6; PLATFORM-UX-1
// Amendment A1-4a) — revenue reporting: an ILLUSTRATIVE LIST-PRICE monthly value (field mrr_minor) and
// its annualized value (arr_minor), never recognized revenue or actual MRR / ARR (Architect W-1,
// 2026-10-25), and the renewal pipeline by month, DERIVED from the
// commercial records at read time. There is no ledger and no stored figure: nothing here writes, and
// no table holds a revenue amount.
//
//   MRR   = Σ over open BASE subscriptions (source MANUAL or SELF_SERVICE, status ACTIVE or PAST_DUE)
//           of the PINNED plan version's list_price_minor (checksum-verified through planVersionTerms),
//           when that price is USD and per MONTH.
//   ARR   = MRR × 12.
//   Every other open commercial row is EXCLUDED and COUNTED, with exactly one reason (first match,
//   REVENUE_EXCLUSION_REASONS order). A price is never converted, defaulted or inferred.
//   Renewal pipeline: the C6 renewal events (COMMITMENT_END for any commercial row; PERIOD_END for a
//   provider-linked row), grouped by UTC calendar month from the as_of month; events on or before
//   as_of form the LAPSED bucket. A bucket's amount is the MRR of the included rows renewing in it.
//
// Exposure (CCP-R3; Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0 LOCKED, FA-1 / FA-5):
// platform-wide aggregate revenue is a Finance amount. The route returns the figures only to a
// holder of platform:billing:read AND platform:billing:amount:read; every other reader gets the
// counts with amount_withheld: FINANCE_SCOPE_REQUIRED. The figures below are proven by the
// service-level tests and an independent SQL oracle.
//
// One REPEATABLE READ snapshot opened READ ONLY (any write would raise). Nothing calls the provider.

export const REVENUE_BILLING_INTERVAL = 'MONTH' as const;
export const REVENUE_BASIS = 'OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE' as const;
export const ARR_MONTHS = 12;
/** Statuses whose open row is recurring revenue. TRIALING, INCOMPLETE and an open CANCELED row are not. */
export const REVENUE_BEARING_STATUSES = ['ACTIVE', 'PAST_DUE'] as const;
export const REVENUE_PIPELINE_DEFAULT_MONTHS = 12;
export const REVENUE_PIPELINE_MAX_MONTHS = 24;

/** Closed set, in precedence order: a row carries the first reason that applies. */
export const REVENUE_EXCLUSION_REASONS = [
  'STATUS_NOT_REVENUE_BEARING',
  'PLAN_VERSION_INTEGRITY',
  'CONTRACT_PRICED',
  'NO_LIST_PRICE',
  'NON_USD_CURRENCY',
  'NON_MONTHLY_INTERVAL',
] as const;
export type RevenueExclusionReason = (typeof REVENUE_EXCLUSION_REASONS)[number];

/** One open BASE subscription as the snapshot reads it. */
export interface RevenueSourceRow {
  readonly subscription_id: string;
  readonly tenant_id: string;
  readonly product_key: string;
  readonly source: string;
  readonly status: string;
  readonly plan_key: string;
  readonly plan_version_id: string;
  readonly version_number: number;
  readonly content: unknown;
  readonly content_checksum: string;
  /** The B4 enterprise contract recorded on this row, if any (its price is negotiated, not the list price). */
  readonly contract_id: string | null;
  readonly commitment_end: Date | null;
  readonly current_period_end: Date | null;
  readonly billing_subscription_ref: string | null;
}

export interface RevenueLine {
  readonly subscription_id: string;
  readonly tenant_id: string;
  readonly product_key: string;
  readonly source: string;
  readonly status: string;
  readonly plan_key: string;
  readonly version_number: number;
  readonly plan_version_id: string;
  readonly monthly_minor: number;
}

export interface RevenueExclusion {
  readonly subscription_id: string;
  readonly tenant_id: string;
  readonly product_key: string;
  readonly source: string;
  readonly status: string;
  readonly plan_key: string;
  readonly reason: RevenueExclusionReason;
}

export interface RenewalBucket {
  /** 'YYYY-MM' (UTC), or 'LAPSED' for events on or before as_of. */
  readonly month: string;
  readonly commitment_end: number;
  readonly period_end: number;
  readonly events: number;
  /** Events of an included row (their MRR is in mrr_minor). */
  readonly priced_events: number;
  readonly unpriced_events: number;
  readonly mrr_minor: number;
}

export interface RevenueProductLine {
  readonly product_key: string;
  readonly subscriptions: number;
  readonly mrr_minor: number;
  readonly arr_minor: number;
}

export interface RevenueReport {
  readonly as_of: Date;
  readonly currency: typeof FINANCE_CURRENCY;
  readonly billing_interval: typeof REVENUE_BILLING_INTERVAL;
  readonly basis: typeof REVENUE_BASIS;
  readonly billing_provider_mode: 'test' | 'live' | 'unconfigured';
  readonly mrr_minor: number;
  readonly arr_minor: number;
  readonly by_product: RevenueProductLine[];
  /** Service level only (tenant-specific figures): the route never exposes these rows. */
  readonly included: RevenueLine[];
  readonly excluded: RevenueExclusion[];
  readonly counts: {
    readonly open_commercial_subscriptions: number;
    readonly included: number;
    readonly excluded: number;
    readonly excluded_by_reason: Record<RevenueExclusionReason, number>;
    /** Open BASE rows of a non-commercial source (FREE, DEVELOPMENT): never revenue, not an exclusion. */
    readonly not_commercial_by_source: Record<string, number>;
  };
  readonly renewal_pipeline: {
    readonly months: number;
    readonly from_month: string;
    readonly through_month: string;
    readonly lapsed: RenewalBucket;
    readonly by_month: RenewalBucket[];
  };
}

export interface RevenueOptions {
  readonly as_of: Date;
  readonly months?: number;
  readonly product_key?: ProductKey;
}

type Tx = Pick<PrismaService, '$queryRawUnsafe' | '$executeRawUnsafe'>;

const isCommercialSource = (s: string): boolean => (FINANCE_SOURCES as readonly string[]).includes(s);
const isRevenueBearing = (s: string): boolean => (REVENUE_BEARING_STATUSES as readonly string[]).includes(s);

/** UTC calendar month key 'YYYY-MM'. */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function addMonths(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

function safeAdd(a: number, b: number): number {
  const s = a + b;
  if (!Number.isSafeInteger(s)) throw new RangeError('revenue figure exceeds the safe integer range');
  return s;
}

function verifiedTerms(r: RevenueSourceRow): PlanVersionContent | null {
  try {
    return planVersionTerms({ id: r.plan_version_id, content: r.content, content_checksum: r.content_checksum });
  } catch {
    return null;
  }
}

/** The monthly USD list price of a row, or the one reason it is excluded. */
export function classifyRevenueRow(r: RevenueSourceRow): { monthly_minor: number } | { reason: RevenueExclusionReason } {
  if (!isRevenueBearing(r.status)) return { reason: 'STATUS_NOT_REVENUE_BEARING' };
  const terms = verifiedTerms(r);
  if (terms === null) return { reason: 'PLAN_VERSION_INTEGRITY' };
  if (r.contract_id !== null) return { reason: 'CONTRACT_PRICED' };
  const price = priceFigure(terms, r.plan_version_id, 'PINNED_PLAN_VERSION');
  if (price.list_price === null) {
    const reason = price.unpriced_reason;
    return { reason: reason === 'CONTRACT_PRICED' || reason === 'NON_USD_CURRENCY' || reason === 'PLAN_VERSION_INTEGRITY' ? reason : 'NO_LIST_PRICE' };
  }
  if (price.list_price.billing_interval !== REVENUE_BILLING_INTERVAL) return { reason: 'NON_MONTHLY_INTERVAL' };
  return { monthly_minor: price.list_price.amount_minor };
}

const emptyBucket = (month: string): { -readonly [K in keyof RenewalBucket]: RenewalBucket[K] } => ({ month, commitment_end: 0, period_end: 0, events: 0, priced_events: 0, unpriced_events: 0, mrr_minor: 0 });

/** The pure computation over a snapshot (exported for the unit tests). */
export function computeRevenue(rows: readonly RevenueSourceRow[], opts: RevenueOptions & { billing_provider_mode: RevenueReport['billing_provider_mode'] }): RevenueReport {
  const months = opts.months ?? REVENUE_PIPELINE_DEFAULT_MONTHS;
  if (!Number.isInteger(months) || months < 1 || months > REVENUE_PIPELINE_MAX_MONTHS) throw new RangeError(`months must be 1..${REVENUE_PIPELINE_MAX_MONTHS}`);
  const as_of = opts.as_of;
  const products: readonly string[] = opts.product_key === undefined ? PRODUCT_KEYS : [assertProductKey(opts.product_key)];
  const scoped = rows.filter((r) => products.includes(r.product_key));

  const included: RevenueLine[] = [];
  const excluded: RevenueExclusion[] = [];
  const not_commercial: Record<string, number> = {};
  const monthlyOf = new Map<string, number>();
  for (const r of scoped) {
    if (!isCommercialSource(r.source)) {
      not_commercial[r.source] = (not_commercial[r.source] ?? 0) + 1;
      continue;
    }
    const c = classifyRevenueRow(r);
    const base = { subscription_id: r.subscription_id, tenant_id: r.tenant_id, product_key: r.product_key, source: r.source, status: r.status, plan_key: r.plan_key };
    if ('reason' in c) {
      excluded.push({ ...base, reason: c.reason });
      continue;
    }
    included.push({ ...base, version_number: r.version_number, plan_version_id: r.plan_version_id, monthly_minor: c.monthly_minor });
    monthlyOf.set(r.subscription_id, c.monthly_minor);
  }

  const excluded_by_reason = Object.fromEntries(REVENUE_EXCLUSION_REASONS.map((k) => [k, excluded.filter((e) => e.reason === k).length])) as Record<RevenueExclusionReason, number>;
  const mrr_minor = included.reduce((s, l) => safeAdd(s, l.monthly_minor), 0);
  const by_product: RevenueProductLine[] = products.map((product_key) => {
    const lines = included.filter((l) => l.product_key === product_key);
    const mrr = lines.reduce((s, l) => safeAdd(s, l.monthly_minor), 0);
    return { product_key, subscriptions: lines.length, mrr_minor: mrr, arr_minor: mrr * ARR_MONTHS };
  });

  // Renewal pipeline by month (the C6 renewal events).
  const from_month = monthKey(as_of);
  const through_month = addMonths(from_month, months - 1);
  const buckets = new Map<string, ReturnType<typeof emptyBucket>>();
  for (let i = 0; i < months; i++) buckets.set(addMonths(from_month, i), emptyBucket(addMonths(from_month, i)));
  const lapsed = emptyBucket('LAPSED');
  for (const r of scoped) {
    if (!isCommercialSource(r.source)) continue;
    const events: Array<['commitment_end' | 'period_end', Date | null]> = [
      ['commitment_end', r.commitment_end],
      ['period_end', r.billing_subscription_ref === null ? null : r.current_period_end],
    ];
    for (const [kind, at] of events) {
      if (at === null) continue;
      const b = at.getTime() <= as_of.getTime() ? lapsed : buckets.get(monthKey(at));
      if (b === undefined) continue; // beyond the horizon
      b[kind] += 1;
      b.events += 1;
      const monthly = monthlyOf.get(r.subscription_id);
      if (monthly === undefined) b.unpriced_events += 1;
      else {
        b.priced_events += 1;
        b.mrr_minor = safeAdd(b.mrr_minor, monthly);
      }
    }
  }

  const byId = (a: { subscription_id: string }, b: { subscription_id: string }) => (a.subscription_id < b.subscription_id ? -1 : a.subscription_id > b.subscription_id ? 1 : 0);
  return {
    as_of,
    currency: FINANCE_CURRENCY,
    billing_interval: REVENUE_BILLING_INTERVAL,
    basis: REVENUE_BASIS,
    billing_provider_mode: opts.billing_provider_mode,
    mrr_minor,
    arr_minor: mrr_minor * ARR_MONTHS,
    by_product,
    included: included.sort(byId),
    excluded: excluded.sort(byId),
    counts: {
      open_commercial_subscriptions: included.length + excluded.length,
      included: included.length,
      excluded: excluded.length,
      excluded_by_reason,
      not_commercial_by_source: Object.fromEntries(Object.entries(not_commercial).sort(([a], [b]) => (a < b ? -1 : 1))),
    },
    renewal_pipeline: { months, from_month, through_month, lapsed, by_month: [...buckets.values()] },
  };
}

@Injectable()
export class BillingRevenueReportService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER_PORT) private readonly billing: BillingProviderPort,
  ) {}

  private providerMode(): 'test' | 'live' | 'unconfigured' {
    return this.billing.isConfigured() ? this.billing.mode() : 'unconfigured';
  }

  /** One consistent, provably read-only snapshot. */
  private async readOnly<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        return fn(tx);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  /** MRR / ARR and the renewal pipeline, derived from the open subscriptions and their pinned versions. */
  async revenue(opts: { as_of?: Date; months?: number; product_key?: ProductKey } = {}): Promise<RevenueReport> {
    const as_of = opts.as_of ?? new Date();
    const months = opts.months ?? REVENUE_PIPELINE_DEFAULT_MONTHS;
    if (!Number.isInteger(months) || months < 1 || months > REVENUE_PIPELINE_MAX_MONTHS) throw new RangeError(`months must be 1..${REVENUE_PIPELINE_MAX_MONTHS}`);
    const rows = await this.readOnly((tx) =>
      tx.$queryRawUnsafe<RevenueSourceRow[]>(
        `SELECT ts.id::text AS subscription_id, ts.tenant_id::text AS tenant_id, ts.product_key, ts.source, ts.status,
                p.key AS plan_key, v.id::text AS plan_version_id, v.version_number, v.content, v.content_checksum,
                (SELECT c.id::text FROM subscription."Contract" c WHERE c.tenant_subscription_id = ts.id) AS contract_id,
                ts.commitment_end, ts.current_period_end, ts.billing_subscription_ref
           FROM subscription."TenantSubscription" ts
           JOIN subscription."Plan" p ON p.id = ts.plan_id
           JOIN subscription."PlanVersion" v ON v.id = ts.plan_version_id
          WHERE ts.ended_at IS NULL AND ts.composition_role = 'BASE'
          ORDER BY ts.id`,
      ),
    );
    return computeRevenue(rows, { as_of, months, product_key: opts.product_key, billing_provider_mode: this.providerMode() });
  }
}

const usd = (minor: number): string => `USD ${(minor / 100).toFixed(2)}`;

/** The revenue output as stable text lines (service-level acceptance evidence only; never a route). */
export function formatRevenueReport(r: RevenueReport): string[] {
  const c = r.counts;
  const bucket = (b: RenewalBucket) => `[revenue]   ${b.month}: events=${b.events} commitment_end=${b.commitment_end} period_end=${b.period_end} priced=${b.priced_events} unpriced=${b.unpriced_events} illustrative_list_price_monthly=${usd(b.mrr_minor)}`;
  return [
    `[revenue] as_of=${r.as_of.toISOString()} basis=${r.basis} currency=${r.currency} interval=${r.billing_interval} provider_mode=${r.billing_provider_mode}`,
    // Architect W-1 (2026-10-25): an illustrative list-price value, never recognized revenue or actual MRR.
    `[revenue] illustrative list-price monthly value=${usd(r.mrr_minor)} annualized=${usd(r.arr_minor)} (annualized = monthly x ${ARR_MONTHS}; recognized_revenue=false)`,
    ...r.by_product.map((p) => `[revenue]   product=${p.product_key} subscriptions=${p.subscriptions} illustrative_list_price_monthly=${usd(p.mrr_minor)} annualized=${usd(p.arr_minor)}`),
    `[revenue] open commercial subscriptions: ${c.open_commercial_subscriptions} included=${c.included} excluded=${c.excluded} ${JSON.stringify(c.excluded_by_reason)}`,
    `[revenue] not commercial (not counted as revenue): ${JSON.stringify(c.not_commercial_by_source)}`,
    `[revenue] renewal pipeline ${r.renewal_pipeline.from_month}..${r.renewal_pipeline.through_month} (${r.renewal_pipeline.months} months)`,
    bucket(r.renewal_pipeline.lapsed),
    ...r.renewal_pipeline.by_month.map(bucket),
  ];
}
