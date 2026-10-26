import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { Client } from 'pg';

// CCP-D1 (PBD §5.4 row D1) — ONE shared helper for the D1 specs (libs/subscription, the
// platform-admin route spec and the platform-admin Pact provider): the migration, its recorded
// compensating SQL, and ledger writers that keep the metering raw-event stream consistent the
// way AllowanceService.consume does (one UsageEvent per CONSUMED SEND row, same transaction).

export const CCP_D1_MIGRATION = resolve(__dirname, '../../../prisma/migrations/20261025240000_ccp_d1_usage_rollups/migration.sql');
export const CCP_D1_COMPENSATING = resolve(__dirname, 'ccp-d1-compensating.sql');
export const SIGN_ENVELOPES = 'sign.envelopes';
export const SIGN_ENVELOPE_SENT = 'sign.envelope.sent';

export interface LedgerRow {
  tenant_id: string;
  period_start: string;
  reserved_at: string;
  state: 'RESERVED' | 'CONSUMED' | 'RELEASED';
  origin?: 'SEND' | 'HISTORICAL';
  send_key?: string;
}

/**
 * Insert ledger rows in ONE transaction; a CONSUMED SEND row also writes its metering
 * UsageEvent (as consume does). Returns the send keys.
 */
export async function writeLedger(pg: Client, rows: readonly LedgerRow[]): Promise<string[]> {
  const keys: string[] = [];
  await pg.query('BEGIN');
  try {
    for (const r of rows) {
      const send_key = r.send_key ?? `d1:${randomUUID()}`;
      keys.push(send_key);
      const origin = r.origin ?? 'SEND';
      await pg.query(
        `INSERT INTO subscription."AllowanceUsage" (id, tenant_id, allowance_key, send_key, period_start, state, origin, reserved_at, reserved_until, finalized_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::timestamptz, $5, $6, $7::timestamptz, $7::timestamptz + interval '10 minutes',
                 CASE WHEN $5 = 'RESERVED' THEN NULL ELSE $7::timestamptz END)`,
        [r.tenant_id, SIGN_ENVELOPES, send_key, r.period_start, r.state, origin, r.reserved_at],
      );
      if (r.state === 'CONSUMED' && origin === 'SEND') await usageEvent(pg, r.tenant_id, r.reserved_at);
    }
    await pg.query('COMMIT');
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  }
  return keys;
}

export async function usageEvent(pg: Client, tenant_id: string, occurred_at: string, quantity = 1): Promise<void> {
  await pg.query(
    `INSERT INTO metering."UsageEvent" (id, tenant_id, event_type, quantity, occurred_at) VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::timestamptz)`,
    [tenant_id, SIGN_ENVELOPE_SENT, quantity, occurred_at],
  );
}

/**
 * The raw-event backfill for ledger rows written WITHOUT their UsageEvent (the A4 corpus seeds
 * the ledger directly): one UsageEvent per CONSUMED SEND row that has none yet.
 */
export async function backfillUsageEventsForLedger(pg: Client): Promise<number> {
  const r = await pg.query(
    `WITH need AS (
       SELECT a.tenant_id, a.reserved_at, a.n - coalesce(e.n, 0) AS missing
         FROM (SELECT tenant_id, min(reserved_at) AS reserved_at, count(*)::int AS n FROM subscription."AllowanceUsage"
                WHERE allowance_key = $1 AND state = 'CONSUMED' AND origin = 'SEND' GROUP BY tenant_id) a
         LEFT JOIN (SELECT tenant_id, sum(quantity)::int AS n FROM metering."UsageEvent" WHERE event_type = $2 GROUP BY tenant_id) e USING (tenant_id))
     INSERT INTO metering."UsageEvent" (id, tenant_id, event_type, quantity, occurred_at)
     SELECT gen_random_uuid(), need.tenant_id, $2, 1, need.reserved_at FROM need, generate_series(1, greatest(need.missing, 0))
     RETURNING id`,
    [SIGN_ENVELOPES, SIGN_ENVELOPE_SENT],
  );
  return r.rowCount ?? 0;
}

/** An independent SQL recomputation of the ledger per (tenant, period_start) — the reconciliation reference. */
export async function ledgerTotals(pg: Client): Promise<Array<{ tenant_id: string; period_start: string; consumed: number; consumed_send: number; consumed_historical: number; reserved: number }>> {
  const r = await pg.query(
    `SELECT tenant_id::text AS tenant_id, to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS period_start,
            count(*) FILTER (WHERE state = 'CONSUMED')::int AS consumed,
            count(*) FILTER (WHERE state = 'CONSUMED' AND origin = 'SEND')::int AS consumed_send,
            count(*) FILTER (WHERE state = 'CONSUMED' AND origin = 'HISTORICAL')::int AS consumed_historical,
            count(*) FILTER (WHERE state = 'RESERVED')::int AS reserved
       FROM subscription."AllowanceUsage" WHERE allowance_key = $1 AND state IN ('CONSUMED', 'RESERVED')
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [SIGN_ENVELOPES],
  );
  return r.rows;
}

/** The period roll-ups in the same shape (for byte-equality against the ledger). */
export async function rollupTotals(pg: Client): Promise<Array<{ tenant_id: string; period_start: string; consumed: number; consumed_send: number; consumed_historical: number; reserved: number }>> {
  const r = await pg.query(
    `SELECT tenant_id::text AS tenant_id, to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS period_start,
            consumed_count AS consumed, consumed_send_count AS consumed_send, consumed_historical_count AS consumed_historical, reserved_count AS reserved
       FROM subscription."UsageRollupPeriod" WHERE metric_key = $1 ORDER BY 1, 2`,
    [SIGN_ENVELOPES],
  );
  return r.rows;
}

/** Every derived row, without run_id / computed_at (identical across idempotent re-runs). */
export async function derivedSnapshot(pg: Client): Promise<{ daily: unknown[]; period: unknown[] }> {
  const daily = (
    await pg.query(
      `SELECT tenant_id, metric_key, product_key, period_start, usage_date::text AS usage_date, consumed_count, consumed_send_count, consumed_historical_count, reserved_count
         FROM subscription."UsageRollupDaily" ORDER BY tenant_id, metric_key, period_start, usage_date`,
    )
  ).rows;
  const period = (
    await pg.query(
      `SELECT tenant_id, metric_key, product_key, period_start, period_end, alignment, subscription_id, plan_version_id, included_quantity, unlimited,
              consumed_count, consumed_send_count, consumed_historical_count, reserved_count
         FROM subscription."UsageRollupPeriod" ORDER BY tenant_id, metric_key, period_start`,
    )
  ).rows;
  return { daily, period };
}

/** md5 of every ledger column of every ledger row — proves the worker never writes the ledger. */
export async function ledgerFingerprint(pg: Client): Promise<{ rows: number; md5: string }> {
  const r = await pg.query(
    `SELECT count(*)::int AS rows, md5(coalesce(string_agg(concat_ws('|', id, tenant_id, allowance_key, send_key, period_start, state, origin, reserved_at, reserved_until, finalized_at), ',' ORDER BY id), '')) AS md5
       FROM subscription."AllowanceUsage"`,
  );
  return r.rows[0];
}

/** The AllowanceUsage table definition (columns, constraints, indexes, user triggers) — TD-D1-3 ruling evidence. */
export async function ledgerDefinition(pg: Client): Promise<{
  columns: Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>;
  constraints: Array<{ conname: string; def: string }>;
  indexes: Array<{ indexname: string; indexdef: string }>;
  triggers: Array<{ tgname: string; def: string }>;
}> {
  const columns = (await pg.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'subscription' AND table_name = 'AllowanceUsage' ORDER BY ordinal_position`)).rows;
  const constraints = (await pg.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'subscription."AllowanceUsage"'::regclass ORDER BY conname`)).rows;
  const indexes = (await pg.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'subscription' AND tablename = 'AllowanceUsage' ORDER BY indexname`)).rows;
  const triggers = (await pg.query(`SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'subscription."AllowanceUsage"'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
  return { columns, constraints, indexes, triggers };
}
