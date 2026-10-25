import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
import { CommercialPolicyRepository } from '../lib/commercial/commercial-policy.repository.js';
import { CommercialOperatorRepository } from '../lib/commercial/commercial-operator.repository.js';
import {
  PLATFORM_OWNER_BOOTSTRAP_EVENT,
  PlatformOwnerBootstrapRefusedError,
  runPlatformOwnerBootstrap,
} from '../lib/commercial/commercial-platform-owner-bootstrap.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { CCP_BUNDLES, PLATFORM_TENANT, POLICY_V1, addOperator, grantRole, humanRef, revokeRole } from './support/ccp-a3-database.js';
import {
  BOOTSTRAP_OPERATOR_ID,
  SEED_PROD_SUPER_ADMIN_ASSERTION,
  addBootstrapOperator,
  applyCcpA9Schema,
  count,
  footprint,
  seedProdAssertionForFixture,
} from './support/ccp-a9-database.js';

// CCP-A9 (PBD §5.1 row A9, mandatory tests) on real Postgres 17: the identity chain (with
// the A9 last-effective-platform_owner trigger), the subscription chain, A2, A3 and the A9
// subscription migration. Test IDs are cited by doc/ccp/slices/CCP-A9-acceptance.md.

const REPO_ROOT = resolve(__dirname, '../../../..');
const HUMAN_PURUSH = humanRef('human:purush');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A9 bootstrap + governed role change + last-owner invariant (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let svc: CommercialChangeRequestService;
  const ctx = { platform_tenant_id: PLATFORM_TENANT, correlation_id: 'ccp-a9-spec' };
  let keyN = 0;
  const key = () => `a9-key-${String(++keyN).padStart(6, '0')}`;
  const as = (user_id: string, roles: readonly string[], extra: Partial<CommercialActor> = {}): CommercialActor => ({
    user_id,
    actor_kind: 'user',
    scopes: [...new Set(roles.flatMap((r) => CCP_BUNDLES[r] ?? []))],
    ...extra,
  });

  const bootstrap = (over: Partial<Parameters<typeof runPlatformOwnerBootstrap>[1]> = {}) =>
    runPlatformOwnerBootstrap(prisma, { po_authorization_ref: 'PO-AUTH-TEST-1', human_ref_hash: HUMAN_PURUSH, executed_by: 'spec@host', correlation_id: 'ccp-a9-bootstrap-spec', ...over });

  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof CommercialApprovalRefusedError) return e.refusal;
      if (e instanceof CommercialNotBootstrappedError) return 'CCP_NOT_BOOTSTRAPPED';
      if (e instanceof CommercialChangeRequestError) return `${e.code}${typeof e.details['reason'] === 'string' ? `:${e.details['reason']}` : ''}`;
      if (e instanceof CommercialApplyRefusedError) return `APPLY:${e.reason}`;
      if (e instanceof PlatformOwnerBootstrapRefusedError) return `BOOTSTRAP:${e.refusal}`;
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
  const rolesOf = async (user_id: string): Promise<string[]> =>
    (
      await pg.query(
        `SELECT r.key FROM identity."UserTenantMembershipRole" mr JOIN identity."UserTenantMembership" m ON m.id = mr.membership_id JOIN identity."Role" r ON r.id = mr.role_id WHERE m.user_id = $1 ORDER BY r.key`,
        [user_id],
      )
    ).rows.map((r) => r.key as string);
  const versionOf = async (user_id: string): Promise<number | null> =>
    ((await pg.query(`SELECT version FROM identity."AuthorizationVersion" WHERE principal_id = $1`, [user_id])).rows[0]?.version as number | undefined) ?? null;
  const stateOf = async (id: string): Promise<string> => (await pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].state as string;
  const eventsOf = async (id: string): Promise<string[]> =>
    (await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.event_type as string);

  /** Creates + submits a role change requested by `requester` (holding platform_owner). */
  async function roleChange(requester: string, action: 'ROLE_GRANT' | 'ROLE_REVOKE', payload: Record<string, unknown>, requesterRoles: readonly string[] = ['platform_owner']) {
    const { request } = await svc.create(as(requester, requesterRoles), { action_type: action, payload, reason: 'role change', idempotency_key: key() }, ctx);
    await svc.submit(as(requester, requesterRoles), request.id, ctx);
    return request.id;
  }
  const approve = (id: string, user: string, roles: readonly string[] = ['platform_owner'], step_index = 0) => svc.approve(as(user, roles), id, { step_index }, ctx);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    prisma = new PrismaService(url);
    await prisma.$connect();
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    svc = new CommercialChangeRequestService(prisma, audit, policies, new CommercialOperatorRepository(prisma, audit, policies));
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  beforeEach(async () => {
    await applyCcpA9Schema(pg);
    await addBootstrapOperator(pg);
  }, 120_000);

  // ---- the bootstrap gate before any chain is satisfiable -----------------------------

  it('A9-GATE-1 before the bootstrap: no platform_owner exists, so a role change cannot be requested (REQUESTER_ROLE_MISSING) and a finance → owner approval is 409 CCP_NOT_BOOTSTRAPPED, while a finance-only chain proceeds (per chain, never a user count)', async () => {
    const FA = await addOperator(pg, ['finance_admin']);
    const FA2 = await addOperator(pg, ['finance_admin']);
    const CAT = await addOperator(pg, ['catalog_manager']);
    const OPS = await addOperator(pg, ['commercial_ops']);
    expect(await count(pg, `SELECT count(*)::int AS n FROM identity."User"`)).toBe(5);
    expect(await outcome(svc.create(as(BOOTSTRAP_OPERATOR_ID, ['super_admin']), { action_type: 'ROLE_GRANT', payload: { subject_user_id: FA, role_key: 'platform_owner' }, reason: 'x', idempotency_key: key() }, ctx))).toBe(
      'NOT_HUMAN:not_human',
    );
    const { request: pub } = await svc.create(as(CAT, ['catalog_manager']), { action_type: 'PLAN_VERSION_PUBLISH', payload: { plan_version_id: 'pv' }, reason: 'x', idempotency_key: key() }, ctx);
    await svc.submit(as(CAT, ['catalog_manager']), pub.id, ctx);
    expect(await outcome(svc.approve(as(FA, ['finance_admin']), pub.id, { step_index: 0 }, ctx))).toBe('CCP_NOT_BOOTSTRAPPED');
    const { request: cr } = await svc.create(as(OPS, ['commercial_ops']), { action_type: 'CREDIT', tenant_id: '0190dddd-0000-7000-8000-0000000000a1', product_key: 'sign', payload: { amount_minor: 1, currency: 'USD' }, reason: 'x', idempotency_key: key() }, ctx);
    await svc.submit(as(OPS, ['commercial_ops']), cr.id, ctx);
    expect((await svc.approve(as(FA2, ['finance_admin']), cr.id, { step_index: 0 }, ctx)).request.state).toBe('APPROVED');
  });

  // ---- the single bootstrap exception -------------------------------------------------

  it('A9-BOOT-1 the bootstrap grants exactly platform_owner to the :28 operator, keeps super_admin, writes ONE is_exception audit event (kind BOOTSTRAP, granted_source MIGRATION) and the D9 attestation; the seed-prod :28 assertion still counts 1', async () => {
    const assertion = seedProdAssertionForFixture();
    expect(await count(pg, assertion.replace('SELECT count(*)', 'SELECT count(*)::int AS n'))).toBe(1);
    const before = await footprint(pg);
    const res = await bootstrap();
    expect(res.outcome).toBe('GRANTED');
    expect(await rolesOf(BOOTSTRAP_OPERATOR_ID)).toEqual(['platform_owner', 'super_admin']);
    expect(await count(pg, assertion.replace('SELECT count(*)', 'SELECT count(*)::int AS n'))).toBe(1);
    const ev = (await pg.query(`SELECT * FROM subscription."CommercialAuditEvent" WHERE event_type = $1`, [PLATFORM_OWNER_BOOTSTRAP_EVENT])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ is_exception: true, actor_type: 'system', actor_id: null, subject: `platform_operator:${BOOTSTRAP_OPERATOR_ID}`, policy_version_id: POLICY_V1 });
    expect(ev[0].payload).toMatchObject({
      exception_kind: 'BOOTSTRAP',
      granted_source: 'MIGRATION',
      target_user_id: BOOTSTRAP_OPERATOR_ID,
      role_granted: 'platform_owner',
      executed_by: 'spec@host',
      po_authorization_ref: 'PO-AUTH-TEST-1',
    });
    const att = (await pg.query(`SELECT * FROM subscription."CommercialOperatorAttestation" WHERE user_id = $1`, [BOOTSTRAP_OPERATOR_ID])).rows;
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ method: 'BOOTSTRAP', attested_by: BOOTSTRAP_OPERATOR_ID, human_ref_hash: HUMAN_PURUSH, statement_version: 'D9-v1', revoked_at: null });
    const after = await footprint(pg);
    // Exactly: +1 membership-role, +1 attestation, +1 audit event, +1 AuthorizationVersion; no user, membership or tenant.
    expect(Object.fromEntries(Object.keys(after).map((k) => [k, (after[k] ?? 0) - (before[k] ?? 0)]))).toEqual({
      'identity."User"': 0,
      'identity."UserTenantMembership"': 0,
      'identity."UserTenantMembershipRole"': 1,
      'identity."Tenant"': 0,
      'identity."AuthorizationVersion"': 1,
      'subscription."CommercialOperatorAttestation"': 1,
      'subscription."CommercialAuditEvent"': 1,
      'subscription."CommercialChangeRequest"': 0,
      'subscription."CommercialApproval"': 0,
    });
    // The verbatim deploy/seed-prod.sh:224 assertion is the one used above (only the fixture role id differs).
    expect(readFileSync(resolve(REPO_ROOT, 'deploy/seed-prod.sh'), 'utf8')).toContain(SEED_PROD_SUPER_ADMIN_ASSERTION.replace(/"/g, '\\"'));
  });

  it('A9-BOOT-2 idempotent re-run: NOOP_ALREADY_GRANTED, writes nothing (every row count unchanged, no second event); the membership-role id is deterministic', async () => {
    const first = await bootstrap();
    const mid = await footprint(pg);
    const again = await bootstrap();
    const third = await bootstrap({ po_authorization_ref: 'PO-AUTH-OTHER', human_ref_hash: humanRef('someone-else') });
    expect(again).toEqual({ outcome: 'NOOP_ALREADY_GRANTED', user_id: BOOTSTRAP_OPERATOR_ID });
    expect(third.outcome).toBe('NOOP_ALREADY_GRANTED');
    expect(await footprint(pg)).toEqual(mid);
    expect(await count(pg, `SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent" WHERE event_type = $1`, [PLATFORM_OWNER_BOOTSTRAP_EVENT])).toBe(1);
    // Deterministic: a fresh database yields the same membership-role id.
    await applyCcpA9Schema(pg);
    await addBootstrapOperator(pg);
    const fresh = await bootstrap();
    expect(first.outcome === 'GRANTED' && fresh.outcome === 'GRANTED' && fresh.membership_role_id === first.membership_role_id).toBe(true);
  });

  it('A9-BOOT-3 one-time: refused once another active platform_owner exists; refused (ALREADY_BOOTSTRAPPED) after its first grant even if the target later lost the role; no target → TARGET_NOT_FOUND; inactive target → TARGET_INACTIVE; nothing written on any refusal', async () => {
    await addOperator(pg, ['platform_owner']);
    const before = await footprint(pg);
    expect(await outcome(bootstrap())).toBe('BOOTSTRAP:OTHER_PLATFORM_OWNER_EXISTS');
    expect(await footprint(pg)).toEqual(before);
    await applyCcpA9Schema(pg);
    await addBootstrapOperator(pg);
    expect((await bootstrap()).outcome).toBe('GRANTED');
    await addOperator(pg, ['platform_owner']);
    await revokeRole(pg, BOOTSTRAP_OPERATOR_ID, 'platform_owner'); // allowed: the other owner remains effective
    const mid = await footprint(pg);
    expect(await outcome(bootstrap())).toBe('BOOTSTRAP:ALREADY_BOOTSTRAPPED');
    expect(await footprint(pg)).toEqual(mid);
    // Target resolution failures.
    await applyCcpA9Schema(pg);
    expect(await outcome(bootstrap())).toBe('BOOTSTRAP:TARGET_NOT_FOUND');
    await addBootstrapOperator(pg);
    await pg.query(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [BOOTSTRAP_OPERATOR_ID]);
    expect(await outcome(bootstrap())).toBe('BOOTSTRAP:TARGET_INACTIVE');
    // A human reference already attested to another account is refused (D9).
    await pg.query(`UPDATE identity."User" SET is_active = true WHERE id = $1`, [BOOTSTRAP_OPERATOR_ID]);
    await addOperator(pg, ['finance_admin'], { human: 'human:purush' });
    expect(await outcome(bootstrap())).toBe('BOOTSTRAP:HUMAN_REF_IN_USE');
    expect(await rolesOf(BOOTSTRAP_OPERATOR_ID)).toEqual(['super_admin']);
  });

  it('A9-BOOT-4 DB backstops: a second BOOTSTRAP attestation and a second bootstrap event are refused by unique indexes; an invalid argument is refused before any read', async () => {
    await bootstrap();
    const X = await addOperator(pg, ['finance_admin'], { attested: false });
    expect(
      await raises(`INSERT INTO subscription."CommercialOperatorAttestation" (id, user_id, human_ref_hash, statement_version, method, attested_by, attested_at) VALUES (gen_random_uuid(), $1, repeat('c', 64), 'D9-v1', 'BOOTSTRAP', $1, now())`, [X]),
    ).toContain('CommercialOperatorAttestation_one_bootstrap_key');
    expect(
      await raises(
        `INSERT INTO subscription."CommercialAuditEvent" (id, actor_type, event_type, is_exception, subject, policy_version_id, correlation_id) VALUES (gen_random_uuid(), 'system', $1, true, 'platform_operator:x', $2, 'c')`,
        [PLATFORM_OWNER_BOOTSTRAP_EVENT, POLICY_V1],
      ),
    ).toContain('CommercialAuditEvent_one_platform_owner_bootstrap_key');
    expect(await outcome(bootstrap({ human_ref_hash: 'not-a-hash' }))).toBe('BOOTSTRAP:INVALID_ARGUMENT');
    expect(await outcome(bootstrap({ po_authorization_ref: '' }))).toBe('BOOTSTRAP:INVALID_ARGUMENT');
  });

  // ---- governed role change -----------------------------------------------------------

  it('A9-RC-1 after the bootstrap alone, a ROLE_GRANT chain is NOT satisfiable (the operator is the requester) → 409 CCP_NOT_BOOTSTRAPPED; once a second attested owner arrives it is, and the grant APPLIES (role + D9 attestation + version bump, audited)', async () => {
    await bootstrap();
    const P = BOOTSTRAP_OPERATOR_ID;
    const X = await addOperator(pg, [], { attested: false }); // an existing platform admin with no CCP role
    const HX = humanRef('human:x');
    const id = await roleChange(P, 'ROLE_GRANT', { subject_user_id: X, role_key: 'finance_admin', human_ref_hash: HX }, ['super_admin', 'platform_owner']);
    expect(await outcome(approve(id, P, ['super_admin', 'platform_owner']))).toBe('CCP_NOT_BOOTSTRAPPED');
    const P2 = await addOperator(pg, ['platform_owner']); // the second operator (arrives through the invite)
    const out = await approve(id, P2);
    expect(out.apply).toEqual({ applied: true, request: expect.objectContaining({ state: 'APPLIED' }), reason: null, detail: {} });
    expect(out.request.state).toBe('APPLIED');
    expect(out.request.applied_at).not.toBeNull();
    expect(await rolesOf(X)).toEqual(['finance_admin']);
    expect(await versionOf(X)).toBe(2);
    const att = (await pg.query(`SELECT method, attested_by, human_ref_hash FROM subscription."CommercialOperatorAttestation" WHERE user_id = $1 AND revoked_at IS NULL`, [X])).rows;
    expect(att).toEqual([{ method: 'PLATFORM_OWNER', attested_by: P2, human_ref_hash: HX }]);
    expect(await eventsOf(id)).toEqual([
      'COMMERCIAL_CHANGE_REQUEST_CREATED',
      'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
      'COMMERCIAL_APPROVAL_REFUSED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPROVED',
      'COMMERCIAL_OPERATOR_ATTESTATION_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPLIED',
    ]);
  });

  it('A9-RC-2 a role grant needs a DISTINCT platform_owner: the requester (SELF_APPROVAL), the subject (SELF_APPROVAL) and a finance_admin (STEP_SCOPE_MISSING) cannot approve; a distinct owner can', async () => {
    const P1 = await addOperator(pg, ['platform_owner']);
    const P2 = await addOperator(pg, ['platform_owner']);
    const P3 = await addOperator(pg, ['platform_owner']);
    const FA = await addOperator(pg, ['finance_admin']);
    // P2 asks for finance_admin for themself; P1 asks P3 to become finance_admin.
    const self = await roleChange(P2, 'ROLE_GRANT', { subject_user_id: P2, role_key: 'finance_admin' });
    expect(await outcome(approve(self, P2))).toBe('SELF_APPROVAL');
    const id = await roleChange(P1, 'ROLE_GRANT', { subject_user_id: P3, role_key: 'finance_admin' });
    expect(await outcome(approve(id, P1))).toBe('SELF_APPROVAL');
    expect(await outcome(approve(id, P3))).toBe('SELF_APPROVAL');
    expect(await outcome(approve(id, FA, ['finance_admin']))).toBe('STEP_SCOPE_MISSING');
    expect((await approve(id, P2)).request.state).toBe('APPLIED');
    expect((await approve(self, P1)).request.state).toBe('APPLIED');
    expect(await rolesOf(P3)).toEqual(['finance_admin', 'platform_owner']);
    // Granting platform_owner follows the same distinct-owner chain.
    const own = await roleChange(P1, 'ROLE_GRANT', { subject_user_id: FA, role_key: 'platform_owner' });
    const chain = (await pg.query(`SELECT required_chain FROM subscription."CommercialChangeRequest" WHERE id = $1`, [own])).rows[0].required_chain;
    expect(chain).toMatchObject({ rule: 'DISTINCT_PLATFORM_OWNER', steps: [{ step_index: 0, role_key: 'platform_owner' }] });
    expect(await outcome(approve(own, FA, ['finance_admin']))).toBe('SELF_APPROVAL');
    expect((await approve(own, P3, ['finance_admin', 'platform_owner'])).request.state).toBe('APPLIED');
  });

  it('A9-RC-3 requester authority (TD-A3-5): only a platform_owner with a live role and an active D9 attestation may request a role change; the payload is closed and validated against the live subject', async () => {
    const P1 = await addOperator(pg, ['platform_owner']);
    const P2 = await addOperator(pg, ['platform_owner']);
    const FA = await addOperator(pg, ['finance_admin']);
    const UNATT = await addOperator(pg, ['platform_owner'], { attested: false });
    const req = (actor: string, roles: string[], action: 'ROLE_GRANT' | 'ROLE_REVOKE', payload: Record<string, unknown>) =>
      outcome(svc.create(as(actor, roles), { action_type: action, payload, reason: 'x', idempotency_key: key() }, ctx));
    expect(await req(FA, ['finance_admin'], 'ROLE_GRANT', { subject_user_id: P2, role_key: 'finance_admin' })).toBe('REQUESTER_ROLE_MISSING');
    expect(await req(UNATT, ['platform_owner'], 'ROLE_GRANT', { subject_user_id: P2, role_key: 'finance_admin' })).toBe('NOT_HUMAN:not_human');
    // The token claims platform_owner but the live roster no longer does (NC-4 at create).
    await revokeRole(pg, P2, 'platform_owner');
    expect(await req(P2, ['platform_owner'], 'ROLE_GRANT', { subject_user_id: FA, role_key: 'catalog_manager' })).toBe('REQUESTER_ROLE_MISSING');
    expect(await req(P1, ['platform_owner'], 'ROLE_GRANT', { subject_user_id: P2, role_key: 'super_admin' })).toBe('INVALID_INPUT:invalid_payload');
    expect(await req(P1, ['platform_owner'], 'ROLE_GRANT', { subject_user_id: P2, role_key: 'finance_admin', tenant: 'x' })).toBe('INVALID_INPUT:invalid_payload');
    expect(await req(P1, ['platform_owner'], 'ROLE_REVOKE', { subject_user_id: FA, role_key: 'finance_admin', human_ref_hash: humanRef('h') })).toBe('INVALID_INPUT:invalid_payload');
    expect(await req(P1, ['platform_owner'], 'ROLE_GRANT', { subject_user_id: '0190dddd-0000-7000-8000-0000000000ee', role_key: 'finance_admin' })).toBe('INVALID_INPUT:subject_not_platform_member');
    expect(await req(P1, ['platform_owner'], 'ROLE_GRANT', { subject_user_id: FA, role_key: 'finance_admin' })).toBe('INVALID_INPUT:role_already_held');
    expect(await req(P1, ['platform_owner'], 'ROLE_REVOKE', { subject_user_id: FA, role_key: 'catalog_manager' })).toBe('INVALID_INPUT:role_not_held');
    expect(await req(P1, ['platform_owner'], 'ROLE_GRANT', { subject_user_id: FA, role_key: 'catalog_manager', human_ref_hash: humanRef('h') })).toBe('INVALID_INPUT:subject_already_attested');
    const NEW = await addOperator(pg, [], { attested: false });
    expect(await req(P1, ['platform_owner'], 'ROLE_GRANT', { subject_user_id: NEW, role_key: 'catalog_manager' })).toBe('INVALID_INPUT:human_ref_required');
    // NC-2 / D9: one human cannot be attested to a second account.
    expect(await req(P1, ['platform_owner'], 'ROLE_GRANT', { subject_user_id: NEW, role_key: 'catalog_manager', human_ref_hash: humanRef(`human:${FA}`) })).toBe('INVALID_INPUT:human_ref_in_use');
    expect(await count(pg, `SELECT count(*)::int AS n FROM subscription."CommercialChangeRequest"`)).toBe(0);
  });

  it('A9-NC2-1 NC-2: one user holding platform_owner AND finance_admin who requested the change cannot also approve it (SELF_APPROVAL); two accounts of one human are blocked by D9', async () => {
    const BOTH = await addOperator(pg, ['platform_owner', 'finance_admin']);
    const P2 = await addOperator(pg, ['platform_owner']);
    const X = await addOperator(pg, []);
    const id = await roleChange(BOTH, 'ROLE_GRANT', { subject_user_id: X, role_key: 'support_admin' }, ['platform_owner', 'finance_admin']);
    expect(await outcome(approve(id, BOTH, ['platform_owner', 'finance_admin']))).toBe('SELF_APPROVAL');
    // P2 is the only other owner: once P2 is the requester too, the chain has nobody left.
    const id2 = await roleChange(P2, 'ROLE_GRANT', { subject_user_id: X, role_key: 'catalog_manager' });
    expect((await approve(id2, BOTH, ['platform_owner', 'finance_admin'])).request.state).toBe('APPLIED');
    const id3 = await roleChange(P2, 'ROLE_REVOKE', { subject_user_id: BOTH, role_key: 'finance_admin' });
    expect(await outcome(approve(id3, BOTH, ['platform_owner', 'finance_admin']))).toBe('CCP_NOT_BOOTSTRAPPED');
    const SECOND = await addOperator(pg, [], { attested: false });
    expect(await raises(`INSERT INTO subscription."CommercialOperatorAttestation" (id, user_id, human_ref_hash, statement_version, method, attested_by, attested_at) VALUES (gen_random_uuid(), $1, $2, 'D9-v1', 'PLATFORM_OWNER', $3, now())`, [SECOND, humanRef(`human:${BOTH}`), P2])).toContain(
      'CommercialOperatorAttestation_active_human_key',
    );
    expect((await approve(id, P2)).request.state).toBe('APPLIED');
  });

  it('A9-NC4-1 NC-4: an approver whose platform_owner is revoked between request and approval is refused (STEP_SCOPE_MISSING, read live); with no other owner left → CCP_NOT_BOOTSTRAPPED', async () => {
    const P1 = await addOperator(pg, ['platform_owner']);
    const P2 = await addOperator(pg, ['platform_owner']);
    const P3 = await addOperator(pg, ['platform_owner']);
    const X = await addOperator(pg, []);
    const id = await roleChange(P1, 'ROLE_GRANT', { subject_user_id: X, role_key: 'read_only_auditor' });
    await revokeRole(pg, P2, 'platform_owner');
    expect(await outcome(approve(id, P2))).toBe('STEP_SCOPE_MISSING');
    await revokeRole(pg, P3, 'platform_owner');
    expect(await outcome(approve(id, P3))).toBe('CCP_NOT_BOOTSTRAPPED');
    expect(await stateOf(id)).toBe('PENDING_APPROVAL');
    expect(await rolesOf(X)).toEqual([]);
  });

  it('A9-NC5-1 NC-5 at apply: a refused apply (role already held, then a lost approver eligibility) leaves the request APPROVED, the signature byte-identical and the roles untouched; a later apply re-checks and applies', async () => {
    const P1 = await addOperator(pg, ['platform_owner']);
    const P2 = await addOperator(pg, ['platform_owner']);
    const P3 = await addOperator(pg, ['platform_owner']);
    const X = await addOperator(pg, []);
    const id = await roleChange(P1, 'ROLE_GRANT', { subject_user_id: X, role_key: 'commercial_ops' });
    await grantRole(pg, X, 'commercial_ops'); // out-of-band: the role is held by the time the chain completes
    const out = await approve(id, P2);
    expect(out.apply).toMatchObject({ applied: false, reason: 'ROLE_ALREADY_HELD' });
    expect(out.request.state).toBe('APPROVED');
    const sig = (await pg.query(`SELECT row_to_json(a)::text AS j FROM subscription."CommercialApproval" a WHERE change_request_id = $1`, [id])).rows;
    await revokeRole(pg, X, 'commercial_ops');
    await revokeRole(pg, P2, 'platform_owner'); // the signer loses the step's role (P1, P3 remain owners)
    const again = await svc.applyRoleChange(as(P3, ['platform_owner']), id, ctx);
    expect(again).toMatchObject({ applied: false, reason: 'APPROVER_NO_LONGER_ELIGIBLE' });
    expect(await stateOf(id)).toBe('APPROVED');
    expect((await pg.query(`SELECT row_to_json(a)::text AS j FROM subscription."CommercialApproval" a WHERE change_request_id = $1`, [id])).rows).toEqual(sig);
    expect(await rolesOf(X)).toEqual([]);
    await grantRole(pg, P2, 'platform_owner');
    expect((await svc.applyRoleChange(as(P3, ['platform_owner']), id, ctx)).request.state).toBe('APPLIED');
    expect(await rolesOf(X)).toEqual(['commercial_ops']);
    expect((await eventsOf(id)).filter((e) => e === 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED')).toHaveLength(2);
    // An APPLIED request never applies twice.
    expect(await svc.applyRoleChange(as(P3, ['platform_owner']), id, ctx)).toMatchObject({ applied: false, reason: 'NOT_APPROVED' });
    expect(await rolesOf(X)).toEqual(['commercial_ops']);
  });

  it('A9-RC-4 ROLE_REVOKE: requested by an owner, approved by a distinct owner, applies (role removed, version bumped); revoking the platform\'s last effective owner is refused at create (409 PLATFORM_LAST_OWNER) and two owners can never revoke each other to zero', async () => {
    const P1 = await addOperator(pg, ['platform_owner']);
    const P2 = await addOperator(pg, ['platform_owner']);
    const FA = await addOperator(pg, ['finance_admin']);
    const id = await roleChange(P1, 'ROLE_REVOKE', { subject_user_id: FA, role_key: 'finance_admin' });
    const v0 = await versionOf(FA);
    expect((await approve(id, P2)).request.state).toBe('APPLIED');
    expect(await rolesOf(FA)).toEqual([]);
    expect(await versionOf(FA)).toBe((v0 ?? 1) + 1);
    // P1 revokes P2: the approver must be neither → no third owner → this chain is not
    // satisfiable, so the gate refuses before eligibility, for P2 and for anyone else.
    const r12 = await roleChange(P1, 'ROLE_REVOKE', { subject_user_id: P2, role_key: 'platform_owner' });
    expect(await outcome(approve(r12, P2))).toBe('CCP_NOT_BOOTSTRAPPED');
    expect(await outcome(approve(r12, FA, []))).toBe('CCP_NOT_BOOTSTRAPPED');
    // P1 revokes their own platform_owner, P2 approves: P2 remains.
    const self = await roleChange(P1, 'ROLE_REVOKE', { subject_user_id: P1, role_key: 'platform_owner' });
    expect((await approve(self, P2)).request.state).toBe('APPLIED');
    // P2 is now the last effective owner: the request itself is refused.
    expect(await outcome(svc.create(as(P2, ['platform_owner']), { action_type: 'ROLE_REVOKE', payload: { subject_user_id: P2, role_key: 'platform_owner' }, reason: 'x', idempotency_key: key() }, ctx))).toBe(
      'LAST_OWNER:platform_last_owner',
    );
    expect(await effectiveOwners()).toEqual([P2]);
  });

  async function effectiveOwners(): Promise<string[]> {
    return (
      await pg.query(
        `SELECT m.user_id::text AS u FROM identity."UserTenantMembershipRole" mr JOIN identity."UserTenantMembership" m ON m.id = mr.membership_id AND m.is_active JOIN identity."User" us ON us.id = m.user_id AND us.is_active JOIN identity."Role" r ON r.id = mr.role_id WHERE m.tenant_id = $1 AND r.key = 'platform_owner' ORDER BY 1`,
        [PLATFORM_TENANT],
      )
    ).rows.map((r) => r.u as string);
  }

  // ---- POLICY_ACTIVATE (TD-A3-5) ------------------------------------------------------

  // CCP-B5 (TD-A9-16) re-pointed the tail of this test: B5 applies the activation after the
  // chain completes, WITHOUT a state transition (the guard still refuses APPLYING for it), so
  // the request stays APPROVED and the target version becomes ACTIVE.
  it('A9-POL-1 POLICY_ACTIVATE is requested by a finance_admin (live role + D9), resolves finance → owner, is approved by a distinct finance_admin then an owner; CCP-B5 applies it while the request stays APPROVED (the guard refuses APPLYING for it)', async () => {
    const FA = await addOperator(pg, ['finance_admin']);
    const FA2 = await addOperator(pg, ['finance_admin']);
    const P = await addOperator(pg, ['platform_owner']);
    const UNATT = await addOperator(pg, ['finance_admin'], { attested: false });
    const V2 = '019a0000-0000-7000-8000-0000000cc2a2';
    await pg.query(`INSERT INTO subscription."CommercialPolicyVersion" (id, version_number, status, content, content_checksum) SELECT $1, 2, 'DRAFT', content, content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $2`, [V2, POLICY_V1]);
    const make = (u: string, roles: string[], policy_version_id = V2) => svc.create(as(u, roles), { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id }, reason: 'activate v2', idempotency_key: key() }, ctx);
    expect(await outcome(make(P, ['platform_owner']))).toBe('REQUESTER_ROLE_MISSING');
    expect(await outcome(make(UNATT, ['finance_admin']))).toBe('NOT_HUMAN:not_human');
    expect(await outcome(make(FA, ['finance_admin'], POLICY_V1))).toBe('INVALID_INPUT:policy_version_already_active');
    expect(await outcome(make(FA, ['finance_admin'], '019a0000-0000-7000-8000-0000000cc2ff'))).toBe('INVALID_INPUT:policy_version_not_found');
    const { request } = await make(FA, ['finance_admin']);
    expect((request.required_chain as { rule: string }).rule).toBe('FINANCE_THEN_OWNER');
    await svc.submit(as(FA, ['finance_admin']), request.id, ctx);
    expect(await outcome(svc.approve(as(FA, ['finance_admin']), request.id, { step_index: 0 }, ctx))).toBe('SELF_APPROVAL');
    await svc.approve(as(FA2, ['finance_admin']), request.id, { step_index: 0 }, ctx);
    const done = await svc.approve(as(P, ['platform_owner']), request.id, { step_index: 1 }, ctx);
    expect(done.request.state).toBe('APPROVED');
    expect(done.apply).toMatchObject({ applied: true, reason: null });
    expect((await pg.query(`SELECT id, status FROM subscription."CommercialPolicyVersion" ORDER BY version_number`)).rows).toEqual([
      { id: POLICY_V1, status: 'RETIRED' },
      { id: V2, status: 'ACTIVE' },
    ]);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', updated_at = now() WHERE id = $1`, [request.id])).toContain('APPROVED -> APPLYING is not allowed');
  });

  it('A9-TRG-1 the replaced guard: APPROVED → APPLYING → APPLIED only for role actions (APPLIED needs applied_at); APPLY_FAILED unreachable; an APPLIED row is frozen', async () => {
    const P1 = await addOperator(pg, ['platform_owner']);
    const P2 = await addOperator(pg, ['platform_owner']);
    const X = await addOperator(pg, []);
    const id = await roleChange(P1, 'ROLE_GRANT', { subject_user_id: X, role_key: 'support_admin' });
    await grantRole(pg, X, 'support_admin');
    await approve(id, P2); // apply refused (ROLE_ALREADY_HELD) → APPROVED
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_FAILED', updated_at = now() WHERE id = $1`, [id])).toContain('APPROVED -> APPLY_FAILED is not allowed');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', updated_at = now() WHERE id = $1`, [id])).toContain('APPROVED -> APPLIED is not allowed');
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', updated_at = now() WHERE id = $1`, [id]);
    const msg = await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', updated_at = now() WHERE id = $1`, [id]);
    await pg.query('ROLLBACK');
    expect(msg).toContain('cannot be APPLIED without applied_at');
    await revokeRole(pg, X, 'support_admin');
    expect((await svc.applyRoleChange(as(P2, ['platform_owner']), id, ctx)).applied).toBe(true);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET reason = 'edit', updated_at = now() WHERE id = $1`, [id])).toContain('immutable');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', updated_at = now() WHERE id = $1`, [id])).toContain('terminal state APPLIED');
  });

  // ---- the last-effective-platform_owner DB invariant --------------------------------

  it('A9-LO-1 with one effective owner: role removal, role re-point, membership deactivation, membership re-point and user deactivation are each refused (platform_last_owner); no session-setting skip', async () => {
    await bootstrap();
    const P = BOOTSTRAP_OPERATOR_ID;
    const m = (await pg.query(`SELECT id FROM identity."UserTenantMembership" WHERE user_id = $1`, [P])).rows[0].id as string;
    const owner = (await pg.query(`SELECT id FROM identity."Role" WHERE key = 'platform_owner'`)).rows[0].id as string;
    const auditor = (await pg.query(`SELECT id FROM identity."Role" WHERE key = 'read_only_auditor'`)).rows[0].id as string;
    const marker = 'platform_last_owner';
    expect(await raises(`DELETE FROM identity."UserTenantMembershipRole" WHERE membership_id = $1 AND role_id = $2`, [m, owner])).toContain(marker);
    expect(await raises(`UPDATE identity."UserTenantMembershipRole" SET role_id = $3 WHERE membership_id = $1 AND role_id = $2`, [m, owner, auditor])).toContain(marker);
    expect(await raises(`UPDATE identity."UserTenantMembership" SET is_active = false WHERE id = $1`, [m])).toContain(marker);
    expect(await raises(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [P])).toContain(marker);
    await pg.query(`SET session_replication_role = replica`);
    const skipped = await raises(`DELETE FROM identity."UserTenantMembershipRole" WHERE membership_id = $1 AND role_id = $2`, [m, owner]);
    await pg.query(`SET session_replication_role = origin`);
    expect(skipped).toContain(marker);
    // super_admin removal is not covered (not an owner) and the operator still holds platform_owner.
    expect(await rolesOf(P)).toEqual(['platform_owner', 'super_admin']);
  });

  it('A9-LO-2 with two owners one may go and the second is then refused; zero-to-zero before the bootstrap is admitted; non-owner removals never consult the count', async () => {
    const FA = await addOperator(pg, ['finance_admin']);
    await revokeRole(pg, FA, 'finance_admin'); // no owner exists: unrelated removal admitted
    await pg.query(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [FA]);
    const A = await addOperator(pg, ['platform_owner']);
    const B = await addOperator(pg, ['platform_owner']);
    await pg.query(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [A]);
    expect(await raises(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [B])).toContain('platform_last_owner');
    // A deactivated owner does not count: re-activating A restores two.
    await pg.query(`UPDATE identity."User" SET is_active = true WHERE id = $1`, [A]);
    await revokeRole(pg, B, 'platform_owner');
    expect(await effectiveOwners()).toEqual([A]);
  });

  it('A9-LO-3 concurrency: two transactions each removing one of two owners serialize — exactly one commits', async () => {
    const A = await addOperator(pg, ['platform_owner']);
    const B = await addOperator(pg, ['platform_owner']);
    const url = container.getConnectionUri();
    const c1 = new Client({ connectionString: url });
    const c2 = new Client({ connectionString: url });
    await c1.connect();
    await c2.connect();
    try {
      const del = (c: Client, u: string) =>
        c.query(
          `DELETE FROM identity."UserTenantMembershipRole" mr USING identity."UserTenantMembership" m, identity."Role" r WHERE mr.membership_id = m.id AND mr.role_id = r.id AND m.user_id = $1 AND r.key = 'platform_owner'`,
          [u],
        );
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await del(c1, A);
      const second = del(c2, B).then(
        () => 'ok',
        (e: Error) => e.message,
      );
      await c1.query('COMMIT');
      const r2 = await second;
      await c2.query('ROLLBACK');
      expect(r2).toContain('platform_last_owner');
    } finally {
      await c1.end();
      await c2.end();
    }
    expect(await effectiveOwners()).toEqual([B]);
  });
});
