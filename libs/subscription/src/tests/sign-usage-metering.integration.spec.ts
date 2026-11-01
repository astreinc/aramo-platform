import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BillingProviderUnavailableError } from '../lib/billing/billing-provider.port.js';
import type { MeterEventReport, UsageMeterReportPort } from '../lib/billing/usage-meter.port.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SIGN_PRODUCT_KEY } from '../lib/product-registry.js';
import { planVersionTerms } from '../lib/plan-version.js';
import { METERED_UNIT_KEYS } from '../lib/usage/metered-units.js';
import { MeteredUsageService } from '../lib/usage/metered-usage.service.js';
import { UsagePeriodReconciliationService } from '../lib/usage/usage-period-reconciliation.service.js';
import { UsageProviderReportService } from '../lib/usage/usage-provider-report.service.js';

import { applyCcpA6Schema } from './support/ccp-a3-database.js';
import { BUSINESS, newTenant, rawSubscription } from './support/ccp-a6.js';

// Sign usage metering (Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §3 item 2, §5 D-2;
// Amendment A1 §A1.1; Amendment A3 D1/D3) on real Postgres 17 with the full migration chain. Stripe
// is a fake meter port (no network, no key).
//   REG     the MeteredUnit registry equals the code mirror; governed; never an envelope unit
//   D1      unit prices live in PlanVersion.content (content_checksum covers them); a published
//           version's prices are immutable; no existing version changed; none seeded (dark)
//   DARK    flag unset: check and record refuse USAGE_BILLING_DISABLED and write nothing
//   GATE    fail closed: no subscription, a non-sending subscription, a unit not priced on the
//           version, an unknown unit, invalid input, a closed billing period
//   REC     a priced record appends one entry (version, checksum, price, period) and a PENDING report
//   IDEM    replay, conflict, and concurrent records of one key (one row)
//   LEDGER  append-only (UPDATE / DELETE / TRUNCATE refused); the INSERT trigger re-derives the
//           effective version, its checksum and its price; another tenant's subscription refused
//   EFF     each event is priced with the version effective at occurred_at (pin history)
//   AGG     the period aggregation (per unit, current period only, priced units with no usage)
//   RPT     provider reporting: held, skipped, reported once by identifier under the unit's meter
//           event name, retry with backoff, refused; terminal rows immutable
//   RECON   the billing-period reconciliation: refused while open; MATCHED / MISMATCH /
//           NOT_PROVIDER_BILLED; idempotent replay; a different invoice refused; append-only
//   COMP    the compensating SQL refuses with data and applies on an empty install

const T0 = new Date('2026-11-10T12:00:00.000Z');
const ON = { SIGN_USAGE_BILLING_ENABLED: '1' };
const OFF = {};
const TEST_PLAN = '019a0000-5150-7000-8000-00000000d201';
const TEST_PLAN_KEY = 'aramo-sign-usage-test';
const MIGRATION = resolve(__dirname, '../../prisma/migrations/20261101300000_sign_usage_metering/migration.sql');
const COMPENSATING = resolve(__dirname, 'fixtures/sign-usage-metering-compensating.sql');

class FakeMeterPort implements UsageMeterReportPort {
  readonly provider = 'STRIPE' as const;
  live = false;
  configured = true;
  sent: MeterEventReport[] = [];
  fail: BillingProviderUnavailableError | null = null;
  mode(): 'test' | 'live' {
    return this.live ? 'live' : 'test';
  }
  meterReportingConfigured(): boolean {
    return this.configured;
  }
  async reportMeterEvent(e: MeterEventReport): Promise<{ provider_event_ref: string }> {
    if (this.fail !== null) throw this.fail;
    this.sent.push(e);
    return { provider_event_ref: e.identifier };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign usage metering (real Postgres 17)', { timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let on: MeteredUsageService;
  let off: MeteredUsageService;
  let V1: string;
  const now = T0;

  const one = async (sql: string, p: unknown[] = []) => (await pg.query(sql, p)).rows[0];
  async function dbError(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
      return 'OK';
    } catch (e) {
      return (e as Error).message;
    }
  }
  /** A DRAFT of the test plan whose content carries these unit prices (A3 D1), then published (the prior version retired). */
  async function publishPriced(prices: Array<{ unit: string; price: number }>): Promise<string> {
    const n = (await one(`SELECT coalesce(max(version_number), 0)::int + 1 AS n FROM subscription."PlanVersion" WHERE plan_id = $1`, [TEST_PLAN])).n as number;
    const id = randomUUID();
    const unit_prices = [...prices].sort((a, b) => (a.unit < b.unit ? -1 : 1)).map((p) => ({ unit_key: p.unit, unit_price_minor: p.price, currency: 'USD' }));
    await pg.query(
      `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
       SELECT $1::uuid, $2::uuid, $3, 'DRAFT', x.c, subscription.ccp_plan_version_checksum(x.c), 'test', now()
         FROM (SELECT CASE WHEN jsonb_array_length($4::jsonb) = 0 THEN subscription.ccp_plan_live_content($2::uuid)
                           ELSE subscription.ccp_plan_live_content($2::uuid) || jsonb_build_object('unit_prices', $4::jsonb) END AS c) x`,
      [id, TEST_PLAN, n, JSON.stringify(unit_prices)],
    );
    await pg.query(`UPDATE subscription."PlanVersion" SET status = 'RETIRED', retired_at = now() WHERE plan_id = $1 AND status = 'PUBLISHED'`, [TEST_PLAN]);
    await pg.query(`UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [id]);
    return id;
  }
  /** A BUSINESS tenant with an open subscription on the test plan's current version. */
  async function tenantOn(o: { stripe?: boolean; status?: string } = {}): Promise<{ t: string; s: string }> {
    const t = await newTenant(pg);
    const s = await rawSubscription(pg, t, { source: o.stripe === true ? 'SELF_SERVICE' : 'MANUAL', plan: TEST_PLAN_KEY, ref: o.stripe === true ? `sub_${t}` : undefined, status: o.status });
    return { t, s };
  }
  const rec = (svc: MeteredUsageService, t: string, over: Partial<{ unit: string; quantity: number; idempotency_key: string; source_ref: string; occurred_at: Date }> = {}) =>
    svc.record({ tenant_id: t, unit: 'sign.sms_message', quantity: 1, idempotency_key: `k-${randomUUID()}`, source_ref: 'sign:envelope:test', ...over });
  const ledgerCount = async (t: string) => (await one(`SELECT count(*)::int n FROM subscription."UsageLedgerEntry" WHERE tenant_id = $1`, [t])).n as number;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    // The test plan: a copy of Standard Business (its live rows), with no version yet.
    await pg.query(
      `INSERT INTO subscription."Plan" (id, key, name, sellable, description, tenant_kind, sales_model, status, display_order, product_key)
       SELECT $1::uuid, $2, 'Usage test', false, description, tenant_kind, 'CONTACT_SALES', 'ACTIVE', 953, product_key FROM subscription."Plan" WHERE key = $3`,
      [TEST_PLAN, TEST_PLAN_KEY, BUSINESS],
    );
    for (const t of ['PlanAllowance', 'PlanCapacity', 'PlanFeature', 'PlanAllowanceWindow']) {
      const cols = (await pg.query(`SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) c FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name = $1 AND column_name <> 'plan_id'`, [t])).rows[0].c;
      if (cols !== null) await pg.query(`INSERT INTO subscription."${t}" (plan_id, ${cols}) SELECT $1::uuid, ${cols} FROM subscription."${t}" WHERE plan_id = (SELECT id FROM subscription."Plan" WHERE key = $2)`, [TEST_PLAN, BUSINESS]);
    }
    // v1: SMS at 36, WhatsApp at 5; ID verification and every other unit NOT SOLD (absent).
    V1 = await publishPriced([
      { unit: 'sign.sms_message', price: 36 },
      { unit: 'sign.whatsapp_message', price: 5 },
    ]);
    on = new MeteredUsageService(prisma, { env: ON, clock: () => now });
    off = new MeteredUsageService(prisma, { env: OFF, clock: () => now });
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  // ---- REG / PRICE ----------------------------------------------------------------------------

  it('REG-1 the DB registry equals METERED_UNIT_KEYS (all sign), and it is governed', async () => {
    const rows = (await pg.query(`SELECT unit_key, product_key FROM subscription."MeteredUnit" ORDER BY unit_key`)).rows;
    expect(rows.map((r) => r.unit_key)).toEqual([...METERED_UNIT_KEYS].sort());
    expect(new Set(rows.map((r) => r.product_key))).toEqual(new Set(['sign']));
    expect(await dbError(`UPDATE subscription."MeteredUnit" SET name = 'x' WHERE unit_key = 'sign.kba'`)).toMatch(/governed registry/);
    expect(await dbError(`DELETE FROM subscription."MeteredUnit" WHERE unit_key = 'sign.kba'`)).toMatch(/governed registry/);
    expect(await dbError(`INSERT INTO subscription."MeteredUnit" VALUES ('ats.sms', 'sign', 'x', 'message', 'x', now())`)).toMatch(/check constraint/);
  });

  it('REG-2 the envelope allowance is never a metered unit (A3 D3)', async () => {
    expect(await dbError(`INSERT INTO subscription."MeteredUnit" VALUES ('sign.envelopes', 'sign', 'x', 'message', 'x', now())`)).toMatch(/not_envelope_check/);
  });

  it('D1-1 no unit price is seeded and no pre-existing version changed: every other version has no unit_prices and verifies', async () => {
    const rows = (await pg.query(`SELECT id, content, content_checksum FROM subscription."PlanVersion" WHERE plan_id <> $1`, [TEST_PLAN])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.content).not.toHaveProperty('unit_prices');
      expect(planVersionTerms(r).unit_prices).toBeUndefined();
    }
  });

  it('D1-2 the unit prices are approved content: covered by content_checksum (TS and SQL agree), immutable once PUBLISHED', async () => {
    const v = await one(`SELECT id, content, content_checksum FROM subscription."PlanVersion" WHERE id = $1`, [V1]);
    expect(planVersionTerms(v).unit_prices).toEqual([
      { unit_key: 'sign.sms_message', unit_price_minor: 36, currency: 'USD' },
      { unit_key: 'sign.whatsapp_message', unit_price_minor: 5, currency: 'USD' },
    ]);
    const unpriced = await one(`SELECT subscription.ccp_plan_version_checksum(content - 'unit_prices') AS c FROM subscription."PlanVersion" WHERE id = $1`, [V1]);
    expect(unpriced.c).not.toBe(v.content_checksum);
    expect(await dbError(`UPDATE subscription."PlanVersion" SET content = jsonb_set(content, '{unit_prices,0,unit_price_minor}', '1') WHERE id = $1`, [V1])).toMatch(/immutable|checksum/);
    expect(await one(`SELECT subscription.sign_plan_version_unit_price($1::uuid, 'sign.sms_message') AS p`, [V1])).toEqual({ p: 36 });
    expect(await one(`SELECT subscription.sign_plan_version_unit_price($1::uuid, 'sign.kba') AS p`, [V1])).toEqual({ p: null });
  });

  // ---- DARK / GATE ----------------------------------------------------------------------------

  it('DARK-1 flag unset: check and record refuse USAGE_BILLING_DISABLED and write nothing', async () => {
    const { t } = await tenantOn();
    expect(await off.check({ tenant_id: t, unit: 'sign.sms_message' })).toMatchObject({ ok: false, reason: 'USAGE_BILLING_DISABLED' });
    expect(await rec(off, t)).toMatchObject({ ok: false, reason: 'USAGE_BILLING_DISABLED' });
    expect(await ledgerCount(t)).toBe(0);
    expect(off.enabled()).toBe(false);
    expect(new MeteredUsageService(prisma, { env: { SIGN_USAGE_BILLING_ENABLED: 'true' } }).enabled()).toBe(false);
  });

  it('GATE-1 fail closed: no subscription, a non-sending one, an unpriced unit, a NULL price, a unit not on the version', async () => {
    const none = await newTenant(pg);
    expect(await on.check({ tenant_id: none, unit: 'sign.sms_message' })).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED' });
    expect(await rec(on, none)).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED' });
    const canceled = await tenantOn({ status: 'INCOMPLETE' });
    expect(await rec(on, canceled.t)).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED' });
    const { t } = await tenantOn();
    expect(await rec(on, t, { unit: 'sign.id_verification' })).toMatchObject({ ok: false, reason: 'UNIT_NOT_SOLD' });
    expect(await rec(on, t, { unit: 'sign.qes_signature' })).toMatchObject({ ok: false, reason: 'UNIT_NOT_SOLD' });
    // The previous billing period (October) closed an hour after it ended: a late event for it is refused.
    expect(await rec(on, t, { occurred_at: new Date('2026-10-20T00:00:00.000Z') })).toMatchObject({ ok: false, reason: 'PERIOD_CLOSED' });
    // A subscriber on a plan whose version prices nothing (the shipped catalog) is refused too.
    const shipped = await newTenant(pg);
    await rawSubscription(pg, shipped, { source: 'MANUAL' });
    expect(await rec(on, shipped)).toMatchObject({ ok: false, reason: 'UNIT_NOT_SOLD' });
    expect(await ledgerCount(t)).toBe(0);
  });

  it('GATE-2 input: unknown unit, bad tenant, quantity, key, source_ref and occurred_at are refused before any read', async () => {
    const { t } = await tenantOn();
    expect(await rec(on, t, { unit: 'sign.envelopes' })).toMatchObject({ ok: false, reason: 'UNKNOWN_UNIT' });
    expect(await on.check({ tenant_id: 'not-a-uuid', unit: 'sign.sms_message' })).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
    for (const over of [{ quantity: 0 }, { quantity: 1.5 }, { quantity: 100_001 }, { idempotency_key: '' }, { idempotency_key: 'x'.repeat(201) }, { source_ref: '' }, { occurred_at: new Date(T0.getTime() + 6 * 60_000) }, { occurred_at: new Date(T0.getTime() - 36 * 86_400_000) }]) {
      expect(await rec(on, t, over)).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
    }
    expect(await ledgerCount(t)).toBe(0);
  });

  // ---- REC / IDEM / LEDGER --------------------------------------------------------------------

  it('REC-1 a priced record appends one entry with the version, price and period snapshot, and a PENDING report', async () => {
    const { t, s } = await tenantOn();
    expect(await on.check({ tenant_id: t, unit: 'sign.sms_message' })).toEqual({ ok: true, unit: 'sign.sms_message', unit_price_minor: 36, currency: 'USD', plan_version_id: V1 });
    const r = await rec(on, t, { quantity: 3, idempotency_key: 'sms-1', source_ref: 'sign:envelope:abc' });
    expect(r).toMatchObject({ ok: true, replayed: false, unit: 'sign.sms_message', quantity: 3, unit_price_minor: 36, amount_minor: 108, currency: 'USD' });
    if (!r.ok) throw new Error('expected ok');
    // rawSubscription anchors on 2026-10-01: T0 (Nov 10) is in the period Nov 1 → Dec 1.
    expect(r.period_start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(r.period_end.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    const row = await one(`SELECT * FROM subscription."UsageLedgerEntry" WHERE id = $1`, [r.entry_id]);
    const v1sum = (await one(`SELECT content_checksum FROM subscription."PlanVersion" WHERE id = $1`, [V1])).content_checksum as string;
    expect(row).toMatchObject({ tenant_id: t, product_key: 'sign', subscription_id: s, plan_version_id: V1, plan_version_checksum: v1sum, quantity: 3, unit_price_minor: 36, amount_minor: '108', source_ref: 'sign:envelope:abc' });
    const rep = await one(`SELECT * FROM subscription."UsageProviderReport" WHERE ledger_entry_id = $1`, [r.entry_id]);
    expect(rep).toMatchObject({ tenant_id: t, state: 'PENDING', attempts: 0, reason: null });
  });

  it('IDEM-1 the same key replays (no second row); a different event under the key is IDEMPOTENCY_CONFLICT; concurrent records write one row', async () => {
    const { t } = await tenantOn();
    const a = await rec(on, t, { idempotency_key: 'k1', quantity: 2 });
    const b = await rec(on, t, { idempotency_key: 'k1', quantity: 2 });
    expect(b).toMatchObject({ ok: true, replayed: true, amount_minor: 72 });
    expect(a.ok && b.ok && a.entry_id === b.entry_id).toBe(true);
    expect(await rec(on, t, { idempotency_key: 'k1', quantity: 3 })).toMatchObject({ ok: false, reason: 'IDEMPOTENCY_CONFLICT' });
    expect(await rec(on, t, { idempotency_key: 'k1', quantity: 2, unit: 'sign.whatsapp_message' })).toMatchObject({ ok: false, reason: 'IDEMPOTENCY_CONFLICT' });
    // A replay is answered even after billing is switched off.
    expect(await rec(off, t, { idempotency_key: 'k1', quantity: 2 })).toMatchObject({ ok: true, replayed: true });
    const many = await Promise.all(Array.from({ length: 6 }, () => rec(on, t, { idempotency_key: 'k-race' })));
    expect(many.every((r) => r.ok)).toBe(true);
    expect(new Set(many.map((r) => (r.ok ? r.entry_id : '')))).toHaveProperty('size', 1);
    expect(many.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
    expect(await ledgerCount(t)).toBe(2);
    // The same key under ANOTHER tenant is a different event.
    const other = await tenantOn();
    expect(await rec(on, other.t, { idempotency_key: 'k1', quantity: 2 })).toMatchObject({ ok: true, replayed: false });
  });

  it('LEDGER-1 append-only: UPDATE, DELETE and TRUNCATE refused; an INSERT at a price the version does not have is refused', async () => {
    const { t, s } = await tenantOn();
    const r = await rec(on, t);
    if (!r.ok) throw new Error('expected ok');
    expect(await dbError(`UPDATE subscription."UsageLedgerEntry" SET quantity = 9 WHERE id = $1`, [r.entry_id])).toMatch(/append-only/);
    expect(await dbError(`DELETE FROM subscription."UsageLedgerEntry" WHERE id = $1`, [r.entry_id])).toMatch(/append-only/);
    expect(await dbError(`TRUNCATE subscription."UsageLedgerEntry" CASCADE`)).toMatch(/append-only/);
    const v1sum = (await one(`SELECT content_checksum FROM subscription."PlanVersion" WHERE id = $1`, [V1])).content_checksum as string;
    const ins = (unit: string, price: number, o: { tenant?: string; version?: string; checksum?: string } = {}) =>
      dbError(
        `INSERT INTO subscription."UsageLedgerEntry" (id, tenant_id, product_key, unit_key, quantity, occurred_at, recorded_at, idempotency_key, source_ref, subscription_id, plan_version_id, plan_version_checksum, period_start, period_end, unit_price_minor, currency, amount_minor)
         VALUES (gen_random_uuid(), $1, 'sign', $2, 1, '2026-11-10T12:00:00Z', now(), $3, 'x', $4, $5, $7, '2026-11-01', '2026-12-01', $6, 'USD', $6)`,
        [o.tenant ?? t, unit, randomUUID(), s, o.version ?? V1, price, o.checksum ?? v1sum],
      );
    expect(await ins('sign.sms_message', 1)).toMatch(/does not match the approved price/);
    expect(await ins('sign.id_verification', 0)).toMatch(/is not sold on plan version/);
    expect(await ins('sign.kba', 0)).toMatch(/is not sold on plan version/);
    expect(await ins('sign.sms_message', 36, { checksum: '0'.repeat(64) })).toMatch(/plan_version_checksum does not match/);
    expect(await ins('sign.sms_message', 36, { tenant: await newTenant(pg) })).toMatch(/is not the tenant's/);
    const other = (await one(`SELECT id FROM subscription."PlanVersion" WHERE plan_id <> $1 AND status = 'PUBLISHED' LIMIT 1`, [TEST_PLAN])).id as string;
    expect(await ins('sign.sms_message', 36, { version: other })).toMatch(/not the version effective at occurred_at/);
    expect(await ins('sign.sms_message', 36)).toBe('OK');
    expect(await dbError(`DELETE FROM subscription."UsageProviderReport" WHERE ledger_entry_id = $1`, [r.entry_id])).toMatch(/never deleted/);
  });

  // ---- GF / AGG ---------------------------------------------------------------------------------

  it('GF-1 grandfathering: v2 re-prices new subscribers only; a v1 subscriber keeps the v1 price', async () => {
    const before = await tenantOn();
    const v2 = await publishPriced([{ unit: 'sign.sms_message', price: 50 }]);
    try {
      const after = await tenantOn();
      expect(await rec(on, before.t)).toMatchObject({ ok: true, unit_price_minor: 36 });
      expect(await rec(on, after.t)).toMatchObject({ ok: true, unit_price_minor: 50 });
      // WhatsApp is not on v2: a v2 subscriber is refused, the v1 subscriber is not.
      expect(await rec(on, after.t, { unit: 'sign.whatsapp_message' })).toMatchObject({ ok: false, reason: 'UNIT_NOT_SOLD' });
      expect(await rec(on, before.t, { unit: 'sign.whatsapp_message' })).toMatchObject({ ok: true, unit_price_minor: 5 });
    } finally {
      // Restore v1 as the published version for the later cases (a v2 subscriber row stays pinned to v2).
      await pg.query(`UPDATE subscription."PlanVersion" SET status = 'RETIRED', retired_at = now() WHERE id = $1`, [v2]);
      const v3 = await publishPriced([
        { unit: 'sign.sms_message', price: 36 },
        { unit: 'sign.whatsapp_message', price: 5 },
      ]);
      V1 = v3;
    }
  });

  it('EFF-1 each event is priced with the version effective at occurred_at: before a re-pin the old version, after it the new one', async () => {
    const { t, s } = await tenantOn();
    const from = (await one(`SELECT plan_version_id FROM subscription."TenantSubscription" WHERE id = $1`, [s])).plan_version_id as string;
    const v4 = await publishPriced([{ unit: 'sign.sms_message', price: 41 }]);
    try {
      await pg.query('BEGIN');
      await pg.query(`SET LOCAL aramo.subscription_pin_reason = 'PROVIDER_PLAN_CHANGE'`);
      await pg.query(`UPDATE subscription."TenantSubscription" SET plan_version_id = $2::uuid WHERE id = $1::uuid`, [s, v4]);
      await pg.query('COMMIT');
      const pinAt = (await one(`SELECT recorded_at FROM subscription."SubscriptionVersionPinEvent" WHERE subscription_id = $1`, [s])).recorded_at as Date;
      await new Promise((r) => setTimeout(r, 20));
      const live = new MeteredUsageService(prisma, { env: ON });
      const before = await rec(live, t, { occurred_at: new Date(pinAt.getTime() - 1) });
      const after = await rec(live, t, { occurred_at: new Date() });
      expect(before).toMatchObject({ ok: true, unit_price_minor: 36 });
      expect(after).toMatchObject({ ok: true, unit_price_minor: 41 });
      if (!before.ok || !after.ok) throw new Error('expected ok');
      const rows = (await pg.query(`SELECT id, plan_version_id FROM subscription."UsageLedgerEntry" WHERE id = ANY($1::uuid[])`, [[before.entry_id, after.entry_id]])).rows;
      expect(new Map(rows.map((r) => [r.id, r.plan_version_id]))).toEqual(new Map([[before.entry_id, from], [after.entry_id, v4]]));
    } finally {
      await pg.query(`UPDATE subscription."PlanVersion" SET status = 'RETIRED', retired_at = now() WHERE id = $1`, [v4]);
      V1 = await publishPriced([
        { unit: 'sign.sms_message', price: 36 },
        { unit: 'sign.whatsapp_message', price: 5 },
      ]);
    }
  });

  it('AGG-1 the period summary: per-unit quantity and amount in the current period, priced units with no usage, earlier periods excluded', async () => {
    const { t } = await tenantOn();
    await rec(on, t, { quantity: 2 });
    await rec(on, t, { quantity: 1 });
    await rec(on, t, { unit: 'sign.whatsapp_message', quantity: 4 });
    // October usage recorded while October was open stays in October (a summary is per period).
    const octSvc = new MeteredUsageService(prisma, { env: ON, clock: () => new Date('2026-10-25T00:00:00.000Z') });
    await rec(octSvc, t, { quantity: 5, occurred_at: new Date('2026-10-20T00:00:00.000Z') });
    const s = await on.periodSummary(t, SIGN_PRODUCT_KEY, T0);
    expect(s).not.toBeNull();
    expect(s!.period_start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(s!.units).toEqual([
      { unit_key: 'sign.sms_message', name: 'SMS delivery', quantity_label: 'message', quantity: 3, unit_price_minor: 36, amount_minor: 108 },
      { unit_key: 'sign.whatsapp_message', name: 'WhatsApp delivery', quantity_label: 'message', quantity: 4, unit_price_minor: 5, amount_minor: 20 },
    ]);
    expect(s!.total_amount_minor).toBe(128);
    const oct = await on.periodSummary(t, SIGN_PRODUCT_KEY, new Date('2026-10-15T00:00:00.000Z'));
    expect(oct!.units.find((u) => u.unit_key === 'sign.sms_message')).toMatchObject({ quantity: 5, amount_minor: 180 });
    const fresh = await tenantOn();
    expect((await on.periodSummary(fresh.t, SIGN_PRODUCT_KEY, T0))!.units.map((u) => [u.unit_key, u.quantity])).toEqual([
      ['sign.sms_message', 0],
      ['sign.whatsapp_message', 0],
    ]);
    expect(await on.periodSummary(await newTenant(pg), SIGN_PRODUCT_KEY, T0)).toBeNull();
  });

  // ---- RPT ------------------------------------------------------------------------------------

  it('RPT-1 provider reporting: held while dark / live / unconfigured; MANUAL skipped; no meter deferred; reported once by identifier; retry and refusal; terminal rows immutable', async () => {
    const port = new FakeMeterPort();
    const offR = new UsageProviderReportService(prisma, port, { env: OFF });
    const onR = new UsageProviderReportService(prisma, port, { env: ON });
    // Drain everything earlier cases left so this case counts its own rows.
    await onR.dispatchDue(new Date(T0.getTime() + 365 * 86_400_000), 10_000);
    port.sent = [];
    const stripe = await tenantOn({ stripe: true });
    const manual = await tenantOn();
    const sms = await rec(on, stripe.t, { quantity: 2, idempotency_key: 'rpt-sms' });
    const wa = await rec(on, stripe.t, { unit: 'sign.whatsapp_message', idempotency_key: 'rpt-wa' });
    const man = await rec(on, manual.t, { idempotency_key: 'rpt-man' });
    if (!sms.ok || !wa.ok || !man.ok) throw new Error('expected ok');
    const state = async (id: string) => one(`SELECT state, reason, attempts, provider_event_ref FROM subscription."UsageProviderReport" WHERE ledger_entry_id = $1`, [id]);

    expect(await offR.dispatchDue(T0)).toMatchObject({ held: 'DISABLED', claimed: 0 });
    port.live = true;
    expect(await onR.dispatchDue(T0)).toMatchObject({ held: 'LIVE_MODE', claimed: 0 });
    port.live = false;
    port.configured = false;
    expect(await onR.dispatchDue(T0)).toMatchObject({ held: 'NOT_CONFIGURED', claimed: 0 });
    port.configured = true;

    const tick = await onR.dispatchDue(T0);
    expect(tick).toMatchObject({ held: null, claimed: 3, reported: 2, skipped: 1, deferred: 0, failed: 0 });
    expect(new Set(port.sent.map((e) => JSON.stringify(e)))).toEqual(
      new Set([
        JSON.stringify({ event_name: 'aramo_sign_sms_message', account_ref: `acct_${stripe.t}`, value: 2, identifier: sms.entry_id, occurred_at: T0 }),
        JSON.stringify({ event_name: 'aramo_sign_whatsapp_message', account_ref: `acct_${stripe.t}`, value: 1, identifier: wa.entry_id, occurred_at: T0 }),
      ]),
    );
    expect(await state(sms.entry_id)).toMatchObject({ state: 'REPORTED', attempts: 1, provider_event_ref: sms.entry_id });
    expect(await state(man.entry_id)).toMatchObject({ state: 'SKIPPED', reason: 'NOT_PROVIDER_BILLED' });
    expect(await state(wa.entry_id)).toMatchObject({ state: 'REPORTED', attempts: 1 });
    // Nothing is sent twice: the next tick has nothing due.
    expect(await onR.dispatchDue(T0)).toMatchObject({ claimed: 0 });
    expect(port.sent).toHaveLength(2);
    expect(await dbError(`UPDATE subscription."UsageProviderReport" SET state = 'PENDING', reported_at = NULL WHERE ledger_entry_id = $1`, [sms.entry_id])).toMatch(/terminal/);

    // Retry: a transient provider error backs off; a refusal fails the row.
    const r2 = await rec(on, stripe.t, { idempotency_key: 'rpt-retry' });
    const r3 = await rec(on, stripe.t, { idempotency_key: 'rpt-refused' });
    if (!r2.ok || !r3.ok) throw new Error('expected ok');
    port.fail = new BillingProviderUnavailableError('HTTP 503', true);
    await onR.dispatchDue(T0);
    expect(await state(r2.entry_id)).toMatchObject({ state: 'PENDING', reason: 'PROVIDER_UNAVAILABLE', attempts: 1 });
    const next = (await one(`SELECT next_attempt_at FROM subscription."UsageProviderReport" WHERE ledger_entry_id = $1`, [r2.entry_id])).next_attempt_at as Date;
    expect(next.getTime()).toBe(T0.getTime() + 60_000);
    port.fail = new BillingProviderUnavailableError('HTTP 400', false);
    await onR.dispatchDue(new Date(T0.getTime() + 61_000));
    expect(await state(r2.entry_id)).toMatchObject({ state: 'FAILED', reason: 'PROVIDER_REFUSED', attempts: 2 });
    expect(await state(r3.entry_id)).toMatchObject({ state: 'FAILED', reason: 'PROVIDER_REFUSED' });
    port.fail = null;

    expect(port.sent).toHaveLength(2);
  });

  // ---- RECON ----------------------------------------------------------------------------------

  it('RECON-1 the billing-period reconciliation: refused while open; MATCHED / MISMATCH; idempotent replay; a different invoice refused; NOT_PROVIDER_BILLED; append-only', async () => {
    const stripe = await tenantOn({ stripe: true });
    const manual = await tenantOn();
    await rec(on, stripe.t, { quantity: 200 });
    await rec(on, stripe.t, { quantity: 10, unit: 'sign.whatsapp_message' });
    await rec(on, manual.t, { quantity: 3 });
    const nov = new Date('2026-11-01T00:00:00.000Z');
    const open = new UsagePeriodReconciliationService(prisma, { clock: () => new Date('2026-12-01T00:30:00.000Z') });
    const closed = new UsagePeriodReconciliationService(prisma, { clock: () => new Date('2026-12-01T02:00:00.000Z') });
    const invoice = (sms: number, wa: number) => ({
      provider: 'STRIPE' as const,
      invoice_ref: 'in_test_1',
      currency: 'USD' as const,
      lines: [
        { unit_key: 'sign.sms_message', quantity: sms, amount_minor: sms * 36 },
        { unit_key: 'sign.whatsapp_message', quantity: wa, amount_minor: wa * 5 },
      ],
    });
    await expect(open.reconcilePeriod({ subscription_id: stripe.s, period_start: nov, invoice: invoice(200, 10), reconciled_by: 'test' })).rejects.toMatchObject({ code: 'PERIOD_OPEN' });
    await expect(closed.reconcilePeriod({ subscription_id: stripe.s, period_start: new Date('2026-11-02T00:00:00.000Z'), invoice: invoice(200, 10), reconciled_by: 'test' })).rejects.toMatchObject({ code: 'INVALID_PERIOD' });
    await expect(closed.reconcilePeriod({ subscription_id: stripe.s, period_start: nov, invoice: null, reconciled_by: 'test' })).rejects.toMatchObject({ code: 'INVOICE_REQUIRED' });

    const a = await closed.reconcilePeriod({ subscription_id: stripe.s, period_start: nov, invoice: invoice(200, 10), reconciled_by: 'test' });
    expect(a).toMatchObject({ outcome: 'MATCHED', replayed: false, ledger_entry_count: 2, ledger_amount_minor: 7250, provider_amount_minor: 7250, discrepancies: [] });
    const again = await closed.reconcilePeriod({ subscription_id: stripe.s, period_start: nov, invoice: invoice(200, 10), reconciled_by: 'test' });
    expect(again).toMatchObject({ id: a.id, replayed: true, outcome: 'MATCHED' });
    await expect(closed.reconcilePeriod({ subscription_id: stripe.s, period_start: nov, invoice: invoice(400, 10), reconciled_by: 'test' })).rejects.toMatchObject({ code: 'RECONCILIATION_CONFLICT' });
    expect((await one(`SELECT count(*)::int n FROM subscription."UsagePeriodReconciliation" WHERE subscription_id = $1`, [stripe.s])).n).toBe(1);

    // A double-counted invoice (every SMS twice) is a MISMATCH on another subscription.
    const dup = await tenantOn({ stripe: true });
    await rec(on, dup.t, { quantity: 200 });
    const m = await closed.reconcilePeriod({ subscription_id: dup.s, period_start: nov, invoice: { ...invoice(400, 0), lines: [{ unit_key: 'sign.sms_message', quantity: 400, amount_minor: 14400 }] }, reconciled_by: 'test' });
    expect(m).toMatchObject({ outcome: 'MISMATCH', discrepancies: [{ unit_key: 'sign.sms_message', ledger_quantity: 200, provider_quantity: 400, ledger_amount_minor: 7200, provider_amount_minor: 14400 }] });

    await expect(closed.reconcilePeriod({ subscription_id: manual.s, period_start: nov, invoice: invoice(3, 0), reconciled_by: 'test' })).rejects.toMatchObject({ code: 'INVOICE_NOT_EXPECTED' });
    expect(await closed.reconcilePeriod({ subscription_id: manual.s, period_start: nov, invoice: null, reconciled_by: 'test' })).toMatchObject({ outcome: 'NOT_PROVIDER_BILLED', ledger_amount_minor: 108, provider_invoice_ref: null });

    expect(await dbError(`UPDATE subscription."UsagePeriodReconciliation" SET outcome = 'MATCHED' WHERE id = $1`, [m.id])).toMatch(/append-only/);
    expect(await dbError(`DELETE FROM subscription."UsagePeriodReconciliation" WHERE id = $1`, [m.id])).toMatch(/append-only/);
  });

  // ---- COMP -----------------------------------------------------------------------------------

  it('COMP-1 the compensating SQL is refused while the ledger has entries, and applies (then the migration re-applies) on an empty install', async () => {
    await pg.query('BEGIN');
    try {
      await expect(pg.query(readFileSync(COMPENSATING, 'utf8'))).rejects.toThrow(/compensation refused/);
    } finally {
      await pg.query('ROLLBACK');
    }
    await pg.query('CREATE DATABASE usage_comp');
    const c = new Client({ connectionString: container.getConnectionUri().replace(/\/[^/?]+(\?|$)/, '/usage_comp$1') });
    await c.connect();
    try {
      await applyCcpA6Schema(c);
      await c.query(readFileSync(COMPENSATING, 'utf8'));
      const left = await c.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema = 'subscription' AND table_name IN ('MeteredUnit', 'UsageLedgerEntry', 'UsageProviderReport', 'UsagePeriodReconciliation')`);
      expect(left.rows[0].n).toBe(0);
      await c.query(readFileSync(MIGRATION, 'utf8'));
      expect((await c.query(`SELECT count(*)::int n FROM subscription."MeteredUnit"`)).rows[0].n).toBe(METERED_UNIT_KEYS.length);
    } finally {
      await c.end();
    }
  });
});
