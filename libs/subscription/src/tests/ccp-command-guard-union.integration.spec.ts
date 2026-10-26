import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BILLING_COMMAND_KINDS,
  BILLING_COMMAND_KINDS_BY_ACTION,
  BILLING_COMMAND_STATES,
  canTransitionBillingCommand,
  type BillingCommandState,
} from '../lib/billing/billing-provider-command.js';
import { COMMERCIAL_ACTION_TYPES } from '../lib/commercial/commercial-change-request.js';

import { POLICY_V1, TENANT_1, applyCcpA6Schema } from './support/ccp-a3-database.js';

// CCP merge train — TD-MERGE-CMDGUARD-1. Applies the FULL subscription chain (ending with the
// integrator-owned 20261029000000_ccp_command_guard_union) and asserts that the LIVE
// guard_billing_provider_command() is the union of the C1 base, the CCP-C4 block and the CCP-C7
// block, against explicit tables (the TS mirrors):
//   CMDGUARD-1  INSERT from a change request: every action type x every command kind. Admitted iff
//               BILLING_COMMAND_KINDS_BY_ACTION[action] lists the kind (the C4 block; C1 alone admits
//               only CONVERSION, C7's body alone refuses every CREDIT / DISCOUNT / REFUND kind).
//   CMDGUARD-2  INSERT from a self-service request (the C7 block): only SUBSCRIPTION_CANCEL with
//               {"mode": "AT_PERIOD_END"}; and exactly one origin (none or both refused).
//   CMDGUARD-3  UPDATE: every from-state x to-state against canTransitionBillingCommand (C1 table).
//   CMDGUARD-4  the live body carries both labelled blocks, and is exactly the union migration's.
//   CMDGUARD-5  the compensation restores CCP-C7's body (no C4 block) and is refused while a C4
//               command is unconfirmed; re-applying the union restores the union.
// Method (as GUARD-UNION): each probe runs in a transaction that is always rolled back; fixtures are
// placed with triggers off (session_replication_role = replica, which also skips FK triggers); the
// probed statement runs with triggers on. ONLY the guard's own refusal messages count as refused:
// any other outcome (success, a CHECK, or the guard's later tenant / product check — the probe
// request carries no tenant) means the guard's kind / origin / transition table admitted it.

const REFUSED_INSERT = /does not issue|exactly one origin|issues only SUBSCRIPTION_CANCEL AT_PERIOD_END|needs a completed approval chain/;
const REFUSED_UPDATE = /transition \S+ -> \S+ refused|is CONFIRMED \(terminal\)/;

const ROOT = resolve(__dirname, '../../../..');
const UNION = resolve(ROOT, 'libs/subscription/prisma/migrations/20261029000000_ccp_command_guard_union/migration.sql');
const C7 = resolve(ROOT, 'libs/subscription/prisma/migrations/20261028030000_ccp_c7_self_service_commands/migration.sql');
const COMPENSATION = resolve(ROOT, 'libs/subscription/src/tests/fixtures/ccp-command-guard-union-compensating.sql');

const CR_ID = '019a0000-0000-7000-8000-00000c3d0001';
const SSR_ID = '019a0000-0000-7000-8000-00000c3d0002';
const CMD_ID = '019a0000-0000-7000-8000-00000c3d0003';
const ACTOR = '019a0000-0000-7000-8000-00000c3d0004';
const CHECKSUM = 'a'.repeat(64);
const TARGET = 'sub_cmdguard';

const fnBody = (sql: string): string => {
  const m = /RETURNS TRIGGER AS \$\$\n([\s\S]*?)\n\$\$ LANGUAGE plpgsql;/.exec(sql.slice(sql.indexOf('FUNCTION "subscription"."guard_billing_provider_command"()')));
  if (m === null) throw new Error('no guard_billing_provider_command body');
  return m[1] as string;
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TD-MERGE-CMDGUARD-1 command guard union (real Postgres 17)', { timeout: 600_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    await applyCcpA6Schema(pg);
  }, 600_000);

  afterAll(async () => {
    await pg?.end();
    await container?.stop();
  });

  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    await pg.query('BEGIN');
    try {
      return await fn();
    } finally {
      await pg.query('ROLLBACK');
    }
  }

  async function changeRequest(action: string): Promise<void> {
    await pg.query(
      `INSERT INTO subscription."CommercialChangeRequest"
         (id, action_type, kind, state, payload, payload_checksum, required_chain, policy_version_id, policy_checksum,
          requested_by, reason, idempotency_key, created_at, submitted_at, expires_at, apply_attempts, updated_at)
       VALUES ($1, $2, 'NORMAL', 'APPROVED', '{}'::jsonb, $3, '{"steps": []}'::jsonb, $4, $3, $5, 'cmd guard probe', 'cmd-guard-probe', now(),
               now(), now() + interval '72 hours', 0, now())`,
      [CR_ID, action, CHECKSUM, POLICY_V1, ACTOR],
    );
  }

  async function selfServiceRequest(): Promise<void> {
    await pg.query(
      `INSERT INTO subscription."SelfServiceBillingRequest" (id, tenant_id, product_key, action, subscription_id, provider, target_ref, terms_ref, requested_by, created_at)
       VALUES ($1, $2, 'sign', 'CANCEL_AT_PERIOD_END', gen_random_uuid(), 'STRIPE', $3, $4, $5, now())`,
      [SSR_ID, TENANT_1, TARGET, `sign.terms@1#${'b'.repeat(64)}`, ACTOR],
    );
  }

  /** One INSERT with triggers on; true unless the guard refused it. */
  async function tryInsert(cols: { cr: string | null; ssr: string | null; kind: string; params: object }): Promise<boolean> {
    await pg.query(`SET LOCAL session_replication_role = origin`);
    const key = cols.cr !== null ? `aramo-ccp-${cols.cr}-probe` : `aramo-ccp-ss-${String(cols.ssr)}-probe`;
    try {
      await pg.query('SAVEPOINT p');
      await pg.query(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, self_service_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES ($1, 'STRIPE', $2, $3, $4, 'probe', $5, $6, 'sign', $7, $8::jsonb, 'PENDING', 0, $9, now(), now())`,
        [CMD_ID, cols.kind, cols.cr, cols.ssr, key, TENANT_1, TARGET, JSON.stringify(cols.params), ACTOR],
      );
      await pg.query('RELEASE SAVEPOINT p');
      return true;
    } catch (e) {
      await pg.query('ROLLBACK TO SAVEPOINT p');
      return !REFUSED_INSERT.test((e as Error).message);
    }
  }

  it('CMDGUARD-1 INSERT from a change request: every action type x command kind is admitted iff BILLING_COMMAND_KINDS_BY_ACTION lists the kind', async () => {
    const mismatches: string[] = [];
    let admitted = 0;
    let probes = 0;
    for (const action of COMMERCIAL_ACTION_TYPES) {
      for (const kind of BILLING_COMMAND_KINDS) {
        const db = await inTx(async () => {
          await pg.query(`SET LOCAL session_replication_role = replica`);
          await changeRequest(action);
          return tryInsert({ cr: CR_ID, ssr: null, kind, params: {} });
        });
        const ts = (BILLING_COMMAND_KINDS_BY_ACTION[action] ?? []).includes(kind);
        probes += 1;
        if (db) admitted += 1;
        if (db !== ts) mismatches.push(`${action} / ${kind}: db=${db} ts=${ts}`);
      }
    }
    expect(probes).toBe(COMMERCIAL_ACTION_TYPES.length * BILLING_COMMAND_KINDS.length);
    // CONVERSION 2 + CREDIT 2 + DISCOUNT 2 + REFUND 1.
    expect(admitted).toBe(7);
    expect(mismatches).toEqual([]);
  });

  it('CMDGUARD-2 INSERT from a self-service request: only SUBSCRIPTION_CANCEL AT_PERIOD_END; exactly one origin', async () => {
    const out: Record<string, boolean> = {};
    for (const kind of BILLING_COMMAND_KINDS) {
      for (const [label, params] of [['period_end', { mode: 'AT_PERIOD_END' }], ['immediate', { mode: 'IMMEDIATE' }], ['empty', {}]] as const) {
        out[`${kind}/${label}`] = await inTx(async () => {
          await pg.query(`SET LOCAL session_replication_role = replica`);
          await selfServiceRequest();
          return tryInsert({ cr: null, ssr: SSR_ID, kind, params });
        });
      }
    }
    expect(Object.entries(out).filter(([, ok]) => ok).map(([k]) => k)).toEqual(['SUBSCRIPTION_CANCEL/period_end']);
    const none = await inTx(() => tryInsert({ cr: null, ssr: null, kind: 'SUBSCRIPTION_CANCEL', params: { mode: 'AT_PERIOD_END' } }));
    const both = await inTx(async () => {
      await pg.query(`SET LOCAL session_replication_role = replica`);
      await changeRequest('CONVERSION');
      await selfServiceRequest();
      return tryInsert({ cr: CR_ID, ssr: SSR_ID, kind: 'SUBSCRIPTION_CANCEL', params: { mode: 'AT_PERIOD_END' } });
    });
    expect([none, both]).toEqual([false, false]);
  });

  it('CMDGUARD-3 UPDATE: every from-state x to-state agrees with canTransitionBillingCommand', async () => {
    const mismatches: string[] = [];
    let probes = 0;
    const cols = (s: BillingCommandState, attempts: number, past: boolean): string =>
      [
        `state = '${s}'`,
        `attempts = ${attempts}`,
        `lease_until = ${s === 'DISPATCHING' ? (past ? `now() - interval '1 minute'` : `now() + interval '5 minutes'`) : 'NULL'}`,
        `next_attempt_at = ${s === 'RETRY_WAIT' ? `now() + interval '1 minute'` : 'NULL'}`,
        `last_error_code = ${s === 'RETRY_WAIT' || s === 'FAILED' ? `'PROBE'` : 'NULL'}`,
        `failed_at = ${s === 'FAILED' ? 'now()' : 'NULL'}`,
        `confirmed_at = ${s === 'CONFIRMED' ? 'now()' : 'NULL'}`,
        `confirmation_source = ${s === 'CONFIRMED' ? `'REFETCH'` : 'NULL'}`,
        `updated_at = now()`,
      ].join(', ');
    for (const from of BILLING_COMMAND_STATES) {
      for (const to of BILLING_COMMAND_STATES) {
        const db = await inTx(async () => {
          await pg.query(`SET LOCAL session_replication_role = replica`);
          await changeRequest('CONVERSION');
          await pg.query(
            `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
             VALUES ($1, 'STRIPE', 'SUBSCRIPTION_CANCEL', $2::uuid, 'probe', 'aramo-ccp-' || $2::text || '-probe', $3, 'sign', $4, '{"mode": "IMMEDIATE"}'::jsonb, 'PENDING', 1, $5, now(), now())`,
            [CMD_ID, CR_ID, TENANT_1, TARGET, ACTOR],
          );
          await pg.query(`UPDATE subscription."BillingProviderCommand" SET ${cols(from, 1, true)} WHERE id = $1`, [CMD_ID]);
          await pg.query(`SET LOCAL session_replication_role = origin`);
          try {
            await pg.query(`UPDATE subscription."BillingProviderCommand" SET ${cols(to, to === 'DISPATCHING' ? 2 : 1, false)} WHERE id = $1`, [CMD_ID]);
            return true;
          } catch (e) {
            return !REFUSED_UPDATE.test((e as Error).message);
          }
        });
        probes += 1;
        const ts = canTransitionBillingCommand(from, to);
        if (db !== ts) mismatches.push(`${from} -> ${to}: db=${db} ts=${ts}`);
      }
    }
    expect(probes).toBe(BILLING_COMMAND_STATES.length ** 2);
    expect(mismatches).toEqual([]);
  });

  const liveBody = async (): Promise<string> =>
    (
      await pg.query<{ src: string }>(
        `SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'subscription' AND p.proname = 'guard_billing_provider_command'`,
      )
    ).rows[0]?.src ?? '';

  it('CMDGUARD-4 the live body is the union migration (both labelled blocks; no later migration replaced it)', async () => {
    const src = await liveBody();
    expect(src).toContain('>>> CCP-C7 self-service origin');
    expect(src).toContain('>>> CCP-C4');
    expect(src.trim()).toBe(fnBody(readFileSync(UNION, 'utf8')).trim());
  });

  it('CMDGUARD-5 the compensation restores the CCP-C7 body, is refused while a C4 command is unconfirmed, and the union re-applies', async () => {
    // Refused while a CREDIT command is unconfirmed (nothing changed).
    const refused = await inTx(async () => {
      await pg.query(`SET LOCAL session_replication_role = replica`);
      await changeRequest('CREDIT');
      await pg.query(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES ($1, 'STRIPE', 'CREDIT_GRANT', $2::uuid, 'probe', 'aramo-ccp-' || $2::text || '-probe', $3, 'sign', $4, $5::jsonb, 'PENDING', 0, $6, now(), now())`,
        [CMD_ID, CR_ID, TENANT_1, TARGET, JSON.stringify({ subscription_id: SSR_ID, amount_minor: 100, currency: 'USD' }), ACTOR],
      );
      await pg.query(`SET LOCAL session_replication_role = origin`);
      try {
        await pg.query(readFileSync(COMPENSATION, 'utf8'));
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(refused).toMatch(/compensation refused: a CCP-C4 provider command is not confirmed/);
    expect((await liveBody()).trim()).toBe(fnBody(readFileSync(UNION, 'utf8')).trim());
    // Applied on a clean state: the body is C7's verbatim (no C4 block).
    await pg.query('BEGIN');
    await pg.query(readFileSync(COMPENSATION, 'utf8'));
    await pg.query('COMMIT');
    const compensated = await liveBody();
    expect(compensated.trim()).toBe(fnBody(readFileSync(C7, 'utf8')).trim());
    expect(compensated).not.toContain('>>> CCP-C4');
    // Re-applying the union restores it.
    await pg.query(readFileSync(UNION, 'utf8'));
    expect((await liveBody()).trim()).toBe(fnBody(readFileSync(UNION, 'utf8')).trim());
  });
});
