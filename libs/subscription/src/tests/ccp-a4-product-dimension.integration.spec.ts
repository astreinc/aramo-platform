import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AllowanceService } from '../lib/allowance.service.js';
import type { BillingProviderPort, ProviderSubscriptionState } from '../lib/billing/billing-provider.port.js';
import type { PlanEligibilityPort } from '../lib/billing/plan-eligibility.port.js';
import { SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import { CapacityService } from '../lib/capacity.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  PRODUCT_KEYS,
  ProductContextError,
  SIGN_PRODUCT_KEY,
  assertMeteredKeyOf,
  assertProductKey,
  isProductKey,
  productOfMeteredKey,
  type ProductKey,
} from '../lib/product-registry.js';

import { CCP_A4_COMPENSATING, CCP_A4_MIGRATION, ISOLATION_TEST_PRODUCT_KEY, registerIsolationTestProduct } from './fixtures/ccp-a4.js';
import { publishTestPlanV1, publishedVersionOf } from './fixtures/ccp-a5.js';
import { FakeOrganizationBillingProfile } from './fixtures/organization-billing-profile.fake.js';

// CCP-A4 (PBD §5.1 A4 row; MP-A2 N-6, N-7, N-9, N-11, N-12; PBD §7.1 A0-C7) on real Postgres 17:
//   registry   the shipped registry is sign only, in the DB and in code, and REJECTS the test key
//   default    no DB default exists on any new column; a write that omits one fails
//   N-7        a subscription's product must equal its plan's (composite FK)
//   index      one open BASE subscription per (tenant, product); the live-table swap is reversible
//              while every row is sign (the recorded compensating SQL), and re-applicable
//   N-12       a tenant holding an open sign AND an open second-product subscription: every Sign
//              path reads the sign row only; checkout, webhook, reconcile and eligibility refresh
//              never end, re-point or read the other row; removing it leaves Sign results identical

const ROOT = resolve(__dirname, '../../../..');
const SUB_DIR = resolve(ROOT, 'libs/subscription/prisma/migrations');
const ALL = [
  resolve(ROOT, 'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'),
  ...readdirSync(SUB_DIR)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(SUB_DIR, n, 'migration.sql')),
];
// CCP-A5: the replay below exercises A4 alone, so only the migrations BEFORE A4 precede it.
const PRE_A4 = ALL.slice(0, ALL.indexOf(CCP_A4_MIGRATION));
const ISO = ISOLATION_TEST_PRODUCT_KEY;
const KEY = 'sign.envelopes';
const STORAGE = 'sign.storage_bytes';
const AT = new Date('2026-10-18T12:00:00.000Z');
const INCLUDED = '019a0000-5150-7000-8000-000000000001';
const BUSINESS_KEY = 'aramo-sign-standard-business-v1';
const ISO_PLAN = '019a0000-a4a4-7000-8000-0000000000e1';
const ISO_PLAN_KEY = 'ccp-a4-isolation-test-plan';
let seq = 0;
const tenant = (): string => `0190a4a8-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

class FakeBilling implements BillingProviderPort {
  readonly provider = 'STRIPE' as const;
  subs = new Map<string, ProviderSubscriptionState>();
  retrieved: string[] = [];
  checkouts: { intent_id: string; tenant_id: string; account_ref: string | null }[] = [];
  isConfigured(): boolean {
    return true;
  }
  mode(): 'test' {
    return 'test';
  }
  async upsertBillingAccount(account_ref: string | null, d: { tenant_id: string }): Promise<string> {
    return account_ref ?? `cus_${d.tenant_id}`;
  }
  async createCheckoutSession(req: { intent_id: string; tenant_id: string; account_ref: string | null }) {
    this.checkouts.push(req);
    return { session_ref: `cs_${req.intent_id}`, url: `https://checkout.test/${req.intent_id}` };
  }
  async createPortalSession(account_ref: string) {
    return { url: `https://portal.test/${account_ref}` };
  }
  async retrieveSubscription(ref: string): Promise<ProviderSubscriptionState> {
    this.retrieved.push(ref);
    const s = this.subs.get(ref);
    if (s === undefined) throw new Error(`no such subscription ${ref}`);
    return s;
  }
  verifyWebhook(): never {
    throw new Error('not used');
  }
}

const state = (over: Partial<ProviderSubscriptionState> & { subscription_ref: string; tenant_id: string }): ProviderSubscriptionState => ({
  provider: 'STRIPE',
  account_ref: `cus_${over.tenant_id}`,
  provider_status: 'active',
  current_period_start: new Date('2026-10-18T00:00:00Z'),
  current_period_end: new Date('2026-11-18T00:00:00Z'),
  cancel_at_period_end: false,
  price_ref: null,
  intent_id: null,
  account_country: 'US',
  ...over,
});

function filesUnder(dir: string, keep: (p: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'generated' || e === 'dist' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A4 — product dimension (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let allowance: AllowanceService;
  let capacity: CapacityService;
  let billing: FakeBilling;
  let lifecycle: SubscriptionLifecycleService;
  let eligibleAnswer = true;
  const env = { ...process.env };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const m of ALL) await pg.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    allowance = new AllowanceService(prisma);
    capacity = new CapacityService(prisma);
    billing = new FakeBilling();
    const eligibility: PlanEligibilityPort = { isEligible: async () => eligibleAnswer };
    lifecycle = new SubscriptionLifecycleService(prisma, allowance, billing, capacity, eligibility, undefined, new FakeOrganizationBillingProfile());
    process.env['STRIPE_PLAN_PRICES'] = `${BUSINESS_KEY}=price_business,${ISO_PLAN_KEY}=price_iso`;
    delete process.env['BILLING_PAST_DUE_GRACE_DAYS'];
  }, 240_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  async function signRow(t: string, source = 'MANUAL', anchor = '2026-10-01T00:00:00Z', plan = INCLUDED): Promise<string> {
    const r = await pg.query(
      `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ${publishedVersionOf('$2::uuid')}, 'sign', 'BASE', $3::timestamptz, $4, 'ccp-a4') RETURNING id`,
      [t, plan, anchor, source],
    );
    return r.rows[0].id as string;
  }

  // ── Registry (N-6) — BEFORE the test database is widened ────────────────────────────────
  describe('the shipped registry is sign only and rejects the test key', () => {
    it('code registry = DB CHECKs = [sign]', async () => {
      expect([...PRODUCT_KEYS]).toEqual(['sign']);
      const r = await pg.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname IN ('Plan_product_key_registry_check', 'TenantSubscription_product_key_registry_check') ORDER BY conname`,
      );
      expect(r.rows.map((x) => x.conname)).toEqual(['Plan_product_key_registry_check', 'TenantSubscription_product_key_registry_check']);
      for (const row of r.rows) {
        const admitted = [...String(row.def).matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
        expect(admitted).toEqual([...PRODUCT_KEYS].sort());
      }
    });

    it('the production registry rejects the N-12 test key: Plan and TenantSubscription inserts fail', async () => {
      await expect(
        pg.query(`INSERT INTO subscription."Plan" (id, key, name, product_key) VALUES (gen_random_uuid(), 'reject-me', 'x', $1)`, [ISO]),
      ).rejects.toThrow(/Plan_product_key_registry_check/);
      await expect(
        pg.query(
          `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ${publishedVersionOf('$2::uuid')}, $3, 'BASE', now(), 'MANUAL', 'x')`,
          [tenant(), INCLUDED, ISO],
        ),
      ).rejects.toThrow(/TenantSubscription_product_key_registry_check|TenantSubscription_plan_id_product_key_fkey/);
    });

    it('the code registry rejects the test key; services refuse it (fail closed)', async () => {
      expect(isProductKey(ISO)).toBe(false);
      expect(() => assertProductKey(ISO)).toThrow(ProductContextError);
      await expect(allowance.getStatus(tenant(), ISO as ProductKey, KEY, AT)).rejects.toThrow(ProductContextError);
      await expect(capacity.status(tenant(), ISO as ProductKey, STORAGE)).rejects.toThrow(ProductContextError);
      await expect(lifecycle.reconcile(ISO as ProductKey, AT)).rejects.toThrow(ProductContextError);
    });

    it('metered keys map to exactly one product through the declared mapping', () => {
      expect(productOfMeteredKey('sign.envelopes')).toBe('sign');
      expect(productOfMeteredKey('sign.storage_bytes')).toBe('sign');
      expect(productOfMeteredKey('sign.forms')).toBe('sign');
      for (const k of ['ats.envelopes', 'esign.envelopes', 'sign', 'sign.', '', 'core.x', 'constructor.x']) expect(() => productOfMeteredKey(k)).toThrow(ProductContextError);
      expect(() => assertMeteredKeyOf(SIGN_PRODUCT_KEY, 'sign.envelopes')).not.toThrow();
    });

    it('the test key appears in no migration, seed, deploy or tool file', () => {
      const shipped = [
        ...filesUnder(resolve(ROOT, 'libs'), (p) => /\/prisma\/(migrations\/.+\.sql|seed[^/]*\.ts)$/.test(p)),
        ...filesUnder(resolve(ROOT, 'deploy'), () => true),
        ...filesUnder(resolve(ROOT, 'tools'), () => true),
      ];
      expect(shipped.length).toBeGreaterThan(0);
      expect(shipped.filter((p) => readFileSync(p, 'utf8').includes(ISO))).toEqual([]);
    });
  });

  // ── No DB default (C7, N-11) ────────────────────────────────────────────────────────────
  describe('no reliance on a DB default after migration', () => {
    it('the three new columns are NOT NULL with no default', async () => {
      const r = await pg.query(
        `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'subscription' AND column_name IN ('product_key', 'composition_role')
            AND table_name IN ('Plan', 'TenantSubscription') ORDER BY table_name, column_name`,
      );
      expect(r.rows).toEqual([
        { table_name: 'Plan', column_name: 'product_key', is_nullable: 'NO', column_default: null },
        { table_name: 'TenantSubscription', column_name: 'composition_role', is_nullable: 'NO', column_default: null },
        { table_name: 'TenantSubscription', column_name: 'product_key', is_nullable: 'NO', column_default: null },
      ]);
    });

    it('a write that omits product_key or composition_role fails', async () => {
      await expect(pg.query(`INSERT INTO subscription."Plan" (id, key, name) VALUES (gen_random_uuid(), 'no-product', 'x')`)).rejects.toThrow(/product_key/);
      await expect(
        pg.query(
          `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, composition_role, period_anchor, source, created_by)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ${publishedVersionOf('$2::uuid')}, 'BASE', now(), 'MANUAL', 'x')`,
          [tenant(), INCLUDED],
        ),
      ).rejects.toThrow(/product_key/);
      await expect(
        pg.query(
          `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, period_anchor, source, created_by)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ${publishedVersionOf('$2::uuid')}, 'sign', now(), 'MANUAL', 'x')`,
          [tenant(), INCLUDED],
        ),
      ).rejects.toThrow(/composition_role/);
    });

    it('every raw INSERT into Plan or TenantSubscription in shipped code and the Pact verifier names product_key', () => {
      const code = [
        ...filesUnder(resolve(ROOT, 'apps'), (p) => p.endsWith('.ts') && !/\/tests?\//.test(p) && !p.endsWith('.spec.ts')),
        ...filesUnder(resolve(ROOT, 'libs'), (p) => p.endsWith('.ts') && !/\/tests?\//.test(p) && !p.endsWith('.spec.ts')),
        ...filesUnder(resolve(ROOT, 'pact/provider/src'), (p) => p.endsWith('.ts')),
        ...filesUnder(resolve(ROOT, 'tools'), () => true),
        ...filesUnder(resolve(ROOT, 'deploy'), () => true),
      ];
      const offenders: string[] = [];
      for (const p of code) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/INSERT INTO\s+"?subscription"?\."(Plan|TenantSubscription)"\s*\(([^)]*)\)/g)) {
          if (!m[2]!.includes('product_key') || (m[1] === 'TenantSubscription' && !m[2]!.includes('composition_role'))) offenders.push(`${p}: ${m[0].slice(0, 80)}`);
        }
      }
      expect(offenders).toEqual([]);
      // The two Pact arbiters (MP-A2 §1.4: verify-sign.ts:248, :521) are re-pointed; CCP-A6 adds
      // a third (the governed-subscription checkout fixture), written on the new arbiter too.
      const pact = readFileSync(resolve(ROOT, 'pact/provider/src/verify-sign.ts'), 'utf8');
      expect(pact).not.toContain('ON CONFLICT (tenant_id) WHERE ended_at IS NULL');
      expect(pact.match(/ON CONFLICT \(tenant_id, product_key\) WHERE ended_at IS NULL AND composition_role = 'BASE' DO NOTHING/g)?.length).toBe(3);
    });

    it('the Pact arbiter infers the new index (the INSERT is a no-op on a second run)', async () => {
      const t = tenant();
      const sql = `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
         SELECT gen_random_uuid(), $1::uuid, p.id, ${publishedVersionOf('p.id')}, p.product_key, 'BASE', now(), 'DEVELOPMENT', 'pact-verify-sign'
           FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1' AND p.product_key = 'sign'
         ON CONFLICT (tenant_id, product_key) WHERE ended_at IS NULL AND composition_role = 'BASE' DO NOTHING`;
      expect((await pg.query(sql, [t])).rowCount).toBe(1);
      expect((await pg.query(sql, [t])).rowCount).toBe(0);
    });
  });

  // ── Index swap (N-9) ────────────────────────────────────────────────────────────────────
  describe('index swap: one open BASE subscription per (tenant, product)', () => {
    it('the old index is gone; the new partial unique index names the BASE composition', async () => {
      const r = await pg.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'subscription' AND tablename = 'TenantSubscription' AND indexname LIKE '%one_open%'`);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].indexname).toBe('TenantSubscription_one_open_base_per_tenant_product');
      expect(r.rows[0].indexdef).toContain('UNIQUE INDEX');
      expect(r.rows[0].indexdef).toContain('(tenant_id, product_key) WHERE ((ended_at IS NULL) AND (composition_role = \'BASE\'::text))');
    });

    it('a second open sign BASE row is refused; ended rows are unlimited; a non-BASE role is refused', async () => {
      const t = tenant();
      await signRow(t);
      await expect(signRow(t)).rejects.toThrow(/one_open_base_per_tenant_product/);
      await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = now() WHERE tenant_id = $1`, [t]);
      await signRow(t);
      await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = now() WHERE tenant_id = $1 AND ended_at IS NULL`, [t]);
      await signRow(t);
      expect((await pg.query(`SELECT count(*)::int AS n FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [t])).rows[0].n).toBe(3);
      await expect(
        pg.query(
          `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ${publishedVersionOf('$2::uuid')}, 'sign', 'ADD_ON', now(), 'MANUAL', 'x')`,
          [tenant(), INCLUDED],
        ),
      ).rejects.toThrow(/TenantSubscription_composition_role_check/);
    });

    it('live-table plan: A4 over a populated pre-A4 table, compensation (all sign) restores the old shape, A4 re-applies', async () => {
      const admin = new Client({ connectionString: container.getConnectionUri() });
      await admin.connect();
      await admin.query('CREATE DATABASE ccp_a4_replay');
      await admin.end();
      const url = container.getConnectionUri().replace(/\/[^/?]+(\?|$)/, '/ccp_a4_replay$1');
      const db = new Client({ connectionString: url });
      await db.connect();
      try {
        for (const m of PRE_A4) await db.query(readFileSync(m, 'utf8'));
        // A3 interplay: a stand-in for CommercialChangeRequest with its interim CHECK, when A3 is absent.
        const hasCcr = (await db.query(`SELECT to_regclass('subscription."CommercialChangeRequest"') AS r`)).rows[0].r !== null;
        if (!hasCcr) {
          await db.query(
            `CREATE TABLE subscription."CommercialChangeRequest" (id uuid PRIMARY KEY, product_key text NOT NULL,
               CONSTRAINT "CommercialChangeRequest_product_key_check" CHECK (product_key = 'sign'))`,
          );
        }
        for (let i = 0; i < 25; i += 1) {
          await db.query(
            `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, period_anchor, source, created_by, ended_at)
             VALUES (gen_random_uuid(), gen_random_uuid(), $1::uuid, now(), 'MANUAL', 'replay', CASE WHEN $2 THEN now() ELSE NULL END)`,
            [INCLUDED, i % 5 === 0],
          );
        }
        const before = (await db.query(`SELECT count(*)::int AS n FROM subscription."TenantSubscription"`)).rows[0].n;
        await db.query(readFileSync(CCP_A4_MIGRATION, 'utf8'));
        expect((await db.query(`SELECT count(*)::int AS n FROM subscription."TenantSubscription" WHERE product_key = 'sign' AND composition_role = 'BASE'`)).rows[0].n).toBe(before);
        const ccr = await db.query(
          `SELECT conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
            WHERE r.relname = 'CommercialChangeRequest' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%product_key%'`,
        );
        // The interim A3 CHECK is replaced by the registry CHECK. When the real A3 table is present
        // (merged program branch), its pairing CHECK (tenant_id/product_key both NULL or both set)
        // MUST survive: A4 drops the interim CHECK by exact name only (post-merge lead fix).
        const names = ccr.rows.map((x) => x.conname).sort();
        const expected = hasCcr
          ? ['CommercialChangeRequest_product_key_registry_check', 'CommercialChangeRequest_tenant_product_check']
          : ['CommercialChangeRequest_product_key_registry_check'];
        expect(names).toEqual(expected);
        const reg = ccr.rows.find((x) => x.conname === 'CommercialChangeRequest_product_key_registry_check')!;
        expect([...String(reg.def).matchAll(/'([^']+)'::text/g)].map((m) => m[1])).toEqual([...PRODUCT_KEYS]);

        await db.query(readFileSync(CCP_A4_COMPENSATING, 'utf8'));
        const cols = await db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'subscription' AND column_name IN ('product_key', 'composition_role') AND table_name IN ('Plan', 'TenantSubscription')`);
        expect(cols.rows[0].n).toBe(0);
        const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'subscription' AND indexname LIKE 'TenantSubscription_one_open%'`);
        expect(idx.rows).toEqual([{ indexname: 'TenantSubscription_one_open_per_tenant' }]);
        expect((await db.query(`SELECT count(*)::int AS n FROM subscription."TenantSubscription"`)).rows[0].n).toBe(before);

        await db.query(readFileSync(CCP_A4_MIGRATION, 'utf8'));
        const again = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'subscription' AND indexname LIKE 'TenantSubscription_one_open%'`);
        expect(again.rows).toEqual([{ indexname: 'TenantSubscription_one_open_base_per_tenant_product' }]);

        // Compensation is refused once a non-sign row exists (reversible only while every row is sign).
        await registerIsolationTestProduct(db);
        await db.query(`INSERT INTO subscription."Plan" (id, key, name, product_key) VALUES (gen_random_uuid(), 'iso-replay', 'x', $1)`, [ISO]);
        await expect(db.query(readFileSync(CCP_A4_COMPENSATING, 'utf8'))).rejects.toThrow(/compensation refused/);
      } finally {
        await db.end();
      }
    });
  });

  // ── N-7 and N-12 — the test database is widened from here on ─────────────────────────────
  describe('N-7 product equality and N-12 historical-caller isolation (test key registered in THIS database only)', () => {
    let iso: { t: string; ref: string };

    beforeAll(async () => {
      await registerIsolationTestProduct(pg);
      await pg.query(
        `INSERT INTO subscription."Plan" (id, key, name, product_key, sellable, sales_model, status, eligibility, display_order)
         VALUES ($1::uuid, $2, 'Isolation test plan', $3, true, 'SELF_SERVICE', 'ACTIVE', 'ATS_SUBSCRIPTION', 50)`,
        [ISO_PLAN, ISO_PLAN_KEY, ISO],
      );
      // Same metered keys as Sign, different numbers: a product-blind read would be visible.
      await pg.query(`INSERT INTO subscription."PlanAllowance" (plan_id, allowance_key, included_quantity, unlimited, period) VALUES ($1::uuid, $2, 7, false, 'MONTHLY')`, [ISO_PLAN, KEY]);
      await pg.query(`INSERT INTO subscription."PlanCapacity" (plan_id, capacity_key, limit_quantity, unlimited) VALUES ($1::uuid, $2, 5, false)`, [ISO_PLAN, STORAGE]);
      // CCP-A5 — a plan created after the A5 migration needs its v1 before a subscription can pin it.
      await publishTestPlanV1(pg, ISO_PLAN);
    });

    async function isoRow(t: string, ref: string): Promise<void> {
      await pg.query(
        `INSERT INTO subscription."TenantSubscription"
           (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by, status, billing_provider,
            billing_account_ref, billing_subscription_ref, current_period_end, provider_state_at, activated_by, eligibility_state, eligibility_checked_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ${publishedVersionOf('$2::uuid')}, $3, 'BASE', '2026-10-09T00:00:00Z', 'SELF_SERVICE', 'ccp-a4', 'ACTIVE', 'STRIPE',
                 $4, $5, '2026-11-09T00:00:00Z', '2026-10-09T00:00:00Z', 'iso-owner', 'OK', '2026-10-09T00:00:00Z')`,
        [t, ISO_PLAN, ISO, `cus_iso_${t}`, ref],
      );
    }
    const isoSnapshot = async (t: string): Promise<unknown> =>
      (await pg.query(`SELECT * FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND product_key = $2`, [t, ISO])).rows;

    async function signResults(t: string): Promise<string> {
      return JSON.stringify({
        status: await allowance.getStatus(t, SIGN_PRODUCT_KEY, KEY, AT),
        capacity: await capacity.status(t, SIGN_PRODUCT_KEY, STORAGE),
        account: await lifecycle.account(t, SIGN_PRODUCT_KEY, KEY, AT),
        owner: await lifecycle.sendingOwner(t, SIGN_PRODUCT_KEY, AT),
        stale: await allowance.staleReservations(t, SIGN_PRODUCT_KEY, KEY, AT),
        catalog: (await lifecycle.catalog(SIGN_PRODUCT_KEY, t)).map((p) => p.key),
      });
    }

    beforeAll(async () => {
      iso = { t: tenant(), ref: '' };
      iso.ref = `sub_iso_${iso.t}`;
      await signRow(iso.t);
      await isoRow(iso.t, iso.ref);
      await pg.query(
        `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, origin, reserved_at, reserved_until, finalized_at)
         SELECT gen_random_uuid(), $1::uuid, $2, 'seed:' || g, '2026-10-01T00:00:00Z', 'CONSUMED', 'SEND', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'
           FROM generate_series(1, 3) g`,
        [iso.t, KEY],
      );
    });

    it('N-7: a subscription whose product differs from its plan is refused by the DB', async () => {
      await expect(
        pg.query(
          `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ${publishedVersionOf('$2::uuid')}, $3, 'BASE', now(), 'MANUAL', 'x')`,
          [tenant(), INCLUDED, ISO],
        ),
      ).rejects.toThrow(/TenantSubscription_plan_id_product_key_fkey/);
      await expect(
        pg.query(
          `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ${publishedVersionOf('$2::uuid')}, 'sign', 'BASE', now(), 'MANUAL', 'x')`,
          [tenant(), ISO_PLAN],
        ),
      ).rejects.toThrow(/TenantSubscription_plan_id_product_key_fkey/);
      // CCP-A5 — the pin moves with the plan (composite FK), so only the product FK is in question here.
      await expect(
        pg.query(`UPDATE subscription."TenantSubscription" SET plan_id = $1::uuid, plan_version_id = ${publishedVersionOf('$1::uuid')} WHERE tenant_id = $2 AND product_key = 'sign'`, [ISO_PLAN, iso.t]),
      ).rejects.toThrow(
        /TenantSubscription_plan_id_product_key_fkey/,
      );
      await expect(pg.query(`UPDATE subscription."Plan" SET product_key = $1 WHERE id = $2::uuid`, [ISO, INCLUDED])).rejects.toThrow(/TenantSubscription_plan_id_product_key_fkey/);
    });

    it('the fixture: one tenant holds an open BASE sign row AND an open BASE second-product row', async () => {
      const r = await pg.query(`SELECT product_key, composition_role FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL ORDER BY product_key`, [iso.t]);
      expect(r.rows).toEqual([
        { product_key: ISO, composition_role: 'BASE' },
        { product_key: 'sign', composition_role: 'BASE' },
      ]);
    });

    it('every Sign read path resolves the sign row, never the other product row', async () => {
      expect(await allowance.getStatus(iso.t, SIGN_PRODUCT_KEY, KEY, AT)).toMatchObject({ subscribed: true, plan_key: 'aramo-sign-included-v1', limit: 100, used: 3 });
      expect(await capacity.status(iso.t, SIGN_PRODUCT_KEY, STORAGE)).toMatchObject({ subscribed: true, limit: null });
      expect((await lifecycle.account(iso.t, SIGN_PRODUCT_KEY, KEY, AT)).subscription).toMatchObject({ plan_key: 'aramo-sign-included-v1', source: 'MANUAL' });
      expect(await lifecycle.sendingOwner(iso.t, SIGN_PRODUCT_KEY, AT)).toBeNull();
      expect((await lifecycle.catalog(SIGN_PRODUCT_KEY, iso.t)).map((p) => p.key)).not.toContain(ISO_PLAN_KEY);
      // recordHistorical uses the sign row's anchor 2026-10-01 (the other row's anchor would give 2026-10-09).
      expect(await allowance.recordHistorical({ tenant_id: iso.t, product_key: SIGN_PRODUCT_KEY, allowance_key: KEY, send_key: 'hist:iso', sent_at: new Date('2026-09-20T00:00:00Z') })).toBe(true);
      const h = await pg.query(`SELECT period_start FROM subscription."AllowanceUsage" WHERE tenant_id = $1 AND send_key = 'hist:iso'`, [iso.t]);
      expect((h.rows[0].period_start as Date).toISOString()).toBe('2026-10-01T00:00:00.000Z');
      // The Sign send gate path (reserve → consume) charges against the sign plan's 100, not the other plan's 7.
      expect(await allowance.reserve({ tenant_id: iso.t, product_key: SIGN_PRODUCT_KEY, allowance_key: KEY, send_key: 'iso:send', at: AT })).toMatchObject({ ok: true, status: { limit: 100, used: 5 } }); // 3 seeded + the historical send + this one
      expect(await allowance.consume({ tenant_id: iso.t, product_key: SIGN_PRODUCT_KEY, allowance_key: KEY, send_key: 'iso:send', usage_event_type: 'sign.envelope.sent', at: AT })).toBe('CONSUMED');
    });

    it('removing the second product row leaves every Sign result byte-identical', async () => {
      const t = tenant();
      await signRow(t, 'MANUAL', '2026-10-03T00:00:00Z');
      await isoRow(t, `sub_iso_${t}`);
      const withOther = await signResults(t);
      await pg.query(`DELETE FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND product_key = $2`, [t, ISO]);
      expect(await signResults(t)).toBe(withOther);
    });

    it('reconcile and eligibility refresh for sign never read or touch the other product row', async () => {
      const before = await isoSnapshot(iso.t);
      billing.retrieved = [];
      await lifecycle.reconcile(SIGN_PRODUCT_KEY, AT);
      expect(billing.retrieved.filter((r) => r.startsWith('sub_iso_'))).toEqual([]);
      eligibleAnswer = false;
      await lifecycle.refreshEligibility(SIGN_PRODUCT_KEY, AT);
      eligibleAnswer = true;
      expect(await isoSnapshot(iso.t)).toEqual(before);
    });

    it('a sign webhook for the other product subscription is IGNORED and the row untouched', async () => {
      const before = await isoSnapshot(iso.t);
      billing.subs.set(iso.ref, state({ subscription_ref: iso.ref, tenant_id: iso.t, provider_status: 'canceled', price_ref: 'price_business' }));
      const r = await lifecycle.syncSubscription(iso.ref, SIGN_PRODUCT_KEY, AT);
      expect(r).toMatchObject({ outcome: 'IGNORED', detail: expect.stringContaining('another product') });
      expect(await isoSnapshot(iso.t)).toEqual(before);
    });

    it('sign checkout + activation ends only the sign row; a price of the other product never re-points the sign row', async () => {
      const before = await isoSnapshot(iso.t);
      // CCP-A6 (Conversion Rule C-1) — the governed MANUAL sign row refuses a sign checkout, and
      // only the SIGN row decides it (the other product's SELF_SERVICE row is not consulted).
      await expect(
        lifecycle.startCheckout({ tenant_id: iso.t, product_key: SIGN_PRODUCT_KEY, user_id: 'sign-owner', user_email: 'o@acme.test', plan_key: BUSINESS_KEY, success_url: 'https://e/ok', cancel_url: 'https://e/no', accept_terms: true }),
      ).rejects.toMatchObject({ reason: 'GOVERNED_SUBSCRIPTION_OPEN' });
      // The product-isolation proof below needs a replaceable sign row: the fixture row becomes
      // DEVELOPMENT (not governed), which a self-service activation may still end.
      await pg.query(`UPDATE subscription."TenantSubscription" SET source = 'DEVELOPMENT' WHERE tenant_id = $1 AND product_key = 'sign' AND ended_at IS NULL`, [iso.t]);
      // Product-blind, the open SELF_SERVICE ACTIVE other-product row would refuse ALREADY_SUBSCRIBED.
      await lifecycle.startCheckout({ tenant_id: iso.t, product_key: SIGN_PRODUCT_KEY, user_id: 'sign-owner', user_email: 'o@acme.test', plan_key: BUSINESS_KEY, success_url: 'https://e/ok', cancel_url: 'https://e/no', accept_terms: true });
      const c = billing.checkouts[billing.checkouts.length - 1]!;
      const ref = `sub_sign_${iso.t}`;
      billing.subs.set(ref, state({ subscription_ref: ref, tenant_id: iso.t, intent_id: c.intent_id, price_ref: 'price_business' }));
      expect(await lifecycle.syncSubscription(ref, SIGN_PRODUCT_KEY, AT)).toMatchObject({ outcome: 'APPLIED', detail: 'opened ACTIVE (ended DEVELOPMENT)' });
      const rows = await pg.query(
        `SELECT p.key, s.product_key, s.source, s.ended_at IS NULL AS open FROM subscription."TenantSubscription" s JOIN subscription."Plan" p ON p.id = s.plan_id
          WHERE s.tenant_id = $1 ORDER BY s.product_key, s.started_at`,
        [iso.t],
      );
      expect(rows.rows).toEqual([
        { key: ISO_PLAN_KEY, product_key: ISO, source: 'SELF_SERVICE', open: true },
        { key: 'aramo-sign-included-v1', product_key: 'sign', source: 'DEVELOPMENT', open: false },
        { key: BUSINESS_KEY, product_key: 'sign', source: 'SELF_SERVICE', open: true },
      ]);
      expect(await isoSnapshot(iso.t)).toEqual(before);
      // The provider moves the sign subscription to the other product's price: planForPrice is product-scoped.
      billing.subs.set(ref, state({ subscription_ref: ref, tenant_id: iso.t, intent_id: c.intent_id, price_ref: 'price_iso' }));
      expect(await lifecycle.syncSubscription(ref, SIGN_PRODUCT_KEY, AT)).toMatchObject({ outcome: 'APPLIED' });
      const plan = await pg.query(`SELECT p.key FROM subscription."TenantSubscription" s JOIN subscription."Plan" p ON p.id = s.plan_id WHERE s.billing_subscription_ref = $1`, [ref]);
      expect(plan.rows).toEqual([{ key: BUSINESS_KEY }]);
      expect(await lifecycle.sendingOwner(iso.t, SIGN_PRODUCT_KEY, AT)).toBe('sign-owner');
      expect(await isoSnapshot(iso.t)).toEqual(before);
    });

    it('a checkout of the other product plan through the sign product is refused', async () => {
      const t = tenant();
      await expect(
        lifecycle.startCheckout({ tenant_id: t, product_key: SIGN_PRODUCT_KEY, user_id: 'u', user_email: 'u@acme.test', plan_key: ISO_PLAN_KEY, success_url: 'x', cancel_url: 'y' }),
      ).rejects.toMatchObject({ reason: 'PLAN_NOT_SELLABLE' });
    });
  });
});
