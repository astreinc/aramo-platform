import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parsePlanVersionContent, planVersionChecksum, priceUnitOf } from '../lib/plan-version.js';

// Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) §3.1 with Amendment A1 (No
// Existing Subscribers, LOCKED) on real Postgres: the schema part (price_unit CHECK, seat columns) leaves every
// existing PlanVersion checksum valid; the catalog part publishes exactly one SEAT version of Standard Business
// (1500) and Standard Professional (2000) with no provider price pin, retires the previous one, leaves every
// other Sign plan's published version untouched, is idempotent, and refuses a database where a subscription is
// on either plan (A1-3).

const ROOT = resolve(__dirname, '../../../..');
const SUB_DIR = resolve(ROOT, 'libs/subscription/prisma/migrations');
const SCHEMA = '20261108100000_sign_business_per_seat';
const CATALOG = '20261108100100_sign_business_per_seat_catalog';
const names = readdirSync(SUB_DIR).filter((n) => /^\d/.test(n)).sort();
const file = (n: string): string => resolve(SUB_DIR, n, 'migration.sql');
const BEFORE_SCHEMA = [resolve(ROOT, 'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'), ...names.filter((n) => n < SCHEMA).map(file)];
const CATALOG_SQL = readFileSync(file(CATALOG), 'utf8');
const ACTOR = `migration:${CATALOG}`;

const BUSINESS = 'aramo-sign-standard-business-v1';
const PROFESSIONAL = 'aramo-sign-standard-professional-v1';
const PRICES: Readonly<Record<string, number>> = { [BUSINESS]: 1500, [PROFESSIONAL]: 2000 };

interface Row {
  id: string;
  key: string;
  tenant_kind: string | null;
  version_number: number;
  status: string;
  content: Record<string, unknown>;
  content_checksum: string;
  created_by: string;
  live: Record<string, unknown>;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign Business per-seat pricing migrations (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let before: Row[];

  const versions = async (): Promise<Row[]> =>
    (
      await pg.query<Row>(
        `SELECT v.id, p.key, p.tenant_kind, v.version_number, v.status, v.content, v.content_checksum, v.created_by,
                subscription.ccp_plan_live_content(p.id) AS live
           FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id ORDER BY p.key, v.version_number`,
      )
    ).rows;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    expect(names).toContain(SCHEMA);
    expect(names).toContain(CATALOG);
    for (const m of BEFORE_SCHEMA) await pg.query(readFileSync(m, 'utf8'));
    before = await versions();
    await pg.query(readFileSync(file(SCHEMA), 'utf8'));
  }, 180_000);

  afterAll(async () => {
    await pg?.end();
    await container?.stop();
  });

  it('schema: every existing version keeps its content and checksum, and the seat columns are nullable', async () => {
    expect(await versions()).toEqual(before);
    for (const r of before) expect(r.content).not.toHaveProperty('price_unit');
    const cols = await pg.query(
      `SELECT table_name, column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'subscription' AND column_name IN ('seat_quantity', 'seat_pending_quantity') ORDER BY table_name, column_name`,
    );
    expect(cols.rows).toEqual([
      { table_name: 'CheckoutIntent', column_name: 'seat_quantity', is_nullable: 'YES', data_type: 'integer' },
      { table_name: 'TenantSubscription', column_name: 'seat_pending_quantity', is_nullable: 'YES', data_type: 'integer' },
      { table_name: 'TenantSubscription', column_name: 'seat_quantity', is_nullable: 'YES', data_type: 'integer' },
    ]);
  });

  it('schema: the price_unit CHECK refuses a PERSONAL plan and any value but "SEAT"', async () => {
    const draft = async (key: string, unit: unknown): Promise<string> => {
      await pg.query('SAVEPOINT s');
      try {
        await pg.query(
          `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
           SELECT gen_random_uuid(), p.id, 99, 'DRAFT', c, subscription.ccp_plan_version_checksum(c), 'spec', now()
             FROM subscription."Plan" p, LATERAL (SELECT subscription.ccp_plan_live_content(p.id) || jsonb_build_object('price_unit', $2::jsonb) AS c) x
            WHERE p.key = $1`,
          [key, JSON.stringify(unit)],
        );
        return 'ok';
      } catch (e) {
        return (e as Error).message;
      } finally {
        await pg.query('ROLLBACK TO SAVEPOINT s');
      }
    };
    await pg.query('BEGIN');
    try {
      expect(await draft(BUSINESS, 'SEAT')).toBe('ok');
      expect(await draft('aramo-sign-standard-personal-v1', 'SEAT')).toMatch(/PlanVersion_price_unit_check/);
      expect(await draft('aramo-sign-enterprise-v1', 'SEAT')).toMatch(/PlanVersion_price_unit_check/);
      expect(await draft(BUSINESS, 'ACCOUNT')).toMatch(/PlanVersion_price_unit_check/);
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('A1-3: the catalog part refuses a database where a subscription is on Standard Business', async () => {
    await pg.query('BEGIN');
    try {
      await pg.query(
        `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, period_anchor, source, created_by, status, product_key, composition_role, plan_version_id)
         SELECT gen_random_uuid(), gen_random_uuid(), p.id, now(), 'DEVELOPMENT', 'spec', 'ACTIVE', 'sign', 'BASE', v.id
           FROM subscription."Plan" p JOIN subscription."PlanVersion" v ON v.plan_id = p.id AND v.status = 'PUBLISHED' WHERE p.key = $1`,
        [BUSINESS],
      );
      await expect(pg.query(CATALOG_SQL)).rejects.toThrow(/Amendment A1-3/);
    } finally {
      await pg.query('ROLLBACK');
    }
    expect(await versions()).toEqual(before);
  });

  it('A1-2: both plans end with exactly one PUBLISHED SEAT version at the new price, the previous one RETIRED', async () => {
    await pg.query(CATALOG_SQL);
    const rows = await versions();
    for (const key of [BUSINESS, PROFESSIONAL]) {
      const plan = await pg.query(`SELECT list_price_minor FROM subscription."Plan" WHERE key = $1`, [key]);
      expect(plan.rows[0].list_price_minor).toBe(PRICES[key]);
      const mine = rows.filter((r) => r.key === key);
      const published = mine.filter((r) => r.status === 'PUBLISHED');
      expect(published).toHaveLength(1);
      const v = published[0] as Row;
      expect(v.created_by).toBe(ACTOR);
      expect(v.version_number).toBe(Math.max(...before.filter((r) => r.key === key).map((r) => r.version_number)) + 1);
      const terms = parsePlanVersionContent(v.content);
      expect(priceUnitOf(terms)).toBe('SEAT');
      expect(terms.plan.list_price_minor).toBe(PRICES[key]);
      expect(planVersionChecksum(terms)).toBe(v.content_checksum);
      expect(v.content).toEqual({ ...v.live, price_unit: 'SEAT' });
      const previous = before.find((r) => r.key === key && r.status === 'PUBLISHED') as Row;
      expect(mine.find((r) => r.id === previous.id)?.status).toBe('RETIRED');
      // A1-5 — no provider price on the per-seat version.
      const pins = await pg.query(`SELECT 1 FROM subscription."PlanVersionPrice" WHERE plan_version_id = $1`, [v.id]);
      expect(pins.rows).toHaveLength(0);
    }
  });

  it('A1-4: every other plan keeps its versions, and every pre-existing version keeps its content and checksum', async () => {
    const after = await versions();
    for (const b of before) {
      const a = after.find((r) => r.id === b.id) as Row;
      expect(a.content).toEqual(b.content);
      expect(a.content_checksum).toBe(b.content_checksum);
      if (b.key !== BUSINESS && b.key !== PROFESSIONAL) expect(a.status).toBe(b.status);
    }
    const others = (rs: Row[]) => rs.filter((r) => r.key !== BUSINESS && r.key !== PROFESSIONAL).map((r) => [r.id, r.status, r.content_checksum]);
    expect(others(after)).toEqual(others(before));
    const plans = await pg.query(`SELECT key FROM subscription."Plan" WHERE product_key = 'sign'`);
    for (const { key } of plans.rows) expect(after.filter((r) => r.key === key && r.status === 'PUBLISHED')).toHaveLength(1);
  });

  it('is idempotent: a re-apply of both parts adds no version and changes no row', async () => {
    const snapshot = await versions();
    const plans = (await pg.query(`SELECT * FROM subscription."Plan" ORDER BY key`)).rows;
    await pg.query(readFileSync(file(SCHEMA), 'utf8'));
    await pg.query(CATALOG_SQL);
    expect(await versions()).toEqual(snapshot);
    expect((await pg.query(`SELECT * FROM subscription."Plan" ORDER BY key`)).rows).toEqual(plans);
  });
});
