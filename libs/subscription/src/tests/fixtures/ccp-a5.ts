import { resolve } from 'node:path';

import type { Client } from 'pg';

// CCP-A5 (PBD §5.1 A5 row; MP-A2 N-15…N-19) — ONE shared helper for the specs the A5
// migration ripples into (CLAUDE.md: one helper, not N duplicated edits).

/** The A5 migration (PlanVersion, PlanVersionPrice, pin history, plan_version_id + v1 backfill). */
export const CCP_A5_MIGRATION = resolve(__dirname, '../../../prisma/migrations/20261025160000_ccp_a5_plan_version/migration.sql');

/** The recorded compensating SQL (pre-execution record §4). Executed by the A5 spec only. */
export const CCP_A5_COMPENSATING = resolve(__dirname, 'ccp-a5-compensating.sql');

/**
 * SQL expression for the PUBLISHED (current) version of the plan whose id is `planIdSql`
 * (e.g. `p.id` or `$3::uuid`). A raw TenantSubscription INSERT names plan_version_id with it:
 * there is no DB default (A0-C7 rule carried to A5).
 */
export const publishedVersionOf = (planIdSql: string): string =>
  `(SELECT v.id FROM subscription."PlanVersion" v WHERE v.plan_id = ${planIdSql} AND v.status = 'PUBLISHED')`;

/**
 * A plan created by a test AFTER the A5 migration has no version. This publishes its v1 from
 * its live rows (DRAFT, then PUBLISHED, as the guard trigger requires). Test databases only.
 */
export async function publishTestPlanV1(pg: Client, planId: string): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO subscription."PlanVersion" (id, plan_id, version_number, status, content, content_checksum, created_by, created_at)
     SELECT gen_random_uuid(), $1::uuid, 1, 'DRAFT', x.c, subscription.ccp_plan_version_checksum(x.c), 'test', now()
       FROM (SELECT subscription.ccp_plan_live_content($1::uuid) AS c) x
     RETURNING id`,
    [planId],
  );
  const id = r.rows[0]!.id;
  await pg.query(`UPDATE subscription."PlanVersion" SET status = 'PUBLISHED', published_at = now() WHERE id = $1::uuid`, [id]);
  return id;
}
