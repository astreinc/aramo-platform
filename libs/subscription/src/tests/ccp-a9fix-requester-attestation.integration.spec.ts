import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CommercialApplyRefusedError, assertChainStillSatisfiableAtApply, checkChainSatisfiable } from '../lib/commercial/commercial-approval-eligibility.js';
import { CommercialAuditRepository } from '../lib/commercial/commercial-audit.repository.js';
import {
  CommercialApprovalRefusedError,
  type CommercialActor,
  CommercialChangeRequestError,
  CommercialChangeRequestService,
  CommercialNotBootstrappedError,
} from '../lib/commercial/commercial-change-request.service.js';
import { CommercialOperatorRepository } from '../lib/commercial/commercial-operator.repository.js';
import { CommercialPolicyRepository } from '../lib/commercial/commercial-policy.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { CCP_BUNDLES, PLATFORM_TENANT, TENANT_1, addOperator, applyCcpA6Schema, attest, revokeAttestation } from './support/ccp-a3-database.js';

// CCP-A9-FIX (TD-A9-7) on real Postgres 17, the full migration chain. One human reference
// holding two platform accounts must never fill both the requester and an approval step of
// the same commercial change request (A0-C4; PBD §12; D9 one-account-per-human attestation).
// Test IDs are cited by doc/ccp/slices/CCP-A9-acceptance.md (§ A9-FIX).

const T0 = new Date('2026-10-25T00:00:00.000Z');
const OPEN_PAYLOAD = { plan_key: 'aramo-sign-included-v1', plan_version_id: '019a0000-0000-7000-8000-00000000a601', replaces_subscription_id: null };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A9-FIX requester D9 attestation + distinct human (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let svc: CommercialChangeRequestService;
  let now = T0;
  const ctx = { platform_tenant_id: PLATFORM_TENANT, correlation_id: 'ccp-a9fix-spec' };

  const as = (user_id: string, role: string): CommercialActor => ({ user_id, actor_kind: 'user', scopes: [...(CCP_BUNDLES[role] ?? [])] });
  let keyN = 0;
  const key = () => `a9fix-key-${String(++keyN).padStart(6, '0')}`;

  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof CommercialApprovalRefusedError) return e.refusal;
      if (e instanceof CommercialNotBootstrappedError) return 'CCP_NOT_BOOTSTRAPPED';
      if (e instanceof CommercialChangeRequestError) return e.code;
      throw e;
    }
    return 'OK';
  }
  const approvals = async (id: string): Promise<number> =>
    (await pg.query(`SELECT count(*)::int AS n FROM subscription."CommercialApproval" WHERE change_request_id = $1`, [id])).rows[0].n as number;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    prisma = new PrismaService(url);
    await prisma.$connect();
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    const operators = new CommercialOperatorRepository(prisma, audit, policies);
    svc = new CommercialChangeRequestService(prisma, audit, policies, operators, () => now);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  beforeEach(async () => {
    now = T0;
    await applyCcpA6Schema(pg);
    // Distinct, attested humans so every chain stays satisfiable without the dual account.
    await addOperator(pg, ['finance_admin']);
    await addOperator(pg, ['platform_owner']);
  }, 120_000);

  it('A9FIX-1 one human, two accounts: the requester account is unattested (its D9 attestation for H was revoked), the approver account is attested for H → the CREDIT is never approved by that human', async () => {
    const REQ = await addOperator(pg, ['commercial_ops'], { human: 'human:dual' });
    await revokeAttestation(pg, REQ);
    const APP = await addOperator(pg, ['finance_admin'], { human: 'human:dual' });

    const created = await outcome(
      (async () => {
        const r = (await svc.create(as(REQ, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' }, reason: 'goodwill credit', idempotency_key: key() }, ctx)).request;
        await svc.submit(as(REQ, 'commercial_ops'), r.id, ctx);
        const a = await svc.approve(as(APP, 'finance_admin'), r.id, { step_index: 0 }, ctx);
        expect(await approvals(r.id)).toBe(1);
        return a;
      })(),
    );
    expect(created).not.toBe('OK');
    expect(created).toBe('NOT_HUMAN');
  });

  it('A9FIX-2 a never-attested requester is refused NOT_HUMAN at create for every commercial action type tried (CREDIT, SUBSCRIPTION_OPEN, PLAN_VERSION_PUBLISH)', async () => {
    const OPS = await addOperator(pg, ['commercial_ops'], { attested: false });
    const CAT = await addOperator(pg, ['catalog_manager'], { attested: false });
    expect(await outcome(svc.create(as(OPS, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' }, reason: 'x', idempotency_key: key() }, ctx))).toBe('NOT_HUMAN');
    expect(await outcome(svc.create(as(OPS, 'commercial_ops'), { action_type: 'SUBSCRIPTION_OPEN', tenant_id: TENANT_1, product_key: 'sign', payload: OPEN_PAYLOAD, reason: 'x', idempotency_key: key() }, ctx))).toBe('NOT_HUMAN');
    expect(await outcome(svc.create(as(CAT, 'catalog_manager'), { action_type: 'PLAN_VERSION_PUBLISH', payload: { plan_version_id: '019a0000-0000-7000-8000-00000000b201' }, reason: 'x', idempotency_key: key() }, ctx))).toBe('NOT_HUMAN');
    // Nothing was written.
    expect((await pg.query(`SELECT count(*)::int AS n FROM subscription."CommercialChangeRequest"`)).rows[0].n).toBe(0);
    // Positive control: the same requester, once attested, creates.
    await attest(pg, OPS, 'human:ops-now-attested');
    expect(await outcome(svc.create(as(OPS, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' }, reason: 'x', idempotency_key: key() }, ctx))).toBe('OK');
  });

  it('A9FIX-3 distinct human by human reference: the requester was attested for H at create; H later moves to a second account → that account is refused SELF_APPROVAL (not compared by user_id only)', async () => {
    const REQ = await addOperator(pg, ['commercial_ops'], { human: 'human:moved' });
    const r = (await svc.create(as(REQ, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' }, reason: 'goodwill credit', idempotency_key: key() }, ctx)).request;
    await svc.submit(as(REQ, 'commercial_ops'), r.id, ctx);
    await revokeAttestation(pg, REQ);
    const APP = await addOperator(pg, ['finance_admin'], { human: 'human:moved' });
    expect(await outcome(svc.approve(as(APP, 'finance_admin'), r.id, { step_index: 0 }, ctx))).toBe('SELF_APPROVAL');
    expect(await approvals(r.id)).toBe(0);
    // Positive control: a distinct human approves the same request.
    const OTHER = await addOperator(pg, ['finance_admin'], { human: 'human:other' });
    expect(await outcome(svc.approve(as(OTHER, 'finance_admin'), r.id, { step_index: 0 }, ctx))).toBe('OK');
  });

  it('A9FIX-4 distinct human across approval steps: H signs step 0 from one account, then (attestation moved) step 1 from another → USER_ALREADY_APPROVED', async () => {
    const REQ = await addOperator(pg, ['commercial_ops']);
    const r = (await svc.create(as(REQ, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: TENANT_1, product_key: 'sign', payload: { amount_minor: 50_000, currency: 'USD' }, reason: 'goodwill credit', idempotency_key: key() }, ctx)).request;
    expect((r.required_chain as { steps: unknown[] }).steps.length).toBe(2);
    await svc.submit(as(REQ, 'commercial_ops'), r.id, ctx);
    const S0 = await addOperator(pg, ['finance_admin'], { human: 'human:two-steps' });
    await svc.approve(as(S0, 'finance_admin'), r.id, { step_index: 0 }, ctx);
    await revokeAttestation(pg, S0);
    const S1 = await addOperator(pg, ['platform_owner'], { human: 'human:two-steps' });
    expect(await outcome(svc.approve(as(S1, 'platform_owner'), r.id, { step_index: 1 }, ctx))).toBe('USER_ALREADY_APPROVED');
    expect(await approvals(r.id)).toBe(1);
  });
});

// Pure engine (no database): the apply-time re-check and the chain gate by human reference.
describe('CCP-A9-FIX pure engine: distinct human by human reference', () => {
  const H1 = 'a'.repeat(64);
  const H2 = 'b'.repeat(64);
  const chain = { rule: 'FINANCE_THEN_OWNER', basis: {}, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: [] }, { step_index: 1, role_key: 'platform_owner', scope_keys: [] }] } as never;
  const roster = [
    { user_id: 'u-fa', attested: true, human_ref_hash: H1, role_keys: ['finance_admin'], scopes: [] },
    { user_id: 'u-po', attested: true, human_ref_hash: H2, role_keys: ['platform_owner'], scopes: [] },
  ];
  it('A9FIX-U1 apply refuses APPROVER_NOT_DISTINCT when a signer is the requester\'s attested human', () => {
    const req = { id: 'r', state: 'APPROVED', requested_by: 'u-req', subject_user_id: null, required_chain: chain, approvals: [{ step_index: 0, approver_user_id: 'u-fa', approver_human_ref: H1 }, { step_index: 1, approver_user_id: 'u-po', approver_human_ref: H2 }] };
    expect(() => assertChainStillSatisfiableAtApply({ ...req, requester_human_refs: [H1] }, roster)).toThrow(CommercialApplyRefusedError);
    expect(() => assertChainStillSatisfiableAtApply({ ...req, requester_human_refs: ['c'.repeat(64)] }, roster)).not.toThrow();
  });
  it('A9FIX-U2 apply refuses APPROVER_NOT_DISTINCT when two signers share one human reference', () => {
    const req = { id: 'r', state: 'APPROVED', requested_by: 'u-req', subject_user_id: null, required_chain: chain, approvals: [{ step_index: 0, approver_user_id: 'u-fa', approver_human_ref: H1 }, { step_index: 1, approver_user_id: 'u-po', approver_human_ref: H1 }] };
    try {
      assertChainStillSatisfiableAtApply(req, roster);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as CommercialApplyRefusedError).reason).toBe('APPROVER_NOT_DISTINCT');
    }
  });
  it('A9FIX-U3 the chain gate excludes an account attested for an excluded human reference', () => {
    expect(checkChainSatisfiable((chain as { steps: never[] }).steps, roster, new Set(['u-req'])).satisfiable).toBe(true);
    expect(checkChainSatisfiable((chain as { steps: never[] }).steps, roster, new Set(['u-req']), new Set([H1])).satisfiable).toBe(false);
  });
});
