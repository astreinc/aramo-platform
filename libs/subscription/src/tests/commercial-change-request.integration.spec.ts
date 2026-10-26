import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommercialAuditRepository } from '../lib/commercial/commercial-audit.repository.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import {
  CommercialApprovalRefusedError,
  type CommercialActor,
  CommercialChangeRequestError,
  CommercialChangeRequestService,
  CommercialNotBootstrappedError,
} from '../lib/commercial/commercial-change-request.service.js';
import { commercialPolicyChecksum } from '../lib/commercial/commercial-policy.js';
import { CommercialPolicyRepository } from '../lib/commercial/commercial-policy.repository.js';
import { CommercialOperatorRepository } from '../lib/commercial/commercial-operator.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';
import {
  CCP_BUNDLES,
  PLATFORM_TENANT,
  POLICY_V1,
  TENANT_1,
  TENANT_2,
  activatePolicyV2,
  addOperator,
  applyCcpA3Schema,
  attest,
  grantRole,
  humanRef,
  revokeAttestation,
  revokeRole,
} from './support/ccp-a3-database.js';

// CCP-A3 (PBD §5.1 row A3, mandatory tests) on real Postgres 17: the identity RBAC chain,
// the subscription chain, A2 and A3 applied as whole files. Test IDs are cited by
// doc/ccp/slices/CCP-A3-acceptance.md.

const H = 3_600_000;
const T0 = new Date('2026-10-25T00:00:00.000Z');

// CCP-A6 — SUBSCRIPTION_OPEN now carries its full payload schema (validated at create).
const OPEN_PAYLOAD = { plan_key: 'aramo-sign-included-v1', plan_version_id: '019a0000-0000-7000-8000-00000000a601', replaces_subscription_id: null };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A3 change request + approval + eligibility (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let svc: CommercialChangeRequestService;
  let operators: CommercialOperatorRepository;
  let now = T0;
  const ctx = { platform_tenant_id: PLATFORM_TENANT, correlation_id: 'ccp-a3-spec' };

  // Operators, re-created per test.
  let OPS: string; // commercial_ops (requester)
  let CAT: string; // catalog_manager (requester)
  let FA: string;
  let FA2: string;
  let PO: string;

  const as = (user_id: string, role: string, extra: Partial<CommercialActor> = {}): CommercialActor => ({ user_id, actor_kind: 'user', scopes: [...(CCP_BUNDLES[role] ?? [])], ...extra });
  let keyN = 0;
  const key = () => `idem-key-${String(++keyN).padStart(6, '0')}`;

  async function credit(amount_minor: number, tenant = TENANT_1, k = key()) {
    return (await svc.create(as(OPS, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: tenant, product_key: 'sign', payload: { amount_minor, currency: 'USD' }, reason: 'goodwill credit', idempotency_key: k }, ctx)).request;
  }
  async function publish(k = key()) {
    return (await svc.create(as(CAT, 'catalog_manager'), { action_type: 'PLAN_VERSION_PUBLISH', payload: { plan_version_id: '019a0000-0000-7000-8000-00000000b201' }, reason: 'publish v2 of the plan', idempotency_key: k }, ctx)).request;
  }
  const submit = (id: string, user = OPS, role = 'commercial_ops') => svc.submit(as(user, role), id, ctx);
  const approve = (id: string, user: string, step_index: number, role = 'finance_admin') => svc.approve(as(user, role), id, { step_index }, ctx);

  async function refusalOf(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof CommercialApprovalRefusedError) return e.refusal;
      if (e instanceof CommercialNotBootstrappedError) return 'CCP_NOT_BOOTSTRAPPED';
      if (e instanceof CommercialChangeRequestError) return e.code;
      if (e instanceof CommercialApplyRefusedError) return `APPLY:${e.reason}`;
      throw e;
    }
    return 'OK';
  }
  async function raises(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error(`expected the statement to raise: ${sql}`);
  }
  const events = async (id: string): Promise<string[]> =>
    (await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.event_type as string);
  const state = async (id: string): Promise<string> => (await pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].state as string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    prisma = new PrismaService(url);
    await prisma.$connect();
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    operators = new CommercialOperatorRepository(prisma, audit, policies);
    svc = new CommercialChangeRequestService(prisma, audit, policies, operators, () => now);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  beforeEach(async () => {
    now = T0;
    await applyCcpA3Schema(pg);
    OPS = await addOperator(pg, ['commercial_ops']);
    CAT = await addOperator(pg, ['catalog_manager']);
    FA = await addOperator(pg, ['finance_admin']);
    FA2 = await addOperator(pg, ['finance_admin']);
    PO = await addOperator(pg, ['platform_owner']);
  }, 120_000);

  // ---- happy path + audit ------------------------------------------------------------

  it('A3-INT-1 escalated credit: DRAFT → PENDING_APPROVAL → finance → owner → APPROVED; every act is audited; nothing applies', async () => {
    const r = await credit(50_000);
    expect(r.state).toBe('DRAFT');
    expect(r.policy_version_id).toBe(POLICY_V1);
    expect((r.required_chain as { rule: string }).rule).toBe('FINANCE_THEN_OWNER');
    await submit(r.id);
    const a0 = await approve(r.id, FA, 0);
    expect(a0.request.state).toBe('PENDING_APPROVAL');
    const a1 = await approve(r.id, PO, 1, 'platform_owner');
    expect(a1.request.state).toBe('APPROVED');
    expect(await events(r.id)).toEqual([
      'COMMERCIAL_CHANGE_REQUEST_CREATED',
      'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPROVED',
    ]);
    const roles = (await pg.query(`SELECT actor_role_keys FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_APPROVAL_RECORDED' ORDER BY created_at, id`, [r.id])).rows.map((x) => x.actor_role_keys);
    expect(roles).toEqual([['finance_admin'], ['platform_owner']]);
    // A3 applies nothing: no subscription or entitlement row exists.
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."TenantSubscription"`)).rows[0].n).toBe(0);
    expect(r.applied_at).toBeNull();
  });

  it('A3-INT-2 below-threshold credit: one finance approval → APPROVED', async () => {
    const r = await credit(49_999);
    await submit(r.id);
    expect((await approve(r.id, FA, 0)).request.state).toBe('APPROVED');
  });

  // CCP-A9 (TD-A3-5) re-pointed the governance row: POLICY_ACTIVATE is requested by a
  // finance_admin (a platform_owner is now REQUESTER_ROLE_MISSING, no longer
  // REQUESTER_AUTHORITY_UNDEFINED). The A9 spec covers the governance requesters in full.
  it('A3-INT-3 requester authority: missing request scope → REQUESTER_SCOPE_MISSING; a governance action without its requester role → REQUESTER_ROLE_MISSING (A9); non-NORMAL kind refused; 0 rows written', async () => {
    expect(await refusalOf(svc.create(as(FA, 'finance_admin'), { action_type: 'SUBSCRIPTION_OPEN', tenant_id: TENANT_1, product_key: 'sign', payload: OPEN_PAYLOAD, reason: 'x', idempotency_key: key() }, ctx))).toBe('REQUESTER_SCOPE_MISSING');
    expect(await refusalOf(svc.create(as(PO, 'platform_owner'), { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: POLICY_V1 }, reason: 'x', idempotency_key: key() }, ctx))).toBe('REQUESTER_ROLE_MISSING');
    expect(await refusalOf(svc.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_OPEN', kind: 'EXCEPTION', tenant_id: TENANT_1, product_key: 'sign', payload: OPEN_PAYLOAD, reason: 'x', idempotency_key: key() }, ctx))).toBe('KIND_NOT_SUPPORTED');
    expect(await refusalOf(svc.create(as(OPS, 'commercial_ops', { actor_kind: 'service_account' }), { action_type: 'SUBSCRIPTION_OPEN', tenant_id: TENANT_1, product_key: 'sign', payload: OPEN_PAYLOAD, reason: 'x', idempotency_key: key() }, ctx))).toBe('NOT_HUMAN');
    expect(await refusalOf(svc.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_OPEN', tenant_id: '0190dddd-0000-7000-8000-0000000000ff', product_key: 'sign', payload: OPEN_PAYLOAD, reason: 'x', idempotency_key: key() }, ctx))).toBe('TENANT_NOT_FOUND');
    expect(await refusalOf(svc.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_OPEN', tenant_id: TENANT_1, product_key: 'ats', payload: OPEN_PAYLOAD, reason: 'x', idempotency_key: key() }, ctx))).toBe('INVALID_INPUT');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest"`)).rows[0].n).toBe(0);
  });

  // ---- idempotency + Q14 -------------------------------------------------------------

  it('A3-IDEM-1 idempotency-key replay returns the same request (replayed), writes no second row or event; a different body under the key → IDEMPOTENCY_KEY_CONFLICT', async () => {
    const k = key();
    const first = await svc.create(as(OPS, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' }, reason: 'r', idempotency_key: k }, ctx);
    const again = await svc.create(as(OPS, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { currency: 'USD', amount_minor: 100 }, reason: 'r', idempotency_key: k }, ctx);
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, request: { id: first.request.id } });
    expect(await refusalOf(svc.create(as(OPS, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { amount_minor: 101, currency: 'USD' }, reason: 'r', idempotency_key: k }, ctx))).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest"`)).rows[0].n).toBe(1);
    expect(await events(first.request.id)).toEqual(['COMMERCIAL_CHANGE_REQUEST_CREATED']);
  });

  it('A3-IDEM-2 concurrent creates with one key → exactly one row; both callers get the same id', async () => {
    const k = key();
    const body = { action_type: 'PLAN_VERSION_PUBLISH' as const, payload: { plan_version_id: '019a0000-0000-7000-8000-00000000b201' }, reason: 'r', idempotency_key: k };
    const res = await Promise.all([0, 1, 2, 3].map(() => svc.create(as(CAT, 'catalog_manager'), body, ctx)));
    expect(new Set(res.map((r) => r.request.id)).size).toBe(1);
    expect(res.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest"`)).rows[0].n).toBe(1);
  });

  it('A3-Q14-1 one open request per tenant × product: a second is refused; another tenant is not; withdrawal frees the slot', async () => {
    const r = await credit(100);
    expect(await refusalOf(credit(200))).toBe('OPEN_REQUEST_EXISTS');
    await credit(300, TENANT_2);
    await svc.withdraw(as(OPS, 'commercial_ops'), r.id, ctx);
    expect((await credit(400)).state).toBe('DRAFT');
  });

  it('A3-Q14-2 concurrent creates for one tenant × product → exactly one; the DB index backstops the service', async () => {
    const res = await Promise.all([1, 2, 3, 4].map((n) => refusalOf(credit(n))));
    expect(res.filter((x) => x === 'OK')).toHaveLength(1);
    expect(res.filter((x) => x === 'OPEN_REQUEST_EXISTS')).toHaveLength(3);
    const msg = await raises(
      `INSERT INTO subscription."CommercialChangeRequest" (id, action_type, kind, tenant_id, product_key, payload, payload_checksum, required_chain, policy_version_id, policy_checksum, requested_by, reason, idempotency_key, created_at, updated_at)
       SELECT gen_random_uuid(), action_type, kind, tenant_id, product_key, payload, payload_checksum, required_chain, policy_version_id, policy_checksum, requested_by, reason, 'raw-insert-key-1', now(), now() FROM subscription."CommercialChangeRequest" LIMIT 1`,
    );
    expect(msg).toContain('CommercialChangeRequest_one_open_per_tenant_product_key');
  });

  it('A3-Q14-3 an expired PENDING request frees its slot lazily (transitions to EXPIRED, audited) when the next request is created', async () => {
    const r = await credit(100);
    await submit(r.id);
    now = new Date(T0.getTime() + 72 * H);
    const next = await credit(200);
    expect(next.state).toBe('DRAFT');
    expect(await state(r.id)).toBe('EXPIRED');
    expect(await events(r.id)).toContain('COMMERCIAL_CHANGE_REQUEST_EXPIRED');
  });

  // ---- 72 h expiry (service, injected clock) -----------------------------------------

  for (const [id, offset, expected] of [
    ['A3-EXP-INT-1 approve at exactly 72 h → EXPIRED (request transitions to EXPIRED)', 72 * H, 'EXPIRED'],
    ['A3-EXP-INT-2 approve at 72 h − 1 ms → recorded', 72 * H - 1, 'OK'],
    ['A3-EXP-INT-3 approve at 72 h + 1 ms → EXPIRED', 72 * H + 1, 'EXPIRED'],
  ] as const) {
    it(id, async () => {
      const r = await publish();
      await submit(r.id, CAT, 'catalog_manager');
      const row = (await pg.query(`SELECT submitted_at, expires_at FROM subscription."CommercialChangeRequest" WHERE id = $1`, [r.id])).rows[0];
      expect((row.expires_at as Date).getTime() - (row.submitted_at as Date).getTime()).toBe(72 * H);
      now = new Date(T0.getTime() + offset);
      expect(await refusalOf(approve(r.id, FA, 0))).toBe(expected);
      expect(await state(r.id)).toBe(expected === 'OK' ? 'PENDING_APPROVAL' : 'EXPIRED');
      if (expected === 'EXPIRED') expect(await events(r.id)).toEqual(['COMMERCIAL_CHANGE_REQUEST_CREATED', 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED', 'COMMERCIAL_CHANGE_REQUEST_EXPIRED', 'COMMERCIAL_APPROVAL_REFUSED']);
    });
  }

  // ---- self-approval, refusals audited ----------------------------------------------

  it('A3-SELF-1 the requester holding finance_admin cannot approve their own request (SELF_APPROVAL, application rule, D8); the refusal is audited and writes no approval', async () => {
    const MAKER = await addOperator(pg, ['commercial_ops', 'finance_admin']);
    const r = (await svc.create(as(MAKER, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { amount_minor: 1, currency: 'USD' }, reason: 'r', idempotency_key: key() }, ctx)).request;
    await svc.submit(as(MAKER, 'commercial_ops'), r.id, ctx);
    expect(await refusalOf(approve(r.id, MAKER, 0))).toBe('SELF_APPROVAL');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialApproval"`)).rows[0].n).toBe(0);
    const refused = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_APPROVAL_REFUSED'`, [r.id])).rows;
    expect(refused.map((x) => x.payload.refusal)).toEqual(['SELF_APPROVAL']);
    // There is no DB rule against it: a raw approval row by the requester is admitted by the
    // DB (D8 — requester ≠ approver is not a DB CHECK); the service is the authority.
    const att = (await pg.query(`SELECT id FROM subscription."CommercialOperatorAttestation" WHERE user_id = $1`, [MAKER])).rows[0].id;
    await pg.query(`INSERT INTO subscription."CommercialApproval" (id, change_request_id, step_index, approver_user_id, step_role_key, step_scope_keys, approver_role_keys, attestation_id, created_at) VALUES (gen_random_uuid(), $1, 0, $2, 'finance_admin', ARRAY['platform:billing:approve'], ARRAY['finance_admin'], $3, now())`, [r.id, MAKER, att]);
  });

  it('A3-REJ-1 rejection: an eligible finance checker rejects (REJECTED, audited); the requester cannot (SELF_APPROVAL); a non-requester cannot withdraw (NOT_REQUESTER)', async () => {
    const r = await credit(1);
    await submit(r.id);
    expect(await refusalOf(svc.reject(as(OPS, 'commercial_ops'), r.id, { reason: 'no' }, ctx))).toBe('SELF_APPROVAL');
    expect(await refusalOf(svc.withdraw(as(FA, 'finance_admin'), r.id, ctx))).toBe('NOT_REQUESTER');
    const out = await svc.reject(as(FA, 'finance_admin'), r.id, { reason: 'not justified' }, ctx);
    expect(out).toMatchObject({ state: 'REJECTED', rejected_by: FA, rejection_reason: 'not justified' });
    expect(await refusalOf(approve(r.id, FA2, 0))).toBe('NOT_PENDING');
    expect(await events(r.id)).toEqual(['COMMERCIAL_CHANGE_REQUEST_CREATED', 'COMMERCIAL_CHANGE_REQUEST_SUBMITTED', 'COMMERCIAL_REJECTION_REFUSED', 'COMMERCIAL_CHANGE_REQUEST_REJECTED', 'COMMERCIAL_APPROVAL_REFUSED']);
  });

  // ---- NC-1 --------------------------------------------------------------------------

  it('A3-NC1-1 concurrent approvals of the same step serialize: exactly one succeeds, the rest are refused, no double-advance (two-step chain)', async () => {
    const extra = [await addOperator(pg, ['finance_admin']), await addOperator(pg, ['finance_admin']), await addOperator(pg, ['finance_admin'])];
    const r = await publish();
    await submit(r.id, CAT, 'catalog_manager');
    const out = await Promise.all([FA, FA2, ...extra].map((u) => refusalOf(approve(r.id, u, 0))));
    expect(out.filter((x) => x === 'OK')).toHaveLength(1);
    expect(out.filter((x) => x === 'OUT_OF_ORDER')).toHaveLength(4);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialApproval" WHERE change_request_id = $1`, [r.id])).rows[0].n).toBe(1);
    expect(await state(r.id)).toBe('PENDING_APPROVAL');
  });

  it('A3-NC1-2 concurrent approvals of a one-step chain: exactly one approves, the rest get NOT_PENDING; one approval row; APPROVED once', async () => {
    const r = await credit(1);
    await submit(r.id);
    const extra = [await addOperator(pg, ['finance_admin']), await addOperator(pg, ['finance_admin'])];
    const out = await Promise.all([FA, FA2, ...extra].map((u) => refusalOf(approve(r.id, u, 0))));
    expect(out.filter((x) => x === 'OK')).toHaveLength(1);
    expect(out.filter((x) => x === 'NOT_PENDING')).toHaveLength(3);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialApproval" WHERE change_request_id = $1`, [r.id])).rows[0].n).toBe(1);
    expect((await events(r.id)).filter((e) => e === 'COMMERCIAL_CHANGE_REQUEST_APPROVED')).toHaveLength(1);
  });

  // ---- NC-2 + D9 ---------------------------------------------------------------------

  it('A3-NC2-1 one user holding finance_admin and platform_owner fills at most one step (USER_ALREADY_APPROVED); the owner step needs another human', async () => {
    const BOTH = await addOperator(pg, ['finance_admin', 'platform_owner']);
    const r = await publish();
    await submit(r.id, CAT, 'catalog_manager');
    await approve(r.id, BOTH, 0);
    expect(await refusalOf(approve(r.id, BOTH, 1, 'platform_owner'))).toBe('USER_ALREADY_APPROVED');
    expect((await approve(r.id, PO, 1, 'platform_owner')).request.state).toBe('APPROVED');
  });

  it('A3-NC2-2 a roster whose only owner is the finance approver cannot complete finance → owner: 409 CCP_NOT_BOOTSTRAPPED (chain-satisfiability, not a user count)', async () => {
    // CCP-A9: BOTH is added first — the last-effective-platform_owner trigger refuses removing the only owner.
    const BOTH = await addOperator(pg, ['finance_admin', 'platform_owner']);
    await revokeRole(pg, PO, 'platform_owner');
    const r = await publish();
    await submit(r.id, CAT, 'catalog_manager');
    // Five platform users exist; the chain still needs a distinct owner after BOTH takes finance.
    expect(await refusalOf(approve(r.id, FA, 0))).toBe('OK');
    // With FA on step 0, BOTH can take the owner step — satisfiable.
    expect((await approve(r.id, BOTH, 1, 'platform_owner')).request.state).toBe('APPROVED');
    const r2 = await publish();
    await submit(r2.id, CAT, 'catalog_manager');
    await revokeRole(pg, FA, 'finance_admin');
    await revokeRole(pg, FA2, 'finance_admin');
    // Only BOTH remains for both steps → not bootstrapped for this chain.
    expect(await refusalOf(approve(r2.id, BOTH, 0))).toBe('CCP_NOT_BOOTSTRAPPED');
    const refused = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_APPROVAL_REFUSED'`, [r2.id])).rows;
    expect(refused[0].payload).toMatchObject({ refusal: 'CCP_NOT_BOOTSTRAPPED', unfillable_steps: [1] });
    // A finance-only chain is not blocked by it (other satisfiable action types proceed).
    const c = await credit(1);
    await submit(c.id);
    expect((await approve(c.id, BOTH, 0)).request.state).toBe('APPROVED');
  });

  it('A3-NC2-3 D9: an approver without an active one-account-per-human attestation is NOT_HUMAN; a second account for the same human cannot be attested', async () => {
    const UNATT = await addOperator(pg, ['finance_admin'], { attested: false });
    const r = await credit(1);
    await submit(r.id);
    expect(await refusalOf(approve(r.id, UNATT, 0))).toBe('NOT_HUMAN');
    await revokeAttestation(pg, FA2);
    expect(await refusalOf(approve(r.id, FA2, 0))).toBe('NOT_HUMAN');
    const msg = await raises(`INSERT INTO subscription."CommercialOperatorAttestation" (id, user_id, human_ref_hash, statement_version, method, attested_by, attested_at) VALUES (gen_random_uuid(), $1, $2, 'D9-v1', 'BOOTSTRAP', $1, now())`, [UNATT, humanRef(`human:${FA}`)]);
    expect(msg).toContain('CommercialOperatorAttestation_active_human_key');
    // Only unattested finance holders remain → the gate refuses before eligibility.
    await revokeAttestation(pg, FA);
    expect(await refusalOf(approve(r.id, UNATT, 0))).toBe('CCP_NOT_BOOTSTRAPPED');
  });

  // ---- NC-3 / NC-4 -------------------------------------------------------------------

  it('A3-NC4-1 a role revoked between request and approval is refused (eligibility read live in the transaction, never from the snapshot)', async () => {
    const r = await credit(1);
    await submit(r.id);
    await revokeRole(pg, FA, 'finance_admin');
    expect(await refusalOf(approve(r.id, FA, 0))).toBe('STEP_SCOPE_MISSING');
    expect((await approve(r.id, FA2, 0)).request.state).toBe('APPROVED');
  });

  it('A3-NC3-1 a stale chain is refused at approve: the only owner is revoked after step 0 → 409 CCP_NOT_BOOTSTRAPPED; nothing advances', async () => {
    const r = await publish();
    await submit(r.id, CAT, 'catalog_manager');
    await approve(r.id, FA, 0);
    // CCP-A9: the requester CAT also holds platform_owner (excluded from every step as the
    // requester), so PO's revocation does not hit the last-owner trigger.
    await grantRole(pg, CAT, 'platform_owner');
    await revokeRole(pg, PO, 'platform_owner');
    expect(await refusalOf(approve(r.id, PO, 1, 'platform_owner'))).toBe('CCP_NOT_BOOTSTRAPPED');
    expect(await state(r.id)).toBe('PENDING_APPROVAL');
  });

  it('A3-NC3-2 a stale chain is refused at apply (apply-time check) and an expired request never applies', async () => {
    const r = await publish();
    await submit(r.id, CAT, 'catalog_manager');
    await approve(r.id, FA, 0);
    await approve(r.id, PO, 1, 'platform_owner');
    expect(await refusalOf(svc.assertApplyEligible(r.id, PLATFORM_TENANT))).toBe('OK');
    await revokeRole(pg, FA, 'finance_admin');
    expect(await refusalOf(svc.assertApplyEligible(r.id, PLATFORM_TENANT))).toBe('APPLY:APPROVER_NO_LONGER_ELIGIBLE');
    const e = await publish();
    await submit(e.id, CAT, 'catalog_manager');
    now = new Date(T0.getTime() + 72 * H);
    expect(await svc.expireDue(ctx)).toBe(1);
    expect(await refusalOf(svc.assertApplyEligible(e.id, PLATFORM_TENANT))).toBe('APPLY:NOT_APPROVED');
  });

  // ---- NC-5 (ratified 2026-10-25) -----------------------------------------------------

  it('A3-NC5-a role revocation between approval and apply: the apply-time check refuses (fail closed)', async () => {
    const r = await credit(50_000);
    await submit(r.id);
    await approve(r.id, FA, 0);
    await approve(r.id, PO, 1, 'platform_owner');
    await grantRole(pg, OPS, 'platform_owner'); // CCP-A9: keeps an effective owner (last-owner trigger)
    await revokeRole(pg, PO, 'platform_owner');
    expect(await refusalOf(svc.assertApplyEligible(r.id, PLATFORM_TENANT))).toBe('APPLY:APPROVER_NO_LONGER_ELIGIBLE');
    await revokeAttestation(pg, FA);
    expect(await refusalOf(svc.assertApplyEligible(r.id, PLATFORM_TENANT))).toBe('APPLY:APPROVER_NO_LONGER_ELIGIBLE');
  });

  it('A3-NC5-b a policy-version change after creation: the request keeps v1 and its chain; expiry and apply revalidation use the snapshot, not v2', async () => {
    const r = await credit(50_000); // v1: $500.00 ≥ threshold → finance → owner
    const v1 = seededPolicyV1().content as Record<string, unknown>;
    const v2content = { ...v1, credit_escalation_threshold_minor: 100_000, approval_expiry_hours: 24 };
    const v2 = await activatePolicyV2(pg, v2content, commercialPolicyChecksum(v2content));
    await submit(r.id);
    const row = (await pg.query(`SELECT policy_version_id, required_chain, submitted_at, expires_at FROM subscription."CommercialChangeRequest" WHERE id = $1`, [r.id])).rows[0];
    expect(row.policy_version_id).toBe(POLICY_V1);
    expect(row.required_chain.rule).toBe('FINANCE_THEN_OWNER');
    expect((row.expires_at as Date).getTime() - (row.submitted_at as Date).getTime()).toBe(72 * H); // v1's 72 h, not v2's 24 h
    // Under v2 the same credit would need finance only; the snapshot still needs the owner.
    expect((await approve(r.id, FA, 0)).request.state).toBe('PENDING_APPROVAL');
    expect(await refusalOf(svc.assertApplyEligible(r.id, PLATFORM_TENANT))).toBe('APPLY:NOT_APPROVED');
    await approve(r.id, PO, 1, 'platform_owner');
    expect(await refusalOf(svc.assertApplyEligible(r.id, PLATFORM_TENANT))).toBe('OK');
    // A request created after v2 resolves under v2 (finance only).
    const later = await credit(50_000, TENANT_2);
    expect(later.policy_version_id).toBe(v2);
    expect((later.required_chain as { rule: string }).rule).toBe('FINANCE_ONLY');
  });

  it('A3-NC5-c after an apply refusal the original CommercialApproval rows (and the request row) are byte-identical: signatures preserved', async () => {
    const r = await credit(50_000);
    await submit(r.id);
    await approve(r.id, FA, 0);
    await approve(r.id, PO, 1, 'platform_owner');
    const snap = async () => ({
      approvals: (await pg.query(`SELECT row_to_json(a)::text j FROM subscription."CommercialApproval" a WHERE change_request_id = $1 ORDER BY step_index`, [r.id])).rows.map((x) => x.j),
      request: (await pg.query(`SELECT row_to_json(c)::text j FROM subscription."CommercialChangeRequest" c WHERE id = $1`, [r.id])).rows[0].j,
      audit: (await pg.query(`SELECT count(*)::int n FROM subscription."CommercialAuditEvent"`)).rows[0].n,
    });
    const before = await snap();
    expect(before.approvals).toHaveLength(2);
    await revokeRole(pg, FA, 'finance_admin');
    expect(await refusalOf(svc.assertApplyEligible(r.id, PLATFORM_TENANT))).toBe('APPLY:APPROVER_NO_LONGER_ELIGIBLE');
    expect(await snap()).toEqual(before);
  });

  // ---- integrity + triggers ----------------------------------------------------------

  it('A3-INTEG-1 a tampered payload (trigger bypassed by a superuser) is refused at approve: checksum mismatch', async () => {
    const r = await credit(1);
    await submit(r.id);
    await pg.query(`ALTER TABLE subscription."CommercialChangeRequest" DISABLE TRIGGER commercial_change_request_guard_update`);
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET payload = '{"amount_minor": 999999, "currency": "USD"}'::jsonb WHERE id = $1`, [r.id]);
    await pg.query(`ALTER TABLE subscription."CommercialChangeRequest" ENABLE TRIGGER commercial_change_request_guard_update`);
    expect(await refusalOf(approve(r.id, FA, 0))).toBe('INTEGRITY');
  });

  it('A3-TRG-1 CommercialChangeRequest: payload, checksum, chain, policy snapshot and requester are immutable; DELETE rejected', async () => {
    const r = await credit(1);
    for (const set of [`payload = '{}'::jsonb`, `payload_checksum = repeat('0', 64)`, `required_chain = '{"steps":[]}'::jsonb`, `policy_checksum = repeat('1', 64)`, `requested_by = gen_random_uuid()`, `reason = 'x'`, `idempotency_key = 'another-key-1'`, `tenant_id = '${TENANT_2}'`]) {
      const msg = await raises(`UPDATE subscription."CommercialChangeRequest" SET ${set}, state = 'PENDING_APPROVAL', submitted_at = now(), expires_at = now() WHERE id = $1`, [r.id]);
      expect(msg, set).toMatch(/immutable|state transition/);
    }
    expect(await raises(`DELETE FROM subscription."CommercialChangeRequest" WHERE id = $1`, [r.id])).toBe('CommercialChangeRequest is append-only (DELETE rejected)');
  });

  it('A3-TRG-2 state moves only along the A3 table; APPLYING / APPLIED / APPLY_FAILED unreachable; APPROVED needs every step; terminal rows frozen; created in DRAFT only', async () => {
    const r = await publish();
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPROVED', approved_at = now() WHERE id = $1`, [r.id])).toBe('CommercialChangeRequest state DRAFT -> APPROVED is not allowed');
    await submit(r.id, CAT, 'catalog_manager');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPROVED' WHERE id = $1`, [r.id])).toBe('CommercialChangeRequest cannot be APPROVED with 0 of 2 approvals');
    await approve(r.id, FA, 0);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPROVED' WHERE id = $1`, [r.id])).toBe('CommercialChangeRequest cannot be APPROVED with 1 of 2 approvals');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET expires_at = now() WHERE id = $1`, [r.id])).toBe('CommercialChangeRequest submitted_at and expires_at are immutable once set');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET rejection_reason = 'x' WHERE id = $1`, [r.id])).toBe('CommercialChangeRequest columns change only with a state transition');
    await approve(r.id, PO, 1, 'platform_owner');
    for (const to of ['APPLYING', 'APPLIED', 'APPLY_FAILED']) {
      expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = '${to}' WHERE id = $1`, [r.id])).toBe(`CommercialChangeRequest state APPROVED -> ${to} is not allowed`);
    }
    const w = await credit(1);
    await svc.withdraw(as(OPS, 'commercial_ops'), w.id, ctx);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'PENDING_APPROVAL' WHERE id = $1`, [w.id])).toBe('CommercialChangeRequest in terminal state WITHDRAWN is immutable');
    const msg = await raises(
      `INSERT INTO subscription."CommercialChangeRequest" (id, action_type, kind, state, payload, payload_checksum, required_chain, policy_version_id, policy_checksum, requested_by, reason, idempotency_key, created_at, submitted_at, expires_at, updated_at)
       SELECT gen_random_uuid(), action_type, kind, 'PENDING_APPROVAL', payload, payload_checksum, required_chain, policy_version_id, policy_checksum, requested_by, reason, 'raw-insert-key-2', now(), now(), now(), now() FROM subscription."CommercialChangeRequest" WHERE id = $1`,
      [r.id],
    );
    expect(msg).toBe('CommercialChangeRequest is created in DRAFT (got PENDING_APPROVAL)');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET action_type = 'NOPE' WHERE id = $1`, [w.id])).toMatch(/terminal state|action_type_check|immutable/);
  });

  it('A3-TRG-3 CommercialApproval is append-only; inserts are in order, only while PENDING; D8 unique indexes exist', async () => {
    const r = await publish();
    await submit(r.id, CAT, 'catalog_manager');
    const a = await approve(r.id, FA, 0);
    expect(await raises(`UPDATE subscription."CommercialApproval" SET comment = 'x' WHERE id = $1`, [a.approval.id])).toBe('CommercialApproval is append-only evidence (UPDATE rejected)');
    expect(await raises(`DELETE FROM subscription."CommercialApproval" WHERE id = $1`, [a.approval.id])).toBe('CommercialApproval is append-only evidence (DELETE rejected)');
    const att = (await pg.query(`SELECT id FROM subscription."CommercialOperatorAttestation" WHERE user_id = $1`, [FA])).rows[0].id;
    const ins = (step: number, user: string) =>
      raises(
        `INSERT INTO subscription."CommercialApproval" (id, change_request_id, step_index, approver_user_id, step_role_key, step_scope_keys, approver_role_keys, attestation_id, created_at) VALUES (gen_random_uuid(), $1, $2, $3, 'platform_owner', ARRAY['x'], ARRAY['x'], $4, now())`,
        [r.id, step, user, att],
      );
    expect(await ins(0, PO)).toBe('CommercialApproval step 0 is out of order (next step 1, 2 steps)');
    expect(await ins(2, PO)).toBe('CommercialApproval step 2 is out of order (next step 1, 2 steps)');
    expect(await ins(1, FA)).toContain('CommercialApproval_change_request_id_approver_user_id_key');
    const idx = (await pg.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'CommercialApproval' AND indexdef LIKE 'CREATE UNIQUE%' ORDER BY indexname`)).rows.map((x) => x.indexdef);
    expect(idx.some((d: string) => d.includes('(change_request_id, approver_user_id)'))).toBe(true);
    expect(idx.some((d: string) => d.includes('(change_request_id, step_index)'))).toBe(true);
    await svc.reject(as(PO, 'platform_owner'), r.id, { reason: 'no' }, ctx);
    const pending = await ins(1, PO);
    expect(pending).toBe('CommercialApproval requires a PENDING_APPROVAL request (state REJECTED)');
  });

  it('A3-TRG-4 CommercialOperatorAttestation: DELETE rejected; one revocation only; distinct attester for PLATFORM_OWNER; one active per account', async () => {
    const id = (await pg.query(`SELECT id FROM subscription."CommercialOperatorAttestation" WHERE user_id = $1`, [FA])).rows[0].id;
    expect(await raises(`DELETE FROM subscription."CommercialOperatorAttestation" WHERE id = $1`, [id])).toBe('CommercialOperatorAttestation is append-only (DELETE rejected)');
    expect(await raises(`UPDATE subscription."CommercialOperatorAttestation" SET human_ref_hash = repeat('a', 64) WHERE id = $1`, [id])).toBe('CommercialOperatorAttestation allows only a single revocation (UPDATE rejected)');
    expect(await raises(`INSERT INTO subscription."CommercialOperatorAttestation" (id, user_id, human_ref_hash, statement_version, method, attested_by, attested_at) VALUES (gen_random_uuid(), $1, repeat('b', 64), 'D9-v1', 'BOOTSTRAP', $1, now())`, [FA])).toContain('CommercialOperatorAttestation_active_user_key');
    expect(await raises(`INSERT INTO subscription."CommercialOperatorAttestation" (id, user_id, human_ref_hash, statement_version, method, attested_by, attested_at) VALUES (gen_random_uuid(), $1, repeat('c', 64), 'D9-v1', 'PLATFORM_OWNER', $1, now())`, [OPS])).toContain('distinct_attester_check');
    await revokeAttestation(pg, FA);
    expect(await raises(`UPDATE subscription."CommercialOperatorAttestation" SET revoke_reason = 'again' WHERE id = $1`, [id])).toBe('CommercialOperatorAttestation allows only a single revocation (UPDATE rejected)');
    await attest(pg, FA, `human:${FA}`); // a fresh attestation after revocation is allowed
  });

  it('A3-ATT-1 the repository records an attestation with its audit event; the roster read reflects it live', async () => {
    const NEW = await addOperator(pg, ['finance_admin'], { attested: false });
    expect((await operators.readOperator(prisma, PLATFORM_TENANT, NEW)).attested).toBe(false);
    await operators.recordAttestation({ user_id: NEW, human_ref_hash: humanRef('new-human'), method: 'PLATFORM_OWNER', attested_by: PO, attested_at: T0, correlation_id: 'c' });
    const live = await operators.readOperator(prisma, PLATFORM_TENANT, NEW);
    expect(live).toMatchObject({ attested: true, role_keys: ['finance_admin'] });
    expect(live.scopes).toContain('platform:billing:approve');
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialAuditEvent" WHERE event_type = 'COMMERCIAL_OPERATOR_ATTESTATION_RECORDED'`)).rows[0].n).toBe(1);
    await operators.revokeAttestation({ user_id: NEW, revoked_by: PO, reason: 'left', at: T0, correlation_id: 'c' });
    expect((await operators.readOperator(prisma, PLATFORM_TENANT, NEW)).attested).toBe(false);
  });

  it('A3-READ-1 get: per-step verdict for the caller; list filters by state, requester and eligible-for-me', async () => {
    const r = await publish();
    await submit(r.id, CAT, 'catalog_manager');
    const forFa = await svc.get(as(FA, 'finance_admin'), r.id, ctx);
    expect(forFa.steps.map((s) => [s.status, s.caller?.eligible, s.caller?.refusal])).toEqual([
      ['NEXT', true, null],
      ['WAITING', false, 'OUT_OF_ORDER'],
    ]);
    expect(forFa.chain_satisfiable).toBe(true);
    const forPo = await svc.get(as(PO, 'platform_owner'), r.id, ctx);
    expect(forPo.steps.map((s) => s.caller?.refusal)).toEqual(['OUT_OF_ORDER', 'OUT_OF_ORDER']);
    await approve(r.id, FA, 0);
    const forPo2 = await svc.get(as(PO, 'platform_owner'), r.id, ctx);
    expect(forPo2.steps.map((s) => [s.status, s.caller?.eligible ?? null])).toEqual([
      ['APPROVED', null],
      ['NEXT', true],
    ]);
    const c = await credit(1);
    expect((await svc.list(as(FA, 'finance_admin'), { state: 'DRAFT' }, ctx)).requests.map((x) => x.id)).toEqual([c.id]);
    expect((await svc.list(as(FA, 'finance_admin'), { requested_by: CAT }, ctx)).requests.map((x) => x.id)).toEqual([r.id]);
    expect((await svc.list(as(PO, 'platform_owner'), { eligible_for_me: true }, ctx)).requests.map((x) => x.id)).toEqual([r.id]);
    expect((await svc.list(as(FA2, 'finance_admin'), { eligible_for_me: true }, ctx)).requests).toEqual([]);
    const page1 = await svc.list(as(FA, 'finance_admin'), { limit: 1 }, ctx);
    const page2 = await svc.list(as(FA, 'finance_admin'), { limit: 1, cursor: page1.next_cursor as string }, ctx);
    expect([...page1.requests, ...page2.requests].map((x) => x.id).sort()).toEqual([r.id, c.id].sort());
    expect(page2.next_cursor).toBeNull();
  });
});
