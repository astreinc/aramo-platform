import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply-records.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { CommercialApprovalRefusedError, CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { CommercialCatalogService } from '../lib/commercial/commercial-catalog.service.js';
import { CommercialAuditRepository } from '../lib/commercial/commercial-audit.repository.js';
import { CommercialOperatorRepository } from '../lib/commercial/commercial-operator.repository.js';
import { CommercialPolicyRepository } from '../lib/commercial/commercial-policy.repository.js';
import { type PlanCreatePayload } from '../lib/commercial/commercial-plan-create.js';
import { planVersionTerms } from '../lib/plan-version.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, a6Harness, as, type A6Harness } from './support/ccp-a6.js';
import { VALID } from './support/ccp-plan-create.js';

// CCP PLAN_CREATE (Aramo-CCP-Amendment-PLAN_CREATE-Console-Plan-Creation, catalog row 17) — the governed
// plan creation end to end on real Postgres 17: the Finance → Owner chain and maker ≠ checker (PC-1,
// PC-2), the available-capability refusal (PC-4), the duplicate-key refusals (PC-6), the one-transaction
// apply with nothing written before it (PC-7, PC-8), audit (PC-9), idempotency (PC-12), the DB guard's
// APPLIED backstop, and the compensating SQL.

const T0 = new Date('2026-11-01T12:00:00.000Z');
const ROOT = resolve(__dirname, '../../../..');
const COMPENSATION = resolve(ROOT, 'libs/subscription/src/tests/fixtures/ccp-plan-create-compensating.sql');
const GUARD_UNION = resolve(ROOT, 'libs/subscription/prisma/migrations/20261027000000_ccp_guard_union/migration.sql');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP PLAN_CREATE governed plan creation (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let catalog: CommercialCatalogService;
  let faultAt: string | null = null;
  let CAT: string;
  let CAT_FA: string;
  let FA: string;
  let PO: string;
  let FA_PO: string;
  let OPS: string;
  let keyN = 0;
  const key = () => `pc-key-${String(++keyN).padStart(6, '0')}`;
  let planN = 0;
  const payload = (patch: Partial<PlanCreatePayload> = {}): PlanCreatePayload => ({ ...VALID, plan_key: `aramo-sign-pc-${String(++planN).padStart(4, '0')}`, ...patch });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => T0, undefined, (point) => {
      if (point === faultAt) throw new Error(`injected catalog fault at ${point}`);
    });
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    catalog = new CommercialCatalogService(prisma, h.versions, policies, audit, new CommercialOperatorRepository(prisma, audit, policies));
    CAT = await addOperator(pg, ['catalog_manager']);
    CAT_FA = await addOperator(pg, ['catalog_manager', 'finance_admin']);
    FA = await addOperator(pg, ['finance_admin']);
    PO = await addOperator(pg, ['platform_owner']);
    FA_PO = await addOperator(pg, ['finance_admin', 'platform_owner']);
    OPS = await addOperator(pg, ['commercial_ops']);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const create = (p: PlanCreatePayload, requester = CAT, role = 'catalog_manager') =>
    h.changeRequests.create(as(requester, role), { action_type: 'PLAN_CREATE', payload: p, reason: 'new plan\n\nEvidence: pricing sheet v2', idempotency_key: key() }, A6_CTX);
  async function approved(p: PlanCreatePayload): Promise<string> {
    const r = await create(p);
    await h.changeRequests.submit(as(CAT, 'catalog_manager'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    const a = await h.changeRequests.approve(as(PO, 'platform_owner'), r.request.id, { step_index: 1 }, A6_CTX);
    expect(a.request.state).toBe('APPROVED');
    return r.request.id;
  }
  const applyAs = (id: string, user = CAT, role = 'catalog_manager') => h.apply.apply(as(user, role), id, A6_CTX);
  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e instanceof CommercialApplyFailedError) return `FAILED:${e.code}`;
      if (e instanceof CommercialApplyRefusedError) return `REFUSED:${e.reason}`;
      if (e instanceof CommercialApprovalRefusedError) return `APPROVAL:${e.refusal}`;
      if (e instanceof CommercialChangeRequestError) return `ERROR:${e.code}:${String(e.details['reason'] ?? '')}`;
      throw e;
    }
  }
  const plans = async (k: string) => (await pg.query(`SELECT id, status, sellable, sales_model, list_price_minor, display_order FROM subscription."Plan" WHERE key = $1`, [k])).rows;
  const request = async (id: string) => (await pg.query(`SELECT state, apply_attempts FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0];

  it('PC-I-0 the compensating SQL restores the deployed guard body and the two CHECKs (run before any PLAN_CREATE exists; rolled back)', async () => {
    await pg.query('BEGIN');
    try {
      await pg.query(readFileSync(COMPENSATION, 'utf8'));
      const live = (await pg.query(`SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'subscription' AND p.proname = 'guard_commercial_change_request'`)).rows[0].src as string;
      const union = readFileSync(GUARD_UNION, 'utf8');
      const unionBody = union.slice(union.indexOf('AS $$') + 'AS $$'.length, union.lastIndexOf('$$ LANGUAGE plpgsql'));
      expect(live).toBe(unionBody);
      expect(live).not.toContain('PLAN_CREATE');
      const checks = (await pg.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname IN ('CommercialChangeRequest_action_type_check', 'CommercialCatalogApplication_action_type_check')`)).rows.map((r) => r.d as string);
      expect(checks).toHaveLength(2);
      for (const c of checks) expect(c).not.toContain('PLAN_CREATE');
    } finally {
      await pg.query('ROLLBACK');
    }
  });

  it('PC-I-1 a catalog_manager creates, Finance then Owner approve, the requester applies: the plan, its rows and version 1 PUBLISHED exist only after apply; one catalog application; PC-9 audit; idempotent replay', async () => {
    const p = payload({ allowance_windows: [{ allowance_key: 'sign.envelopes', window_kind: 'DAY', limit_quantity: 20 }] });
    const r = await create(p);
    expect(r.request).toMatchObject({ action_type: 'PLAN_CREATE', tenant_id: null, product_key: null, state: 'DRAFT' });
    expect(r.request.required_chain).toMatchObject({ rule: 'FINANCE_THEN_OWNER', steps: [{ role_key: 'finance_admin' }, { role_key: 'platform_owner' }] });
    await h.changeRequests.submit(as(CAT, 'catalog_manager'), r.request.id, A6_CTX);
    // PC-8: pending, visible in the catalog read, nothing created.
    const view = await catalog.readCatalog(T0);
    expect(view.plan_create.pending.map((x) => x.plan_key)).toContain(p.plan_key);
    // PO R-8 2026-11-01: templates, reports and access code are AVAILABLE.
    expect(view.plan_create.available_keys).toEqual([{ product_key: 'sign', keys: ['sign.access_code', 'sign.envelopes', 'sign.in_person_signing', 'sign.reports', 'sign.storage_bytes', 'sign.team_collaboration', 'sign.templates'] }]);
    expect(await plans(p.plan_key)).toEqual([]);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    expect(await plans(p.plan_key)).toEqual([]);
    await h.changeRequests.approve(as(PO, 'platform_owner'), r.request.id, { step_index: 1 }, A6_CTX);
    expect(await plans(p.plan_key)).toEqual([]); // approved is not applied
    const out = await applyAs(r.request.id);
    expect(out).toMatchObject({ replayed: false, application: null, request: { state: 'APPLIED', apply_attempts: 1 } });
    const [plan] = await plans(p.plan_key);
    expect(plan).toMatchObject({ status: 'ACTIVE', sellable: false, sales_model: 'SELF_SERVICE', list_price_minor: 1500, display_order: 25 });
    expect(out.catalog_application).toMatchObject({ action_type: 'PLAN_CREATE', plan_id: plan.id, retired_plan_version_id: null, provider_price_ref: null, attempt: 1, applied_by: CAT });
    const versions = (await pg.query(`SELECT * FROM subscription."PlanVersion" WHERE plan_id = $1`, [plan.id])).rows;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ id: out.catalog_application?.plan_version_id, version_number: 1, status: 'PUBLISHED' });
    const terms = planVersionTerms(versions[0]);
    expect(terms.plan).toMatchObject({ key: p.plan_key, name: 'Team', list_price_minor: 1500, reference_price_minor: null });
    expect(terms.allowance_windows).toEqual([{ allowance_key: 'sign.envelopes', window_kind: 'DAY', limit_quantity: 20 }]);
    expect(terms.features.map((f) => f.feature_key)).toEqual(['sign.team_collaboration', 'sign.in_person_signing']);
    // The live rows equal the version content (version 1 is the projection of exactly these rows; the
    // live read is unordered, so compare by key).
    const byKey = <T>(xs: readonly T[], k: (x: T) => string) => [...xs].sort((a, b) => k(a).localeCompare(k(b)));
    const norm = (c: typeof terms) => ({
      ...c,
      allowances: byKey(c.allowances, (a) => a.allowance_key),
      allowance_windows: byKey(c.allowance_windows, (a) => a.allowance_key + a.window_kind),
      capacities: byKey(c.capacities, (a) => a.capacity_key),
      features: byKey(c.features, (a) => a.feature_key),
    });
    expect(norm(await h.versions.liveContent(plan.id))).toEqual(norm(terms));
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."PlanVersionPrice" WHERE plan_version_id = $1`, [versions[0].id])).rows[0].n).toBe(0);
    // PC-9.
    const events = (await pg.query(`SELECT event_type, subject, payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [r.request.id])).rows;
    expect(events.map((e) => e.event_type).slice(-3)).toEqual(['COMMERCIAL_PLAN_CREATED', 'COMMERCIAL_PLAN_VERSION_PUBLISHED', 'COMMERCIAL_CHANGE_REQUEST_APPLIED']);
    expect(events[events.length - 3]).toMatchObject({ subject: `plan:${plan.id}`, payload: { plan_key: p.plan_key, product_key: 'sign', tenant_kind: 'BUSINESS', sales_model: 'SELF_SERVICE', version_number: 1 } });
    expect(events[events.length - 1].payload).toMatchObject({ outcome: 'APPLIED', requested_by: CAT, from_status: 'NONE', to_status: 'PUBLISHED' });
    expect(events[events.length - 1].payload.approvals).toHaveLength(2);
    // PC-12: replay writes nothing.
    const again = await applyAs(r.request.id);
    expect(again).toMatchObject({ replayed: true, catalog_application: { id: out.catalog_application?.id } });
    expect(await plans(p.plan_key)).toHaveLength(1);
    // The new plan is in the console catalog with its published version; no longer pending.
    const after = await catalog.readCatalog(T0);
    expect(after.products[0]?.plans.find((x) => x.key === p.plan_key)?.versions.map((v) => v.status)).toEqual(['PUBLISHED']);
    expect(after.plan_create.pending.map((x) => x.plan_key)).not.toContain(p.plan_key);
  });

  it('PC-I-2 maker ≠ checker: only platform:catalog:draft requests; the requester never approves; one human fills at most one step; the owner step needs the owner role; only the requester applies', async () => {
    expect(await outcome(create(payload(), OPS, 'commercial_ops'))).toBe('ERROR:REQUESTER_SCOPE_MISSING:');
    expect(await outcome(create(payload(), FA, 'finance_admin'))).toBe('ERROR:REQUESTER_SCOPE_MISSING:');
    // A requester who also holds finance_admin cannot approve their own request.
    const own = await create(payload(), CAT_FA, 'catalog_manager');
    await h.changeRequests.submit(as(CAT_FA, 'catalog_manager'), own.request.id, A6_CTX);
    expect(await outcome(h.changeRequests.approve(as(CAT_FA, 'finance_admin'), own.request.id, { step_index: 0 }, A6_CTX))).toBe('APPROVAL:SELF_APPROVAL');
    // One person holding finance_admin and platform_owner fills at most one step.
    const r = await create(payload());
    await h.changeRequests.submit(as(CAT, 'catalog_manager'), r.request.id, A6_CTX);
    expect(await outcome(h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 1 }, A6_CTX))).toMatch(/^APPROVAL:(STEP_SCOPE_MISSING|OUT_OF_ORDER)$/);
    await h.changeRequests.approve(as(FA_PO, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    expect(await outcome(h.changeRequests.approve(as(FA_PO, 'platform_owner'), r.request.id, { step_index: 1 }, A6_CTX))).toBe('APPROVAL:USER_ALREADY_APPROVED');
    await h.changeRequests.approve(as(PO, 'platform_owner'), r.request.id, { step_index: 1 }, A6_CTX);
    // Apply is requester-only.
    expect(await outcome(applyAs(r.request.id, CAT_FA, 'catalog_manager'))).toBe('ERROR:NOT_REQUESTER:not_requester');
    expect(await outcome(applyAs(r.request.id))).toBe('OK');
  });

  it('PC-I-3 a NOT_AVAILABLE capability is refused at creation (400 invalid_payload with the stable code); nothing is recorded', async () => {
    const before = (await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest"`)).rows[0].n;
    try {
      await create(payload({ features: [{ feature_key: 'sign.branding', enabled: true }] }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CommercialChangeRequestError);
      expect((e as CommercialChangeRequestError).code).toBe('INVALID_INPUT');
      expect((e as CommercialChangeRequestError).details).toMatchObject({ reason: 'invalid_payload', codes: ['PLAN_CREATE_FEATURE_NOT_AVAILABLE'] });
    }
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest"`)).rows[0].n).toBe(before);
  });

  it('PC-I-4 duplicate keys: an existing plan key and a key named by another open PLAN_CREATE are refused (409 reasons); a withdrawn request frees the key', async () => {
    expect(await outcome(create(payload({ plan_key: INCLUDED })))).toBe('ERROR:PLAN_KEY_TAKEN:plan_key_taken');
    const p = payload();
    const first = await create(p);
    expect(await outcome(create({ ...p, name: 'Other name' }))).toBe('ERROR:PLAN_KEY_TAKEN:plan_create_open');
    await h.changeRequests.withdraw(as(CAT, 'catalog_manager'), first.request.id, A6_CTX);
    expect(await outcome(create(p))).toBe('OK');
  });

  it('PC-I-5 a key taken between approval and apply fails the apply (PLAN_KEY_TAKEN), rolls back, and writes no second plan', async () => {
    const p = payload();
    const id = await approved(p);
    await pg.query(
      `INSERT INTO subscription."Plan" (id, key, name, sellable, sales_model, status, display_order, product_key) VALUES (gen_random_uuid(), $1, 'Raced', false, 'OPERATOR', 'ACTIVE', 980, 'sign')`,
      [p.plan_key],
    );
    expect(await outcome(applyAs(id))).toBe('FAILED:PLAN_KEY_TAKEN');
    expect(await request(id)).toEqual({ state: 'APPLY_FAILED', apply_attempts: 1 });
    expect((await plans(p.plan_key)).map((x) => x.sales_model)).toEqual(['OPERATOR']);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialCatalogApplication" WHERE change_request_id = $1`, [id])).rows[0].n).toBe(0);
  });

  it('PC-I-6 a fault after the catalog writes rolls back everything (no plan, no version); the retry applies', async () => {
    const p = payload();
    const id = await approved(p);
    faultAt = 'after_catalog_write';
    try {
      expect(await outcome(applyAs(id))).toBe('FAILED:UNEXPECTED');
    } finally {
      faultAt = null;
    }
    expect(await plans(p.plan_key)).toEqual([]);
    expect(await request(id)).toEqual({ state: 'APPLY_FAILED', apply_attempts: 1 });
    expect(await outcome(applyAs(id))).toBe('OK');
    expect(await request(id)).toEqual({ state: 'APPLIED', apply_attempts: 2 });
    expect(await plans(p.plan_key)).toHaveLength(1);
  });

  it('PC-I-7 the DB guard: a PLAN_CREATE cannot be APPLIED without its catalog application, and the compensating SQL refuses while one exists', async () => {
    const id = await approved(payload());
    const msg = async (sql: string): Promise<string> => {
      await pg.query('BEGIN');
      try {
        await pg.query(sql);
        return 'committed';
      } catch (e) {
        return (e as Error).message;
      } finally {
        await pg.query('ROLLBACK');
      }
    };
    expect(await msg(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = apply_attempts + 1 WHERE id = '${id}';
                      UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = '${id}'`)).toContain(
      'cannot be APPLIED without its CommercialCatalogApplication',
    );
    expect(await msg(readFileSync(COMPENSATION, 'utf8'))).toContain('CCP PLAN_CREATE compensation refused');
  });
});
