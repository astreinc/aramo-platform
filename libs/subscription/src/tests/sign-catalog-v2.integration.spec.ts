import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parsePlanVersionContent, planVersionChecksum } from '../lib/plan-version.js';

// Aramo-Sign-Catalog-v2-Pricing-and-Features-Directive-v1_0-LOCKED (fc755040) §4.1 migration part,
// §4.2, P-3, P-6 and L-1 on real Postgres 17: the full metering + subscription migration chain,
// then the final catalog rows, the version cut-over (DRAFT -> PUBLISHED, previous RETIRED), content
// that parses as format 1 with a verifying checksum, and an idempotent re-apply.

const ROOT = resolve(__dirname, '../../../..');
const SUB_DIR = resolve(ROOT, 'libs/subscription/prisma/migrations');
const ALL = [
  resolve(ROOT, 'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql'),
  // The chain up to and including Catalog v2: this spec asserts the catalog v2 produced (later catalog
  // data, e.g. 20261108100100_sign_business_per_seat_catalog, has its own spec).
  ...readdirSync(SUB_DIR)
    .filter((n) => /^\d/.test(n) && n <= '20261101120000_sign_catalog_v2')
    .sort()
    .map((n) => resolve(SUB_DIR, n, 'migration.sql')),
];
const V2 = resolve(SUB_DIR, '20261101120000_sign_catalog_v2/migration.sql');
const V2_ACTOR = 'migration:20261101120000_sign_catalog_v2';
const A5_ACTOR = 'migration:20261025160000_ccp_a5_plan_version';

const FREE = 'aramo-sign-free-personal-v1';
const STANDARD = 'aramo-sign-standard-personal-v1';
const BUSINESS = 'aramo-sign-standard-business-v1';
const PROFESSIONAL = 'aramo-sign-standard-professional-v1';
const ENTERPRISE = 'aramo-sign-enterprise-v1';
const FEATURES = ['sign.advanced_analytics', 'sign.ai_assist_summary', 'sign.custom_domain', 'sign.team_collaboration'];

interface VersionRow {
  key: string;
  version_number: number;
  status: string;
  content: unknown;
  content_checksum: string;
  note: string | null;
  created_by: string;
  live: unknown;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign Catalog v2 migration (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;

  const plan = async (key: string): Promise<Record<string, unknown>> => {
    const r = await pg.query(`SELECT * FROM subscription."Plan" WHERE key = $1`, [key]);
    expect(r.rows).toHaveLength(1);
    return r.rows[0];
  };
  const versions = async (): Promise<VersionRow[]> =>
    (
      await pg.query<VersionRow>(
        `SELECT p.key, v.version_number, v.status, v.content, v.content_checksum, v.note, v.created_by,
                subscription.ccp_plan_live_content(p.id) AS live
           FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id
          WHERE p.product_key = 'sign' ORDER BY p.key, v.version_number`,
      )
    ).rows;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    expect(ALL).toContain(V2);
    for (const m of ALL) await pg.query(readFileSync(m, 'utf8'));
  }, 180_000);

  afterAll(async () => {
    await pg?.end();
    await container?.stop();
  });

  it('adds the Standard plan for individuals with the directive terms and features as Free (all off)', async () => {
    const p = await plan(STANDARD);
    expect(p).toMatchObject({
      id: '019a0000-5150-7000-8000-000000000014',
      name: 'Standard',
      sellable: true,
      product_key: 'sign',
      tenant_kind: 'PERSONAL',
      sales_model: 'SELF_SERVICE',
      status: 'ACTIVE',
      list_price_minor: 1000,
      currency: 'USD',
      reference_price_minor: null,
      reference_price_substantiated: false,
      billing_interval: 'MONTH',
      commitment_months: 12,
      eligibility: null,
      display_order: 15,
    });
    const free = await plan(FREE);
    const business = await plan(BUSINESS);
    expect(Number(free['display_order'])).toBeLessThan(Number(p['display_order']));
    expect(Number(p['display_order'])).toBeLessThan(Number(business['display_order']));

    const allowances = await pg.query(`SELECT allowance_key, included_quantity, unlimited, period FROM subscription."PlanAllowance" WHERE plan_id = $1`, [p['id']]);
    expect(allowances.rows).toEqual([{ allowance_key: 'sign.envelopes', included_quantity: 25, unlimited: false, period: 'MONTHLY' }]);
    const windows = await pg.query(`SELECT 1 FROM subscription."PlanAllowanceWindow" WHERE plan_id = $1`, [p['id']]);
    expect(windows.rows).toHaveLength(0);
    const capacities = await pg.query(`SELECT capacity_key, limit_quantity::text AS limit_quantity, unlimited FROM subscription."PlanCapacity" WHERE plan_id = $1`, [p['id']]);
    expect(capacities.rows).toEqual([{ capacity_key: 'sign.storage_bytes', limit_quantity: '1073741824', unlimited: false }]);
    const features = await pg.query(`SELECT feature_key, enabled FROM subscription."PlanFeature" WHERE plan_id = $1 ORDER BY feature_key`, [p['id']]);
    expect(features.rows).toEqual(FEATURES.map((feature_key) => ({ feature_key, enabled: false })));
  });

  it('corrects descriptions, removes Professional eligibility, turns AI summary off, keeps prices (L-1)', async () => {
    const free = await plan(FREE);
    const business = await plan(BUSINESS);
    const professional = await plan(PROFESSIONAL);
    expect(free['description']).toBe('For individuals: 5 E-Signs a month (up to 2 a day) and 15 MB storage.');
    expect(business['description']).toBe('For your organization: unlimited E-Signs (fair use), 10 GB storage and team collaboration.');
    expect(professional['description']).toBe('For your organization: unlimited E-Signs (fair use), 25 GB storage and team collaboration.');
    expect(professional['eligibility']).toBeNull();
    expect(business['list_price_minor']).toBe(2000);
    expect(professional['list_price_minor']).toBe(1500);
    expect(free['list_price_minor']).toBe(0);

    const sign = await pg.query(`SELECT description FROM subscription."Plan" WHERE product_key = 'sign' AND description IS NOT NULL`);
    for (const { description } of sign.rows) expect(description).not.toMatch(/template|form|\bAI\b/i);

    const ai = await pg.query(
      `SELECT p.key, f.enabled FROM subscription."PlanFeature" f JOIN subscription."Plan" p ON p.id = f.plan_id
        WHERE f.feature_key = 'sign.ai_assist_summary' AND p.key IN ($1, $2) ORDER BY p.key`,
      [BUSINESS, PROFESSIONAL],
    );
    expect(ai.rows).toEqual([
      { key: BUSINESS, enabled: false },
      { key: PROFESSIONAL, enabled: false },
    ]);
    const team = await pg.query(
      `SELECT count(*)::int AS n FROM subscription."PlanFeature" f JOIN subscription."Plan" p ON p.id = f.plan_id
        WHERE f.feature_key = 'sign.team_collaboration' AND f.enabled AND p.key IN ($1, $2)`,
      [BUSINESS, PROFESSIONAL],
    );
    expect(team.rows[0].n).toBe(2);
  });

  it('P-6: the Free plan has no templates (capacity 0, no template feature) and keeps its daily window of 2', async () => {
    const free = await plan(FREE);
    const tpl = await pg.query(`SELECT limit_quantity::text AS q, unlimited FROM subscription."PlanCapacity" WHERE plan_id = $1 AND capacity_key = 'sign.templates'`, [free['id']]);
    expect(tpl.rows).toEqual([{ q: '0', unlimited: false }]);
    const tplFeature = await pg.query(`SELECT 1 FROM subscription."PlanFeature" WHERE plan_id = $1 AND feature_key LIKE '%template%' AND enabled`, [free['id']]);
    expect(tplFeature.rows).toHaveLength(0);
    const window = await pg.query(`SELECT allowance_key, window_kind, limit_quantity FROM subscription."PlanAllowanceWindow" WHERE plan_id = $1`, [free['id']]);
    expect(window.rows).toEqual([{ allowance_key: 'sign.envelopes', window_kind: 'DAY', limit_quantity: 2 }]);
  });

  it('cuts the changed plans over to a new PUBLISHED version and retires the previous one', async () => {
    const rows = await versions();
    const of = (key: string) => rows.filter((r) => r.key === key).map((r) => [r.version_number, r.status, r.created_by]);
    for (const key of [FREE, BUSINESS, PROFESSIONAL]) {
      expect(of(key)).toEqual([
        [1, 'RETIRED', A5_ACTOR],
        [2, 'PUBLISHED', V2_ACTOR],
      ]);
    }
    expect(of(ENTERPRISE)).toEqual([[1, 'PUBLISHED', A5_ACTOR]]);
    expect(of(STANDARD)).toEqual([[1, 'PUBLISHED', V2_ACTOR]]);
    for (const r of rows.filter((x) => x.created_by === V2_ACTOR)) expect(r.note).toMatch(/^Sign Catalog v2 \(directive fc755040\)/);

    const plans = await pg.query(`SELECT key FROM subscription."Plan" WHERE product_key = 'sign'`);
    for (const { key } of plans.rows) expect(rows.filter((r) => r.key === key && r.status === 'PUBLISHED')).toHaveLength(1);
  });

  it('every PUBLISHED content parses as format 1, its checksum verifies, and it equals the live rows', async () => {
    const published = (await versions()).filter((r) => r.status === 'PUBLISHED');
    expect(published.length).toBeGreaterThanOrEqual(6);
    for (const r of published) {
      const content = parsePlanVersionContent(r.content);
      expect(content.plan.key).toBe(r.key);
      expect(planVersionChecksum(content)).toBe(r.content_checksum);
      expect(r.content).toEqual(r.live);
    }
    const standard = parsePlanVersionContent(published.find((r) => r.key === STANDARD)?.content);
    expect(standard.plan.list_price_minor).toBe(1000);
    expect(standard.plan.commitment_months).toBe(12);
    expect(standard.features.every((f) => !f.enabled)).toBe(true);
    const professional = parsePlanVersionContent(published.find((r) => r.key === PROFESSIONAL)?.content);
    expect(professional.plan.eligibility).toBeNull();
  });

  it('is idempotent: a re-apply adds no version and changes no row', async () => {
    const before = await versions();
    const plans = (await pg.query(`SELECT * FROM subscription."Plan" WHERE product_key = 'sign' ORDER BY key`)).rows;
    await pg.query('BEGIN');
    await pg.query(readFileSync(V2, 'utf8'));
    await pg.query('COMMIT');
    expect(await versions()).toEqual(before);
    expect((await pg.query(`SELECT * FROM subscription."Plan" WHERE product_key = 'sign' ORDER BY key`)).rows).toEqual(plans);
  });
});
