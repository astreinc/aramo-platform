import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  COMMERCIAL_ACTION_TYPES,
  COMMERCIAL_CHANGE_REQUEST_KINDS,
  COMMERCIAL_CHANGE_REQUEST_STATES,
  canTransitionFor,
  isApplyExpirable,
} from '../lib/commercial/commercial-change-request.js';
import { CommercialChangeRequestService, type CommercialChangeRequestRow } from '../lib/commercial/commercial-change-request.service.js';

import { POLICY_V1, applyCcpA6Schema } from './support/ccp-a3-database.js';

// CCP merge train — TD-MERGE-GUARD-1. Applies the FULL subscription chain (every lib migration,
// in order, ending with the integrator-owned 20261027000000_ccp_guard_union) and asserts that the
// LIVE guard_commercial_change_request() admits exactly the transitions its TypeScript mirror
// (canTransitionFor) admits, for every action type x kind x from-state x to-state.
//
// Method: per probe, in a transaction that is always rolled back, the row is placed in `from`
// with triggers off (session_replication_role = replica; CHECKs still hold), triggers are turned
// back on, and one UPDATE moves it to `to`. The guard REFUSES the transition when it raises one of
// its transition-table messages (state X -> Y is not allowed, terminal state is immutable, columns
// change only with a state transition, kind is not applied). Any other outcome (success, or a later
// guard check such as the approval count or a missing application record, or a CHECK) means the
// transition table ADMITTED it. A dropped slice branch therefore fails here loudly.

const REFUSED = /state \S+ -> \S+ is not allowed|in terminal state \S+ is immutable|columns change only with a state transition|kind \S+ is not applied/;

// canTransitionFor's optional `kind` (CCP-A8) is passed positionally, so this spec compiles both
// before and after that parameter exists.
const mirror = (action: string, kind: string, from: string, to: string): boolean =>
  (canTransitionFor as unknown as (a: string, f: string, t: string, k: string) => boolean)(action, from, to, kind);

const ID = '019a0000-0000-7000-8000-0000000c0de1';
const CHECKSUM = 'a'.repeat(64);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TD-MERGE-GUARD-1 guard union = canTransitionFor (real Postgres 17)', { timeout: 600_000 }, () => {
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

  async function probe(action: string, kind: string, from: string, to: string): Promise<boolean> {
    await pg.query('BEGIN');
    try {
      await pg.query(`SET LOCAL session_replication_role = replica`);
      const submitted = from !== 'DRAFT';
      await pg.query(
        `INSERT INTO subscription."CommercialChangeRequest"
           (id, action_type, kind, state, payload, payload_checksum, required_chain, policy_version_id, policy_checksum,
            requested_by, reason, idempotency_key, created_at, submitted_at, expires_at, applied_at, apply_attempts, updated_at)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, '{"steps": []}'::jsonb, $6, $5, $1, 'guard probe', 'guard-union-probe', now(),
                 ${submitted ? 'now()' : 'NULL'}, ${submitted ? "now() + interval '72 hours'" : 'NULL'}, ${from === 'APPLIED' ? 'now()' : 'NULL'}, 1, now())`,
        [ID, action, kind, from, CHECKSUM, POLICY_V1],
      );
      await pg.query(`SET LOCAL session_replication_role = origin`);
      const sets = [`state = $2`];
      if (from === 'DRAFT' && to !== 'DRAFT' && to !== 'WITHDRAWN') sets.push(`submitted_at = now()`, `expires_at = now() + interval '72 hours'`);
      if (to === 'APPLYING') sets.push(`apply_attempts = apply_attempts + 1`);
      if (to === 'APPLIED') sets.push(`applied_at = now()`);
      try {
        await pg.query(`UPDATE subscription."CommercialChangeRequest" SET ${sets.join(', ')} WHERE id = $1`, [ID, to]);
        return true;
      } catch (e) {
        return !REFUSED.test((e as Error).message);
      }
    } finally {
      await pg.query('ROLLBACK');
    }
  }

  it('GUARD-UNION-1 the live guard and canTransitionFor agree on every action x kind x from x to', async () => {
    const mismatches: string[] = [];
    let admitted = 0;
    let probes = 0;
    for (const action of COMMERCIAL_ACTION_TYPES) {
      for (const kind of COMMERCIAL_CHANGE_REQUEST_KINDS) {
        for (const from of COMMERCIAL_CHANGE_REQUEST_STATES) {
          for (const to of COMMERCIAL_CHANGE_REQUEST_STATES) {
            const db = await probe(action, kind, from, to);
            const ts = mirror(action, kind, from, to);
            probes += 1;
            if (db) admitted += 1;
            if (db !== ts) mismatches.push(`${action}/${kind} ${from} -> ${to}: db=${db} ts=${ts}`);
          }
        }
      }
    }
    expect(probes).toBe(COMMERCIAL_ACTION_TYPES.length * COMMERCIAL_CHANGE_REQUEST_KINDS.length * COMMERCIAL_CHANGE_REQUEST_STATES.length ** 2);
    expect(admitted).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });

  it('GUARD-UNION-2 the live function body is the union migration (no later migration replaced it)', async () => {
    const r = await pg.query<{ src: string }>(
      `SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'subscription' AND p.proname = 'guard_commercial_change_request'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.src).toContain('[union block: A3 base');
  });

  // TD-MERGE-21 (TD-C2-7): the deferred "cannot commit in APPLYING" triggers of the A6 / B2 / A7 / A8
  // slices are scoped to their own action types, never CONVERSION: a CONVERSION may commit in
  // APPLYING while its provider command is pending (Conversion Rule C-13).
  async function commitInApplying(action: string, withCommand: boolean): Promise<string | null> {
    const id = '019a0000-0000-7000-8000-0000000c0de2';
    try {
      await pg.query('BEGIN');
      await pg.query(`SET LOCAL session_replication_role = replica`);
      await pg.query(
        `INSERT INTO subscription."CommercialChangeRequest"
           (id, action_type, kind, state, tenant_id, product_key, payload, payload_checksum, required_chain, policy_version_id, policy_checksum,
            requested_by, reason, idempotency_key, created_at, submitted_at, expires_at, updated_at)
         VALUES ($1, $2, 'NORMAL', 'APPROVED', $1, 'sign', '{}'::jsonb, $3, '{"steps": []}'::jsonb, $4, $3, $1, 'commit probe', 'guard-union-commit', now(), now(), now() + interval '72 hours', now())`,
        [id, action, CHECKSUM, POLICY_V1],
      );
      if (withCommand) {
        await pg.query(
          `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
           VALUES (gen_random_uuid(), 'STRIPE', 'SUBSCRIPTION_CANCEL', $1::uuid, 'end_self_service', 'aramo-ccp-' || $1::text || '-end_self_service', $1, 'sign', 'sub_probe', '{"mode":"IMMEDIATE"}', 'PENDING', 0, $1, now(), now())`,
          [id],
        );
      }
      await pg.query(`SET LOCAL session_replication_role = origin`);
      await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = apply_attempts + 1 WHERE id = $1`, [id]);
      await pg.query('COMMIT');
      return null;
    } catch (e) {
      await pg.query('ROLLBACK').catch(() => undefined);
      return (e as Error).message;
    } finally {
      // Remove the probe rows (append-only triggers off for the cleanup only).
      await pg.query('BEGIN');
      await pg.query(`SET LOCAL session_replication_role = replica`);
      await pg.query(`DELETE FROM subscription."BillingProviderCommand" WHERE change_request_id = $1`, [id]);
      await pg.query(`DELETE FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id]);
      await pg.query('COMMIT');
    }
  }

  it('GUARD-UNION-3 a CONVERSION with a pending provider command commits in APPLYING; an A6 / CCP-B2-backend / CCP-B5-R POLICY_ACTIVATE apply never does', async () => {
    expect(await commitInApplying('CONVERSION', true)).toBeNull();
    expect(await commitInApplying('CONVERSION', false)).toContain('cannot commit in APPLYING without a provider command');
    for (const a of ['SUBSCRIPTION_OPEN', 'ENTITLEMENT_GRANT', 'PLAN_VERSION_PUBLISH', 'POLICY_ACTIVATE']) {
      expect(await commitInApplying(a, false), a).toContain('cannot commit in APPLYING');
    }
  });

  it('GUARD-UNION-4 (TD-MERGE-21; CCP-B5-R) the lazy expiry evaluates exactly the guard-admitted APPLY_EXPIRED set (every applyable type, a SUPPORT_EXTENSION only when NORMAL) and leaves every other action or kind alone (no DB access is attempted)', async () => {
    const svc = new CommercialChangeRequestService(null as never, null as never, null as never, null as never);
    const req = (action_type: string, kind = 'NORMAL', state = 'APPROVED') => ({ id: ID, action_type, kind, state, approved_at: new Date(0) }) as unknown as CommercialChangeRequestRow;
    const ctx = { platform_tenant_id: ID, correlation_id: 'guard-union' } as never;
    // A null transaction would throw on any DB access: the early return proves none is made.
    const left = [req('CREDIT'), req('DISCOUNT'), req('SUPPORT_EXTENSION', 'EXCEPTION'), req('SUPPORT_EXTENSION', 'MIGRATION'), req('CONVERSION', 'NORMAL', 'APPLYING'), req('POLICY_ACTIVATE', 'NORMAL', 'APPLYING')];
    for (const r of left) expect(await svc.expireApplyIfDue(null as never, r, new Date(), ctx), `${r.action_type}/${r.kind}/${r.state}`).toBe(false);
    // Every type the guard admits → APPLY_EXPIRED for is evaluated (it reads the snapshotted policy: here the null client throws).
    const evaluated = COMMERCIAL_ACTION_TYPES.filter((a) => isApplyExpirable(a));
    expect([...evaluated].sort()).toEqual(['CONVERSION', 'ENTITLEMENT_GRANT', 'ENTITLEMENT_REVOKE', 'PLAN_RETIRE', 'PLAN_VERSION_PUBLISH', 'POLICY_ACTIVATE', 'ROLE_GRANT', 'ROLE_REVOKE', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'SUBSCRIPTION_OPEN', 'SUPPORT_EXTENSION']);
    for (const a of evaluated) await expect(svc.expireApplyIfDue(null as never, req(a), new Date(), ctx), a).rejects.toThrow();
    // The predicate is the guard's: for every action x kind, APPROVED -> APPLY_EXPIRED is admitted by the live guard iff isApplyExpirable.
    for (const a of COMMERCIAL_ACTION_TYPES) for (const k of COMMERCIAL_CHANGE_REQUEST_KINDS) expect(await probe(a, k, 'APPROVED', 'APPLY_EXPIRED'), `${a}/${k}`).toBe(isApplyExpirable(a, k));
  });
});
