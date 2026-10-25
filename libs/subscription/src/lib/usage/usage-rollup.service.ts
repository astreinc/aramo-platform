import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { Prisma } from '../../../prisma/generated/client/client.js';
import { billingPeriodAt } from '../billing-period.js';
import { planVersionTerms } from '../plan-version.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BASE_COMPOSITION, type ProductKey } from '../product-registry.js';

import { USAGE_METRICS, usageMetricOf, usageMetricsOf, type UsageMetricDefinition } from './usage-metrics.js';

// CCP-D1 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.4 row D1; the architecture metering
// prerequisite, doc/architecture/aramo-platform-console-enterprise-architecture.md:209) — the
// watermark roll-up worker, period aggregation, the reconciliation check and the read side.
//
// Source of truth: the AllowanceUsage ledger (unchanged; this service only READS it). Every
// roll-up row is DERIVED and recomputable: recovery is "disable the worker" or `rebuild`.
//
// Watermark (pre-execution D1-C4). Each AllowanceUsage write carries its transaction id
// (rollup_xid, trigger). A run is ONE REPEATABLE READ transaction: it processes every row with
// rollup_xid >= the watermark (every row on the first, FULL, run) plus every bucket a row left
// (UsageRollupVacatedBucket: DELETE or a period move), then sets the watermark to
// pg_snapshot_xmin of its own snapshot. Transactions below that xmin have finished (visible to
// the run if committed); transactions at or above it carry an xid the next run still selects.
// So a late commit or a back-dated row is never skipped.
//
// Idempotency (D1-C5). A dirty bucket (tenant × metric × period_start) is RECOMPUTED from the
// source and its derived rows REPLACED; nothing is incremented. Re-runs and rewound / overlapping
// windows converge on the same rows. Two concurrent runs: the second gets BUSY (try-lock); one
// whose snapshot predates the other's commit fails serialization on the watermark row and writes
// nothing (CONFLICT).
//
// Reconciliation (D1-C7), exact, never approximate:
//   R1  every bucket with no row at or above the watermark: daily rows and the period row equal
//       the source counts (CONSUMED, CONSUMED SEND, CONSUMED HISTORICAL, RESERVED). A source
//       bucket without roll-up, or a roll-up without source, is a mismatch. Buckets touched after
//       the watermark are PENDING (reported, not compared).
//   R2  per tenant: Σ UsageEvent.quantity of the metric's event type = CONSUMED SEND rows.
//   R3  per tenant with no pending bucket: Σ roll-up CONSUMED SEND = that UsageEvent total.
//
// Read-only (D1-C8): no allowance, entitlement, billing or limit decision reads a roll-up. The
// analytics read refuses unless the live status is RECONCILED. No money, price or rate is
// computed anywhere (usage-based pricing is out).

export const USAGE_ROLLUP_LOCK_KEY = 'ccp-d1:usage-rollup';
export const USAGE_RECONCILIATION_MISMATCH_LIMIT = 50;
export const USAGE_PERIODS_DEFAULT_LIMIT = 100;
export const USAGE_PERIODS_MAX_LIMIT = 500;
const BUCKET_BATCH = 500;

export type UsageReconciliationStatus = 'NOT_RUN' | 'RECONCILED' | 'NOT_RECONCILED';
export type UsageRollupMode = 'FULL' | 'INCREMENTAL' | 'REBUILD';

export interface UsageCounts {
  readonly consumed: number;
  readonly consumed_send: number;
  readonly consumed_historical: number;
  readonly reserved: number;
}

export interface UsageMismatch {
  readonly kind: 'PERIOD' | 'DAILY' | 'USAGE_EVENT' | 'ROLLUP_USAGE_EVENT';
  readonly tenant_id: string;
  readonly period_start: string | null;
  readonly expected: UsageCounts | number;
  readonly actual: UsageCounts | number | null;
}

export interface UsageMetricReconciliation {
  readonly metric_key: string;
  readonly product_key: ProductKey;
  readonly status: UsageReconciliationStatus;
  readonly watermark: string | null;
  readonly last_run_id: string | null;
  readonly buckets: { readonly source: number; readonly rollup: number; readonly pending: number; readonly compared: number; readonly mismatched: number };
  // Over the COMPARED (non-pending) buckets: the ledger and the roll-up must be equal.
  readonly compared_totals: { readonly allowance_usage: UsageCounts; readonly rollup: UsageCounts };
  readonly usage_event: {
    readonly event_type: string | null;
    readonly tenants: number;
    readonly mismatched_tenants: number;
    readonly allowance_usage_consumed_send: number;
    readonly usage_event_quantity: number;
  };
  readonly mismatch_count: number;
  readonly mismatches: readonly UsageMismatch[];
}

export interface UsageReconciliation {
  readonly product_key: ProductKey;
  readonly status: UsageReconciliationStatus;
  readonly checked_at: Date;
  readonly metrics: readonly UsageMetricReconciliation[];
}

export interface UsageMetricRunResult {
  readonly metric_key: string;
  readonly run_id: string;
  readonly mode: UsageRollupMode;
  readonly from_xid: string | null;
  readonly to_xid: string;
  readonly buckets_recomputed: number;
  readonly rows_scanned: number;
  readonly reconciliation: Exclude<UsageReconciliationStatus, 'NOT_RUN'>;
  readonly mismatch_count: number;
  readonly pending_bucket_count: number;
}

export type UsageRollupRunResult =
  | { readonly status: 'COMPLETED'; readonly metrics: readonly UsageMetricRunResult[] }
  | { readonly status: 'BUSY' | 'CONFLICT'; readonly metrics: readonly [] };

export interface UsageRollupRunOptions {
  /** REBUILD deletes every derived row of the metric and recomputes from the ledger. */
  readonly rebuild?: boolean;
  /**
   * Test / operator overlap: rescan from this xid instead of the stored watermark (an
   * overlapping window). Must not be above the stored watermark. Ignored on FULL / REBUILD.
   */
  readonly rescan_from_xid?: bigint;
  readonly now?: Date;
}

export interface UsagePeriodRow {
  readonly tenant_id: string;
  readonly metric_key: string;
  readonly product_key: string;
  readonly period_start: Date;
  readonly period_end: Date | null;
  readonly alignment: 'ALIGNED' | 'UNALIGNED';
  readonly subscription_id: string | null;
  readonly plan_version_id: string | null;
  readonly included_quantity: number | null;
  readonly unlimited: boolean | null;
  readonly counts: UsageCounts;
  // A row of this bucket was written after the last run: these counts are not yet current.
  readonly stale: boolean;
  readonly computed_at: Date;
  readonly days?: ReadonlyArray<{ readonly usage_date: string; readonly counts: UsageCounts }>;
}

export interface UsagePeriodsQuery {
  readonly product_key: ProductKey;
  readonly metric_key?: string;
  readonly tenant_id?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly include_daily?: boolean;
  readonly limit?: number;
}

export type UsagePeriodsResult =
  | { readonly ok: true; readonly reconciliation: UsageReconciliation; readonly periods: readonly UsagePeriodRow[]; readonly truncated: boolean }
  | { readonly ok: false; readonly reconciliation: UsageReconciliation };

type Db = Prisma.TransactionClient;

interface Bucket {
  tenant_id: string;
  period_start: Date;
}
const bucketId = (b: Bucket): string => `${b.tenant_id}|${b.period_start.toISOString()}`;

const ZERO: UsageCounts = { consumed: 0, consumed_send: 0, consumed_historical: 0, reserved: 0 };
const add = (a: UsageCounts, b: UsageCounts): UsageCounts => ({
  consumed: a.consumed + b.consumed,
  consumed_send: a.consumed_send + b.consumed_send,
  consumed_historical: a.consumed_historical + b.consumed_historical,
  reserved: a.reserved + b.reserved,
});
const same = (a: UsageCounts, b: UsageCounts): boolean =>
  a.consumed === b.consumed && a.consumed_send === b.consumed_send && a.consumed_historical === b.consumed_historical && a.reserved === b.reserved;

/** Prisma error P2034: a REPEATABLE READ write conflict (40001) — the run wrote nothing. */
function isSerializationConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: { code?: unknown } };
  if (e?.code === 'P2034') return true;
  const msg = typeof e?.message === 'string' ? e.message : '';
  return /could not serialize access|40001/.test(msg);
}

@Injectable()
export class UsageRollupService {
  constructor(private readonly prisma: PrismaService) {}

  // ── the worker ────────────────────────────────────────────────────────────────────────────

  /** One roll-up run over every registered metric (one REPEATABLE READ transaction). */
  async run(opts: UsageRollupRunOptions = {}): Promise<UsageRollupRunResult> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const lock = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${USAGE_ROLLUP_LOCK_KEY}, 0)) AS ok`;
          if (lock[0]?.ok !== true) return { status: 'BUSY', metrics: [] } as const;
          const snap = await tx.$queryRaw<Array<{ xmin: string }>>`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`;
          const xmin = BigInt(snap[0]?.xmin ?? '0');
          const metrics: UsageMetricRunResult[] = [];
          for (const m of USAGE_METRICS) metrics.push(await this.runMetric(tx, m, xmin, opts));
          return { status: 'COMPLETED', metrics } as const;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 300_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (isSerializationConflict(err)) return { status: 'CONFLICT', metrics: [] };
      throw err;
    }
  }

  private async runMetric(tx: Db, m: UsageMetricDefinition, xmin: bigint, opts: UsageRollupRunOptions): Promise<UsageMetricRunResult> {
    const started_at = opts.now ?? new Date();
    const run_id = uuidv7();
    const wm = await tx.usageRollupWatermark.findUnique({ where: { metric_key: m.metric_key } });
    const mode: UsageRollupMode = opts.rebuild === true ? 'REBUILD' : wm === null ? 'FULL' : 'INCREMENTAL';
    let from: bigint | null = null;
    if (mode === 'INCREMENTAL' && wm !== null) {
      from = wm.xmin_watermark;
      if (opts.rescan_from_xid !== undefined) {
        if (opts.rescan_from_xid > wm.xmin_watermark) throw new Error('rescan_from_xid must not be above the stored watermark');
        from = opts.rescan_from_xid;
      }
    }

    let buckets: Bucket[];
    let rows_scanned: number;
    if (mode === 'INCREMENTAL' && from !== null) {
      const fromText = from.toString();
      const touched = await tx.$queryRaw<Array<{ tenant_id: string; period_start: Date; n: number }>>`
        SELECT tenant_id::text AS tenant_id, period_start, count(*)::int AS n
          FROM subscription."AllowanceUsage"
         WHERE allowance_key = ${m.allowance_key} AND rollup_xid >= ${fromText}::xid8
         GROUP BY tenant_id, period_start`;
      const vacated = await tx.$queryRaw<Array<{ tenant_id: string; period_start: Date }>>`
        SELECT DISTINCT tenant_id::text AS tenant_id, period_start
          FROM subscription."UsageRollupVacatedBucket"
         WHERE allowance_key = ${m.allowance_key} AND vacated_xid >= ${fromText}::xid8`;
      const map = new Map<string, Bucket>();
      for (const b of [...touched, ...vacated]) map.set(bucketId(b), { tenant_id: b.tenant_id, period_start: b.period_start });
      buckets = [...map.values()];
      rows_scanned = touched.reduce((s, r) => s + r.n, 0);
    } else {
      // FULL (first run) and REBUILD: every derived row of the metric is recomputed from the ledger.
      await tx.usageRollupDaily.deleteMany({ where: { metric_key: m.metric_key } });
      await tx.usageRollupPeriod.deleteMany({ where: { metric_key: m.metric_key } });
      const all = await tx.$queryRaw<Array<{ tenant_id: string; period_start: Date; n: number }>>`
        SELECT tenant_id::text AS tenant_id, period_start, count(*)::int AS n
          FROM subscription."AllowanceUsage" WHERE allowance_key = ${m.allowance_key}
         GROUP BY tenant_id, period_start`;
      buckets = all.map((b) => ({ tenant_id: b.tenant_id, period_start: b.period_start }));
      rows_scanned = all.reduce((s, r) => s + r.n, 0);
    }

    for (let i = 0; i < buckets.length; i += BUCKET_BATCH) {
      await this.recomputeBuckets(tx, m, buckets.slice(i, i + BUCKET_BATCH), run_id, started_at);
    }

    // Processed: prune the vacated-bucket log below the new watermark (every such row is visible here).
    const xminText = xmin.toString();
    await tx.$executeRaw`DELETE FROM subscription."UsageRollupVacatedBucket" WHERE allowance_key = ${m.allowance_key} AND vacated_xid < ${xminText}::xid8`;

    // The watermark row is written by EVERY run: a concurrent run whose snapshot predates this
    // commit fails serialization here (REPEATABLE READ) and writes nothing.
    await tx.usageRollupWatermark.upsert({
      where: { metric_key: m.metric_key },
      create: { metric_key: m.metric_key, xmin_watermark: xmin, last_run_id: run_id, updated_at: started_at },
      update: { xmin_watermark: xmin, last_run_id: run_id, updated_at: started_at },
    });

    const rec = await this.reconcileMetric(tx, m, xmin.toString(), run_id);
    const finished_at = opts.now ?? new Date();
    await tx.usageRollupRun.create({
      data: {
        id: run_id,
        metric_key: m.metric_key,
        mode,
        from_xid: from,
        to_xid: xmin,
        buckets_recomputed: buckets.length,
        rows_scanned,
        reconciliation: rec.status === 'RECONCILED' ? 'RECONCILED' : 'NOT_RECONCILED',
        mismatch_count: rec.mismatch_count,
        pending_bucket_count: rec.buckets.pending,
        started_at,
        finished_at,
      },
    });
    return {
      metric_key: m.metric_key,
      run_id,
      mode,
      from_xid: from === null ? null : from.toString(),
      to_xid: xmin.toString(),
      buckets_recomputed: buckets.length,
      rows_scanned,
      reconciliation: rec.status === 'RECONCILED' ? 'RECONCILED' : 'NOT_RECONCILED',
      mismatch_count: rec.mismatch_count,
      pending_bucket_count: rec.buckets.pending,
    };
  }

  /** Recompute a batch of buckets from the ledger and replace their derived rows. */
  private async recomputeBuckets(tx: Db, m: UsageMetricDefinition, batch: Bucket[], run_id: string, computed_at: Date): Promise<void> {
    if (batch.length === 0) return;
    const tenants = batch.map((b) => b.tenant_id);
    const periods = batch.map((b) => b.period_start);
    const days = await tx.$queryRaw<Array<{ tenant_id: string; period_start: Date; usage_date: Date; c: number; cs: number; ch: number; r: number }>>`
      SELECT au.tenant_id::text AS tenant_id, au.period_start, (au.reserved_at AT TIME ZONE 'UTC')::date AS usage_date,
             count(*) FILTER (WHERE au.state = 'CONSUMED')::int AS c,
             count(*) FILTER (WHERE au.state = 'CONSUMED' AND au.origin = 'SEND')::int AS cs,
             count(*) FILTER (WHERE au.state = 'CONSUMED' AND au.origin = 'HISTORICAL')::int AS ch,
             count(*) FILTER (WHERE au.state = 'RESERVED')::int AS r
        FROM subscription."AllowanceUsage" au
        JOIN unnest(${tenants}::uuid[], ${periods}::timestamptz[]) AS b(t, p) ON au.tenant_id = b.t AND au.period_start = b.p
       WHERE au.allowance_key = ${m.allowance_key} AND au.state IN ('CONSUMED', 'RESERVED')
       GROUP BY au.tenant_id, au.period_start, (au.reserved_at AT TIME ZONE 'UTC')::date`;

    await tx.$executeRaw`
      DELETE FROM subscription."UsageRollupDaily" d
       USING unnest(${tenants}::uuid[], ${periods}::timestamptz[]) AS b(t, p)
       WHERE d.metric_key = ${m.metric_key} AND d.tenant_id = b.t AND d.period_start = b.p`;
    await tx.$executeRaw`
      DELETE FROM subscription."UsageRollupPeriod" r
       USING unnest(${tenants}::uuid[], ${periods}::timestamptz[]) AS b(t, p)
       WHERE r.metric_key = ${m.metric_key} AND r.tenant_id = b.t AND r.period_start = b.p`;
    if (days.length === 0) return;

    await tx.usageRollupDaily.createMany({
      data: days.map((d) => ({
        tenant_id: d.tenant_id,
        metric_key: m.metric_key,
        product_key: m.product_key,
        period_start: d.period_start,
        usage_date: d.usage_date,
        consumed_count: d.c,
        consumed_send_count: d.cs,
        consumed_historical_count: d.ch,
        reserved_count: d.r,
        run_id,
        computed_at,
      })),
    });

    const sums = new Map<string, { b: Bucket; counts: UsageCounts }>();
    for (const d of days) {
      const k = bucketId(d);
      const prev = sums.get(k) ?? { b: { tenant_id: d.tenant_id, period_start: d.period_start }, counts: ZERO };
      sums.set(k, { b: prev.b, counts: add(prev.counts, { consumed: d.c, consumed_send: d.cs, consumed_historical: d.ch, reserved: d.r }) });
    }
    const aligner = await this.aligner(tx, m, [...new Set([...sums.values()].map((s) => s.b.tenant_id))]);
    await tx.usageRollupPeriod.createMany({
      data: [...sums.values()].map(({ b, counts }) => {
        const a = aligner(b);
        return {
          tenant_id: b.tenant_id,
          metric_key: m.metric_key,
          product_key: m.product_key,
          period_start: b.period_start,
          period_end: a.period_end,
          alignment: a.alignment,
          subscription_id: a.subscription_id,
          plan_version_id: a.plan_version_id,
          included_quantity: a.included_quantity,
          unlimited: a.unlimited,
          consumed_count: counts.consumed,
          consumed_send_count: counts.consumed_send,
          consumed_historical_count: counts.consumed_historical,
          reserved_count: counts.reserved,
          run_id,
          computed_at,
        };
      }),
    });
  }

  /**
   * Period alignment (D1-C6): the tenant's BASE subscription of the metric's product whose anchor
   * produces the bucket's period_start and whose lifetime overlaps the period (latest started
   * wins); the plan version in force at period_start (pin history, else the current pin) and its
   * allowance terms. No match ⇒ UNALIGNED (kept and counted, never dropped).
   */
  private async aligner(tx: Db, m: UsageMetricDefinition, tenant_ids: string[]): Promise<(b: Bucket) => {
    alignment: 'ALIGNED' | 'UNALIGNED';
    period_end: Date | null;
    subscription_id: string | null;
    plan_version_id: string | null;
    included_quantity: number | null;
    unlimited: boolean | null;
  }> {
    const subs = await tx.tenantSubscription.findMany({
      where: { tenant_id: { in: tenant_ids }, product_key: m.product_key, composition_role: BASE_COMPOSITION },
      select: { id: true, tenant_id: true, period_anchor: true, started_at: true, ended_at: true, plan_version_id: true },
      orderBy: [{ started_at: 'desc' }, { id: 'desc' }],
    });
    const pins = await tx.subscriptionVersionPinEvent.findMany({
      where: { subscription_id: { in: subs.map((s) => s.id) } },
      select: { subscription_id: true, from_plan_version_id: true, to_plan_version_id: true, recorded_at: true },
      orderBy: [{ recorded_at: 'asc' }, { id: 'asc' }],
    });
    const versionIds = new Set<string>([...subs.map((s) => s.plan_version_id), ...pins.flatMap((p) => [p.from_plan_version_id, p.to_plan_version_id])]);
    const versions = await tx.planVersion.findMany({ where: { id: { in: [...versionIds] } }, select: { id: true, content: true, content_checksum: true } });
    const terms = new Map<string, { included_quantity: number | null; unlimited: boolean | null }>();
    for (const v of versions) {
      // Checksum-verified (fail closed): a corrupt version fails the run rather than mislabel a period.
      const a = planVersionTerms(v).allowances.find((x) => x.allowance_key === m.allowance_key);
      terms.set(v.id, a === undefined ? { included_quantity: null, unlimited: null } : { included_quantity: a.unlimited ? null : (a.included_quantity ?? 0), unlimited: a.unlimited });
    }
    const versionAt = (sub: (typeof subs)[number], at: Date): string => {
      const history = pins.filter((p) => p.subscription_id === sub.id);
      const before = history.filter((p) => p.recorded_at.getTime() <= at.getTime());
      if (before.length > 0) return before[before.length - 1]!.to_plan_version_id;
      if (history.length > 0) return history[0]!.from_plan_version_id;
      return sub.plan_version_id;
    };
    return (b) => {
      for (const s of subs) {
        if (s.tenant_id !== b.tenant_id) continue;
        const p = billingPeriodAt(s.period_anchor, b.period_start);
        if (p.start.getTime() !== b.period_start.getTime()) continue;
        if (s.started_at.getTime() >= p.end.getTime()) continue;
        if (s.ended_at !== null && s.ended_at.getTime() <= p.start.getTime()) continue;
        const plan_version_id = versionAt(s, b.period_start);
        const t = terms.get(plan_version_id) ?? { included_quantity: null, unlimited: null };
        return { alignment: 'ALIGNED', period_end: p.end, subscription_id: s.id, plan_version_id, ...t };
      }
      return { alignment: 'UNALIGNED', period_end: null, subscription_id: null, plan_version_id: null, included_quantity: null, unlimited: null };
    };
  }

  // ── reconciliation ──────────────────────────────────────────────────────────────────────────

  /** The live reconciliation status of one product (read-only, one consistent snapshot). */
  async reconcile(product_key: ProductKey, now: Date = new Date()): Promise<UsageReconciliation> {
    const metrics = usageMetricsOf(product_key);
    const results = await this.prisma.$transaction(
      async (tx) => {
        const out: UsageMetricReconciliation[] = [];
        for (const m of metrics) {
          const wm = await tx.usageRollupWatermark.findUnique({ where: { metric_key: m.metric_key } });
          out.push(wm === null ? notRun(m) : await this.reconcileMetric(tx, m, wm.xmin_watermark.toString(), wm.last_run_id));
        }
        return out;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000, maxWait: 10_000 },
    );
    return { product_key, status: overall(results), checked_at: now, metrics: results };
  }

  private async reconcileMetric(tx: Db, m: UsageMetricDefinition, watermark: string, last_run_id: string): Promise<UsageMetricReconciliation> {
    const rows = await tx.$queryRaw<
      Array<{
        tenant_id: string;
        period_start: Date;
        has_source: boolean;
        has_period: boolean;
        sc: number; scs: number; sch: number; sr: number;
        dc: number; dcs: number; dch: number; dr: number;
        pc: number | null; pcs: number | null; pch: number | null; pr: number | null;
        day_mismatches: number;
        pending: boolean;
      }>
    >`
      WITH src AS (
        SELECT tenant_id, period_start, (reserved_at AT TIME ZONE 'UTC')::date AS d,
               count(*) FILTER (WHERE state = 'CONSUMED')::int AS c,
               count(*) FILTER (WHERE state = 'CONSUMED' AND origin = 'SEND')::int AS cs,
               count(*) FILTER (WHERE state = 'CONSUMED' AND origin = 'HISTORICAL')::int AS ch,
               count(*) FILTER (WHERE state = 'RESERVED')::int AS r
          FROM subscription."AllowanceUsage"
         WHERE allowance_key = ${m.allowance_key} AND state IN ('CONSUMED', 'RESERVED')
         GROUP BY 1, 2, 3
      ), roll AS (
        SELECT tenant_id, period_start, usage_date AS d, consumed_count AS c, consumed_send_count AS cs,
               consumed_historical_count AS ch, reserved_count AS r
          FROM subscription."UsageRollupDaily" WHERE metric_key = ${m.metric_key}
      ), dj AS (
        SELECT tenant_id, period_start, (s.tenant_id IS NOT NULL) AS hs,
               coalesce(s.c, 0) AS sc, coalesce(s.cs, 0) AS scs, coalesce(s.ch, 0) AS sch, coalesce(s.r, 0) AS sr,
               coalesce(o.c, 0) AS oc, coalesce(o.cs, 0) AS ocs, coalesce(o.ch, 0) AS och, coalesce(o.r, 0) AS orr
          FROM src s FULL JOIN roll o USING (tenant_id, period_start, d)
      ), b AS (
        SELECT tenant_id, period_start, bool_or(hs) AS has_source,
               sum(sc)::int AS sc, sum(scs)::int AS scs, sum(sch)::int AS sch, sum(sr)::int AS sr,
               sum(oc)::int AS dc, sum(ocs)::int AS dcs, sum(och)::int AS dch, sum(orr)::int AS dr,
               count(*) FILTER (WHERE sc <> oc OR scs <> ocs OR sch <> och OR sr <> orr)::int AS day_mismatches
          FROM dj GROUP BY 1, 2
      ), per AS (
        SELECT tenant_id, period_start, consumed_count AS pc, consumed_send_count AS pcs,
               consumed_historical_count AS pch, reserved_count AS pr
          FROM subscription."UsageRollupPeriod" WHERE metric_key = ${m.metric_key}
      ), pend AS (
        SELECT tenant_id, period_start FROM subscription."AllowanceUsage"
         WHERE allowance_key = ${m.allowance_key} AND rollup_xid >= ${watermark}::xid8
        UNION
        SELECT tenant_id, period_start FROM subscription."UsageRollupVacatedBucket"
         WHERE allowance_key = ${m.allowance_key} AND vacated_xid >= ${watermark}::xid8
      )
      SELECT j.tenant_id::text AS tenant_id, j.period_start,
             coalesce(j.has_source, false) AS has_source, (j.pc IS NOT NULL) AS has_period,
             coalesce(j.sc, 0) AS sc, coalesce(j.scs, 0) AS scs, coalesce(j.sch, 0) AS sch, coalesce(j.sr, 0) AS sr,
             coalesce(j.dc, 0) AS dc, coalesce(j.dcs, 0) AS dcs, coalesce(j.dch, 0) AS dch, coalesce(j.dr, 0) AS dr,
             j.pc, j.pcs, j.pch, j.pr, coalesce(j.day_mismatches, 0) AS day_mismatches,
             EXISTS (SELECT 1 FROM pend p WHERE p.tenant_id = j.tenant_id AND p.period_start = j.period_start) AS pending
        FROM (SELECT * FROM b FULL JOIN per USING (tenant_id, period_start)) j
       ORDER BY j.tenant_id, j.period_start`;

    const mismatches: UsageMismatch[] = [];
    let mismatch_count = 0;
    const push = (x: UsageMismatch): void => {
      mismatch_count += 1;
      if (mismatches.length < USAGE_RECONCILIATION_MISMATCH_LIMIT) mismatches.push(x);
    };
    let source = 0;
    let rollup = 0;
    let pending = 0;
    let compared = 0;
    let mismatched = 0;
    let ledgerTotals = ZERO;
    let rollupTotals = ZERO;
    const pendingTenants = new Set<string>();
    for (const r of rows) {
      if (r.has_source) source += 1;
      if (r.has_period) rollup += 1;
      if (r.pending) {
        pending += 1;
        pendingTenants.add(r.tenant_id);
        continue;
      }
      compared += 1;
      const ledger: UsageCounts = { consumed: r.sc, consumed_send: r.scs, consumed_historical: r.sch, reserved: r.sr };
      const period: UsageCounts | null = r.pc === null ? null : { consumed: r.pc, consumed_send: r.pcs ?? 0, consumed_historical: r.pch ?? 0, reserved: r.pr ?? 0 };
      const daily: UsageCounts = { consumed: r.dc, consumed_send: r.dcs, consumed_historical: r.dch, reserved: r.dr };
      ledgerTotals = add(ledgerTotals, ledger);
      rollupTotals = add(rollupTotals, period ?? ZERO);
      let bad = false;
      if (!same(ledger, period ?? ZERO)) {
        bad = true;
        push({ kind: 'PERIOD', tenant_id: r.tenant_id, period_start: r.period_start.toISOString(), expected: ledger, actual: period });
      }
      if (r.day_mismatches > 0 || !same(daily, period ?? ZERO)) {
        bad = true;
        push({ kind: 'DAILY', tenant_id: r.tenant_id, period_start: r.period_start.toISOString(), expected: ledger, actual: daily });
      }
      if (bad) mismatched += 1;
    }

    // R2 / R3 — the raw-event cross-check (metering.UsageEvent), when the metric names its event.
    let tenants = 0;
    let mismatched_tenants = 0;
    let auSend = 0;
    let ueQty = 0;
    if (m.usage_event_type !== null) {
      const ev = await tx.$queryRaw<Array<{ tenant_id: string; a: number; e: number; r: number }>>`
        WITH a AS (
          SELECT tenant_id, count(*)::int AS n FROM subscription."AllowanceUsage"
           WHERE allowance_key = ${m.allowance_key} AND state = 'CONSUMED' AND origin = 'SEND' GROUP BY 1
        ), e AS (
          SELECT tenant_id, sum(quantity)::int AS n FROM metering."UsageEvent" WHERE event_type = ${m.usage_event_type} GROUP BY 1
        ), r AS (
          SELECT tenant_id, sum(consumed_send_count)::int AS n FROM subscription."UsageRollupPeriod" WHERE metric_key = ${m.metric_key} GROUP BY 1
        )
        SELECT tenant_id::text AS tenant_id, coalesce(a.n, 0) AS a, coalesce(e.n, 0) AS e, coalesce(r.n, 0) AS r
          FROM a FULL JOIN e USING (tenant_id) FULL JOIN r USING (tenant_id)
         ORDER BY tenant_id`;
      for (const t of ev) {
        tenants += 1;
        auSend += t.a;
        ueQty += t.e;
        let bad = false;
        if (t.a !== t.e) {
          bad = true;
          push({ kind: 'USAGE_EVENT', tenant_id: t.tenant_id, period_start: null, expected: t.e, actual: t.a });
        }
        if (!pendingTenants.has(t.tenant_id) && t.r !== t.e) {
          bad = true;
          push({ kind: 'ROLLUP_USAGE_EVENT', tenant_id: t.tenant_id, period_start: null, expected: t.e, actual: t.r });
        }
        if (bad) mismatched_tenants += 1;
      }
    }

    return {
      metric_key: m.metric_key,
      product_key: m.product_key,
      status: mismatch_count === 0 ? 'RECONCILED' : 'NOT_RECONCILED',
      watermark,
      last_run_id,
      buckets: { source, rollup, pending, compared, mismatched },
      compared_totals: { allowance_usage: ledgerTotals, rollup: rollupTotals },
      usage_event: { event_type: m.usage_event_type, tenants, mismatched_tenants, allowance_usage_consumed_send: auSend, usage_event_quantity: ueQty },
      mismatch_count,
      mismatches,
    };
  }

  // ── read side (read-only until reconciled) ───────────────────────────────────────────────

  /** Consumption analytics: period roll-ups, ONLY when the live status is RECONCILED. */
  async listPeriods(q: UsagePeriodsQuery, now: Date = new Date()): Promise<UsagePeriodsResult> {
    if (q.metric_key !== undefined) usageMetricOf(q.product_key, q.metric_key);
    const reconciliation = await this.reconcile(q.product_key, now);
    if (reconciliation.status !== 'RECONCILED') return { ok: false, reconciliation };
    const metricKeys = q.metric_key !== undefined ? [q.metric_key] : usageMetricsOf(q.product_key).map((m) => m.metric_key);
    const limit = Math.min(Math.max(q.limit ?? USAGE_PERIODS_DEFAULT_LIMIT, 1), USAGE_PERIODS_MAX_LIMIT);
    const rows = await this.prisma.usageRollupPeriod.findMany({
      where: {
        metric_key: { in: metricKeys },
        product_key: q.product_key,
        ...(q.tenant_id !== undefined ? { tenant_id: q.tenant_id } : {}),
        ...(q.from !== undefined || q.to !== undefined ? { period_start: { ...(q.from !== undefined ? { gte: q.from } : {}), ...(q.to !== undefined ? { lt: q.to } : {}) } } : {}),
      },
      orderBy: [{ period_start: 'desc' }, { tenant_id: 'asc' }, { metric_key: 'asc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const stale = await this.pendingSet(metricKeys, page);
    const daysBy = new Map<string, Array<{ usage_date: string; counts: UsageCounts }>>();
    if (q.include_daily === true && page.length > 0) {
      const days = await this.prisma.usageRollupDaily.findMany({
        where: { OR: page.map((p) => ({ tenant_id: p.tenant_id, metric_key: p.metric_key, period_start: p.period_start })) },
        orderBy: [{ usage_date: 'asc' }],
      });
      for (const d of days) {
        const k = `${d.metric_key}|${d.tenant_id}|${d.period_start.toISOString()}`;
        const list = daysBy.get(k) ?? [];
        list.push({ usage_date: d.usage_date.toISOString().slice(0, 10), counts: { consumed: d.consumed_count, consumed_send: d.consumed_send_count, consumed_historical: d.consumed_historical_count, reserved: d.reserved_count } });
        daysBy.set(k, list);
      }
    }
    return {
      ok: true,
      reconciliation,
      truncated: rows.length > limit,
      periods: page.map((p) => {
        const k = `${p.metric_key}|${p.tenant_id}|${p.period_start.toISOString()}`;
        return {
          tenant_id: p.tenant_id,
          metric_key: p.metric_key,
          product_key: p.product_key,
          period_start: p.period_start,
          period_end: p.period_end,
          alignment: p.alignment === 'ALIGNED' ? 'ALIGNED' : 'UNALIGNED',
          subscription_id: p.subscription_id,
          plan_version_id: p.plan_version_id,
          included_quantity: p.included_quantity,
          unlimited: p.unlimited,
          counts: { consumed: p.consumed_count, consumed_send: p.consumed_send_count, consumed_historical: p.consumed_historical_count, reserved: p.reserved_count },
          stale: stale.has(k),
          computed_at: p.computed_at,
          ...(q.include_daily === true ? { days: daysBy.get(k) ?? [] } : {}),
        };
      }),
    };
  }

  /** `${metric}|${tenant}|${period}` keys of the page rows touched after their metric's watermark. */
  private async pendingSet(metricKeys: string[], page: ReadonlyArray<{ metric_key: string; tenant_id: string; period_start: Date }>): Promise<Set<string>> {
    const out = new Set<string>();
    for (const metric_key of metricKeys) {
      const rows = page.filter((p) => p.metric_key === metric_key);
      if (rows.length === 0) continue;
      const m = USAGE_METRICS.find((x) => x.metric_key === metric_key);
      const wm = await this.prisma.usageRollupWatermark.findUnique({ where: { metric_key } });
      if (m === undefined || wm === null) continue;
      const w = wm.xmin_watermark.toString();
      const tenants = rows.map((r) => r.tenant_id);
      const periods = rows.map((r) => r.period_start);
      const hit = await this.prisma.$queryRaw<Array<{ tenant_id: string; period_start: Date }>>`
        SELECT DISTINCT b.t::text AS tenant_id, b.p AS period_start
          FROM unnest(${tenants}::uuid[], ${periods}::timestamptz[]) AS b(t, p)
         WHERE EXISTS (SELECT 1 FROM subscription."AllowanceUsage" au
                        WHERE au.allowance_key = ${m.allowance_key} AND au.tenant_id = b.t AND au.period_start = b.p AND au.rollup_xid >= ${w}::xid8)
            OR EXISTS (SELECT 1 FROM subscription."UsageRollupVacatedBucket" v
                        WHERE v.allowance_key = ${m.allowance_key} AND v.tenant_id = b.t AND v.period_start = b.p AND v.vacated_xid >= ${w}::xid8)`;
      for (const h of hit) out.add(`${metric_key}|${h.tenant_id}|${h.period_start.toISOString()}`);
    }
    return out;
  }
}

function notRun(m: UsageMetricDefinition): UsageMetricReconciliation {
  return {
    metric_key: m.metric_key,
    product_key: m.product_key,
    status: 'NOT_RUN',
    watermark: null,
    last_run_id: null,
    buckets: { source: 0, rollup: 0, pending: 0, compared: 0, mismatched: 0 },
    compared_totals: { allowance_usage: ZERO, rollup: ZERO },
    usage_event: { event_type: m.usage_event_type, tenants: 0, mismatched_tenants: 0, allowance_usage_consumed_send: 0, usage_event_quantity: 0 },
    mismatch_count: 0,
    mismatches: [],
  };
}

function overall(ms: readonly UsageMetricReconciliation[]): UsageReconciliationStatus {
  if (ms.length === 0 || ms.some((m) => m.status === 'NOT_RUN')) return 'NOT_RUN';
  return ms.some((m) => m.status === 'NOT_RECONCILED') ? 'NOT_RECONCILED' : 'RECONCILED';
}
