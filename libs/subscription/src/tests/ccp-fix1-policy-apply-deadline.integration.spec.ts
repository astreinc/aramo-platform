import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply-records.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { CommercialAuditRepository } from '../lib/commercial/commercial-audit.repository.js';
import { CommercialApprovalRefusedError, CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { CommercialOperatorRepository } from '../lib/commercial/commercial-operator.repository.js';
import { CommercialPolicyGovernanceService, POLICY_EDITABLE_KEYS } from '../lib/commercial/commercial-policy-governance.service.js';
import { CommercialPolicyRepository } from '../lib/commercial/commercial-policy.repository.js';
import { commercialPolicyChecksum } from '../lib/commercial/commercial-policy.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';
import { CCP_BUNDLES, POLICY_V1, addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, a6Harness, as, newTenant, publishedVersion, type A6Harness } from './support/ccp-a6.js';

// CCP-FIX1 item 2 (D5-DEF-2; Charter Amendment A1 AD-1 … AD-3) on real Postgres 17 with the full
// chain: the governed, no-SQL path to the v2 policy that carries the apply deadline.
//   FIX1-POL-1  apply_expiry_hours is an editable draft key; a malformed value fails closed exactly
//               as the strict parser refuses it, and changes nothing
//   FIX1-POL-2  draft v2 (v1 + apply_expiry_hours = 72) → POLICY_ACTIVATE (finance_admin) → finance
//               then owner approvals → requester apply → v2 ACTIVE → a NEW request snapshots v2 and
//               expires at the half-open 72 h boundary (deadline − 1 ms actionable, deadline expired)
// Nothing here seeds a default or creates a v2 outside the governed path.

const H = 3_600_000;
const T0 = new Date('2026-10-26T09:00:00.000Z');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-FIX1 governed apply-deadline policy v2 (real Postgres 17)', { timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let gov: CommercialPolicyGovernanceService;
  let now = T0;
  let FA: string;
  let FA2: string;
  let PO: string;
  let OPS: string;
  let keyN = 0;
  const key = () => `fix1-pol-${String(++keyN).padStart(6, '0')}`;
  const roles = (user_id: string, rs: readonly string[]) => ({ user_id, actor_kind: 'user' as const, scopes: [...new Set(rs.flatMap((r) => CCP_BUNDLES[r] ?? []))] });

  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof CommercialApprovalRefusedError) return e.refusal;
      if (e instanceof CommercialApplyRefusedError) return `REFUSED:${e.reason}`;
      if (e instanceof CommercialApplyFailedError) return `FAILED:${e.code}`;
      if (e instanceof CommercialChangeRequestError) return `${e.code}${typeof e.details['reason'] === 'string' ? `:${e.details['reason']}` : ''}`;
      throw e;
    }
    return 'OK';
  }
  const versionRow = async (id: string) =>
    (await pg.query(`SELECT status, content, content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [id])).rows[0] as { status: string; content: Record<string, unknown>; content_checksum: string };
  const auditCount = async () => Number((await pg.query(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent"`)).rows[0].n);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => now);
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    gov = new CommercialPolicyGovernanceService(prisma, policies, audit, new CommercialOperatorRepository(prisma, audit, policies), h.changeRequests);
    FA = await addOperator(pg, ['finance_admin']);
    FA2 = await addOperator(pg, ['finance_admin']);
    PO = await addOperator(pg, ['platform_owner']);
    OPS = await addOperator(pg, ['commercial_ops']);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  let V2 = '';

  it('FIX1-POL-1 apply_expiry_hours is an editable draft key (optional, never defaulted); a malformed value is refused policy_value_invalid exactly as the strict parser refuses it, and changes nothing', async () => {
    expect(POLICY_EDITABLE_KEYS).toContain('apply_expiry_hours');
    // The seeded v1 carries no apply deadline, and a fresh draft copies v1 exactly (no default seeded).
    expect('apply_expiry_hours' in (await versionRow(POLICY_V1)).content).toBe(false);
    const draft = await gov.createDraft(roles(FA, ['finance_admin']), { source_version_id: POLICY_V1 }, A6_CTX);
    V2 = draft.id;
    expect('apply_expiry_hours' in (await versionRow(V2)).content).toBe(false);
    expect((await versionRow(V2)).content).toEqual(seededPolicyV1().content);
    const before = await versionRow(V2);
    const audits = await auditCount();
    for (const bad of [0, -1, 1.5, '72', null, true, 87_601]) {
      expect(await outcome(gov.updateDraft(roles(FA, ['finance_admin']), V2, { content: { apply_expiry_hours: bad } }, A6_CTX)), String(bad)).toBe('INVALID_INPUT:policy_value_invalid');
    }
    expect(await versionRow(V2)).toEqual(before);
    expect(await auditCount()).toBe(audits);
    // Boundaries the parser admits (1 … 87,600 h).
    for (const ok of [1, 87_600]) {
      await gov.updateDraft(roles(FA, ['finance_admin']), V2, { content: { apply_expiry_hours: ok } }, A6_CTX);
      expect((await versionRow(V2)).content['apply_expiry_hours']).toBe(ok);
    }
    // Non-authors still cannot edit it.
    expect(await outcome(gov.updateDraft(roles(OPS, ['commercial_ops']), V2, { content: { apply_expiry_hours: 72 } }, A6_CTX))).toBe('REQUESTER_ROLE_MISSING');
  });

  it('FIX1-POL-2 the governed path end to end: draft v2 with apply_expiry_hours = 72 → POLICY_ACTIVATE by finance_admin → finance then owner approvals → requester apply → v2 ACTIVE; a NEW request snapshots v2 and expires at the half-open 72 h boundary', async () => {
    now = T0;
    const updated = await gov.updateDraft(roles(FA, ['finance_admin']), V2, { content: { apply_expiry_hours: 72 }, note: 'v1 plus the apply deadline (Charter Amendment A1 AD-1)' }, A6_CTX);
    const expected = { ...(seededPolicyV1().content as Record<string, unknown>), apply_expiry_hours: 72 };
    expect((await versionRow(V2)).content).toEqual(expected);
    expect(updated.content_checksum).toBe(commercialPolicyChecksum(expected));
    const drafted = (
      await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE event_type = 'COMMERCIAL_POLICY_DRAFT_UPDATED' AND subject = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [`commercial_policy_version:${V2}`])
    ).rows[0].payload;
    expect(drafted).toMatchObject({ changed_keys: ['apply_expiry_hours'], before: { apply_expiry_hours: 87_600 }, after: { apply_expiry_hours: 72 } });

    // POLICY_ACTIVATE, requested by finance_admin (TD-A3-5), chain finance → owner (Q1).
    const { request } = await h.changeRequests.create(roles(FA, ['finance_admin']), { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: V2 }, reason: 'activate the apply deadline', idempotency_key: key() }, A6_CTX);
    expect(request.policy_version_id).toBe(POLICY_V1); // the activation itself snapshots v1 (TD-ACC-1)
    await h.changeRequests.submit(roles(FA, ['finance_admin']), request.id, A6_CTX);
    await h.changeRequests.approve(roles(FA2, ['finance_admin']), request.id, { step_index: 0 }, A6_CTX);
    const approved = await h.changeRequests.approve(roles(PO, ['platform_owner']), request.id, { step_index: 1 }, A6_CTX);
    expect(approved.request.state).toBe('APPROVED');
    expect((await versionRow(V2)).status).toBe('DRAFT');
    // Requester-only apply (TD-B2-3): an approver is refused; the requester applies.
    expect(await outcome(h.apply.apply(roles(PO, ['platform_owner']), request.id, A6_CTX))).toBe('NOT_REQUESTER:not_requester');
    const out = await h.apply.apply(roles(FA, ['finance_admin']), request.id, A6_CTX);
    expect(out.request.state).toBe('APPLIED');
    expect((await versionRow(V2)).status).toBe('ACTIVE');
    expect((await versionRow(POLICY_V1)).status).toBe('RETIRED');

    // A NEW request snapshots v2 and carries its 72 h apply deadline from its final approval.
    const t = await newTenant(pg);
    const fresh = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, reason: 'fix1 ttl', idempotency_key: key() },
      A6_CTX,
    );
    expect(fresh.request.policy_version_id).toBe(V2);
    expect(fresh.request.policy_checksum).toBe(commercialPolicyChecksum(expected));
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), fresh.request.id, A6_CTX);
    const A = new Date(T0.getTime() + 5 * 60_000);
    now = A;
    const fin = await h.changeRequests.approve(as(FA2, 'finance_admin'), fresh.request.id, { step_index: 0 }, A6_CTX);
    expect(fin.request.state).toBe('APPROVED');
    expect(fin.request.approved_at?.toISOString()).toBe(A.toISOString());
    const deadline = await h.changeRequests.applyDeadlineOf((await h.changeRequests.get(as(OPS, 'commercial_ops'), fresh.request.id, A6_CTX)).request);
    expect(deadline?.toISOString()).toBe(new Date(A.getTime() + 72 * H).toISOString());

    // Half-open (AD-3): at deadline − 1 ms the authority still exists (a read leaves it APPROVED, actionable).
    now = new Date(A.getTime() + 72 * H - 1);
    const live = await h.changeRequests.get(as(OPS, 'commercial_ops'), fresh.request.id, A6_CTX);
    expect(live.request.state).toBe('APPROVED');
    expect(live.apply_actionable).toBe(true);
    // Exactly at the deadline it has expired: the apply is refused APPLY_EXPIRED and the request is terminal.
    now = new Date(A.getTime() + 72 * H);
    expect(await outcome(h.apply.apply(as(OPS, 'commercial_ops'), fresh.request.id, A6_CTX))).toMatch(/APPLY_EXPIRED$/);
    const after = await h.changeRequests.get(as(OPS, 'commercial_ops'), fresh.request.id, A6_CTX);
    expect(after.request.state).toBe('APPLY_EXPIRED');
    expect(after.apply_actionable).toBe(false);
    const expiries = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED'`, [fresh.request.id])).rows;
    expect(expiries).toHaveLength(1);
    expect(expiries[0].payload).toMatchObject({ final_approved_at: A.toISOString(), apply_deadline: new Date(A.getTime() + 72 * H).toISOString() });
    // No subscription was opened.
    expect(Number((await pg.query(`SELECT count(*)::int AS n FROM subscription."TenantSubscription" WHERE tenant_id = $1`, [t])).rows[0].n)).toBe(0);
  });
});
