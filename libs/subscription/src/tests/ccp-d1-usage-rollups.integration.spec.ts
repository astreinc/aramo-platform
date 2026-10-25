import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ESIGN_ENVELOPE_ALLOWANCE, ESIGN_ENVELOPE_SENT_EVENT } from '../index.js';
import { AllowanceService } from '../lib/allowance.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PRODUCT_KEYS, ProductContextError, SIGN_PRODUCT_KEY } from '../lib/product-registry.js';
import { USAGE_METRICS, usageMetricOf, usageMetricsOf } from '../lib/usage/usage-metrics.js';
import { UsageRollupService, type UsageReconciliation } from '../lib/usage/usage-rollup.service.js';

import { CCP_A4_MIGRATION } from './fixtures/ccp-a4.js';
import { seedCorpus, SUBS, T } from './fixtures/ccp-a4-sign-corpus.js';
import { publishedVersionOf } from './fixtures/ccp-a5.js';
import {
  CCP_D1_COMPENSATING,
  CCP_D1_MIGRATION,
  backfillUsageEventsForLedger,
  derivedSnapshot,
  ledgerFingerprint,
  ledgerTotals,
  rollupTotals,
  usageEvent,
  writeLedger,
} from './fixtures/ccp-d1.js';

// CCP-D1 (PBD §5.4 row D1) on real Postgres 17. Mandatory tests (D1 row + brief):
//   REC   totals reconcile to AllowanceUsage exactly — the populated A4 Sign corpus (15
//         subscriptions, every N-13 semantic) + an Astre-shaped MANUAL subscription (HISTORICAL
//         backfill across periods + live sends through the real AllowanceService) + an
//         UNALIGNED bucket; and to the metering raw events (UsageEvent)
//   IDEM  the worker is idempotent: re-run, rewound / overlapping window, REBUILD, concurrent runs
//   WM    watermark correctness: a late-committing transaction, a back-dated historical row, a
//         period move (RELEASED → re-reserved), a DELETE — none is ever missed
//   OFF   off by default: no roll-up until a run; analytics refused while NOT_RUN
//   RO    read-only: the worker never writes the ledger; no allowance decision reads a roll-up;
//         analytics refused when totals do not reconcile (tampered roll-up, missing roll-up,
//         raw-event drift); REBUILD recovers
//   REG   the metric registry: DB ↔ code mirror; product registry CHECK; governed (no UPDATE/DELETE)
//   COMP  the compensating SQL removes every D1 object and leaves the ledger untouched

const ROOT = resolve(__dirname, '../../../..');
const SUB_DIR = resolve(ROOT, 'libs/subscription/prisma/migrations');
const ALL = [
  resolve(ROOT, 'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'),
  ...readdirSync(SUB_DIR)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(SUB_DIR, n, 'migration.sql')),
];
const PRE_A4 = ALL.slice(0, ALL.indexOf(CCP_A4_MIGRATION));
const POST_A4 = ALL.slice(ALL.indexOf(CCP_A4_MIGRATION));
const KEY = 'sign.envelopes';
const AT = new Date('2026-10-18T12:00:00.000Z');
const INCLUDED_PLAN = '019a0000-5150-7000-8000-000000000001';
const PROFESSIONAL_PLAN = '019a0000-5150-7000-8000-000000000012';
// Astre-shaped: one MANUAL, operator-governed subscription on the included plan, no billing
// linkage, day-clamped anchor (the 31st), HISTORICAL backfill plus live sends.
const ASTRE = '0190d1d1-0000-7000-8000-00000000a57e';
const ASTRE_SUB = '0190d1d2-0000-7000-8000-00000000a57e';
const ASTRE_ANCHOR = '2026-03-31T00:00:00.000Z';
const ORPHAN_TENANT = T(11); // the corpus tenant with no subscription

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-D1 — usage roll-ups + reconciliation (real Postgres)', { timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let allowance: AllowanceService;
  let svc: UsageRollupService;
  const url = (): string => container.getConnectionUri();
  const metric = (r: UsageReconciliation) => r.metrics[0]!;
  const sign = { tenant_id: ASTRE, product_key: SIGN_PRODUCT_KEY, allowance_key: KEY } as const;
  const send = async (send_key: string, at: Date, outcome: 'CONSUME' | 'RELEASE' | 'HOLD'): Promise<void> => {
    const r = await allowance.reserve({ ...sign, send_key, at });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (outcome === 'CONSUME') expect(await allowance.consume({ ...sign, send_key, usage_event_type: ESIGN_ENVELOPE_SENT_EVENT, at })).toBe('CONSUMED');
    if (outcome === 'RELEASE') expect(await allowance.release({ ...sign, send_key, at })).toBe(true);
  };
  const expectLedgerEqualsRollups = async (): Promise<void> => {
    expect(await rollupTotals(pg)).toEqual(await ledgerTotals(pg));
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: url() });
    await pg.connect();
    // The A4 corpus is seeded on the pre-A4 schema (its ledger rows predate D1: rollup_xid NULL).
    for (const f of PRE_A4) await pg.query(readFileSync(f, 'utf8'));
    await seedCorpus(pg);
    for (const f of POST_A4) await pg.query(readFileSync(f, 'utf8'));
    expect(POST_A4).toContain(CCP_D1_MIGRATION);
    // The corpus wrote the ledger directly; give its CONSUMED SEND rows their raw events.
    expect(await backfillUsageEventsForLedger(pg)).toBe(79 + 5 + 80 + 96 + 100 + 250 + 3 + 3);
    // The Astre-shaped MANUAL subscription.
    await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, period_anchor, source, started_at, created_by, status, product_key, composition_role, plan_version_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, 'MANUAL', $4::timestamptz, 'operator:astre-manual', 'ACTIVE', 'sign', 'BASE', ${publishedVersionOf('$3::uuid')})`,
      [ASTRE_SUB, ASTRE, INCLUDED_PLAN, ASTRE_ANCHOR],
    );
    prisma = new PrismaService(url());
    await prisma.$connect();
    allowance = new AllowanceService(prisma);
    svc = new UsageRollupService(prisma);
    // Astre: HISTORICAL backfill across three periods (anchor the 31st: Jun 30, Jul 31 clamp).
    for (const [k, at] of [['hist:1', '2026-07-10T09:00:00Z'], ['hist:2', '2026-08-15T09:00:00Z'], ['hist:3', '2026-08-30T23:59:59Z']] as const) {
      expect(await allowance.recordHistorical({ ...sign, send_key: k, sent_at: new Date(at) })).toBe(true);
    }
    // Astre: live sends in the current period (2026-09-30): 3 consumed, 1 released, 1 held.
    for (const k of ['live:1', 'live:2', 'live:3']) await send(k, AT, 'CONSUME');
    await send('live:rel', AT, 'RELEASE');
    await send('live:held', AT, 'HOLD');
    // An UNALIGNED bucket: the corpus tenant without a subscription.
    await writeLedger(pg, [{ tenant_id: ORPHAN_TENANT, period_start: '2026-10-01T00:00:00Z', reserved_at: '2026-10-03T10:00:00Z', state: 'CONSUMED' }]);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 120_000);

  // ── REG ─────────────────────────────────────────────────────────────────────────────────────

  it('REG-1 the DB registry equals the code mirror; the Sign metric is the Sign allowance + its usage event', async () => {
    const rows = (await pg.query(`SELECT metric_key, product_key, source, allowance_key, usage_event_type, unit FROM subscription."UsageMetric" ORDER BY metric_key`)).rows;
    expect(rows).toEqual(USAGE_METRICS.map((m) => ({ ...m })));
    expect(USAGE_METRICS).toHaveLength(1);
    expect(USAGE_METRICS[0]?.allowance_key).toBe(ESIGN_ENVELOPE_ALLOWANCE);
    expect(USAGE_METRICS[0]?.usage_event_type).toBe(ESIGN_ENVELOPE_SENT_EVENT);
    expect(usageMetricsOf('sign').map((m) => m.metric_key)).toEqual(['sign.envelopes']);
    expect(() => usageMetricOf('sign', 'sign.storage_bytes')).toThrow(ProductContextError);
    expect(() => usageMetricsOf('ats' as never)).toThrow(ProductContextError);
    // No price, rate or amount column anywhere in the D1 tables (usage-based pricing is out).
    const cols = (await pg.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name LIKE 'Usage%'`)).rows;
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.filter((c) => /price|amount|rate|currency|minor/i.test(c.column_name as string))).toEqual([]);
  });

  it('REG-2 the registry is governed: product CHECK = the A4 registry; UPDATE and DELETE rejected', async () => {
    const check = (await pg.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'UsageMetric_product_key_registry_check'`)).rows[0].d as string;
    expect(check).toBe(`CHECK ((product_key = ${PRODUCT_KEYS.map((k) => `'${k}'::text`).join(', ')}))`);
    await expect(pg.query(`INSERT INTO subscription."UsageMetric" VALUES ('ats.seats', 'ats', 'ALLOWANCE_USAGE', 'ats.seats', NULL, 'seat', 'x', now())`)).rejects.toThrow(/product_key_registry_check/);
    await expect(pg.query(`INSERT INTO subscription."UsageMetric" VALUES ('sign.other', 'sign', 'ALLOWANCE_USAGE', 'sign.storage_bytes', NULL, 'b', 'x', now())`)).rejects.toThrow(/key_namespace_check/);
    await expect(pg.query(`UPDATE subscription."UsageMetric" SET unit = 'x'`)).rejects.toThrow(/governed registry/);
    await expect(pg.query(`DELETE FROM subscription."UsageMetric"`)).rejects.toThrow(/governed registry/);
  });

  // ── OFF ─────────────────────────────────────────────────────────────────────────────────────

  it('OFF-1 before any run: status NOT_RUN, no derived rows, analytics refused', async () => {
    const rec = await svc.reconcile('sign');
    expect(rec.status).toBe('NOT_RUN');
    expect(metric(rec).watermark).toBeNull();
    expect((await pg.query(`SELECT count(*)::int AS n FROM subscription."UsageRollupPeriod"`)).rows[0].n).toBe(0);
    expect((await pg.query(`SELECT count(*)::int AS n FROM subscription."UsageRollupWatermark"`)).rows[0].n).toBe(0);
    const p = await svc.listPeriods({ product_key: 'sign' });
    expect(p.ok).toBe(false);
  });

  it('OFF-2 pre-D1 ledger rows carry no rollup_xid; rows written after D1 carry one', async () => {
    const r = (await pg.query(`SELECT count(*) FILTER (WHERE rollup_xid IS NULL)::int AS pre, count(*) FILTER (WHERE rollup_xid IS NOT NULL)::int AS post FROM subscription."AllowanceUsage"`)).rows[0];
    expect(r).toEqual({ pre: 79 + 5 + 80 + 96 + 2 + 3 + 100 + 250 + 3 + 3, post: 3 + 5 + 1 });
  });

  // ── REC ─────────────────────────────────────────────────────────────────────────────────────

  let first: Awaited<ReturnType<UsageRollupService['run']>>;
  let reconciliationOutput: UsageReconciliation;

  it('REC-1 the first run is FULL and the roll-ups equal the ledger per (tenant, period) byte for byte', async () => {
    const before = await ledgerFingerprint(pg);
    first = await svc.run();
    expect(first.status).toBe('COMPLETED');
    const m = first.metrics[0]!;
    expect(m.mode).toBe('FULL');
    expect(m.from_xid).toBeNull();
    expect(m.reconciliation).toBe('RECONCILED');
    expect(m.mismatch_count).toBe(0);
    await expectLedgerEqualsRollups();
    // RO: the worker never writes the ledger.
    expect(await ledgerFingerprint(pg)).toEqual(before);
  });

  it('REC-2 the reconciliation output: RECONCILED, compared totals equal, raw events equal (the D1 evidence)', async () => {
    reconciliationOutput = await svc.reconcile('sign');
    const m = metric(reconciliationOutput);
    expect(reconciliationOutput.status).toBe('RECONCILED');
    expect(m.mismatches).toEqual([]);
    expect(m.buckets.pending).toBe(0);
    expect(m.buckets.compared).toBe(m.buckets.source);
    expect(m.buckets.rollup).toBe(m.buckets.source);
    expect(m.compared_totals.rollup).toEqual(m.compared_totals.allowance_usage);
    // Corpus: 79+5+80+96+100+250+3+3 consumed SEND; Astre 3 SEND + 3 HISTORICAL; orphan 1.
    expect(m.compared_totals.allowance_usage).toEqual({ consumed: 616 + 6 + 1, consumed_send: 616 + 3 + 1, consumed_historical: 3, reserved: 3 + 1 });
    expect(m.usage_event).toEqual({ event_type: 'sign.envelope.sent', tenants: 9, mismatched_tenants: 0, allowance_usage_consumed_send: 620, usage_event_quantity: 620 });
    if (process.env['D1_EVIDENCE_OUT']) writeFileSync(process.env['D1_EVIDENCE_OUT'], JSON.stringify({ run: first, reconciliation: reconciliationOutput }, null, 2));
  });

  it('REC-3 per-tenant periods: no rollover, RELEASED never counted, stale reservations counted, day clamp, Astre history', async () => {
    const p = await svc.listPeriods({ product_key: 'sign', limit: 500 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const at = (tenant: string, start: string) => p.periods.find((x) => x.tenant_id === tenant && x.period_start.toISOString() === start);
    expect(at(T(2), '2026-10-15T00:00:00.000Z')?.counts).toEqual({ consumed: 79, consumed_send: 79, consumed_historical: 0, reserved: 0 });
    expect(at(T(2), '2026-09-15T00:00:00.000Z')?.counts.consumed).toBe(5);
    // T(4): 96 consumed, 3 overdue reservations counted, 2 RELEASED not counted.
    expect(at(T(4), '2026-10-01T00:00:00.000Z')?.counts).toEqual({ consumed: 96, consumed_send: 96, consumed_historical: 0, reserved: 3 });
    // T(14): anchor Jan 31 → the period starting Sep 30 ends Oct 31.
    const t14 = at(T(14), '2026-09-30T00:00:00.000Z');
    expect(t14?.alignment).toBe('ALIGNED');
    expect(t14?.period_end?.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    // Astre: anchor Mar 31 → periods Jun 30, Jul 31, Sep 30 (clamped), on the included plan's v1 (100).
    const astre = p.periods.filter((x) => x.tenant_id === ASTRE).map((x) => [x.period_start.toISOString(), x.period_end?.toISOString(), x.counts, x.subscription_id, x.included_quantity, x.unlimited]);
    expect(astre).toEqual([
      ['2026-09-30T00:00:00.000Z', '2026-10-31T00:00:00.000Z', { consumed: 3, consumed_send: 3, consumed_historical: 0, reserved: 1 }, ASTRE_SUB, 100, false],
      ['2026-07-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', { consumed: 2, consumed_send: 0, consumed_historical: 2, reserved: 0 }, ASTRE_SUB, 100, false],
      ['2026-06-30T00:00:00.000Z', '2026-07-31T00:00:00.000Z', { consumed: 1, consumed_send: 0, consumed_historical: 1, reserved: 0 }, ASTRE_SUB, 100, false],
    ]);
    const astreVersion = (await pg.query(`SELECT plan_version_id FROM subscription."TenantSubscription" WHERE id = $1`, [ASTRE_SUB])).rows[0].plan_version_id;
    expect(p.periods.filter((x) => x.tenant_id === ASTRE).every((x) => x.plan_version_id === astreVersion)).toBe(true);
    // T(6): unlimited plan, metered.
    const t6 = at(T(6), '2026-10-05T00:00:00.000Z');
    expect([t6?.counts.consumed, t6?.unlimited, t6?.included_quantity]).toEqual([250, true, null]);
    // The tenant without a subscription: kept, counted, UNALIGNED.
    const orphan = at(ORPHAN_TENANT, '2026-10-01T00:00:00.000Z');
    expect([orphan?.alignment, orphan?.subscription_id, orphan?.period_end, orphan?.counts.consumed]).toEqual(['UNALIGNED', null, null, 1]);
    // Every period of every subscribed corpus tenant is aligned.
    const subscribed = new Set([...SUBS.map((s) => T(s.n)), ASTRE]);
    expect(p.periods.filter((x) => subscribed.has(x.tenant_id) && x.alignment !== 'ALIGNED')).toEqual([]);
    expect(p.periods.every((x) => x.stale === false)).toBe(true);
  });

  it('REC-4 the roll-ups agree with the allowance authority: used = consumed + reserved for the current period', async () => {
    const st = await allowance.getStatus(ASTRE, 'sign', KEY, AT);
    const p = await svc.listPeriods({ product_key: 'sign', tenant_id: ASTRE, from: new Date('2026-09-30T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z'), include_daily: true });
    expect(st.subscribed).toBe(true);
    if (!st.subscribed || !p.ok) throw new Error('unexpected');
    expect(p.periods).toHaveLength(1);
    const row = p.periods[0]!;
    expect(row.counts.consumed + row.counts.reserved).toBe(st.used);
    expect(row.days).toEqual([{ usage_date: '2026-10-18', counts: { consumed: 3, consumed_send: 3, consumed_historical: 0, reserved: 1 } }]);
  });

  // ── IDEM ────────────────────────────────────────────────────────────────────────────────────

  it('IDEM-1 a re-run with no ledger change recomputes nothing and changes no derived row', async () => {
    const snap = await derivedSnapshot(pg);
    const runIds = (await pg.query(`SELECT DISTINCT run_id FROM subscription."UsageRollupPeriod"`)).rows;
    const r = await svc.run();
    expect(r.status).toBe('COMPLETED');
    expect(r.metrics[0]).toMatchObject({ mode: 'INCREMENTAL', buckets_recomputed: 0, rows_scanned: 0, reconciliation: 'RECONCILED', from_xid: first.metrics[0]!.to_xid });
    expect(await derivedSnapshot(pg)).toEqual(snap);
    expect((await pg.query(`SELECT DISTINCT run_id FROM subscription."UsageRollupPeriod"`)).rows).toEqual(runIds);
  });

  it('IDEM-2 an overlapping window (rewound to xid 1: every post-D1 row again) converges on the same rows', async () => {
    const snap = await derivedSnapshot(pg);
    const r = await svc.run({ rescan_from_xid: 1n });
    expect(r.status).toBe('COMPLETED');
    expect(r.metrics[0]).toMatchObject({ mode: 'INCREMENTAL', from_xid: '1', reconciliation: 'RECONCILED' });
    // Every post-D1 row again: Astre Jun 30, Jul 31 (2 rows), Sep 30, and the orphan bucket.
    expect(r.metrics[0]!.buckets_recomputed).toBe(4);
    expect(await derivedSnapshot(pg)).toEqual(snap);
    // The same window twice.
    expect((await svc.run({ rescan_from_xid: 1n })).metrics[0]!.buckets_recomputed).toBe(r.metrics[0]!.buckets_recomputed);
    expect(await derivedSnapshot(pg)).toEqual(snap);
    await expect(svc.run({ rescan_from_xid: 2n ** 62n })).rejects.toThrow(/must not be above/);
  });

  it('IDEM-3 REBUILD recomputes every bucket from the ledger and yields identical rows', async () => {
    const snap = await derivedSnapshot(pg);
    const r = await svc.run({ rebuild: true });
    expect(r.metrics[0]).toMatchObject({ mode: 'REBUILD', from_xid: null, reconciliation: 'RECONCILED' });
    expect(r.metrics[0]!.buckets_recomputed).toBe(metric(reconciliationOutput).buckets.source);
    expect(await derivedSnapshot(pg)).toEqual(snap);
  });

  it('IDEM-4 concurrent runs: at most one writes at a time (BUSY / CONFLICT write nothing); the result equals a single run', async () => {
    await writeLedger(pg, [{ tenant_id: ASTRE, period_start: '2026-09-30T00:00:00Z', reserved_at: '2026-10-19T08:00:00Z', state: 'CONSUMED' }]);
    const runsBefore = Number((await pg.query(`SELECT count(*)::int AS n FROM subscription."UsageRollupRun"`)).rows[0].n);
    const results = await Promise.all([svc.run(), svc.run(), svc.run()]);
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain('COMPLETED');
    expect(statuses.every((s) => s === 'COMPLETED' || s === 'BUSY' || s === 'CONFLICT')).toBe(true);
    const completed = statuses.filter((s) => s === 'COMPLETED').length;
    expect(Number((await pg.query(`SELECT count(*)::int AS n FROM subscription."UsageRollupRun"`)).rows[0].n)).toBe(runsBefore + completed);
    await expectLedgerEqualsRollups();
    expect((await svc.reconcile('sign')).status).toBe('RECONCILED');
  });

  // ── WM ──────────────────────────────────────────────────────────────────────────────────────

  it('WM-1 a write after the run is PENDING (flagged stale, not compared), then picked up by the next run', async () => {
    await send('wm1:a', new Date('2026-10-20T10:00:00Z'), 'CONSUME');
    const rec = await svc.reconcile('sign');
    expect(rec.status).toBe('RECONCILED');
    expect(metric(rec).buckets.pending).toBe(1);
    const p = await svc.listPeriods({ product_key: 'sign', tenant_id: ASTRE });
    if (!p.ok) throw new Error('refused');
    expect(p.periods.find((x) => x.period_start.toISOString() === '2026-09-30T00:00:00.000Z')?.stale).toBe(true);
    expect(p.periods.filter((x) => x.stale)).toHaveLength(1);
    const r = await svc.run();
    expect(r.metrics[0]).toMatchObject({ mode: 'INCREMENTAL', buckets_recomputed: 1, rows_scanned: 1, pending_bucket_count: 0, reconciliation: 'RECONCILED' });
    await expectLedgerEqualsRollups();
  });

  it('WM-2 a transaction that commits AFTER the run (open during it) is never skipped', async () => {
    const late = new Client({ connectionString: url() });
    await late.connect();
    try {
      await late.query('BEGIN');
      await late.query(
        `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, origin, reserved_at, reserved_until, finalized_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, 'wm2:late', '2026-09-30T00:00:00Z', 'CONSUMED', 'SEND', '2026-10-21T10:00:00Z', '2026-10-21T10:10:00Z', '2026-10-21T10:00:00Z')`,
        [ASTRE, KEY],
      );
      await usageEvent(late, ASTRE, '2026-10-21T10:00:00Z');
      const lateXid = BigInt((await late.query(`SELECT pg_current_xact_id()::text AS x`)).rows[0].x);
      const r = await svc.run();
      expect(r.status).toBe('COMPLETED');
      // The new watermark is at or below the open transaction's id: it will be rescanned.
      expect(BigInt(r.metrics[0]!.to_xid) <= lateXid).toBe(true);
      expect((await svc.reconcile('sign')).status).toBe('RECONCILED');
      await late.query('COMMIT');
    } finally {
      await late.end();
    }
    const rec = await svc.reconcile('sign');
    expect(metric(rec).buckets.pending).toBe(1);
    expect(rec.status).toBe('RECONCILED');
    const r2 = await svc.run();
    expect(r2.metrics[0]).toMatchObject({ buckets_recomputed: 1, pending_bucket_count: 0, reconciliation: 'RECONCILED' });
    await expectLedgerEqualsRollups();
  });

  it('WM-3 a BACK-DATED row (historical backfill into an old period) after a run is picked up (xid, not time)', async () => {
    expect(await allowance.recordHistorical({ ...sign, send_key: 'hist:old', sent_at: new Date('2026-05-05T00:00:00Z') })).toBe(true);
    const r = await svc.run();
    expect(r.metrics[0]).toMatchObject({ buckets_recomputed: 1, rows_scanned: 1, reconciliation: 'RECONCILED' });
    const p = await svc.listPeriods({ product_key: 'sign', tenant_id: ASTRE, from: new Date('2026-04-30T00:00:00Z'), to: new Date('2026-05-01T00:00:00Z') });
    if (!p.ok) throw new Error('refused');
    expect(p.periods.map((x) => [x.period_start.toISOString(), x.counts.consumed_historical])).toEqual([['2026-04-30T00:00:00.000Z', 1]]);
    await expectLedgerEqualsRollups();
  });

  it('WM-4 a row that MOVES period (released, then re-reserved later) and a DELETE: the vacated bucket is recomputed', async () => {
    await send('wm4:move', new Date('2026-10-22T10:00:00Z'), 'HOLD');
    await svc.run();
    const sepBefore = (await rollupTotals(pg)).find((x) => x.tenant_id === ASTRE && x.period_start === '2026-09-30T00:00:00.000Z')!;
    expect(await allowance.release({ ...sign, send_key: 'wm4:move' })).toBe(true);
    // Re-reserved in the next period (2026-10-31): the ledger row's period_start changes.
    const re = await allowance.reserve({ ...sign, send_key: 'wm4:move', at: new Date('2026-11-02T10:00:00Z') });
    expect(re.ok).toBe(true);
    expect((await pg.query(`SELECT count(*)::int AS n FROM subscription."UsageRollupVacatedBucket"`)).rows[0].n).toBe(1);
    // Before the run both buckets are pending: never reported as a mismatch.
    const rec = await svc.reconcile('sign');
    // Sep 30 (vacated) and Oct 31 (the row's new bucket).
    expect([rec.status, metric(rec).buckets.pending]).toEqual(['RECONCILED', 2]);
    const r = await svc.run();
    expect(r.metrics[0]).toMatchObject({ buckets_recomputed: 2, reconciliation: 'RECONCILED', pending_bucket_count: 0 });
    const after = await rollupTotals(pg);
    expect(after.find((x) => x.tenant_id === ASTRE && x.period_start === '2026-09-30T00:00:00.000Z')!.reserved).toBe(sepBefore.reserved - 1);
    expect(after.find((x) => x.tenant_id === ASTRE && x.period_start === '2026-10-31T00:00:00.000Z')).toMatchObject({ reserved: 1, consumed: 0 });
    // The processed vacated entry is pruned.
    expect((await pg.query(`SELECT count(*)::int AS n FROM subscription."UsageRollupVacatedBucket"`)).rows[0].n).toBe(0);
    // DELETE of a RESERVED row (e.g. an operator correction): logged, recomputed.
    await pg.query(`DELETE FROM subscription."AllowanceUsage" WHERE tenant_id = $1 AND send_key = 'wm4:move'`, [ASTRE]);
    expect((await svc.run()).metrics[0]).toMatchObject({ buckets_recomputed: 1, reconciliation: 'RECONCILED' });
    expect((await rollupTotals(pg)).find((x) => x.tenant_id === ASTRE && x.period_start === '2026-10-31T00:00:00.000Z')).toBeUndefined();
    await expectLedgerEqualsRollups();
  });

  it('WM-5 a version re-pin: each period carries the plan version in force at its start', async () => {
    // T(6) business v1 → professional v1 (a provider-side plan change, attributed as A5 requires).
    const pro = (await pg.query(`SELECT id FROM subscription."PlanVersion" WHERE plan_id = $1 AND status = 'PUBLISHED'`, [PROFESSIONAL_PLAN])).rows[0].id as string;
    const before = (await pg.query(`SELECT plan_version_id FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [T(6)])).rows[0].plan_version_id as string;
    await pg.query('BEGIN');
    await pg.query(`SET LOCAL aramo.subscription_pin_reason = 'PROVIDER_PLAN_CHANGE'`);
    await pg.query(`UPDATE subscription."TenantSubscription" SET plan_id = $2::uuid, plan_version_id = $3::uuid WHERE tenant_id = $1::uuid`, [T(6), PROFESSIONAL_PLAN, pro]);
    await pg.query('COMMIT');
    const pinAt = (await pg.query(`SELECT recorded_at FROM subscription."SubscriptionVersionPinEvent" WHERE tenant_id = $1`, [T(6)])).rows[0].recorded_at as Date;
    // A send in a period that starts after the re-pin (anchor Oct 5 → a period one year on).
    const later = new Date(Date.UTC(pinAt.getUTCFullYear() + 1, 9, 5));
    await writeLedger(pg, [{ tenant_id: T(6), period_start: later.toISOString(), reserved_at: new Date(later.getTime() + 3_600_000).toISOString(), state: 'CONSUMED' }]);
    await svc.run({ rebuild: true });
    const p = await svc.listPeriods({ product_key: 'sign', tenant_id: T(6) });
    if (!p.ok) throw new Error('refused');
    expect(p.periods.map((x) => [x.period_start.toISOString(), x.plan_version_id])).toEqual([
      [later.toISOString(), pro],
      ['2026-10-05T00:00:00.000Z', before],
    ]);
  });

  // ── RO ──────────────────────────────────────────────────────────────────────────────────────

  it('RO-1 a tampered roll-up is NOT_RECONCILED (PERIOD + DAILY mismatch), analytics refused; REBUILD recovers', async () => {
    await pg.query(`UPDATE subscription."UsageRollupPeriod" SET consumed_count = consumed_count + 1, consumed_send_count = consumed_send_count + 1 WHERE tenant_id = $1 AND period_start = '2026-10-01T00:00:00Z'`, [T(3)]);
    const rec = await svc.reconcile('sign');
    expect(rec.status).toBe('NOT_RECONCILED');
    expect(metric(rec).mismatches.map((x) => [x.kind, x.tenant_id])).toEqual([['PERIOD', T(3)], ['DAILY', T(3)], ['ROLLUP_USAGE_EVENT', T(3)]]);
    expect((await svc.listPeriods({ product_key: 'sign' })).ok).toBe(false);
    expect((await svc.run({ rebuild: true })).metrics[0]!.reconciliation).toBe('RECONCILED');
    expect((await svc.listPeriods({ product_key: 'sign' })).ok).toBe(true);
  });

  it('RO-2 a missing roll-up row is a mismatch (actual null)', async () => {
    await pg.query(`DELETE FROM subscription."UsageRollupPeriod" WHERE tenant_id = $1`, [T(5)]);
    const rec = await svc.reconcile('sign');
    expect(rec.status).toBe('NOT_RECONCILED');
    expect(metric(rec).mismatches.find((x) => x.kind === 'PERIOD')).toMatchObject({ tenant_id: T(5), actual: null });
    await svc.run({ rebuild: true });
    expect((await svc.reconcile('sign')).status).toBe('RECONCILED');
  });

  it('RO-3 raw-event drift (a UsageEvent without its ledger row) is NOT_RECONCILED even though the roll-up equals the ledger', async () => {
    await usageEvent(pg, T(2), '2026-10-16T00:00:00Z');
    const rec = await svc.reconcile('sign');
    expect(rec.status).toBe('NOT_RECONCILED');
    expect(metric(rec).mismatches.filter((x) => x.kind === 'USAGE_EVENT')).toEqual([{ kind: 'USAGE_EVENT', tenant_id: T(2), period_start: null, expected: 85, actual: 84 }]);
    expect((await svc.listPeriods({ product_key: 'sign' })).ok).toBe(false);
    await pg.query(`DELETE FROM metering."UsageEvent" WHERE id = (SELECT id FROM metering."UsageEvent" WHERE tenant_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1)`, [T(2)]);
    expect((await svc.reconcile('sign')).status).toBe('RECONCILED');
  });

  it('RO-4 no allowance, entitlement or billing code reads a roll-up (source scan: only src/lib/usage names the D1 tables)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, e.name);
        if (e.isDirectory()) {
          if (!['node_modules', 'generated', 'tests', 'dist'].includes(e.name)) walk(p);
        } else if (/\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) {
          const src = readFileSync(p, 'utf8');
          if (/UsageRollup|usageRollup|UsageMetric\b|rollup_xid/.test(src)) offenders.push(p.slice(ROOT.length + 1));
        }
      }
    };
    for (const d of ['libs/subscription/src/lib', 'libs/metering/src', 'libs/entitlement/src', 'apps/sign-service/src', 'apps/api/src']) walk(resolve(ROOT, d));
    expect(offenders.sort()).toEqual(['libs/subscription/src/lib/subscription.module.ts', 'libs/subscription/src/lib/usage/usage-metrics.ts', 'libs/subscription/src/lib/usage/usage-rollup.service.ts']);
  });

  it('RO-5 the run log is append-only', async () => {
    await expect(pg.query(`UPDATE subscription."UsageRollupRun" SET mismatch_count = 9`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`DELETE FROM subscription."UsageRollupRun"`)).rejects.toThrow(/append-only/);
  });

  // ── COMP ────────────────────────────────────────────────────────────────────────────────────

  it('COMP-1 the compensating SQL removes every D1 object; the ledger is untouched; D1 re-applies and reconciles', async () => {
    const before = await ledgerFingerprint(pg);
    await pg.query(readFileSync(CCP_D1_COMPENSATING, 'utf8'));
    const left = (await pg.query(
      `SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'subscription' AND table_name LIKE 'Usage%') AS tables,
              (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'subscription' AND column_name = 'rollup_xid') AS columns,
              (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'ccp_d1_%') AS functions,
              (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'allowance_usage_rollup%') AS triggers`,
    )).rows[0];
    expect(left).toEqual({ tables: 0, columns: 0, functions: 0, triggers: 0 });
    expect(await ledgerFingerprint(pg)).toEqual(before);
    await pg.query(readFileSync(CCP_D1_MIGRATION, 'utf8'));
    expect((await svc.reconcile('sign')).status).toBe('NOT_RUN');
    expect((await svc.run()).metrics[0]).toMatchObject({ mode: 'FULL', reconciliation: 'RECONCILED' });
    await expectLedgerEqualsRollups();
  });
});
