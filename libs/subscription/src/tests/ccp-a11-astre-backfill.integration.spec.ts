import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { CAPABILITY_VALUES, type Capability, EntitlementGuard, EntitlementModule, EntitlementRepository, REQUIRED_CAPABILITIES_KEY } from '@aramo/entitlement';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CapacityService } from '../lib/capacity.service.js';
import { type FactCheckReport, ccpFactCheck, formatFactCheck } from '../lib/commercial/ccp-fact-check.js';
import {
  type BackfillPlan,
  PRE_CCP_RECORD_EVENT,
  PRE_CCP_WITHDRAWN_EVENT,
  type SqlClient,
  applyPreCcpBackfill,
  formatBackfillPlan,
  planPreCcpBackfill,
  recordIdFor,
} from '../lib/commercial/pre-ccp-backfill.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { A11, A11_PII, A11_SUB, A11_T0, applyCcpMigrations, applyPreCcpSchema, databaseFingerprint, seedProductionLike } from './fixtures/ccp-a11-production-like.js';
import { addOperator, seedCcpCatalog } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, a6Harness, as, newTenant, publishedVersion, type A6Harness } from './support/ccp-a6.js';

// CCP-A11 (PBD §5.1 row A11 mandatory tests) on real Postgres 17: the production-like fixture is
// seeded on the PRE-CCP schema, carried through every CCP migration, then the dry run, the
// no-service-change proof (allowance decisions, entitlements via the A7 readers, capability guard
// results, usage), the idempotent re-run, the compensating SQL and the read-only fact-check.
// Test IDs are cited by doc/ccp/slices/CCP-A11-acceptance.md.

const REPO_ROOT = resolve(__dirname, '../../../..');
const COMPENSATING = resolve(__dirname, 'fixtures/ccp-a11-compensating.sql');
const GOLDEN = resolve(__dirname, 'fixtures/ccp-a11-dry-run.golden.txt');
const run = promisify(execFile);

/** A client wrapper that records every statement (the read-only proof). */
function recording(c: Client): SqlClient & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    query: async (sql: string, params?: unknown[]) => {
      log.push(sql.trim());
      return c.query(sql, params as unknown[]);
    },
  };
}
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|LOCK|SELECT\s+pg_advisory)/i;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A11 Astre backfill tooling, dry-run only (real Postgres 17)', { timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let url: string;
  let pg: Client;
  let prisma: PrismaService;
  let entitlementModule: TestingModule;
  let entitlements: EntitlementRepository;
  let h: A6Harness;
  let GOVERNED: string;
  let factPre: FactCheckReport;
  let factPreLines: string[];
  let planPre: BackfillPlan;
  let fpBeforeBackfill: Record<string, string>;
  let serviceBeforeBackfill: string;
  let fpAfterBackfill: Record<string, string>;
  let keyN = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    // 1. Production today: the pre-CCP schema and the production shape.
    await applyPreCcpSchema(pg);
    await seedProductionLike(pg);
    factPre = await ccpFactCheck(pg);
    factPreLines = formatFactCheck(factPre);
    planPre = await planPreCcpBackfill(pg);
    // 2. Every CCP migration over it (A4, A5, A7 backfills run here, as in a release).
    await applyCcpMigrations(pg);
    await seedCcpCatalog(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => A11_T0);
    const prior = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = url;
    try {
      entitlementModule = await Test.createTestingModule({ imports: [EntitlementModule] }).compile();
    } finally {
      if (prior === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = prior;
    }
    entitlements = entitlementModule.get(EntitlementRepository);
    // 3. Post-CCP governed acts: REVOKED loses `sign`; GOVERNED is opened through a change request.
    const OPS = await addOperator(pg, ['commercial_ops']);
    const FA = await addOperator(pg, ['finance_admin']);
    const approvedApply = async (action_type: 'ENTITLEMENT_REVOKE' | 'SUBSCRIPTION_OPEN', tenant_id: string, payload: Record<string, unknown>) => {
      const r = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type, tenant_id, product_key: 'sign', payload, reason: 'ccp-a11 fixture', idempotency_key: `a11-key-${++keyN}` }, A6_CTX);
      await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
      await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
      return h.apply.apply(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    };
    await approvedApply('ENTITLEMENT_REVOKE', A11.REVOKED, { capabilities: ['sign'] });
    GOVERNED = await newTenant(pg);
    await approvedApply('SUBSCRIPTION_OPEN', GOVERNED, { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null });
  }, 400_000);

  afterAll(async () => {
    await entitlementModule?.close();
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const tenants = () => [A11.ASTRE, A11.STRIPE, A11.REVOKED, A11.ATS_ONLY, GOVERNED];

  async function settle(p: Promise<unknown>): Promise<unknown> {
    try {
      return { ok: JSON.parse(JSON.stringify(await p, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) };
    } catch (e) {
      const err = e as { name?: string; code?: string; statusCode?: number; message?: string };
      return { error: err.code ?? err.name, status: err.statusCode ?? null };
    }
  }
  function guardResult(tenant_id: string, required: Capability): Promise<unknown> {
    const r = new Reflector();
    vi.spyOn(r, 'getAllAndOverride').mockImplementation((key: string) => (key === REQUIRED_CAPABILITIES_KEY ? [required] : undefined));
    const request = { authContext: { tenant_id }, requestId: 'ccp-a11' };
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => class A11Route {},
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => ({}) }),
    } as unknown as ExecutionContext;
    return settle(new EntitlementGuard(r, entitlements).canActivate(ctx));
  }

  /** Effective service as JSON text: allowance decisions, entitlements via the A7 readers, guard results. */
  async function effectiveService(): Promise<string> {
    const out: Record<string, unknown> = {};
    for (const t of tenants()) {
      const guard: Record<string, unknown> = {};
      for (const c of CAPABILITY_VALUES) guard[c] = await guardResult(t, c);
      out[t] = {
        allowance: await settle(h.allowance.getStatus(t, 'sign', 'sign.envelopes', A11_T0)),
        stale: await settle(h.allowance.staleReservations(t, 'sign', 'sign.envelopes', A11_T0)),
        capacity: await settle(new CapacityService(prisma).status(t, 'sign', 'sign.storage_bytes')),
        account: await settle(h.lifecycle.account(t, 'sign', 'sign.envelopes', A11_T0)),
        capabilities: [...(await entitlements.getCapabilities(t))].sort(),
        guard,
      };
    }
    const replace: Record<string, string[]> = {};
    for (const c of CAPABILITY_VALUES) replace[c] = (await entitlements.listTenantIdsWithCapability(c)).filter((t) => tenants().includes(t));
    out['listTenantIdsWithCapability'] = replace;
    return JSON.stringify(out);
  }
  const usageRows = async () =>
    (await pg.query(`SELECT 'A' || row_to_json(u)::text j FROM subscription."AllowanceUsage" u UNION ALL SELECT 'C' || row_to_json(c)::text FROM subscription."CapacityUsage" c ORDER BY 1`)).rows.map(
      (r) => r.j as string,
    );
  const noPii = (lines: readonly string[]) => {
    const text = lines.join('\n');
    for (const s of A11_PII) expect(text).not.toContain(s);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  };

  it('A11-FACT-1 the read-only fact-check on the PRE-CCP schema (production today) reports the known production facts for the Astre-shaped tenant', () => {
    expect(factPre.schema.stage).toBe('pre-CCP');
    const astre = factPre.manual_tenants.find((t) => t.tenant_id === A11.ASTRE);
    expect(astre).toEqual({
      tenant_id: A11.ASTRE,
      open_subscriptions: 1,
      plan_key: 'aramo-sign-included-v1',
      status: 'ACTIVE',
      started_on: '2026-10-19',
      period_anchor_on: '2026-10-19',
      billing_link: 'absent',
      plan_version: 'n/a (pre-A5)',
      entitlements: ['ats', 'core', 'portal', 'sign'],
    });
    expect(factPre.checkout_intents_total).toBe(0);
    expect(factPre.subscriptions_by_source).toEqual([
      { source: 'MANUAL', open: 2, total: 3 },
      { source: 'SELF_SERVICE', open: 1, total: 1 },
    ]);
    expect(factPre.plan_versions).toBe('n/a');
    expect(factPre.pre_ccp_records).toBe('n/a');
    noPii(factPreLines);
  });

  it('A11-DRY-0 the dry run on the PRE-CCP schema refuses (schema not at CCP-A7) and lists what is missing', () => {
    expect(planPre.schema_ready).toBe(false);
    expect(planPre.halt).toBe(true);
    expect(planPre.schema_missing).toEqual([
      'subscription."TenantSubscription".product_key (CCP-A4)',
      'subscription."TenantSubscription".composition_role (CCP-A4)',
      'subscription."TenantSubscription".plan_version_id (CCP-A5)',
      'subscription."PlanVersion".content_checksum (CCP-A5)',
      'subscription."CommercialAuditEvent".event_type (CCP-A2)',
      'subscription."CommercialPolicyVersion".status (CCP-A2)',
      'subscription."CommercialChangeApplication".subscription_id (CCP-A6)',
      'entitlement."TenantEntitlement".granted_source (CCP-A7)',
      'entitlement."TenantEntitlement".revoked_at (CCP-A7)',
    ]);
  });

  it('A11-FACT-2 the fact-check on the post-CCP schema: one READ ONLY session, rolled back, no write statement, nothing changed, no PII', async () => {
    const before = await databaseFingerprint(pg);
    const c = recording(pg);
    const fact = await ccpFactCheck(c);
    expect(c.log[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(c.log.at(-1)).toBe('ROLLBACK');
    expect(c.log.filter((q) => WRITE_SQL.test(q))).toEqual([]);
    expect(await databaseFingerprint(pg)).toEqual(before);
    expect(fact.schema.stage).toBe('CCP-A7');
    expect(fact.manual_tenants.find((t) => t.tenant_id === A11.ASTRE)).toMatchObject({
      open_subscriptions: 1,
      plan_key: 'aramo-sign-included-v1',
      status: 'ACTIVE',
      started_on: '2026-10-19',
      billing_link: 'absent',
      plan_version: 'v1 PUBLISHED',
      entitlements: ['ats:MIGRATION', 'core:MIGRATION', 'portal:MIGRATION', 'sign:MIGRATION'],
    });
    expect(fact.manual_tenants.find((t) => t.tenant_id === A11.REVOKED)?.entitlements).toEqual(['core:MIGRATION', 'sign:MIGRATION:revoked']);
    expect(fact.checkout_intents_total).toBe(0);
    expect(fact.pre_ccp_records).toBe(0);
    noPii(formatFactCheck(fact));
  });

  it('A11-DRY-1 the dry run on the fixture: deterministic counts, exception report, 2 planned records (Astre + the revoked pre-CCP tenant), every effective-service table 0 writes; it writes nothing', async () => {
    const fp = await databaseFingerprint(pg);
    const c = recording(pg);
    const plan = await planPreCcpBackfill(c);
    expect(c.log[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(c.log.at(-1)).toBe('ROLLBACK');
    expect(c.log.filter((q) => WRITE_SQL.test(q))).toEqual([]);
    expect(await databaseFingerprint(pg)).toEqual(fp);
    expect(plan.schema_ready).toBe(true);
    expect(plan.halt).toBe(false);
    expect(plan.counts).toEqual({
      subscriptions_total: 5,
      subscriptions_open: 4,
      open_manual: 3,
      open_manual_governed_by_change_request: 1,
      open_manual_already_recorded: 0,
      open_manual_withdrawn: 0,
      open_manual_to_record: 2,
      open_self_service_not_in_scope: 1,
      open_free_not_in_scope: 0,
      open_development: 0,
      open_pinned_checksum_ok: 4,
      open_pinned_v1: 4,
      open_product_sign_base: 4,
      entitlement_rows: 15, // incl. the 3 rows the entitlement init migration seeds for the bootstrap tenant
      entitlement_rows_active: 14,
      entitlement_rows_revoked: 1,
      checkout_intents: 0,
      checkout_intents_created_for_manual: 0,
      pre_ccp_records_existing: 0,
      exceptions_halt: 0,
      exceptions_review: 1,
    });
    expect(plan.open_by_product_source_status).toEqual([
      { product_key: 'sign', source: 'MANUAL', status: 'ACTIVE', n: 3 },
      { product_key: 'sign', source: 'SELF_SERVICE', status: 'ACTIVE', n: 1 },
    ]);
    expect(plan.entitlements_by_source).toEqual([
      { granted_source: 'MIGRATION', active: 12, revoked: 1 },
      { granted_source: 'PLAN', active: 2, revoked: 0 },
    ]);
    expect(plan.exceptions).toEqual([
      { code: 'PRODUCT_CAPABILITY_REVOKED', severity: 'REVIEW', tenant_id: A11.REVOKED, subscription_id: A11_SUB.REVOKED, detail: 'sign is revoked; the backfill never re-grants (resurrection guard)' },
    ]);
    expect(plan.planned.map((r) => [r.tenant_id, r.subscription_id, r.id])).toEqual([
      [A11.ASTRE, A11_SUB.ASTRE, recordIdFor(A11_SUB.ASTRE)],
      [A11.REVOKED, A11_SUB.REVOKED, recordIdFor(A11_SUB.REVOKED)],
    ].sort());
    const astre = plan.planned.find((r) => r.tenant_id === A11.ASTRE)!;
    expect(astre.payload).toMatchObject({
      backfill: 'CCP-A11',
      record_kind: 'PRE_CCP_MANUAL_GRANT',
      product_key: 'sign',
      composition_role: 'BASE',
      source: 'MANUAL',
      status: 'ACTIVE',
      plan_key: 'aramo-sign-included-v1',
      plan_version_number: 1,
      plan_version_checksum: '6ec16b4a2d871fb0a1da7a890462e1b9a5721c68216d963df5acef700ad62bf8',
      started_at: '2026-10-19T00:00:00.000Z',
      billing_linked: false,
      capabilities: ['ats', 'core', 'portal', 'sign'].map((capability) => ({ capability, granted_source: 'MIGRATION', revoked: false })),
    });
    expect(plan.planned_writes).toEqual({
      'subscription."CommercialAuditEvent"': 2,
      'subscription."TenantSubscription"': 0,
      'subscription."CommercialChangeRequest"': 0,
      'subscription."SubscriptionVersionPinEvent"': 0,
      'subscription."AllowanceUsage"': 0,
      'subscription."CapacityUsage"': 0,
      'entitlement."TenantEntitlement"': 0,
      'entitlement."TenantEntitlementEvent"': 0,
    });
    // Deterministic: a second dry run prints the same report byte for byte.
    const again = formatBackfillPlan(await planPreCcpBackfill(pg));
    expect(again).toEqual(formatBackfillPlan(plan));
    noPii(again);
    // The exact report, pinned (cited by the acceptance record §2).
    expect(`${again.join('\n')}\n`).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('A11-CLI-1 the commands: `ccp:astre-backfill --dry-run` against the testcontainer prints the same report (exit 0); the fact-check command runs; both refuse a non-local URL', async () => {
    const runner = resolve(REPO_ROOT, 'deploy/jiti-tsconfig-runner.mjs');
    const dry = await run('node', [runner, 'libs/subscription/prisma/ccp-astre-backfill.ts', '--dry-run', '--database-url', url], { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: '' } });
    expect(dry.stdout.trimEnd().split('\n')).toEqual(formatBackfillPlan(await planPreCcpBackfill(pg)));
    const fact = await run('node', [runner, 'libs/subscription/prisma/ccp-astre-fact-check.ts', '--database-url', url], { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: '' } });
    expect(fact.stdout.trimEnd().split('\n')).toEqual(formatFactCheck(await ccpFactCheck(pg)));
    const remote = url.replace(/@[^:/]+(:\d+)?\//, '@db.prod.example:5432/');
    await expect(run('node', [runner, 'libs/subscription/prisma/ccp-astre-backfill.ts', '--dry-run', '--database-url', remote], { cwd: REPO_ROOT })).rejects.toMatchObject({ code: 2 });
    await expect(run('node', [runner, 'libs/subscription/prisma/ccp-astre-fact-check.ts', '--database-url', remote], { cwd: REPO_ROOT })).rejects.toMatchObject({ code: 2 });
  });

  it('A11-NSC-1 no service change: applying the planned records (test-only apply) leaves effective service byte-identical (allowance, capacity, account, the A7 readers, the capability guard for every capability) and usage unchanged; only CommercialAuditEvent gains exactly 2 rows', async () => {
    fpBeforeBackfill = await databaseFingerprint(pg);
    serviceBeforeBackfill = await effectiveService();
    const usageBefore = await usageRows();
    const astreBefore = JSON.parse(serviceBeforeBackfill)[A11.ASTRE];
    expect(astreBefore.allowance.ok).toMatchObject({ limit: 100, used: 43, remaining: 57 });
    expect(astreBefore.capabilities).toEqual(['ats', 'core', 'portal', 'sign']);
    expect(JSON.parse(serviceBeforeBackfill)[A11.REVOKED].guard.sign).toEqual({ error: 'TENANT_CAPABILITY_NOT_ENTITLED', status: 403 });

    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      const res = await applyPreCcpBackfill(c, { po_authorization_ref: 'fixture-only (no production authorization)' });
      expect(res.inserted.sort()).toEqual([recordIdFor(A11_SUB.ASTRE), recordIdFor(A11_SUB.REVOKED)].sort());
    } finally {
      await c.end();
    }

    expect(await effectiveService()).toBe(serviceBeforeBackfill);
    expect(await usageRows()).toEqual(usageBefore);
    fpAfterBackfill = await databaseFingerprint(pg);
    const changed = Object.keys(fpAfterBackfill).filter((k) => fpAfterBackfill[k] !== fpBeforeBackfill[k]);
    expect(changed).toEqual(['subscription.CommercialAuditEvent']);
    expect(Number(fpAfterBackfill['subscription.CommercialAuditEvent']!.split(':')[0]) - Number(fpBeforeBackfill['subscription.CommercialAuditEvent']!.split(':')[0])).toBe(2);
    const rows = (await pg.query(`SELECT id::text, tenant_id::text, subject, actor_type, actor_id, change_request_id, is_exception, correlation_id FROM subscription."CommercialAuditEvent" WHERE event_type = $1 ORDER BY id`, [PRE_CCP_RECORD_EVENT])).rows;
    expect(rows).toEqual(
      [A11_SUB.ASTRE, A11_SUB.REVOKED]
        .map((s) => ({ id: recordIdFor(s), tenant_id: s === A11_SUB.ASTRE ? A11.ASTRE : A11.REVOKED, subject: `subscription:${s}`, actor_type: 'system', actor_id: null, change_request_id: null, is_exception: false, correlation_id: `ccp-a11-backfill:${s}` }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it('A11-IDEM-1 idempotent re-run: the next dry run plans 0 records (2 already recorded); a second apply inserts nothing; the database and effective service are byte-identical to after the first apply', async () => {
    const plan = await planPreCcpBackfill(pg);
    expect(plan.planned).toEqual([]);
    expect(plan.counts['open_manual_already_recorded']).toBe(2);
    expect(plan.counts['open_manual_to_record']).toBe(0);
    expect(plan.counts['pre_ccp_records_existing']).toBe(2);
    expect(plan.planned_writes['subscription."CommercialAuditEvent"']).toBe(0);
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      expect(await applyPreCcpBackfill(c, { po_authorization_ref: 'fixture-only (no production authorization)' })).toEqual({
        inserted: [],
        already_present: [recordIdFor(A11_SUB.ASTRE), recordIdFor(A11_SUB.REVOKED)].sort(),
      });
    } finally {
      await c.end();
    }
    expect(await databaseFingerprint(pg)).toEqual(fpAfterBackfill);
    expect(await effectiveService()).toBe(serviceBeforeBackfill);
    expect(formatBackfillPlan(await planPreCcpBackfill(pg))).toEqual(formatBackfillPlan(plan));
  });

  it('A11-COMP-1 the compensating SQL appends one withdrawal per record (no delete), is idempotent, and changes no effective service; the dry run then reports RECORD_WITHDRAWN and plans nothing', async () => {
    const sql = readFileSync(COMPENSATING, 'utf8');
    await pg.query(sql);
    const n = async () => Number((await pg.query(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent" WHERE event_type = $1`, [PRE_CCP_WITHDRAWN_EVENT])).rows[0].n);
    expect(await n()).toBe(2);
    const fp = await databaseFingerprint(pg);
    await pg.query(sql);
    expect(await n()).toBe(2);
    expect(await databaseFingerprint(pg)).toEqual(fp);
    expect(Object.keys(fp).filter((k) => fp[k] !== fpBeforeBackfill[k])).toEqual(['subscription.CommercialAuditEvent']);
    expect(await effectiveService()).toBe(serviceBeforeBackfill);
    const plan = await planPreCcpBackfill(pg);
    expect(plan.planned).toEqual([]);
    expect(plan.counts['open_manual_withdrawn']).toBe(2);
    expect(plan.exceptions.filter((e) => e.code === 'RECORD_WITHDRAWN').map((e) => e.subscription_id).sort()).toEqual([A11_SUB.ASTRE, A11_SUB.REVOKED].sort());
    // The audit stream stays append-only: compensation can never delete a record.
    await expect(pg.query(`DELETE FROM subscription."CommercialAuditEvent" WHERE event_type = $1`, [PRE_CCP_RECORD_EVENT])).rejects.toThrow();
  });

  it('A11-HALT-1 a HALT exception (a CREATED checkout intent for a tenant holding an open MANUAL row, Conv. C-16(a)/C-17) makes the dry run HALT and the apply refuse, writing nothing', async () => {
    await pg.query(
      `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, status, created_at)
       SELECT '0190a11e-0000-7000-8000-000000000001', $1::uuid, 'ccp-a11-halt', p.id, 'STRIPE', 'CREATED', now() FROM subscription."Plan" p WHERE p.key = 'aramo-sign-standard-business-v1'`,
      [A11.ASTRE],
    );
    const plan = await planPreCcpBackfill(pg);
    expect(plan.halt).toBe(true);
    expect(plan.exceptions.filter((e) => e.severity === 'HALT').map((e) => [e.code, e.tenant_id])).toEqual([['OPEN_CHECKOUT_INTENT_FOR_MANUAL', A11.ASTRE]]);
    expect(formatBackfillPlan(plan).at(-1)).toMatch(/^\[ccp-a11\] HALT/);
    const fp = await databaseFingerprint(pg);
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      await expect(applyPreCcpBackfill(c, { po_authorization_ref: 'fixture-only' })).rejects.toThrow(/HALT exceptions present/);
    } finally {
      await c.end();
    }
    expect(await databaseFingerprint(pg)).toEqual(fp);
  });
});
