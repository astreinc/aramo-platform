import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// CCP FIX1 TD-D5-4 — the FULL reverse chain of the CCP migrations (21 at FIX1's base, 27 on the integrated
// branch after merge train 2, TD-MERGE-45; doc/ccp/program-gate-20261025.md
// section 6). On a fresh Postgres 17:
//   FULL-0   the full chain (every lib migration in the global order of tools/db-sync-local.sh, the
//            same chain() as ccp-merge-train-compensation) applies, with a catalog fingerprint of the
//            identity, subscription and entitlement schemas taken before each CCP migration
//   ORDER-1  every compensation that depends on a later one being run first is refused on the full
//            chain (nothing changed)
//   COMP-k   for k = N down to 1: compensation k is refused (nothing changed) while data depending on
//            it is seeded, then applies with 0 errors and the schemas equal the fingerprint taken just
//            before migration k was applied
//   REAPPLY  the N migrations re-apply in order with 0 errors, each restoring the fingerprint taken
//            after it in the forward chain, and the A1 catalog is back
// The fingerprint is DDL (columns, constraints, indexes, triggers with their enabled mode, functions
// with an md5 of their source, table comments). A1 and A1-A1 are data only, so they are checked by their row counts.

const ROOT = resolve(__dirname, '../../../..');
const SUB_M = (n: string) => resolve(ROOT, 'libs/subscription/prisma/migrations', n, 'migration.sql');
const SUB_C = (n: string) => resolve(ROOT, 'libs/subscription/src/tests/fixtures', `${n}-compensating.sql`);
const sql = (p: string) => readFileSync(p, 'utf8');

const ID = '019a0000-0000-7000-8000-00000000c0f1';
const CHECKSUM = 'a'.repeat(64);
const CCP_ROLES = ['2c0', '2c1', '2c2', '2c3', '2c4', '2c5'].map((h) => `01900000-0000-7000-8000-000000000${h}`);

/** A change request row (seeded with triggers off); $1 and $2 are replaced by the checksum and the policy version id. */
const REQUEST = (action: string, state: string) =>
  `INSERT INTO subscription."CommercialChangeRequest" (id, action_type, kind, state, payload, payload_checksum, required_chain, policy_version_id, policy_checksum,
     requested_by, reason, idempotency_key, created_at, submitted_at, expires_at, updated_at)
   VALUES ('${ID}', '${action}', 'NORMAL', '${state}', '{}'::jsonb, $1, '{"steps": []}'::jsonb, $2, $1, '${ID}', 'probe', 'compensation-probe', now(), now(), now() + interval '72 hours', now())`;

interface Step {
  readonly label: string;
  readonly migration: string;
  readonly compensation: string;
  /** Data only (A1-A1): the DDL is unchanged by it, so it is checked by its catalog rows. */
  readonly dataOnly?: boolean;
  /** Dependent data seeded (triggers off) for the refusal probe; in a `request` seed $1 and $2 become the checksum and policy id. */
  readonly probe?: { readonly seed: string; readonly request?: boolean; readonly refusal: string };
}

// Apply order (the gate table, rows 1 to 21).
const STEPS: readonly Step[] = [
  {
    label: 'A1',
    migration: resolve(ROOT, 'libs/identity/prisma/migrations/20261024120000_ccp_a1_commercial_role_catalog/migration.sql'),
    compensation: resolve(ROOT, 'libs/identity/src/tests/fixtures/ccp-a1-compensating.sql'),
    probe: {
      seed: `INSERT INTO "identity"."UserTenantMembershipRole" (id, membership_id, role_id) VALUES (gen_random_uuid(), gen_random_uuid(), '${CCP_ROLES[0]}')`,
      refusal: 'CCP-A1 compensation refused',
    },
  },
  {
    label: 'A2',
    migration: SUB_M('20261024180000_ccp_a2_commercial_audit_policy'),
    compensation: SUB_C('ccp-a2'),
    probe: {
      seed: `INSERT INTO subscription."CommercialAuditEvent" (id, actor_type, event_type, subject, policy_version_id, correlation_id)
             VALUES (gen_random_uuid(), 'system', 'PROBE_EVENT', 'probe:1', '019a0000-0000-7000-8000-0000000cc201', 'probe')`,
      refusal: 'CCP-A2 compensation refused: a commercial audit or policy row',
    },
  },
  {
    label: 'A3',
    migration: SUB_M('20261025120000_ccp_a3_change_request_approval'),
    compensation: SUB_C('ccp-a3'),
    probe: { seed: REQUEST('SUBSCRIPTION_OPEN', 'PENDING_APPROVAL'), request: true, refusal: 'CCP-A3 compensation refused: a change request' },
  },
  {
    label: 'A4',
    migration: SUB_M('20261025140000_ccp_a4_product_dimension'),
    compensation: SUB_C('ccp-a4'),
    probe: {
      seed: `ALTER TABLE subscription."Plan" DROP CONSTRAINT "Plan_product_key_registry_check";
             ALTER TABLE subscription."Plan" ADD CONSTRAINT "Plan_product_key_registry_check" CHECK (product_key IN ('sign', 'probe'));
             INSERT INTO subscription."Plan" (id, key, name, product_key) VALUES (gen_random_uuid(), 'probe-plan', 'Probe', 'probe')`,
      refusal: 'CCP-A4 compensation refused',
    },
  },
  {
    label: 'A5',
    migration: SUB_M('20261025160000_ccp_a5_plan_version'),
    compensation: SUB_C('ccp-a5'),
    probe: {
      seed: `INSERT INTO subscription."PlanVersionPrice" (id, plan_version_id, provider, provider_price_ref, created_by, created_at)
             VALUES (gen_random_uuid(), gen_random_uuid(), 'STRIPE', 'price_probe', 'probe', now())`,
      refusal: 'CCP-A5 compensation refused: a provider price is pinned',
    },
  },
  {
    label: 'A9 identity',
    migration: resolve(ROOT, 'libs/identity/prisma/migrations/20261025180000_ccp_a9_platform_last_owner_invariant/migration.sql'),
    compensation: resolve(ROOT, 'libs/identity/src/tests/fixtures/ccp-a9-compensating.sql'),
    // No data depends on the trigger set: its refusal is the ordering guard, probed in the A9 subscription step.
  },
  {
    label: 'A9 subscription',
    migration: SUB_M('20261025180100_ccp_a9_role_change_apply_bootstrap'),
    compensation: SUB_C('ccp-a9'),
    probe: { seed: REQUEST('ROLE_GRANT', 'APPLIED'), request: true, refusal: 'CCP-A9 compensation refused: a change request is APPLYING or APPLIED' },
  },
  {
    label: 'A6',
    migration: SUB_M('20261025200000_ccp_a6_transactional_apply'),
    compensation: SUB_C('ccp-a6'),
    probe: { seed: REQUEST('SUBSCRIPTION_OPEN', 'APPLIED'), request: true, refusal: 'CCP-A6 compensation refused: A6 state exists' },
  },
  {
    label: 'B2-backend',
    migration: SUB_M('20261025220000_ccp_b2_catalog_apply'),
    compensation: SUB_C('ccp-b2'),
    probe: { seed: REQUEST('PLAN_VERSION_PUBLISH', 'APPLIED'), request: true, refusal: 'CCP-B2-backend compensation refused: catalog apply state exists' },
  },
  {
    label: 'D1',
    migration: SUB_M('20261025240000_ccp_d1_usage_rollups'),
    compensation: SUB_C('ccp-d1'),
    // The D1 compensation has no refusal: everything it drops is derived (CCP-D1 pre-execution section 3.3).
  },
  {
    label: 'A7 entitlement',
    migration: resolve(ROOT, 'libs/entitlement/prisma/migrations/20261026000000_ccp_a7_entitlement_revoke_provenance/migration.sql'),
    compensation: resolve(ROOT, 'libs/entitlement/src/tests/fixtures/ccp-a7-compensating.sql'),
    probe: {
      seed: `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source, revoked_at, revoked_by, revoke_change_request_id)
             VALUES (gen_random_uuid(), 'core', 'MIGRATION', now(), gen_random_uuid(), gen_random_uuid())`,
      refusal: 'CCP-A7 entitlement compensation refused: revoked or commercially sourced rows exist',
    },
  },
  {
    label: 'A7 subscription',
    migration: SUB_M('20261026000100_ccp_a7_entitlement_revoke_apply'),
    compensation: SUB_C('ccp-a7'),
    probe: { seed: REQUEST('ENTITLEMENT_REVOKE', 'APPLIED'), request: true, refusal: 'CCP-A7 compensation refused: governed revokes exist' },
  },
  {
    label: 'A8',
    migration: SUB_M('20261026010000_ccp_a8_support_extension_overlay'),
    compensation: SUB_C('ccp-a8'),
    probe: { seed: REQUEST('SUPPORT_EXTENSION', 'APPLIED'), request: true, refusal: 'CCP-A8 compensation refused: A8 state exists' },
  },
  {
    label: 'C1',
    migration: SUB_M('20261026020000_ccp_c1_stripe_command_inbox'),
    compensation: SUB_C('ccp-c1'),
    probe: {
      seed: `INSERT INTO subscription."BillingWebhookInbox" (id, provider, provider_event_id, event_type, event_created_at, product_key, status, attempts, received_at, updated_at)
             VALUES (gen_random_uuid(), 'STRIPE', 'evt_probe', 'probe.event', now(), 'sign', 'RECEIVED', 0, now(), now())`,
      refusal: 'CCP-C1 compensation refused: an unconfirmed command or an unprocessed inbox event exists',
    },
  },
  {
    label: 'B4',
    migration: SUB_M('20261026030000_ccp_b4_enterprise_contracts'),
    compensation: SUB_C('ccp-b4'),
    probe: {
      seed: `INSERT INTO subscription."Contract" (id, contract_ref, tenant_subscription_id, terms, evidence_documents, provenance, recorded_by_change_request_id, recorded_by, recorded_at)
             VALUES (gen_random_uuid(), 'CT-PROBE-1', gen_random_uuid(), '["probe term"]'::jsonb, '[]'::jsonb, 'CHANGE_REQUEST', gen_random_uuid(), gen_random_uuid(), now())`,
      refusal: 'CCP-B4 compensation refused: contract records exist',
    },
  },
  {
    label: 'A6-R',
    migration: SUB_M('20261026050000_ccp_a6r_apply_deadline'),
    compensation: SUB_C('ccp-a6r'),
    probe: { seed: REQUEST('SUBSCRIPTION_OPEN', 'APPLY_EXPIRED'), request: true, refusal: 'CCP-A6-R compensation refused: an APPLY_EXPIRED request exists' },
  },
  {
    label: 'C2',
    migration: SUB_M('20261026060000_ccp_c2_conversion'),
    compensation: SUB_C('ccp-c2'),
    probe: { seed: REQUEST('CONVERSION', 'APPLIED'), request: true, refusal: 'CCP-C2 compensation refused: conversion state exists' },
  },
  {
    label: 'D3',
    migration: SUB_M('20261026090000_ccp_d3_operational_alerts'),
    compensation: SUB_C('ccp-d3'),
    probe: {
      seed: `INSERT INTO subscription."CommercialOperationalAlert" (id, alert_type, family, subject_kind, subject_id, status, detail, evidence, detection_count, first_detected_at, last_detected_at, updated_at)
             VALUES (gen_random_uuid(), 'APPLY_FAILED', 'APPROVAL', 'change_request', 'probe', 'OPEN', 'probe', '{}'::jsonb, 1, now(), now(), now())`,
      refusal: 'CCP-D3 compensation refused: an OPEN operational alert exists',
    },
  },
  {
    label: 'guard union',
    migration: SUB_M('20261027000000_ccp_guard_union'),
    compensation: SUB_C('ccp-guard-union'),
    probe: { seed: REQUEST('SUPPORT_EXTENSION', 'APPROVED'), request: true, refusal: 'CCP guard-union compensation refused' },
  },
  {
    label: 'constraint union',
    migration: SUB_M('20261027000100_ccp_constraint_union'),
    compensation: SUB_C('ccp-constraint-union'),
    probe: {
      seed: `${REQUEST('ENTITLEMENT_REVOKE', 'APPLIED')};
             INSERT INTO subscription."CommercialChangeApplication" (id, change_request_id, action_type, tenant_id, product_key, capabilities, capabilities_inserted, capabilities_revoked, attempt, applied_by, applied_at)
             VALUES (gen_random_uuid(), '${ID}', 'ENTITLEMENT_REVOKE', '${ID}', 'sign', '{}', '{}', '{sign}', 1, '${ID}', now())`,
      request: true,
      refusal: 'CCP constraint-union compensation refused',
    },
  },
  {
    label: 'B5-R',
    migration: SUB_M('20261027000200_ccp_b5r_policy_activate_apply'),
    compensation: SUB_C('ccp-b5r'),
    probe: { seed: REQUEST('POLICY_ACTIVATE', 'APPROVED'), request: true, refusal: 'CCP-B5-R compensation refused' },
  },
  // ---- Merge train 2 (TD-MERGE-45): the migrations added on the integrated branch after FIX1's base. ----
  {
    label: 'C4',
    migration: SUB_M('20261028010000_ccp_c4_billing_adjustments'),
    compensation: SUB_C('ccp-c4'),
    probe: { seed: REQUEST('CREDIT', 'APPROVED'), request: true, refusal: 'CCP-C4 compensation refused' },
  },
  {
    label: 'C7',
    migration: SUB_M('20261028030000_ccp_c7_self_service_commands'),
    compensation: SUB_C('ccp-c7'),
    probe: {
      seed: `INSERT INTO subscription."SelfServiceBillingRequest" (id, tenant_id, product_key, action, subscription_id, provider, target_ref, terms_ref, requested_by, created_at)
             VALUES (gen_random_uuid(), gen_random_uuid(), 'sign', 'CANCEL_AT_PERIOD_END', gen_random_uuid(), 'STRIPE', 'sub_probe', 'sign.terms@1#${'b'.repeat(64)}', gen_random_uuid(), now())`,
      refusal: 'CCP-C7 compensation refused',
    },
  },
  {
    label: 'R3 alert',
    migration: SUB_M('20261028050000_ccp_r3_entitlement_alert'),
    compensation: SUB_C('ccp-r3-alert'),
    probe: {
      seed: `INSERT INTO subscription."CommercialOperationalAlert" (id, alert_type, family, subject_kind, subject_id, status, detail, evidence, detection_count, first_detected_at, last_detected_at, updated_at)
             VALUES (gen_random_uuid(), 'ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION', 'BILLING', 'product_entitlement', 'probe:sign', 'OPEN', 'probe', '{}'::jsonb, 1, now(), now(), now())`,
      refusal: 'CCP-R3 alert compensation refused',
    },
  },
  {
    label: 'A1-A1 identity',
    migration: resolve(ROOT, 'libs/identity/prisma/migrations/20261028060000_ccp_a1a1_finance_amount_scope/migration.sql'),
    compensation: resolve(ROOT, 'libs/identity/src/tests/fixtures/ccp-a1a1-compensating.sql'),
    dataOnly: true,
    probe: {
      seed: `INSERT INTO "identity"."RoleScope" (id, role_id, scope_id) VALUES (gen_random_uuid(), '${CCP_ROLES[2]}', '01900000-0000-7000-8000-000000000335')`,
      refusal: 'CCP-A1-A1 compensation refused',
    },
  },
  {
    label: 'command guard union',
    migration: SUB_M('20261029000000_ccp_command_guard_union'),
    compensation: SUB_C('ccp-command-guard-union'),
    probe: {
      seed: `${REQUEST('CREDIT', 'APPLYING')};
             INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
             VALUES (gen_random_uuid(), 'STRIPE', 'CREDIT_GRANT', '${ID}', 'credit_grant', 'aramo-ccp-${ID}-credit_grant', '${ID}', 'sign', 'acct_probe', '{"subscription_id": "${ID}", "amount_minor": 100, "currency": "USD"}'::jsonb, 'PENDING', 0, '${ID}', now(), now())`,
      request: true,
      refusal: 'CCP command-guard-union compensation refused',
    },
  },
  {
    label: 'alert type union',
    migration: SUB_M('20261029000100_ccp_alert_type_union'),
    compensation: SUB_C('ccp-alert-type-union'),
    probe: {
      seed: `INSERT INTO subscription."CommercialOperationalAlert" (id, alert_type, family, subject_kind, subject_id, status, detail, evidence, detection_count, first_detected_at, last_detected_at, updated_at)
             VALUES (gen_random_uuid(), 'APPLY_DEADLINE_NEARING', 'APPROVAL', 'change_request', 'probe', 'OPEN', 'probe', '{}'::jsonb, 1, now(), now(), now())`,
      refusal: 'CCP alert-type-union compensation refused',
    },
  },
];
const N = STEPS.length;

// The compensations that refuse while a LATER migration they depend on is still applied (ORDER-1).
const ORDERING: ReadonlyArray<readonly [string, string]> = [
  ['A2', 'the CCP-A3 change-request tables still exist'],
  ['A3', 'the CCP-A4 product registry CHECK is still present'],
  ['A9 identity', 'the CCP-A9 subscription role-change apply path is still installed'],
  ['A9 subscription', 'CCP-A6 is still applied'],
  ['A6', 'CCP-B2-backend is still applied'],
  ['B2-backend', 'CCP-A7 is still applied'],
  ['A7 entitlement', 'the CCP-A7 subscription half is still applied'],
  ['A7 subscription', 'CCP-A8 is still applied'],
  ['A8', 'CCP-A6-R is still applied'],
  ['C1', 'CCP-C2 is still applied'],
  ['A6-R', 'CCP-C2 is still applied'],
  ['C2', 'the guard union is still applied'],
];

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

const FINGERPRINT = `
  WITH s AS (SELECT oid, nspname FROM pg_namespace WHERE nspname IN ('identity', 'subscription', 'entitlement'))
  SELECT 'col ' || c.table_schema || '.' || c.table_name || '.' || c.column_name || ' ' || c.data_type || ' ' || c.is_nullable || ' ' || coalesce(c.column_default, '-') AS f
    FROM information_schema.columns c WHERE c.table_schema IN (SELECT nspname FROM s)
  UNION ALL
  SELECT 'con ' || r.oid::regclass::text || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
    FROM pg_constraint k JOIN pg_class r ON r.oid = k.conrelid WHERE r.relnamespace IN (SELECT oid FROM s)
  UNION ALL
  SELECT 'idx ' || i.indexdef FROM pg_indexes i WHERE i.schemaname IN (SELECT nspname FROM s)
  UNION ALL
  SELECT 'trg ' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid)
    FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal AND r.relnamespace IN (SELECT oid FROM s)
  UNION ALL
  SELECT 'fn ' || s.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || p.provolatile::text || ' ' || md5(p.prosrc)
    FROM pg_proc p JOIN s ON s.oid = p.pronamespace
  UNION ALL
  SELECT 'cmt ' || r.oid::regclass::text || ' ' || md5(d.description)
    FROM pg_description d JOIN pg_class r ON r.oid = d.objoid AND d.classoid = 'pg_class'::regclass AND d.objsubid = 0
   WHERE r.relnamespace IN (SELECT oid FROM s)
  ORDER BY 1`;

/** The A1 catalog (6 roles, 15 scopes, 45 grants) plus A1-A1's scope and its 3 grants. */
const FULL_CATALOG = { roles: 6, scopes: 16, grants: 48 };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP full compensation chain 27 -> 1 (real Postgres 17, full chain)', { timeout: 900_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let policy: string;
  /** before[k] = fingerprint just before STEPS[k] was applied in the forward chain; before[N] = the full chain. */
  const before: string[][] = [];

  const fingerprint = async (): Promise<string[]> => (await pg.query(FINGERPRINT)).rows.map((r) => r.f as string);
  const a1Counts = async () =>
    (
      await pg.query(
        `SELECT (SELECT count(*)::int FROM "identity"."Role" WHERE id = ANY($1::uuid[])) AS roles,
                (SELECT count(*)::int FROM "identity"."Scope" WHERE key LIKE 'platform:%' AND key <> 'platform:tenant:read' AND id::text LIKE '01900000-0000-7000-8000-0000000003%') AS scopes,
                (SELECT count(*)::int FROM "identity"."RoleScope" WHERE role_id = ANY($1::uuid[])) AS grants`,
        [CCP_ROLES],
      )
    ).rows[0];

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
  async function refusedWith(seed: string, file: string): Promise<string | null> {
    await pg.query('BEGIN');
    try {
      await pg.query(`SET LOCAL session_replication_role = replica`);
      await pg.query(seed);
      await pg.query(`SET LOCAL session_replication_role = origin`);
      await pg.query(sql(file));
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await pg.query('ROLLBACK');
    }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    pg = new Client({ connectionString: container.getConnectionUri() });
    await pg.connect();
    const ccp = new Map(STEPS.map((s, k) => [s.migration, k]));
    for (const f of chain()) {
      const k = ccp.get(f);
      if (k !== undefined) before[k] = await fingerprint();
      await pg.query(sql(f));
    }
    before[STEPS.length] = await fingerprint();
    // A1 is a no-op on an empty catalog (the seed writes the model): give it the catalog it expects,
    // then run it so its 6 roles, 15 scopes and 45 grants exist (as ccp-merge-train-compensation does).
    await pg.query(`INSERT INTO "identity"."Role" ("id", "key", "description", "is_active", "updated_at") VALUES (gen_random_uuid(), 'super_admin', 'Super admin', true, now())`);
    await pg.query(`INSERT INTO "identity"."Scope" ("id", "key", "description") VALUES (gen_random_uuid(), 'platform:tenant:read', 'Read tenants')`);
    await pg.query(sql(STEPS[0]!.migration));
    // A1-A1 (CCP-R3) likewise grants platform:billing:amount:read (0x335) to its 3 roles only once they exist.
    await pg.query(sql(STEPS.find((s) => s.label === 'A1-A1 identity')!.migration));
    policy = (await pg.query(`SELECT id::text FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE'`)).rows[0].id as string;
  }, 900_000);

  afterAll(async () => {
    await pg?.end();
    await container?.stop();
  });

  it('FULL-0 the full chain applied every one of the 27 CCP migrations, and A1 + A1-A1 wrote their catalog (6 roles, 16 scopes, 48 grants)', async () => {
    expect(STEPS).toHaveLength(27);
    expect(before.filter(Boolean)).toHaveLength(N + 1);
    expect(await a1Counts()).toEqual(FULL_CATALOG);
    expect(await fingerprint()).toEqual(before[N]);
  });

  it('ORDER-1 on the full chain, each compensation that needs a later one run first is refused, and nothing changed', async () => {
    for (const [label, reason] of ORDERING) {
      const step = STEPS.find((s) => s.label === label)!;
      const err = await run(step.compensation);
      expect(err, label).toContain(reason);
    }
    expect(await fingerprint()).toEqual(before[N]);
    expect(await a1Counts()).toEqual(FULL_CATALOG);
  });

  for (let k = STEPS.length - 1; k >= 0; k -= 1) {
    const step = STEPS[k]!;
    const n = k + 1;
    it(`COMP-${n} ${step.label}: ${step.probe ? 'refused while dependent data exists (nothing changed), then ' : ''}compensates with 0 errors and restores the pre-${step.label} schema`, async () => {
      const now = await fingerprint();
      if (step.probe) {
        const seed = step.probe.request ? step.probe.seed.replace(/\$1/g, `'${CHECKSUM}'`).replace(/\$2/g, `'${policy}'`) : step.probe.seed;
        const err = await refusedWith(seed, step.compensation);
        expect(err).toContain(step.probe.refusal);
        expect(await fingerprint()).toEqual(now);
      }
      if (step.label === 'A9 subscription') {
        // The A9 identity compensation is refused while this step's role-change apply path is installed.
        expect(await run(STEPS[k - 1]!.compensation)).toContain('CCP-A9 identity compensation refused');
        expect(await fingerprint()).toEqual(now);
      }
      expect(await run(step.compensation)).toBeNull();
      if (k === 0) {
        // A1 is data only: the DDL is unchanged and the catalog rows are gone.
        expect(await fingerprint()).toEqual(now);
        expect(await a1Counts()).toEqual({ roles: 0, scopes: 0, grants: 0 });
      } else if (step.dataOnly === true) {
        // A1-A1 is data only: the DDL is unchanged and the A1 catalog alone remains.
        expect(await fingerprint()).toEqual(now);
        expect(await a1Counts()).toEqual({ roles: 6, scopes: 15, grants: 45 });
      } else {
        expect(await fingerprint()).toEqual(before[k]);
      }
    });
  }

  it('REAPPLY the 27 CCP migrations re-apply in order with 0 errors, each restoring the forward-chain state after it', async () => {
    for (let k = 0; k < STEPS.length; k += 1) {
      const step = STEPS[k]!;
      expect(await run(step.migration), step.label).toBeNull();
      expect(await fingerprint(), step.label).toEqual(before[k + 1]);
    }
    expect(await a1Counts()).toEqual(FULL_CATALOG);
    expect((await pg.query(`SELECT id::text FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE'`)).rows[0].id).toBe(policy);
  });
});
