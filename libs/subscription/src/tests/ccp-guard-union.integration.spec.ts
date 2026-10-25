import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  COMMERCIAL_ACTION_TYPES,
  COMMERCIAL_CHANGE_REQUEST_KINDS,
  COMMERCIAL_CHANGE_REQUEST_STATES,
  canTransitionFor,
} from '../lib/commercial/commercial-change-request.js';

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
});
