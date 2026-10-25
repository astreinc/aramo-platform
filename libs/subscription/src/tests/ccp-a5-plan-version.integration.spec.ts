import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AllowanceService } from '../lib/allowance.service.js';
import type { BillingProviderPort, ProviderSubscriptionState } from '../lib/billing/billing-provider.port.js';
import type { PlanEligibilityPort } from '../lib/billing/plan-eligibility.port.js';
import { checkProviderPriceParity } from '../lib/billing/provider-price.js';
import { BillingRefusedError, SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import { CapacityService } from '../lib/capacity.service.js';
import { canonicalJson } from '../lib/commercial/commercial-policy.js';
import { openDevelopmentSubscription } from '../lib/development-subscription.js';
import { type PlanVersionContent, planVersionChecksum, planVersionContentFromRows } from '../lib/plan-version.js';
import { PlanVersionRepository, PlanVersionStateError } from '../lib/plan-version.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SIGN_PRODUCT_KEY } from '../lib/product-registry.js';

import { CCP_A4_MIGRATION } from './fixtures/ccp-a4.js';
import { observe, rowCounts, seedCorpus, type SignOps } from './fixtures/ccp-a4-sign-corpus.js';
import { CCP_A5_COMPENSATING, CCP_A5_MIGRATION, publishedVersionOf } from './fixtures/ccp-a5.js';
import { applyRemainingSubscriptionMigrations } from './fixtures/ccp-a8.js';
import { FakeOrganizationBillingProfile } from './fixtures/organization-billing-profile.fake.js';

// CCP-A5 (PBD §5.1 row A5; MP-A2 N-15…N-19; Charter D3) on real Postgres 17:
//   N-19   the v1 backfill over a POPULATED database (the A4 Sign corpus): one PUBLISHED v1 per plan
//          whose checksum equals an independent TS recomputation from the live rows; every
//          subscription (open and ended) pinned to its plan's v1; row counts kept
//   golden the A4 golden corpus replayed through the A5 code: no subscriber's limits change
//   N-16   the immutability trigger: UPDATE and DELETE of a published / retired version refused
//   N-18   grandfathering: a later published version never changes an existing subscriber
//   N-17   planForPrice resolves a VERSION (pin or env cutover fallback); a provider-side plan
//          change re-pins with recorded history; an unattributed re-pin is refused
//   D3     the read-only env-parity check, pass and fail cases (function and command)
//   comp   the compensating migration applies while only v1 exists, and is refused otherwise

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
const GOLDEN = resolve(__dirname, 'fixtures/ccp-a4-sign-equality.golden.json');
const KEY = 'sign.envelopes';
const STORAGE = 'sign.storage_bytes';
const AT = new Date('2026-10-18T12:00:00.000Z');
const BUSINESS = 'aramo-sign-standard-business-v1';
const PROFESSIONAL = 'aramo-sign-standard-professional-v1';
const MIGRATION_ACTOR = 'migration:20261025160000_ccp_a5_plan_version';
const TEST_ENV = { ARAMO_ENV: 'test' };
let seq = 0;
const tenant = (): string => `0190a5a5-0000-7000-8000-${String(++seq).padStart(12, '0')}`;
const planId = (n: number): string => `019a0000-a5a5-7000-8000-${String(n).padStart(12, '0')}`;

class FakeBilling implements BillingProviderPort {
  readonly provider = 'STRIPE' as const;
  subs = new Map<string, ProviderSubscriptionState>();
  checkouts: { intent_id: string; tenant_id: string; price_ref: string }[] = [];
  isConfigured(): boolean {
    return true;
  }
  mode(): 'test' {
    return 'test';
  }
  async upsertBillingAccount(account_ref: string | null, d: { tenant_id: string }): Promise<string> {
    return account_ref ?? `cus_${d.tenant_id}`;
  }
  async createCheckoutSession(req: { intent_id: string; tenant_id: string; price_ref: string }) {
    this.checkouts.push(req);
    return { session_ref: `cs_${req.intent_id}`, url: `https://checkout.test/${req.intent_id}` };
  }
  async createPortalSession(account_ref: string) {
    return { url: `https://portal.test/${account_ref}` };
  }
  async retrieveSubscription(ref: string): Promise<ProviderSubscriptionState> {
    const s = this.subs.get(ref);
    if (s === undefined) throw new Error(`no such subscription ${ref}`);
    return s;
  }
  verifyWebhook(): never {
    throw new Error('not used');
  }
}

const providerState = (over: Partial<ProviderSubscriptionState> & { subscription_ref: string; tenant_id: string }): ProviderSubscriptionState => ({
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

/** The live rows of every plan, read with plain SQL and projected in TS (independent of the SQL projection). */
async function liveContents(db: Client): Promise<Map<string, PlanVersionContent>> {
  const plans = (await db.query(`SELECT * FROM subscription."Plan" ORDER BY id`)).rows;
  const out = new Map<string, PlanVersionContent>();
  for (const p of plans) {
    // Stored order, as the SQL projection reads them (and as the catalog / account reads present them).
    const q = async (table: string) => (await db.query(`SELECT * FROM subscription."${table}" WHERE plan_id = $1 ORDER BY ctid`, [p.id])).rows;
    out.set(
      p.id as string,
      planVersionContentFromRows({
        plan: p,
        allowances: await q('PlanAllowance'),
        allowance_windows: await q('PlanAllowanceWindow'),
        // pg returns int8 as a string.
        capacities: (await q('PlanCapacity')).map((c) => ({ ...c, limit_quantity: c.limit_quantity === null ? null : BigInt(c.limit_quantity) })),
        features: await q('PlanFeature'),
      }),
    );
  }
  return out;
}

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

async function freshDatabase(container: StartedPostgreSqlContainer, name: string): Promise<Client> {
  const admin = new Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const db = new Client({ connectionString: container.getConnectionUri().replace(/\/[^/?]+(\?|$)/, `/${name}$1`) });
  await db.connect();
  return db;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A5 — PlanVersion, price pinning and the v1 backfill (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let allowance: AllowanceService;
  let capacity: CapacityService;
  let billing: FakeBilling;
  let lifecycle: SubscriptionLifecycleService;
  let repo: PlanVersionRepository;
  let liveBefore: Map<string, PlanVersionContent>;
  let countsBefore: { plan: number; subscription: number; subscription_open: number };
  let countsAfter: { plan: number; subscription: number; subscription_open: number };
  let observation: Record<string, unknown>;
  const env = { ...process.env };

  beforeAll(async () => {
    delete process.env['STRIPE_PLAN_PRICES'];
    delete process.env['BILLING_PAST_DUE_GRACE_DAYS'];
    delete process.env['SIGN_POST_TERMINATION_EXPORT_DAYS'];
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    // The production order: the pre-A4 chain, the populated corpus, A4, then A5 over it.
    for (const m of PRE_A4) await pg.query(readFileSync(m, 'utf8'));
    await seedCorpus(pg);
    await pg.query(readFileSync(CCP_A4_MIGRATION, 'utf8'));
    countsBefore = await rowCounts(pg);
    liveBefore = await liveContents(pg);
    await pg.query(readFileSync(CCP_A5_MIGRATION, 'utf8'));
    countsAfter = await rowCounts(pg);
    // CCP-A8: the rest of the chain, so the current allowance reader runs on the HEAD schema.
    await applyRemainingSubscriptionMigrations(pg, [...PRE_A4, CCP_A4_MIGRATION, CCP_A5_MIGRATION]);
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    allowance = new AllowanceService(prisma);
    capacity = new CapacityService(prisma);
    billing = new FakeBilling();
    const eligibility: PlanEligibilityPort = { isEligible: async () => true };
    lifecycle = new SubscriptionLifecycleService(prisma, allowance, billing, capacity, eligibility, undefined, new FakeOrganizationBillingProfile());
    repo = new PlanVersionRepository(prisma);
    // The A4 golden observation, replayed through the A5 code right after the migration (the
    // same adapter as the A4 equality spec; the observation mutates the corpus, so it runs first).
    const P = SIGN_PRODUCT_KEY;
    // As in the A4 capture: an unconfigured billing provider (billing_available false).
    const offline: BillingProviderPort = {
      provider: 'STRIPE',
      isConfigured: () => false,
      mode: () => 'test',
      upsertBillingAccount: async () => 'acct',
      createCheckoutSession: async () => ({ session_ref: 'cs', url: 'https://x' }),
      createPortalSession: async () => ({ url: 'https://x' }),
      retrieveSubscription: async () => {
        throw new Error('unused');
      },
      verifyWebhook: () => {
        throw new Error('unused');
      },
    };
    const plainLifecycle = new SubscriptionLifecycleService(prisma, allowance, offline, capacity);
    const ops: SignOps = {
      getStatus: (t, k, at) => allowance.getStatus(t, P, k, at),
      reserve: (i) => allowance.reserve({ ...i, product_key: P }),
      consume: (i) => allowance.consume({ ...i, product_key: P }),
      release: (i) => allowance.release({ ...i, product_key: P }),
      staleReservations: (t, k, at) => allowance.staleReservations(t, P, k, at),
      resolveStale: (i) => allowance.resolveStale({ ...i, product_key: P }),
      recordHistorical: (i) => allowance.recordHistorical({ ...i, product_key: P }),
      capacityStatus: (t, k) => capacity.status(t, P, k),
      capacityReserve: (i) => capacity.reserve({ ...i, product_key: P }),
      capacityRelease: (i) => capacity.release({ ...i, product_key: P }),
      account: (t, k, at) => plainLifecycle.account(t, P, k, at),
      sendingOwner: (t, at) => plainLifecycle.sendingOwner(t, P, at),
    };
    observation = await observe(ops);
  }, 300_000);

  afterAll(async () => {
    process.env = env;
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  // ── N-19: the v1 backfill on a populated database ──────────────────────────────────────
  describe('N-19 v1 backfill over the populated corpus', () => {
    it('row counts are kept and equal the A4 golden counts', () => {
      const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { counts: unknown };
      expect(countsBefore).toEqual(golden.counts);
      expect(countsAfter).toEqual(countsBefore);
    });

    it('exactly one PUBLISHED v1 per plan, created by the migration', async () => {
      const r = await pg.query(
        `SELECT p.key, v.version_number, v.status, v.created_by, v.published_at IS NOT NULL AS published, v.retired_at
           FROM subscription."Plan" p JOIN subscription."PlanVersion" v ON v.plan_id = p.id ORDER BY p.key`,
      );
      expect(r.rows).toHaveLength(countsBefore.plan);
      for (const row of r.rows) expect(row).toMatchObject({ version_number: 1, status: 'PUBLISHED', created_by: MIGRATION_ACTOR, published: true, retired_at: null });
      expect((await pg.query(`SELECT count(*)::int AS n FROM subscription."PlanVersion"`)).rows[0].n).toBe(countsBefore.plan);
    });

    it('each v1 checksum equals an independent TS recomputation from the live rows (and the content is byte-equal)', async () => {
      const r = await pg.query(`SELECT v.plan_id, p.key, v.content, v.content_checksum FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id ORDER BY p.key`);
      const table: { key: string; checksum: string }[] = [];
      for (const row of r.rows) {
        const live = liveBefore.get(row.plan_id as string)!;
        expect(live).toBeDefined();
        expect(row.content).toEqual(live);
        expect(row.content_checksum).toBe(planVersionChecksum(live));
        // The SQL canonical form equals the TS canonical form (the DB CHECK recomputes with it).
        const sql = await pg.query(`SELECT subscription.ccp_canonical_json(content) AS c, subscription.ccp_plan_version_checksum(subscription.ccp_plan_live_content(plan_id)) AS live FROM subscription."PlanVersion" WHERE plan_id = $1`, [row.plan_id]);
        expect(sql.rows[0].c).toBe(canonicalJson(live));
        expect(sql.rows[0].live).toBe(row.content_checksum);
        table.push({ key: row.key as string, checksum: row.content_checksum as string });
      }
      // Evidence for the acceptance record.
      console.log(`[ccp-a5] v1 checksums ${JSON.stringify(table)}`);
    });

    it('every subscription, open and ended, is pinned to its plan v1', async () => {
      const r = await pg.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE v.plan_id = s.plan_id AND v.version_number = 1)::int AS pinned_v1,
                count(*) FILTER (WHERE s.ended_at IS NOT NULL)::int AS ended
           FROM subscription."TenantSubscription" s JOIN subscription."PlanVersion" v ON v.id = s.plan_version_id`,
      );
      expect(r.rows[0]).toEqual({ total: countsBefore.subscription, pinned_v1: countsBefore.subscription, ended: countsBefore.subscription - countsBefore.subscription_open });
    });

    it('plan_version_id is NOT NULL with no default; a write that omits it fails', async () => {
      const r = await pg.query(
        `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name = 'TenantSubscription' AND column_name = 'plan_version_id'`,
      );
      expect(r.rows).toEqual([{ is_nullable: 'NO', column_default: null }]);
      await expect(
        pg.query(
          `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, product_key, composition_role, period_anchor, source, created_by)
           SELECT gen_random_uuid(), $1::uuid, p.id, 'sign', 'BASE', now(), 'MANUAL', 'x' FROM subscription."Plan" p WHERE p.key = 'aramo-sign-included-v1'`,
          [tenant()],
        ),
      ).rejects.toThrow(/plan_version_id/);
    });

    it('every raw INSERT into TenantSubscription in shipped code and the Pact verifier names plan_version_id', () => {
      const code = [
        ...filesUnder(resolve(ROOT, 'apps'), (p) => p.endsWith('.ts') && !/\/tests?\//.test(p) && !p.endsWith('.spec.ts')),
        ...filesUnder(resolve(ROOT, 'libs'), (p) => p.endsWith('.ts') && !/\/tests?\//.test(p) && !p.endsWith('.spec.ts')),
        ...filesUnder(resolve(ROOT, 'pact/provider/src'), (p) => p.endsWith('.ts')),
        ...filesUnder(resolve(ROOT, 'tools'), () => true),
        ...filesUnder(resolve(ROOT, 'deploy'), () => true),
      ];
      const offenders: string[] = [];
      let seen = 0;
      for (const p of code) {
        for (const m of readFileSync(p, 'utf8').matchAll(/INSERT INTO\s+"?subscription"?\."TenantSubscription"\s*\(([^)]*)\)/g)) {
          seen += 1;
          if (!m[1]!.includes('plan_version_id')) offenders.push(`${p}: ${m[0].slice(0, 80)}`);
        }
      }
      expect(seen).toBeGreaterThanOrEqual(2);
      expect(offenders).toEqual([]);
    });
  });

  // ── no subscriber's effective limits change ───────────────────────────────────────────
  it('golden: every Sign allowance, capacity and account result equals the A4 baseline golden byte for byte', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { observation: unknown };
    expect(JSON.stringify(observation)).toBe(JSON.stringify(golden.observation));
  });

  // ── N-16: the immutability trigger ────────────────────────────────────────────────────
  describe('N-16 immutability (PUBLISHED and RETIRED versions, price versions)', () => {
    const PLAN = planId(1);
    let v1: string;

    beforeAll(async () => {
      await pg.query(`INSERT INTO subscription."Plan" (id, key, name, product_key) VALUES ($1::uuid, 'ccp-a5-immutability', 'Immutability', 'sign')`, [PLAN]);
      await pg.query(`INSERT INTO subscription."PlanAllowance" (plan_id, allowance_key, included_quantity, unlimited, period) VALUES ($1::uuid, $2, 9, false, 'MONTHLY')`, [PLAN, KEY]);
      v1 = (await repo.createDraftFromLive({ plan_id: PLAN, created_by: 'test' })).id;
    });

    it('a version is created as DRAFT only; content must match its checksum and its own plan', async () => {
      const content = await repo.liveContent(PLAN);
      const ins = (status: string, checksum: string, c: unknown = content) =>
        pg.query(
          `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at, published_at)
           VALUES (gen_random_uuid(), $1::uuid, 99, $2, $3::jsonb, $4, 'x', now(), CASE WHEN $2 = 'DRAFT' THEN NULL ELSE now() END)`,
          [PLAN, status, JSON.stringify(c), checksum],
        );
      await expect(ins('PUBLISHED', planVersionChecksum(content))).rejects.toThrow(/created as DRAFT/);
      await expect(ins('DRAFT', '0'.repeat(64))).rejects.toThrow(/PlanVersion_content_checksum_check/);
      const other = { ...content, plan: { ...content.plan, key: 'aramo-sign-included-v1' } };
      await expect(ins('DRAFT', planVersionChecksum(other), other)).rejects.toThrow(/names another plan/);
    });

    it('a DRAFT is editable (checksum kept honest) and publishable; it is never deleted', async () => {
      const content = await repo.liveContent(PLAN);
      const edited = { ...content, allowances: [{ ...content.allowances[0]!, included_quantity: 11 }] };
      const row = await repo.updateDraft(v1, edited);
      expect(row.content_checksum).toBe(planVersionChecksum(edited));
      await expect(pg.query(`DELETE FROM subscription."PlanVersion" WHERE id = $1::uuid`, [v1])).rejects.toThrow(/never deleted/);
      await repo.publish(v1, AT);
    });

    it('a PUBLISHED version: UPDATE of content, checksum, note or published_at, a move back to DRAFT, and DELETE are all refused', async () => {
      const cases: [string, RegExp][] = [
        [`UPDATE subscription."PlanVersion" SET content = jsonb_set(content, '{allowances,0,included_quantity}', '12') WHERE id = $1::uuid`, /PlanVersion_content_checksum_check|PUBLISHED PlanVersion is immutable/],
        [
          `UPDATE subscription."PlanVersion" SET content = jsonb_set(content, '{allowances,0,included_quantity}', '12'),
                  content_checksum = subscription.ccp_plan_version_checksum(jsonb_set(content, '{allowances,0,included_quantity}', '12')) WHERE id = $1::uuid`,
          /PUBLISHED PlanVersion is immutable/,
        ],
        [`UPDATE subscription."PlanVersion" SET note = 'edited' WHERE id = $1::uuid`, /PUBLISHED PlanVersion is immutable/],
        [`UPDATE subscription."PlanVersion" SET published_at = now() - interval '1 day' WHERE id = $1::uuid`, /PUBLISHED PlanVersion is immutable/],
        [`UPDATE subscription."PlanVersion" SET status = 'DRAFT', published_at = NULL WHERE id = $1::uuid`, /PUBLISHED PlanVersion is immutable/],
        [`UPDATE subscription."PlanVersion" SET version_number = 7 WHERE id = $1::uuid`, /identity is immutable/],
        [`DELETE FROM subscription."PlanVersion" WHERE id = $1::uuid`, /never deleted/],
      ];
      for (const [sql, err] of cases) await expect(pg.query(sql, [v1]), sql).rejects.toThrow(err);
      // The repository has no in-place edit path either.
      await expect(repo.updateDraft(v1, await repo.liveContent(PLAN))).rejects.toThrow(PlanVersionStateError);
      expect((await repo.getVersion(v1))!.terms.allowances[0]!.included_quantity).toBe(11);
    });

    it('price versions: immutable from INSERT, one per version and provider, one version per provider price, never on a RETIRED version', async () => {
      expect(await repo.pinProviderPrice({ plan_version_id: v1, provider: 'STRIPE', provider_price_ref: 'price_imm_v1', created_by: 'test' })).toEqual({ created: true });
      expect(await repo.pinProviderPrice({ plan_version_id: v1, provider: 'STRIPE', provider_price_ref: 'price_imm_v1', created_by: 'test' })).toEqual({ created: false });
      await expect(repo.pinProviderPrice({ plan_version_id: v1, provider: 'STRIPE', provider_price_ref: 'price_other', created_by: 'test' })).rejects.toThrow(PlanVersionStateError);
      await expect(pg.query(`UPDATE subscription."PlanVersionPrice" SET provider_price_ref = 'price_x' WHERE plan_version_id = $1::uuid`, [v1])).rejects.toThrow(/PlanVersionPrice is immutable/);
      await expect(pg.query(`DELETE FROM subscription."PlanVersionPrice" WHERE plan_version_id = $1::uuid`, [v1])).rejects.toThrow(/PlanVersionPrice is immutable/);
      await expect(
        pg.query(`INSERT INTO subscription."PlanVersionPrice" (id, plan_version_id, provider, provider_price_ref, created_by, created_at) VALUES (gen_random_uuid(), $1::uuid, 'STRIPE', 'price_dup', 'x', now())`, [v1]),
      ).rejects.toThrow(/PlanVersionPrice_plan_version_id_provider_key/);
      // v2 published → v1 RETIRED; v2 cannot reuse v1's provider price; nothing is pinned to RETIRED v1.
      const v2 = await repo.createDraftFromLive({ plan_id: PLAN, created_by: 'test' });
      await expect(
        pg.query(`INSERT INTO subscription."PlanVersionPrice" (id, plan_version_id, provider, provider_price_ref, created_by, created_at) VALUES (gen_random_uuid(), $1::uuid, 'STRIPE', 'price_imm_v1', 'x', now())`, [v2.id]),
      ).rejects.toThrow(/PlanVersionPrice_provider_provider_price_ref_key/);
      await repo.publish(v2.id, AT);
      expect((await repo.listVersions(PLAN)).map((v) => [v.version_number, v.status])).toEqual([
        [2, 'PUBLISHED'],
        [1, 'RETIRED'],
      ]);
      await expect(
        pg.query(`INSERT INTO subscription."PlanVersionPrice" (id, plan_version_id, provider, provider_price_ref, created_by, created_at) VALUES (gen_random_uuid(), $1::uuid, 'STRIPE', 'price_retired', 'x', now())`, [v1]),
      ).rejects.toThrow(/RETIRED PlanVersion/);
      // At most one PUBLISHED per plan.
      const v3 = await repo.createDraftFromLive({ plan_id: PLAN, created_by: 'test' });
      await expect(pg.query(`UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', published_at = now() WHERE id = $1::uuid`, [v3.id])).rejects.toThrow(/PlanVersion_one_published_per_plan/);
    });

    it('a RETIRED version: every UPDATE and DELETE is refused', async () => {
      for (const sql of [
        `UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', retired_at = NULL WHERE id = $1::uuid`,
        `UPDATE subscription."PlanVersion" SET retired_at = now() WHERE id = $1::uuid`,
        `UPDATE subscription."PlanVersion" SET note = 'x' WHERE id = $1::uuid`,
        `DELETE FROM subscription."PlanVersion" WHERE id = $1::uuid`,
      ]) {
        await expect(pg.query(sql, [v1]), sql).rejects.toThrow(/RETIRED PlanVersion is immutable|never deleted/);
      }
      await expect(repo.retire(v1)).rejects.toThrow(PlanVersionStateError);
    });
  });

  // ── N-18: grandfathering ──────────────────────────────────────────────────────────────
  describe('N-18 grandfathering', () => {
    const PLAN = planId(2);
    const KEY_G = 'ccp-a5-grandfather';
    let v1: string;
    let v2: string;
    const early = tenant();
    const late = tenant();

    beforeAll(async () => {
      await pg.query(`INSERT INTO subscription."Plan" (id, key, name, product_key) VALUES ($1::uuid, $2, 'Grandfather', 'sign')`, [PLAN, KEY_G]);
      await pg.query(`INSERT INTO subscription."PlanAllowance" (plan_id, allowance_key, included_quantity, unlimited, period) VALUES ($1::uuid, $2, 10, false, 'MONTHLY')`, [PLAN, KEY]);
      await pg.query(`INSERT INTO subscription."PlanCapacity" (plan_id, capacity_key, limit_quantity, unlimited) VALUES ($1::uuid, $2, 1000, false)`, [PLAN, STORAGE]);
      v1 = (await repo.createDraftFromLive({ plan_id: PLAN, created_by: 'test' })).id;
      await repo.publish(v1, AT);
      await openDevelopmentSubscription(prisma, { tenant_id: early, product_key: 'sign', plan_key: KEY_G, period_anchor: new Date('2026-10-01T00:00:00Z'), created_by: 'test' }, TEST_ENV);
    });

    it('a subscriber opened on v1 is pinned to v1 and has v1 limits', async () => {
      expect((await pg.query(`SELECT plan_version_id FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [early])).rows).toEqual([{ plan_version_id: v1 }]);
      expect(await allowance.getStatus(early, 'sign', KEY, AT)).toMatchObject({ subscribed: true, limit: 10 });
      expect(await capacity.status(early, 'sign', STORAGE)).toMatchObject({ subscribed: true, limit: 1000 });
    });

    it('publishing v2 with different limits changes nothing for the v1 subscriber; a new subscriber gets v2', async () => {
      const live = await repo.liveContent(PLAN);
      const before = JSON.stringify({ s: await allowance.getStatus(early, 'sign', KEY, AT), c: await capacity.status(early, 'sign', STORAGE), a: await lifecycle.account(early, 'sign', KEY, AT) });
      v2 = (
        await repo.createDraft({
          plan_id: PLAN,
          created_by: 'test',
          content: { ...live, allowances: [{ ...live.allowances[0]!, included_quantity: 4 }], capacities: [{ ...live.capacities[0]!, limit_quantity: 500 }] },
        })
      ).id;
      await repo.publish(v2, AT);
      const after = JSON.stringify({ s: await allowance.getStatus(early, 'sign', KEY, AT), c: await capacity.status(early, 'sign', STORAGE), a: await lifecycle.account(early, 'sign', KEY, AT) });
      expect(after).toBe(before);
      expect((await pg.query(`SELECT plan_version_id FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [early])).rows).toEqual([{ plan_version_id: v1 }]);
      await openDevelopmentSubscription(prisma, { tenant_id: late, product_key: 'sign', plan_key: KEY_G, period_anchor: new Date('2026-10-01T00:00:00Z'), created_by: 'test' }, TEST_ENV);
      expect((await pg.query(`SELECT plan_version_id FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [late])).rows).toEqual([{ plan_version_id: v2 }]);
      expect(await allowance.getStatus(late, 'sign', KEY, AT)).toMatchObject({ subscribed: true, limit: 4 });
      expect(await capacity.status(late, 'sign', STORAGE)).toMatchObject({ subscribed: true, limit: 500 });
      // The live rows still define the plan (and equal v1); they were not edited by publishing.
      expect(planVersionChecksum(await repo.liveContent(PLAN))).toBe(planVersionChecksum(live));
    });

    it('the DB refuses a NEW pin to a RETIRED or DRAFT version; the grandfathered row keeps its RETIRED pin', async () => {
      const draft = (await repo.createDraftFromLive({ plan_id: PLAN, created_by: 'test' })).id;
      for (const v of [v1, draft]) {
        await expect(
          pg.query(
            `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, plan_version_id, product_key, composition_role, period_anchor, source, created_by)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'sign', 'BASE', now(), 'MANUAL', 'x')`,
            [tenant(), PLAN, v],
          ),
        ).rejects.toThrow(/pinned only to a PUBLISHED plan version/);
      }
      await pg.query(`UPDATE subscription."TenantSubscription" SET status = 'ACTIVE' WHERE tenant_id = $1`, [early]);
      expect(await allowance.getStatus(early, 'sign', KEY, AT)).toMatchObject({ limit: 10 });
    });
  });

  // ── N-17: planForPrice resolves a version; provider-side plan change re-pins with history ──
  describe('N-17 planForPrice → version, provider-side re-pin with recorded history (D3 cutover)', () => {
    const X = tenant();
    const ref = `sub_a5_${X}`;
    let intent = '';
    let business: { v1: string; v2: string };
    let professionalV1: string;
    const versionOf = async (): Promise<{ plan_key: string; plan_version_id: string }> =>
      (
        await pg.query(
          `SELECT p.key AS plan_key, s.plan_version_id FROM subscription."TenantSubscription" s JOIN subscription."Plan" p ON p.id = s.plan_id WHERE s.billing_subscription_ref = $1`,
          [ref],
        )
      ).rows[0];
    const events = async () =>
      (
        await pg.query(
          `SELECT from_plan_version_id, to_plan_version_id, reason, provider_price_ref, product_key FROM subscription."SubscriptionVersionPinEvent" WHERE tenant_id = $1 ORDER BY recorded_at, id`,
          [X],
        )
      ).rows;
    const sync = (price_ref: string) => {
      billing.subs.set(ref, providerState({ subscription_ref: ref, tenant_id: X, intent_id: intent, price_ref }));
      return lifecycle.syncSubscription(ref, 'sign', AT);
    };

    beforeAll(async () => {
      process.env['STRIPE_PLAN_PRICES'] = `${BUSINESS}=price_business,${PROFESSIONAL}=price_professional`;
      const v = async (key: string) => (await pg.query(`SELECT v.id FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id WHERE p.key = $1 AND v.version_number = 1`, [key])).rows[0].id as string;
      business = { v1: await v(BUSINESS), v2: '' };
      professionalV1 = await v(PROFESSIONAL);
    });

    it('ENV cutover: checkout uses the env price; activation pins the version the price resolves to', async () => {
      await lifecycle.startCheckout({ tenant_id: X, product_key: 'sign', user_id: 'owner-x', user_email: 'o@x.test', plan_key: BUSINESS, success_url: 'https://e/ok', cancel_url: 'https://e/no', accept_terms: true });
      const c = billing.checkouts[billing.checkouts.length - 1]!;
      expect(c.price_ref).toBe('price_business');
      intent = c.intent_id;
      expect(await sync('price_business')).toMatchObject({ outcome: 'APPLIED', detail: 'opened ACTIVE' });
      expect(await versionOf()).toEqual({ plan_key: BUSINESS, plan_version_id: business.v1 });
      expect(await events()).toEqual([]);
    });

    it('grandfathering through the env: a later business version does not re-pin a business v1 subscriber', async () => {
      business.v2 = (await repo.createDraftFromLive({ plan_id: (await prisma.plan.findUniqueOrThrow({ where: { key: BUSINESS } })).id, created_by: 'test' })).id;
      await repo.publish(business.v2, AT);
      expect(await sync('price_business')).toMatchObject({ outcome: 'APPLIED' });
      expect(await versionOf()).toEqual({ plan_key: BUSINESS, plan_version_id: business.v1 });
      expect(await events()).toEqual([]);
    });

    it('a provider-side plan change re-pins plan and version and records it; a repeat is a no-op', async () => {
      expect(await sync('price_professional')).toMatchObject({ outcome: 'APPLIED' });
      expect(await versionOf()).toEqual({ plan_key: PROFESSIONAL, plan_version_id: professionalV1 });
      const one = [{ from_plan_version_id: business.v1, to_plan_version_id: professionalV1, reason: 'PROVIDER_PLAN_CHANGE', provider_price_ref: 'price_professional', product_key: 'sign' }];
      expect(await events()).toEqual(one);
      await sync('price_professional');
      expect(await events()).toEqual(one);
    });

    it('D3 pin: a price pinned to a version is the authority; a pin/env disagreement fails checkout closed', async () => {
      expect(await repo.pinProviderPrice({ plan_version_id: business.v2, provider: 'STRIPE', provider_price_ref: 'price_business_v2', created_by: 'test' })).toEqual({ created: true });
      const err = await lifecycle
        .startCheckout({ tenant_id: tenant(), product_key: 'sign', user_id: 'u', user_email: 'u@x.test', plan_key: BUSINESS, success_url: 'a', cancel_url: 'b', accept_terms: true })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BillingRefusedError);
      expect(err).toMatchObject({ reason: 'BILLING_UNAVAILABLE', message: expect.stringContaining('parity mismatch') });
      expect((await lifecycle.catalog('sign')).find((p) => p.key === BUSINESS)!.purchasable).toBe(false);
      // With the env aligned (or absent), the pin is used.
      process.env['STRIPE_PLAN_PRICES'] = `${BUSINESS}=price_business_v2,${PROFESSIONAL}=price_professional`;
      expect((await lifecycle.catalog('sign')).find((p) => p.key === BUSINESS)!.purchasable).toBe(true);
      process.env['STRIPE_PLAN_PRICES'] = `${PROFESSIONAL}=price_professional`;
      await lifecycle.startCheckout({ tenant_id: tenant(), product_key: 'sign', user_id: 'u', user_email: 'u@x.test', plan_key: BUSINESS, success_url: 'a', cancel_url: 'b', accept_terms: true });
      expect(billing.checkouts[billing.checkouts.length - 1]!.price_ref).toBe('price_business_v2');
    });

    it('planForPrice resolves a pinned price to its VERSION and re-pins with a second history row', async () => {
      expect(await sync('price_business_v2')).toMatchObject({ outcome: 'APPLIED' });
      expect(await versionOf()).toEqual({ plan_key: BUSINESS, plan_version_id: business.v2 });
      expect((await events()).map((e) => [e.from_plan_version_id, e.to_plan_version_id, e.provider_price_ref])).toEqual([
        [business.v1, professionalV1, 'price_professional'],
        [professionalV1, business.v2, 'price_business_v2'],
      ]);
      // An unknown price keeps the pin.
      await sync('price_unknown');
      expect(await versionOf()).toEqual({ plan_key: BUSINESS, plan_version_id: business.v2 });
    });

    it('no silent re-point: an unattributed re-pin and a bare plan_id re-point are refused by the DB; history is append-only', async () => {
      await expect(pg.query(`UPDATE subscription."TenantSubscription" SET plan_id = $1::uuid WHERE billing_subscription_ref = $2`, [(await prisma.plan.findUniqueOrThrow({ where: { key: PROFESSIONAL } })).id, ref])).rejects.toThrow(
        /TenantSubscription_plan_version_id_plan_id_fkey/,
      );
      await expect(
        pg.query(`UPDATE subscription."TenantSubscription" SET plan_id = p.id, plan_version_id = ${publishedVersionOf('p.id')} FROM subscription."Plan" p WHERE p.key = $1 AND billing_subscription_ref = $2`, [PROFESSIONAL, ref]),
      ).rejects.toThrow(/must name its reason/);
      await expect(pg.query(`UPDATE subscription."SubscriptionVersionPinEvent" SET reason = 'x' WHERE tenant_id = $1`, [X])).rejects.toThrow(/append-only/);
      await expect(pg.query(`DELETE FROM subscription."SubscriptionVersionPinEvent" WHERE tenant_id = $1`, [X])).rejects.toThrow(/append-only/);
    });
  });

  // ── D3: the read-only env-parity check ────────────────────────────────────────────────
  describe('D3 env-parity check (read-only)', () => {
    // State from the N-17 block: business v2 is pinned to price_business_v2; professional v1 is unpinned.
    const RETIRED_PLAN = planId(3);

    beforeAll(async () => {
      await pg.query(`INSERT INTO subscription."Plan" (id, key, name, product_key) VALUES ($1::uuid, 'ccp-a5-retired', 'Retired', 'sign')`, [RETIRED_PLAN]);
      const v = await repo.createDraftFromLive({ plan_id: RETIRED_PLAN, created_by: 'test' });
      await repo.publish(v.id, AT);
      await repo.retire(v.id, AT);
    });

    const statuses = async (raw: string, strict = false) => {
      const r = await checkProviderPriceParity(prisma, raw, { strict });
      return { ok: r.ok, failures: r.failures, entries: Object.fromEntries(r.entries.map((e) => [e.plan_key, e.status])) };
    };

    it('pass: a pin that matches the env (MATCH), an unpinned env price in cutover mode (ENV_FALLBACK), a pin with no env entry (PINNED_ONLY)', async () => {
      expect(await statuses(`${BUSINESS}=price_business_v2,${PROFESSIONAL}=price_professional`)).toEqual({
        ok: true,
        failures: 0,
        entries: { [BUSINESS]: 'MATCH', [PROFESSIONAL]: 'ENV_FALLBACK' },
      });
      expect(await statuses('')).toMatchObject({ ok: true, entries: { [BUSINESS]: 'PINNED_ONLY' } });
    });

    it('fail: MISMATCH, UNKNOWN_PLAN, NO_PUBLISHED_VERSION, DUPLICATE_PRICE, an env price pinned to another version, and strict ENV_FALLBACK', async () => {
      expect(await statuses(`${BUSINESS}=price_business`)).toMatchObject({ ok: false, entries: { [BUSINESS]: 'MISMATCH' } });
      expect(await statuses('no-such-plan=price_x')).toMatchObject({ ok: false, entries: { 'no-such-plan': 'UNKNOWN_PLAN' } });
      expect(await statuses('ccp-a5-retired=price_r')).toMatchObject({ ok: false, entries: { 'ccp-a5-retired': 'NO_PUBLISHED_VERSION' } });
      expect(await statuses(`${BUSINESS}=price_same,${PROFESSIONAL}=price_same`)).toMatchObject({ ok: false, failures: 2, entries: { [BUSINESS]: 'DUPLICATE_PRICE', [PROFESSIONAL]: 'DUPLICATE_PRICE' } });
      expect(await statuses(`${PROFESSIONAL}=price_business_v2`)).toMatchObject({ ok: false, entries: { [PROFESSIONAL]: 'MISMATCH', [BUSINESS]: 'PINNED_ONLY' } });
      expect(await statuses(`${BUSINESS}=price_business_v2,${PROFESSIONAL}=price_professional`, true)).toMatchObject({ ok: false, failures: 1, entries: { [PROFESSIONAL]: 'ENV_FALLBACK' } });
    });

    it('the check writes nothing', async () => {
      const snapshot = async () =>
        (
          await pg.query(
            `SELECT (SELECT count(*) FROM subscription."PlanVersion") AS v, (SELECT count(*) FROM subscription."PlanVersionPrice") AS p,
                    (SELECT count(*) FROM subscription."SubscriptionVersionPinEvent") AS e, (SELECT count(*) FROM subscription."TenantSubscription") AS s,
                    (SELECT md5(string_agg(t::text, '|' ORDER BY id)) FROM subscription."PlanVersion" t) AS h`,
          )
        ).rows[0];
      const before = await snapshot();
      await checkProviderPriceParity(prisma, `${BUSINESS}=price_business`, { strict: true });
      expect(await snapshot()).toEqual(before);
    });

    it('the command: exit 0 on parity, exit 1 on a mismatch', async () => {
      const run = promisify(execFile);
      const args = ['deploy/jiti-tsconfig-runner.mjs', 'libs/subscription/prisma/check-provider-price-parity.ts'];
      const base = { ...process.env, DATABASE_URL: container.getConnectionUri() };
      const ok = await run('node', args, { cwd: ROOT, env: { ...base, STRIPE_PLAN_PRICES: `${BUSINESS}=price_business_v2` } });
      expect(ok.stdout).toContain('[price-parity] OK');
      const bad = await run('node', args, { cwd: ROOT, env: { ...base, STRIPE_PLAN_PRICES: `${BUSINESS}=price_business` } }).catch((e: { code: number; stdout: string }) => e);
      expect(bad).toMatchObject({ code: 1 });
      expect((bad as { stdout: string }).stdout).toContain('MISMATCH');
    });
  });

  // ── the compensating migration ────────────────────────────────────────────────────────
  it('compensating migration: applies while only v1 exists (A5 then re-applies identically), refused once a price pin or a later version exists', async () => {
    const db = await freshDatabase(container, 'ccp_a5_comp');
    try {
      for (const m of PRE_A4) await db.query(readFileSync(m, 'utf8'));
      await seedCorpus(db);
      await db.query(readFileSync(CCP_A4_MIGRATION, 'utf8'));
      await db.query(readFileSync(CCP_A5_MIGRATION, 'utf8'));
      const versions = async () => (await db.query(`SELECT id, plan_id, content_checksum FROM subscription."PlanVersion" ORDER BY id`)).rows;
      const first = await versions();
      const counts = await rowCounts(db);
      await db.query(readFileSync(CCP_A5_COMPENSATING, 'utf8'));
      const left = await db.query(
        `SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'subscription' AND table_name IN ('PlanVersion', 'PlanVersionPrice', 'SubscriptionVersionPinEvent')) AS tables,
                (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'subscription' AND column_name = 'plan_version_id') AS cols,
                (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'subscription' AND p.proname LIKE 'ccp\\_%') AS funcs`,
      );
      expect(left.rows[0]).toEqual({ tables: 0, cols: 0, funcs: 0 });
      expect(await rowCounts(db)).toEqual(counts);
      await db.query(readFileSync(CCP_A5_MIGRATION, 'utf8'));
      expect(await versions()).toEqual(first);
      // Refused once information would be lost.
      const v1 = first[0].id as string;
      await db.query(`INSERT INTO subscription."PlanVersionPrice" (id, plan_version_id, provider, provider_price_ref, created_by, created_at) VALUES (gen_random_uuid(), $1::uuid, 'STRIPE', 'price_c', 'x', now())`, [v1]);
      await expect(db.query(readFileSync(CCP_A5_COMPENSATING, 'utf8'))).rejects.toThrow(/compensation refused: a provider price is pinned/);
      await db.query(
        `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
         SELECT gen_random_uuid(), plan_id, 2, 'DRAFT', content, content_checksum, 'x', now() FROM subscription."PlanVersion" WHERE id = $1::uuid`,
        [v1],
      );
      await expect(db.query(readFileSync(CCP_A5_COMPENSATING, 'utf8'))).rejects.toThrow(/compensation refused: a plan version other than the migration v1/);
    } finally {
      await db.end();
    }
  });
});
