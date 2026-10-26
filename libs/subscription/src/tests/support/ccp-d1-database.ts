import { readFileSync } from 'node:fs';

import type { Client } from 'pg';

import { CCP_A4_MIGRATION } from '../fixtures/ccp-a4.js';
import { CCP_A5_MIGRATION, publishedVersionOf } from '../fixtures/ccp-a5.js';
import { CCP_D1_MIGRATION, writeLedger } from '../fixtures/ccp-d1.js';

import { applyCcpA3Schema } from './ccp-a3-database.js';
import { CCP_A9_MIGRATION } from './ccp-a9-database.js';

// CCP-D1 shared real-Postgres test support (the apps/platform-admin D1 route spec and the
// platform-admin Pact provider): the CCP-A3 schema (identity chain + subscription chain to A3 +
// the CCP role catalog), then A4, A5, A9 and D1 in timestamp order, plus one Sign tenant on a
// MANUAL subscription with ledger usage in two periods.

export async function applyCcpD1Schema(pg: Client): Promise<void> {
  await applyCcpA3Schema(pg);
  for (const f of [CCP_A4_MIGRATION, CCP_A5_MIGRATION, CCP_A9_MIGRATION, CCP_D1_MIGRATION]) await pg.query(readFileSync(f, 'utf8'));
}

export const USAGE_INCLUDED_PLAN = '019a0000-5150-7000-8000-000000000001';

/**
 * A MANUAL Sign subscription (included plan, 100 / month, anchor 2026-09-01) for `tenant_id`,
 * with 3 CONSUMED + 1 RESERVED in the 2026-10-01 period and 2 CONSUMED in 2026-09-01. Idempotent.
 */
export async function seedUsageTenant(pg: Client, tenant_id: string, subscription_id: string): Promise<void> {
  const r = await pg.query(`SELECT 1 FROM subscription."TenantSubscription" WHERE id = $1::uuid`, [subscription_id]);
  if ((r.rowCount ?? 0) > 0) return;
  await pg.query(
    `INSERT INTO subscription."TenantSubscription" (id, tenant_id, plan_id, period_anchor, source, started_at, created_by, status, product_key, composition_role, plan_version_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-09-01T00:00:00Z', 'MANUAL', '2026-09-01T00:00:00Z', 'operator:ccp-d1-fixture', 'ACTIVE', 'sign', 'BASE', ${publishedVersionOf('$3::uuid')})`,
    [subscription_id, tenant_id, USAGE_INCLUDED_PLAN],
  );
  const oct = { tenant_id, period_start: '2026-10-01T00:00:00Z', reserved_at: '2026-10-10T09:00:00Z' };
  const sep = { tenant_id, period_start: '2026-09-01T00:00:00Z', reserved_at: '2026-09-12T09:00:00Z' };
  await writeLedger(pg, [
    { ...oct, state: 'CONSUMED' },
    { ...oct, state: 'CONSUMED' },
    { ...oct, state: 'CONSUMED' },
    { ...oct, state: 'RESERVED' },
    { ...oct, state: 'RELEASED' },
    { ...sep, state: 'CONSUMED' },
    { ...sep, state: 'CONSUMED' },
  ]);
}
