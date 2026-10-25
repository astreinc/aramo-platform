import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// CCP merge train — the compensating SQL of the four migrations the program gate found without one
// (doc/ccp/program-gate-20261025.md §7): CCP-A1 (identity 20261024120000), the integrator-owned guard
// union (20261027000000) and constraint union (20261027000100), and CCP-B5-R (20261027000200).
// On a fresh Postgres 17: the FULL chain (every lib migration in the global order of
// tools/db-sync-local.sh), then each compensation is refused while dependent data exists, then all
// four compensate in reverse order with 0 errors, then the four migrations re-apply with 0 errors and
// restore the state.

const ROOT = resolve(__dirname, '../../../..');
const SUB = resolve(ROOT, 'libs/subscription/prisma/migrations');
const A1 = resolve(ROOT, 'libs/identity/prisma/migrations/20261024120000_ccp_a1_commercial_role_catalog/migration.sql');
const GUARD_UNION = resolve(SUB, '20261027000000_ccp_guard_union/migration.sql');
const CHECK_UNION = resolve(SUB, '20261027000100_ccp_constraint_union/migration.sql');
const B5R = resolve(SUB, '20261027000200_ccp_b5r_policy_activate_apply/migration.sql');
const COMP = {
  a1: resolve(ROOT, 'libs/identity/src/tests/fixtures/ccp-a1-compensating.sql'),
  guard: resolve(ROOT, 'libs/subscription/src/tests/fixtures/ccp-guard-union-compensating.sql'),
  check: resolve(ROOT, 'libs/subscription/src/tests/fixtures/ccp-constraint-union-compensating.sql'),
  b5r: resolve(ROOT, 'libs/subscription/src/tests/fixtures/ccp-b5r-compensating.sql'),
};
const sql = (p: string) => readFileSync(p, 'utf8');

function chain(): string[] {
  const out: Array<{ name: string; lib: string; file: string }> = [];
  for (const lib of readdirSync(resolve(ROOT, 'libs'))) {
    if (lib === 'intelligence-core') continue; // its own database
    const dir = resolve(ROOT, 'libs', lib, 'prisma/migrations');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = resolve(dir, name, 'migration.sql');
      if (existsSync(file)) out.push({ name, lib, file });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.lib < b.lib ? -1 : 1)).map((m) => m.file);
}

const CCP_ROLES = ['2c0', '2c1', '2c2', '2c3', '2c4', '2c5'].map((h) => `01900000-0000-7000-8000-000000000${h}`);
const ID = '019a0000-0000-7000-8000-00000000c0f1';
const CHECKSUM = 'a'.repeat(64);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP merge train compensating SQL (real Postgres 17, full chain)', { timeout: 900_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let policy: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    for (const f of chain()) await pg.query(sql(f));
    // A1 is a no-op on an empty catalog (the seed writes the model): give it the catalog it expects,
    // then run it so its 6 roles, 15 scopes and 45 grants exist.
    await pg.query(`INSERT INTO "identity"."Role" ("id", "key", "description", "is_active", "updated_at") VALUES (gen_random_uuid(), 'super_admin', 'Super admin', true, now())`);
    await pg.query(`INSERT INTO "identity"."Scope" ("id", "key", "description") VALUES (gen_random_uuid(), 'platform:tenant:read', 'Read tenants')`);
    await pg.query(sql(A1));
    policy = (await pg.query(`SELECT id::text FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE'`)).rows[0].id as string;
  }, 900_000);

  afterAll(async () => {
    await pg?.end();
    await container?.stop();
  });

  const a1Counts = async () =>
    (
      await pg.query(
        `SELECT (SELECT count(*)::int FROM "identity"."Role" WHERE id = ANY($1::uuid[])) AS roles,
                (SELECT count(*)::int FROM "identity"."Scope" WHERE key LIKE 'platform:%' AND key <> 'platform:tenant:read' AND id::text LIKE '01900000-0000-7000-8000-0000000003%') AS scopes,
                (SELECT count(*)::int FROM "identity"."RoleScope" WHERE role_id = ANY($1::uuid[])) AS grants`,
        [CCP_ROLES],
      )
    ).rows[0];
  const guardSrc = async () => (await pg.query(`SELECT p.prosrc AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'subscription' AND p.proname = 'guard_commercial_change_request'`)).rows[0].s as string;
  const checkDef = async () => (await pg.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'CommercialChangeApplication_action_type_check'`)).rows[0].d as string;
  const b5rTrigger = async () => Number((await pg.query(`SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'commercial_change_request_no_applying_commit_b5r'`)).rows[0].n);

  /** Runs `file` in its own transaction; returns the error message, or null when it committed. */
  async function run(file: string): Promise<string | null> {
    try {
      await pg.query('BEGIN');
      await pg.query(sql(file));
      await pg.query('COMMIT');
      return null;
    } catch (e) {
      await pg.query('ROLLBACK');
      return (e as Error).message;
    }
  }

  /** Seeds `seed` (triggers off) and runs `file`, then rolls everything back. */
  async function refusedWith(seed: string, params: unknown[], file: string): Promise<string | null> {
    await pg.query('BEGIN');
    try {
      await pg.query(`SET LOCAL session_replication_role = replica`);
      await pg.query(seed, params);
      await pg.query(`SET LOCAL session_replication_role = origin`);
      await pg.query(sql(file));
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await pg.query('ROLLBACK');
    }
  }

  const REQUEST = (action: string, state: string) =>
    `INSERT INTO subscription."CommercialChangeRequest" (id, action_type, kind, state, payload, payload_checksum, required_chain, policy_version_id, policy_checksum,
       requested_by, reason, idempotency_key, created_at, submitted_at, expires_at, updated_at)
     VALUES ('${ID}', '${action}', 'NORMAL', '${state}', '{}'::jsonb, $1, '{"steps": []}'::jsonb, $2, $1, '${ID}', 'probe', 'compensation-probe', now(), now(), now() + interval '72 hours', now())`;

  it('COMP-0 the full chain applied and A1 wrote its catalog (6 roles, 15 scopes, 45 grants); the unions and B5-R are live', async () => {
    expect(await a1Counts()).toEqual({ roles: 6, scopes: 15, grants: 45 });
    expect(await guardSrc()).toContain('[union block: A3 base');
    expect(await checkDef()).toContain('SUPPORT_EXTENSION');
    expect(await b5rTrigger()).toBe(1);
  });

  it('COMP-1 each compensation is refused (nothing changed) while data depending on it exists', async () => {
    expect(await refusedWith(REQUEST('POLICY_ACTIVATE', 'APPROVED'), [CHECKSUM, policy], COMP.b5r)).toContain('CCP-B5-R compensation refused');
    expect(
      await refusedWith(
        `${REQUEST('ENTITLEMENT_REVOKE', 'APPLIED')};
         INSERT INTO subscription."CommercialChangeApplication" (id, change_request_id, action_type, tenant_id, product_key, capabilities, capabilities_inserted, capabilities_revoked, attempt, applied_by, applied_at)
         VALUES (gen_random_uuid(), '${ID}', 'ENTITLEMENT_REVOKE', '${ID}', 'sign', '{}', '{}', '{sign}', 1, '${ID}', now())`.replace(/\$1/g, `'${CHECKSUM}'`).replace(/\$2/g, `'${policy}'`),
        [],
        COMP.check,
      ),
    ).toContain('CCP constraint-union compensation refused');
    expect(await refusedWith(REQUEST('SUBSCRIPTION_OPEN', 'APPLY_EXPIRED'), [CHECKSUM, policy], COMP.guard)).toContain('an APPLY_EXPIRED request exists');
    expect(await refusedWith(REQUEST('SUPPORT_EXTENSION', 'APPROVED'), [CHECKSUM, policy], COMP.guard)).toContain('CCP guard-union compensation refused');
    expect(
      await refusedWith(`INSERT INTO "identity"."UserTenantMembershipRole" (id, membership_id, role_id) VALUES (gen_random_uuid(), gen_random_uuid(), $1)`, [CCP_ROLES[0]], COMP.a1),
    ).toContain('CCP-A1 compensation refused');
    // Nothing changed.
    expect(await a1Counts()).toEqual({ roles: 6, scopes: 15, grants: 45 });
    expect(await b5rTrigger()).toBe(1);
  });

  it('COMP-2 compensating in reverse order (B5-R, constraint union, guard union, A1) applies with 0 errors and restores the preceding state', async () => {
    expect(await run(COMP.b5r)).toBeNull();
    expect(await b5rTrigger()).toBe(0);
    expect(await run(COMP.check)).toBeNull();
    expect(await checkDef()).not.toContain('SUPPORT_EXTENSION');
    expect(await checkDef()).toContain('CONVERSION');
    expect(await run(COMP.guard)).toBeNull();
    const src = await guardSrc();
    expect(src).not.toContain('[union block');
    expect(src).toContain('CCP-C2 CONVERSION branch'); // the last slice body (20261026060000), verbatim
    expect(await run(COMP.a1)).toBeNull();
    expect(await a1Counts()).toEqual({ roles: 0, scopes: 0, grants: 0 });
  });

  it('COMP-3 the four migrations re-apply with 0 errors and the state is the gated one again', async () => {
    expect(await run(A1)).toBeNull();
    expect(await run(GUARD_UNION)).toBeNull();
    expect(await run(CHECK_UNION)).toBeNull();
    expect(await run(B5R)).toBeNull();
    expect(await a1Counts()).toEqual({ roles: 6, scopes: 15, grants: 45 });
    expect(await guardSrc()).toContain('[union block: A3 base');
    expect(await checkDef()).toContain('SUPPORT_EXTENSION');
    expect(await b5rTrigger()).toBe(1);
  });
});
