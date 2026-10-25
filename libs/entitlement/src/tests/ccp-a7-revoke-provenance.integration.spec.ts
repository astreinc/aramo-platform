import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, ENTITLEMENT_MIGRATIONS, resolveEntitlementMigrations } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TENANT_CAPABILITIES, type Capability } from '../lib/capability.js';
import { EntitlementGuard } from '../lib/entitlement.guard.js';
import { REQUIRED_CAPABILITIES_KEY } from '../lib/entitlement.metadata.js';
import { isCommercialGrantSource } from '../lib/entitlement-provenance.js';
import { EntitlementRepository } from '../lib/entitlement.repository.js';
import { grantCapabilitiesInTx, revokeCapabilitiesInTx } from '../lib/grant-capabilities-in-tx.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { reconcileTenantEntitlements, type EntitlementReconcileDeps } from '../lib/reconcile-entitlements.js';

// CCP-A7 (PBD §5.1 row A7; Charter D1; Conv. C-20) on real Postgres 17 — the entitlement side:
// the backfill, the two re-pointed readers (next request loses the product; the Intelligence
// REPLACE list drops the tenant), the resurrection guard (provisioning / signup / the seed
// reconcile never clear a governed revoke; the seed-prod Gate 3 query fails closed), the DB
// guard and ledger, and the governed re-grant. Test IDs are cited by
// doc/ccp/slices/CCP-A7-acceptance.md.

const REPO_ROOT = resolve(__dirname, '../../../..');
const OPERATOR = '0190a7a7-0000-7000-8000-0000000000f1';
const SEEDED_TENANT = '01900000-0000-7000-8000-000000000001';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A7 entitlement revoke + provenance (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let repo: EntitlementRepository;
  // The library SQL on a pg client (the same shape as a caller's Prisma transaction).
  const raw = () => ({ $queryRawUnsafe: async <T>(q: string, ...v: unknown[]) => (await pg.query(q, v)).rows as T });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    // Every migration BEFORE A7 first, so the A7 backfill runs over a pre-A7 row (the init seeds one tenant).
    const all = resolveEntitlementMigrations(REPO_ROOT);
    for (const m of all.slice(0, -1)) await pg.query(readFileSync(m, 'utf8'));
    await pg.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1, 'sign')`, [SEEDED_TENANT]);
    await pg.query(readFileSync(all[all.length - 1] as string, 'utf8'));
    await pg.query('CREATE SCHEMA IF NOT EXISTS identity');
    await pg.query('CREATE TABLE identity."Tenant" (id uuid PRIMARY KEY)');
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EntitlementRepository(prisma);
  }, 300_000);

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  async function tenant(caps: Capability[], source: 'PROVISIONING' | 'SIGNUP' = 'SIGNUP'): Promise<string> {
    const t = randomUUID();
    await pg.query(`INSERT INTO identity."Tenant" (id) VALUES ($1)`, [t]);
    await repo.grantCapabilities({ tenant_id: t, capabilities: caps, granted_source: source, granted_by: OPERATOR });
    return t;
  }
  const revoke = (t: string, caps: string[], cr = randomUUID()) => revokeCapabilitiesInTx(raw(), { tenant_id: t, capabilities: caps, revoked_by: OPERATOR, change_request_id: cr });
  const rows = async (t: string) =>
    (await pg.query(`SELECT capability::text, granted_source, change_request_id, revoked_at IS NOT NULL AS revoked, revoke_change_request_id FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 ORDER BY capability`, [t])).rows;
  const ledger = async (t: string) =>
    (await pg.query(`SELECT capability::text, event_type, granted_source FROM entitlement."TenantEntitlementEvent" WHERE tenant_id = $1 ORDER BY occurred_at, event_type, capability`, [t])).rows.map((r) => `${r.capability}:${r.event_type}:${r.granted_source}`);
  async function raises(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error(`expected the statement to raise: ${sql}`);
  }
  function guardContext(tenant_id: string): ExecutionContext {
    const request = { authContext: { sub: OPERATOR, consumer_type: 'sign', actor_kind: 'user', tenant_id, scopes: [] }, requestId: 'a7-guard' };
    return {
      getHandler: () => () => undefined,
      getClass: () => class A7Route {},
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => ({}) }),
    } as unknown as ExecutionContext;
  }
  function guard(required: Capability[]): EntitlementGuard {
    const r = new Reflector();
    vi.spyOn(r, 'getAllAndOverride').mockImplementation((key: string) => (key === REQUIRED_CAPABILITIES_KEY ? required : undefined));
    return new EntitlementGuard(r, repo);
  }

  it('A7-E-0 the helper carries every entitlement migration on disk (one ordered source)', () => {
    const onDisk = readdirSync(resolve(REPO_ROOT, 'libs/entitlement/prisma/migrations')).filter((n) => /^\d/.test(n)).sort();
    expect(ENTITLEMENT_MIGRATIONS.map((p) => p.split('/').at(-2))).toEqual(onDisk);
  });

  it('A7-E-1 backfill: every pre-A7 row is granted_source MIGRATION (non-commercial, no change request) and the ledger opens with one GRANTED event per row', async () => {
    expect(await rows(SEEDED_TENANT)).toEqual(
      ['ats', 'core', 'portal', 'sign'].map((c) => ({ capability: c, granted_source: 'MIGRATION', change_request_id: null, revoked: false, revoke_change_request_id: null })),
    );
    expect((await ledger(SEEDED_TENANT)).sort()).toEqual(['ats:GRANTED:MIGRATION', 'core:GRANTED:MIGRATION', 'portal:GRANTED:MIGRATION', 'sign:GRANTED:MIGRATION']);
    expect(isCommercialGrantSource('MIGRATION')).toBe(false);
  });

  it('A7-E-2 next request loses the product: after a governed revoke the guard refuses `sign` (403 TENANT_CAPABILITY_NOT_ENTITLED) and getCapabilities omits it; the row is kept', async () => {
    const t = await tenant(['core', 'sign']);
    await expect(guard(['sign']).canActivate(guardContext(t))).resolves.toBe(true);
    const cr = randomUUID();
    expect(await revoke(t, ['sign'], cr)).toEqual(['sign']);
    expect([...(await repo.getCapabilities(t))]).toEqual(['core']);
    await expect(guard(['sign']).canActivate(guardContext(t))).rejects.toMatchObject({ code: 'TENANT_CAPABILITY_NOT_ENTITLED', statusCode: 403 });
    await expect(guard(['core']).canActivate(guardContext(t))).resolves.toBe(true);
    expect(await rows(t)).toEqual([
      { capability: 'core', granted_source: 'SIGNUP', change_request_id: null, revoked: false, revoke_change_request_id: null },
      { capability: 'sign', granted_source: 'SIGNUP', change_request_id: null, revoked: true, revoke_change_request_id: cr },
    ]);
    expect(await ledger(t)).toEqual(['core:GRANTED:SIGNUP', 'sign:GRANTED:SIGNUP', 'sign:REVOKED:SIGNUP']);
    // A second revoke of the same capability revokes nothing (the row is already revoked).
    expect(await revoke(t, ['sign'])).toEqual([]);
  });

  it('A7-E-3 Intelligence sync: listTenantIdsWithCapability (the REPLACE list) drops a revoked tenant and keeps the others', async () => {
    const a = await tenant(['core', 'intelligence'], 'PROVISIONING');
    const b = await tenant(['core', 'intelligence'], 'PROVISIONING');
    expect(await repo.listTenantIdsWithCapability('intelligence')).toEqual(expect.arrayContaining([a, b]));
    await revoke(a, ['intelligence']);
    const after = await repo.listTenantIdsWithCapability('intelligence');
    expect(after).toContain(b);
    expect(after).not.toContain(a);
    expect([...after]).toEqual([...after].sort());
  });

  it('A7-E-4 resurrection guard: a provisioning or signup grant never clears a governed revoke; it is reported withheld and ledgered RESURRECTION_REFUSED', async () => {
    const t = await tenant(['core', 'sign']);
    await revoke(t, ['sign']);
    for (const granted_source of ['PROVISIONING', 'SIGNUP'] as const) {
      const out = await repo.grantCapabilities({ tenant_id: t, capabilities: ['core', 'sign', 'portal'], granted_source, granted_by: OPERATOR });
      expect(out).toEqual({ granted: granted_source === 'PROVISIONING' ? ['portal'] : [], already_held: granted_source === 'PROVISIONING' ? ['core'] : ['core', 'portal'], withheld_revoked: ['sign'] });
    }
    expect((await rows(t)).find((r) => r.capability === 'sign')).toMatchObject({ revoked: true, granted_source: 'SIGNUP' });
    expect([...(await repo.getCapabilities(t))].sort()).toEqual(['core', 'portal']);
    expect((await ledger(t)).filter((e) => e.startsWith('sign:'))).toEqual(['sign:GRANTED:SIGNUP', 'sign:REVOKED:SIGNUP', 'sign:RESURRECTION_REFUSED:PROVISIONING', 'sign:RESURRECTION_REFUSED:SIGNUP']);
  });

  it('A7-E-5 seed does not resurrect: the reconcile reports a revoked default capability withheld (never granted), and the seed-prod Gate 3 query (active rows only) counts 2, so the gate fails closed', async () => {
    const t = randomUUID();
    await pg.query(`INSERT INTO identity."Tenant" (id) VALUES ($1)`, [t]);
    await repo.grantCapabilities({ tenant_id: t, capabilities: DEFAULT_TENANT_CAPABILITIES, granted_source: 'PROVISIONING' });
    // Out-of-band (raw SQL) revoke of a default capability; the governed path cannot target it (A7 pre-execution C-3).
    await pg.query(`UPDATE entitlement."TenantEntitlement" SET revoked_at = now(), revoked_by = $2, revoke_change_request_id = $3 WHERE tenant_id = $1 AND capability = 'ats'`, [t, OPERATOR, randomUUID()]);
    const deps: EntitlementReconcileDeps = {
      tenantExists: async (id) => (await pg.query(`SELECT 1 FROM identity."Tenant" WHERE id = $1`, [id])).rowCount === 1,
      getCapabilities: (id) => repo.getCapabilities(id),
      grantCapabilities: (a) => repo.grantCapabilities({ ...a, granted_source: 'PROVISIONING' }),
    };
    for (let run = 0; run < 2; run += 1) {
      const r = await reconcileTenantEntitlements(deps, { tenantId: t, required: DEFAULT_TENANT_CAPABILITIES });
      expect(r).toMatchObject({ already_present: ['core', 'portal'], granted: [], withheld_revoked: ['ats'], final: ['core', 'portal'] });
    }
    expect((await rows(t)).find((r) => r.capability === 'ats')).toMatchObject({ revoked: true });
    // The literal Gate 3 SQL from deploy/seed-prod.sh, with the tenant substituted.
    const sh = readFileSync(resolve(REPO_ROOT, 'deploy/seed-prod.sh'), 'utf8');
    const gate = /"(SELECT count\(\*\) FROM entitlement\.\\"TenantEntitlement\\" WHERE tenant_id='\$\{ASTRE_TENANT_ID\}'[^"]*)"/.exec(sh)?.[1];
    expect(gate).toContain('revoked_at IS NULL');
    const sql = (gate as string).replace(/\\"/g, '"').replace('${ASTRE_TENANT_ID}', t);
    expect(Number((await pg.query(sql)).rows[0].count)).toBe(2);
  });

  it('A7-E-6 the DB guard: a revoke is cleared only by a governed re-grant; a revoked row cannot be deleted; provenance is immutable otherwise; the ledger is append-only; the CHECKs hold', async () => {
    const t = await tenant(['core', 'sign']);
    const cr = randomUUID();
    await revoke(t, ['sign'], cr);
    const W = `WHERE tenant_id = '${t}' AND capability = 'sign'`;
    expect(await raises(`UPDATE entitlement."TenantEntitlement" SET revoked_at = NULL, revoked_by = NULL, revoke_change_request_id = NULL ${W}`)).toMatch(/check constraint|entitlement_resurrection/);
    expect(await raises(`UPDATE entitlement."TenantEntitlement" SET revoked_at = NULL, revoked_by = NULL, revoke_change_request_id = NULL, granted_source = 'PROVISIONING' ${W}`)).toMatch(/entitlement_resurrection/);
    expect(await raises(`UPDATE entitlement."TenantEntitlement" SET revoked_at = NULL, revoked_by = NULL, revoke_change_request_id = NULL, granted_source = 'MANUAL', change_request_id = '${cr}' ${W}`)).toMatch(/entitlement_resurrection/);
    expect(await raises(`DELETE FROM entitlement."TenantEntitlement" ${W}`)).toMatch(/entitlement_revoke_permanent/);
    expect(await raises(`UPDATE entitlement."TenantEntitlement" SET granted_source = 'PLAN', change_request_id = '${randomUUID()}' WHERE tenant_id = '${t}' AND capability = 'core'`)).toMatch(/changes only by a governed revoke or a governed re-grant/);
    expect(await raises(`UPDATE entitlement."TenantEntitlementEvent" SET event_type = 'GRANTED' WHERE tenant_id = '${t}'`)).toMatch(/append-only/);
    expect(await raises(`DELETE FROM entitlement."TenantEntitlementEvent" WHERE tenant_id = '${t}'`)).toMatch(/append-only/);
    const u = randomUUID();
    expect(await raises(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ('${u}', 'sign', 'MANUAL')`)).toMatch(/commercial_source_check/);
    expect(await raises(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source, change_request_id) VALUES ('${u}', 'sign', 'SIGNUP', '${cr}')`)).toMatch(/commercial_source_check/);
    expect(await raises(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ('${u}', 'sign', 'PAYMENT')`)).toMatch(/granted_source_check/);
    expect(await raises(`UPDATE entitlement."TenantEntitlement" SET revoked_at = now() WHERE tenant_id = '${t}' AND capability = 'core'`)).toMatch(/revoke_check/);
    // Under session_replication_role = replica the guard still fires (ENABLE ALWAYS).
    await pg.query('BEGIN');
    await pg.query(`SET LOCAL session_replication_role = replica`);
    const replica = await raises(`DELETE FROM entitlement."TenantEntitlement" ${W}`);
    await pg.query('ROLLBACK');
    expect(replica).toMatch(/entitlement_revoke_permanent/);
    // An ACTIVE row may still be removed out-of-band (fixtures do), and the removal is ledgered.
    await pg.query(`DELETE FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 AND capability = 'core'`, [t]);
    expect((await ledger(t)).at(-1)).toBe('core:REMOVED:SIGNUP');
  });

  it('A7-E-7 re-grant clears the revoke: only a governed grant (a NEW change request) restores the row, re-stamped MANUAL / PLAN; an active row is never re-stamped', async () => {
    const t = await tenant(['core', 'sign']);
    const revokeCr = randomUUID();
    await revoke(t, ['sign'], revokeCr);
    const regrantCr = randomUUID();
    expect(await grantCapabilitiesInTx(raw(), { tenant_id: t, capabilities: ['core', 'sign'], granted_source: 'MANUAL', granted_by: OPERATOR, change_request_id: regrantCr })).toEqual(['sign']);
    expect(await rows(t)).toEqual([
      { capability: 'core', granted_source: 'SIGNUP', change_request_id: null, revoked: false, revoke_change_request_id: null },
      { capability: 'sign', granted_source: 'MANUAL', change_request_id: regrantCr, revoked: false, revoke_change_request_id: null },
    ]);
    expect([...(await repo.getCapabilities(t))].sort()).toEqual(['core', 'sign']);
    await expect(guard(['sign']).canActivate(guardContext(t))).resolves.toBe(true);
    expect(await ledger(t)).toEqual(['core:GRANTED:SIGNUP', 'sign:GRANTED:SIGNUP', 'sign:REVOKED:SIGNUP', 'sign:REGRANTED:MANUAL']);
    // The same request id cannot clear a later revoke (a NEW change request is required).
    await revoke(t, ['sign']);
    expect(await grantCapabilitiesInTx(raw(), { tenant_id: t, capabilities: ['sign'], granted_source: 'PLAN', granted_by: OPERATOR, change_request_id: regrantCr }).catch((e: Error) => e.message)).toMatch(/entitlement_resurrection/);
  });

  it('A7-E-8 Conv. C-20: a signup grant is recorded non-commercial (SIGNUP), is not evidence of payment, and reconciliation never revokes it for want of a subscription', async () => {
    const t = await tenant(['core', 'sign'], 'SIGNUP');
    expect((await rows(t)).map((r) => [r.capability, r.granted_source, isCommercialGrantSource(r.granted_source)])).toEqual([
      ['core', 'SIGNUP', false],
      ['sign', 'SIGNUP', false],
    ]);
    const deps: EntitlementReconcileDeps = {
      tenantExists: async () => true,
      getCapabilities: (id) => repo.getCapabilities(id),
      grantCapabilities: (a) => repo.grantCapabilities({ ...a, granted_source: 'PROVISIONING' }),
    };
    await reconcileTenantEntitlements(deps, { tenantId: t, required: DEFAULT_TENANT_CAPABILITIES });
    expect((await rows(t)).find((r) => r.capability === 'sign')).toMatchObject({ granted_source: 'SIGNUP', revoked: false });
    expect(['MANUAL', 'PLAN', 'PROMOTION'].every(isCommercialGrantSource)).toBe(true);
    expect(['PROVISIONING', 'SIGNUP', 'MIGRATION'].some(isCommercialGrantSource)).toBe(false);
  });

  it('A7-E-9 the migration is replay-safe: re-applying it changes no row and adds no ledger event', async () => {
    const before = (await pg.query(`SELECT count(*)::int n FROM entitlement."TenantEntitlementEvent"`)).rows[0].n;
    const state = (await pg.query(`SELECT row_to_json(e)::text j FROM entitlement."TenantEntitlement" e ORDER BY tenant_id, capability`)).rows;
    await pg.query(readFileSync(resolveEntitlementMigrations(REPO_ROOT).at(-1) as string, 'utf8'));
    expect((await pg.query(`SELECT count(*)::int n FROM entitlement."TenantEntitlementEvent"`)).rows[0].n).toBe(before);
    expect((await pg.query(`SELECT row_to_json(e)::text j FROM entitlement."TenantEntitlement" e ORDER BY tenant_id, capability`)).rows).toEqual(state);
  });
});
