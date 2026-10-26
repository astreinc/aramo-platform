import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommercialApplyFailedError } from '../lib/commercial/commercial-apply-records.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { CommercialAuditRepository } from '../lib/commercial/commercial-audit.repository.js';
import { payloadChecksum } from '../lib/commercial/commercial-change-request.js';
import { CommercialChangeRequestError, type CommercialChangeRequestRow } from '../lib/commercial/commercial-change-request.service.js';
import { CommercialOperatorRepository } from '../lib/commercial/commercial-operator.repository.js';
import { CommercialPolicyGovernanceService } from '../lib/commercial/commercial-policy-governance.service.js';
import { CommercialPolicyRepository } from '../lib/commercial/commercial-policy.repository.js';
import { commercialPolicyChecksum } from '../lib/commercial/commercial-policy.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';
import { POLICY_V1, activatePolicyV2, addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, as, newTenant, publishedVersion } from './support/ccp-a6.js';
import { type C2Harness, c2Harness } from './support/ccp-c2.js';

// CCP-B5-R — Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0-LOCKED AD-4 for EVERY applyable
// action type (the A6-R coverage was the A6 + CCP-B2-backend set; ccp-a6r-apply-deadline.integration
// .spec.ts): POLICY_ACTIVATE, ROLE_GRANT, ROLE_REVOKE, ENTITLEMENT_REVOKE, CONVERSION and a NORMAL
// SUPPORT_EXTENSION, on real Postgres 17 with the full chain (the guard union's "CCP-B5-R" block):
//   B5R-EXP-*   the shared helper (expireApplyIfDue): half-open boundary per type and start state,
//               exactly one APPLY_EXPIRED event, terminal
//   B5R-NEVER-* a v1 snapshot never expires; a CONVERSION in APPLYING never expires; a bounded
//               EXCEPTION is not affected
//   B5R-WIRE-*  the lazy expiry wired into each apply path (A7 / A8 revoke + NORMAL extension through
//               CommercialApplyService, C2, the A9 role-change apply), reads and slot contention
//   B5R-POL-*   the policy screen path end to end (apply, slot contention, the governance read)
// The v2 policy is a TEST FIXTURE (v1 + apply_expiry_hours: 72), never a code constant.

const H = 3_600_000;
const A = new Date('2026-10-25T12:00:00.000Z'); // the final-approval instant of the raw fixtures
const TTL_HOURS = 72;
const DEADLINE = A.getTime() + TTL_HOURS * H;
const CHAIN = { format_version: 1, rule: 'FINANCE_ONLY', basis: {}, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:billing:approve'] }] };

type Covered = 'POLICY_ACTIVATE' | 'ROLE_GRANT' | 'ROLE_REVOKE' | 'ENTITLEMENT_REVOKE' | 'CONVERSION' | 'SUPPORT_EXTENSION';
const COVERED: readonly Covered[] = ['POLICY_ACTIVATE', 'ROLE_GRANT', 'ROLE_REVOKE', 'ENTITLEMENT_REVOKE', 'CONVERSION', 'SUPPORT_EXTENSION'];
const GOVERNANCE = new Set<string>(['POLICY_ACTIVATE', 'ROLE_GRANT', 'ROLE_REVOKE']);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-B5-R apply deadline for every applyable type (real Postgres 17)', { timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: C2Harness;
  let gov: CommercialPolicyGovernanceService;
  let now = A;
  let V2 = '';
  let V2_CHECKSUM = '';
  let V1_CHECKSUM = '';
  let OPS: string;
  let SUP: string;
  let FA: string;
  let FA2: string;
  let PO: string;
  let PO2: string;
  let keyN = 0;
  const key = () => `b5r-key-${String(++keyN).padStart(6, '0')}`;
  const at = (ms: number) => (now = new Date(ms));

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = c2Harness(prisma, () => now);
    const audit = new CommercialAuditRepository(prisma);
    const policies = new CommercialPolicyRepository(prisma);
    gov = new CommercialPolicyGovernanceService(prisma, policies, audit, new CommercialOperatorRepository(prisma, audit, policies), h.changeRequests);
    OPS = await addOperator(pg, ['commercial_ops']);
    SUP = await addOperator(pg, ['support_admin']);
    FA = await addOperator(pg, ['finance_admin']);
    FA2 = await addOperator(pg, ['finance_admin']);
    PO = await addOperator(pg, ['platform_owner']);
    PO2 = await addOperator(pg, ['platform_owner']);
    V1_CHECKSUM = (await pg.query(`SELECT content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [POLICY_V1])).rows[0].content_checksum as string;
    const content = { ...(seededPolicyV1().content as Record<string, unknown>), apply_expiry_hours: TTL_HOURS };
    V2_CHECKSUM = commercialPolicyChecksum(content);
    V2 = await activatePolicyV2(pg, content, V2_CHECKSUM);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  // ---- fixtures ---------------------------------------------------------------------------

  /** The requester of each covered type (its requester scope or role). */
  const requesterOf = (a: Covered): { user: string; role: string } =>
    a === 'POLICY_ACTIVATE' ? { user: FA, role: 'finance_admin' } : a === 'ROLE_GRANT' || a === 'ROLE_REVOKE' ? { user: PO, role: 'platform_owner' } : a === 'SUPPORT_EXTENSION' ? { user: SUP, role: 'support_admin' } : { user: OPS, role: 'commercial_ops' };

  /**
   * A request placed raw (triggers off for the INSERT only) in APPROVED / APPLY_FAILED / APPLYING,
   * finally approved at `A` under the snapshotted policy (`v2` with the 72 h TTL, or `v1` without).
   * The deadline machinery reads only the snapshot and approved_at; the payload checksum is real.
   */
  async function raw(a: Covered, o: { state?: string; policy?: 'v1' | 'v2'; kind?: string; tenant_id?: string } = {}): Promise<string> {
    const id = randomUUID();
    const tenant_id = GOVERNANCE.has(a) ? null : (o.tenant_id ?? (await newTenant(pg)));
    const payload = { probe: a };
    const [policy_version_id, policy_checksum] = o.policy === 'v1' ? [POLICY_V1, V1_CHECKSUM] : [V2, V2_CHECKSUM];
    await pg.query('BEGIN');
    await pg.query(`SET LOCAL session_replication_role = replica`);
    await pg.query(
      `INSERT INTO subscription."CommercialChangeRequest"
         (id, action_type, kind, state, tenant_id, product_key, payload, payload_checksum, required_chain, policy_version_id, policy_checksum,
          requested_by, reason, idempotency_key, created_at, submitted_at, expires_at, approved_at, apply_attempts, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12, 'b5r probe', $13, $14, $14, $15, $14, $16, $14)`,
      [
        id,
        a,
        o.kind ?? 'NORMAL',
        o.state ?? 'APPROVED',
        tenant_id,
        tenant_id === null ? null : 'sign',
        JSON.stringify(payload),
        payloadChecksum(payload),
        JSON.stringify(CHAIN),
        policy_version_id,
        policy_checksum,
        requesterOf(a).user,
        key(),
        A,
        new Date(A.getTime() + 72 * H),
        o.state === 'APPLY_FAILED' || o.state === 'APPLYING' ? 1 : 0,
      ],
    );
    if (o.state === 'APPLYING' && a === 'CONVERSION') {
      // A CONVERSION pending its provider command (C-13): it may commit in APPLYING with one.
      await pg.query(
        `INSERT INTO subscription."BillingProviderCommand" (id, provider, command_kind, change_request_id, step, idempotency_key, tenant_id, product_key, target_ref, params, state, attempts, created_by, created_at, updated_at)
         VALUES (gen_random_uuid(), 'STRIPE', 'SUBSCRIPTION_CANCEL', $1::uuid, 'end_self_service', 'aramo-ccp-' || $1::text || '-end_self_service', $2, 'sign', 'sub_b5r_probe', '{"mode":"IMMEDIATE"}', 'PENDING', 0, $3, now(), now())`,
        [id, tenant_id, OPS],
      );
    }
    await pg.query('COMMIT');
    return id;
  }
  const row = async (id: string) => (await prisma.commercialChangeRequest.findUniqueOrThrow({ where: { id } })) as CommercialChangeRequestRow;
  const stateOf = async (id: string) => (await row(id)).state;
  const events = async (id: string, type: string) => (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = $2 ORDER BY created_at, id`, [id, type])).rows.map((r) => r.payload as Record<string, unknown>);
  const expireAt = async (id: string, t: number) => prisma.$transaction(async (tx) => h.changeRequests.expireApplyIfDue(tx, await row(id), new Date(t), A6_CTX));
  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      const r = await p;
      const reason = (r as { reason?: unknown } | null)?.reason;
      return typeof reason === 'string' ? `OUTCOME:${reason}` : 'OK';
    } catch (e) {
      if (e instanceof CommercialApplyRefusedError) return `REFUSED:${e.reason}`;
      if (e instanceof CommercialApplyFailedError) return `FAILED:${e.code}`;
      if (e instanceof CommercialChangeRequestError) return e.code;
      throw e;
    }
  }
  /** The apply path each covered type is applied through. */
  function applyPath(a: Covered, id: string): Promise<unknown> {
    const r = requesterOf(a);
    if (a === 'CONVERSION') return h.conversions.apply(as(r.user, r.role), id, A6_CTX);
    if (a === 'ROLE_GRANT' || a === 'ROLE_REVOKE') return h.changeRequests.applyRoleChange(as(r.user, r.role), id, A6_CTX);
    return h.apply.apply(as(r.user, r.role), id, A6_CTX); // A7 revoke, A8 NORMAL extension, B5-R policy activation
  }

  // ---- the shared helper ------------------------------------------------------------------

  it('B5R-EXP-1 (AD-3, AD-4, AD-6) every newly covered type, from APPROVED and from APPLY_FAILED: still open at deadline − 1 ms; at the deadline exactly APPLY_EXPIRED with ONE audit event (half-open window); then terminal', async () => {
    let expired = 0;
    for (const a of COVERED) {
      for (const state of ['APPROVED', 'APPLY_FAILED']) {
        const id = await raw(a, { state });
        expect(await expireAt(id, DEADLINE - 1), `${a}/${state} before`).toBe(false);
        expect(await stateOf(id)).toBe(state);
        expect(await expireAt(id, DEADLINE), `${a}/${state} at`).toBe(true);
        expect(await stateOf(id)).toBe('APPLY_EXPIRED');
        const ev = await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED');
        expect(ev, `${a}/${state}`).toHaveLength(1);
        expect(ev[0]).toMatchObject({ action_type: a, from_state: state, final_approved_at: A.toISOString(), apply_deadline: new Date(DEADLINE).toISOString(), evaluated_at: new Date(DEADLINE).toISOString() });
        // Terminal: no transition out, and a second pass is a no-op (no second event).
        expect(await expireAt(id, DEADLINE + H)).toBe(false);
        await expect(pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = apply_attempts + 1 WHERE id = $1`, [id])).rejects.toThrow(/terminal state APPLY_EXPIRED is immutable/);
        expect(await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toHaveLength(1);
        expired += 1;
      }
    }
    expect(expired).toBe(12);
  });

  it('B5R-NEVER-1 (AD-2) a request snapshotted under policy v1 never expires, for every newly covered type: 10 000 h after approval it stays APPROVED', async () => {
    for (const a of COVERED) {
      const id = await raw(a, { policy: 'v1' });
      expect(await expireAt(id, A.getTime() + 10_000 * H), a).toBe(false);
      expect(await stateOf(id)).toBe('APPROVED');
      expect(await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toHaveLength(0);
      // Remove the never-expiring probe (append-only triggers off for the cleanup only): a v1
      // POLICY_ACTIVATE would otherwise hold the one policy slot for B5R-POL-1.
      await pg.query('BEGIN');
      await pg.query(`SET LOCAL session_replication_role = replica`);
      await pg.query(`DELETE FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id]);
      await pg.query('COMMIT');
    }
  });

  it('B5R-NEVER-2 (AD-4) a CONVERSION in APPLYING (pending its provider command) never expires — not by the helper, not by its apply, not by a read; a bounded EXCEPTION support extension is not affected', async () => {
    const t = await newTenant(pg);
    const id = await raw('CONVERSION', { state: 'APPLYING', tenant_id: t });
    at(A.getTime() + 10_000 * H);
    expect(await expireAt(id, now.getTime())).toBe(false);
    expect(await outcome(applyPath('CONVERSION', id))).toBe('OK'); // pending-provider: replayed, nothing to do
    expect((await h.changeRequests.get(as(OPS, 'commercial_ops'), id, A6_CTX)).request.state).toBe('APPLYING');
    await expect(pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_EXPIRED' WHERE id = $1`, [id])).rejects.toThrow(/APPLYING -> APPLY_EXPIRED is not allowed/);
    expect(await stateOf(id)).toBe('APPLYING');
    expect(await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toHaveLength(0);
    // A bounded EXCEPTION is never evaluated (and the guard never admits it → APPLY_EXPIRED).
    const ex = await raw('SUPPORT_EXTENSION', { kind: 'EXCEPTION' });
    expect(await expireAt(ex, now.getTime())).toBe(false);
    expect(await stateOf(ex)).toBe('APPROVED');
    await expect(pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_EXPIRED' WHERE id = $1`, [ex])).rejects.toThrow(/state APPROVED -> APPLY_EXPIRED is not allowed/);
  });

  // ---- wiring: apply, read, slot contention -----------------------------------------------

  it('B5R-WIRE-1 (AD-7, AD-8) each apply path is gated before anything else: at deadline − 1 ms the requester passes the gate (and is refused later, on the raw fixture’s missing approvals, with no state change); at the deadline the apply commits APPLY_EXPIRED (one event, no refusal row) and refuses APPLY_EXPIRED; a later attempt is an audited APPLY_EXPIRED refusal', async () => {
    for (const a of COVERED) {
      const id = await raw(a);
      at(DEADLINE - 1);
      const before = await outcome(applyPath(a, id));
      expect(before, a).not.toMatch(/APPLY_EXPIRED/);
      expect(await stateOf(id), a).toBe('APPROVED');
      at(DEADLINE);
      const refusedBefore = (await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED')).length;
      const atDeadline = await outcome(applyPath(a, id));
      expect(atDeadline, a).toMatch(/APPLY_EXPIRED$/);
      expect(await stateOf(id), a).toBe('APPLY_EXPIRED');
      expect(await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED'), a).toHaveLength(1);
      expect((await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED')).length, a).toBe(refusedBefore);
      const again = await outcome(applyPath(a, id));
      expect(again, a).toMatch(/APPLY_EXPIRED$/);
      expect((await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED')).length, a).toBe(refusedBefore + 1);
      expect(await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED'), a).toHaveLength(1);
    }
  });

  it('B5R-WIRE-2 (AD-7) a read evaluates the deadline lazily for every newly covered type (get and list); a read before the deadline changes nothing', async () => {
    for (const a of COVERED) {
      const id = await raw(a);
      at(DEADLINE - 1);
      expect((await h.changeRequests.get(as(OPS, 'commercial_ops'), id, A6_CTX)).request.state, a).toBe('APPROVED');
      at(DEADLINE);
      if (a === 'ROLE_REVOKE') {
        const listed = await h.changeRequests.list(as(OPS, 'commercial_ops'), { limit: 200 }, A6_CTX);
        expect(listed.requests.find((r) => r.id === id)?.state).toBe('APPLY_EXPIRED');
      } else {
        const view = await h.changeRequests.get(as(OPS, 'commercial_ops'), id, A6_CTX);
        expect(view.request.state, a).toBe('APPLY_EXPIRED');
        expect(view.apply_actionable).toBe(false);
      }
      expect(await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED'), a).toHaveLength(1);
    }
  });

  it('B5R-WIRE-3 (AD-5) slot contention releases the tenant × product slot held by an approved CONVERSION, ENTITLEMENT_REVOKE or NORMAL SUPPORT_EXTENSION once its apply authority lapsed', async () => {
    for (const a of ['CONVERSION', 'ENTITLEMENT_REVOKE', 'SUPPORT_EXTENSION'] as const) {
      const t = await newTenant(pg);
      const id = await raw(a, { tenant_id: t });
      const withPlan = async () => {
        const plan_version_id = await publishedVersion(pg, INCLUDED);
        return h.changeRequests.create(
          as(OPS, 'commercial_ops'),
          { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id, replaces_subscription_id: null }, reason: 'slot', idempotency_key: key() },
          A6_CTX,
        );
      };
      at(DEADLINE - 1);
      expect(await outcome(withPlan()), a).toBe('OPEN_REQUEST_EXISTS');
      at(DEADLINE);
      expect(await outcome(withPlan()), a).toBe('OK');
      expect(await stateOf(id), a).toBe('APPLY_EXPIRED');
      expect(await events(id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED'), a).toHaveLength(1);
    }
  });

  // ---- the policy screen path, end to end -------------------------------------------------

  it('B5R-POL-1 POLICY_ACTIVATE under the v2 snapshot: applied by its requester inside the window; past it the governance read expires it lazily and unlocks the draft; a create contending for the policy slot expires an approved one; the expired request refuses its apply', async () => {
    const NOW0 = A.getTime() + 1_000 * H; // after the raw fixtures above
    at(NOW0);
    const draft = await gov.createDraft(as(FA, 'finance_admin'), { source_version_id: V2 }, A6_CTX);
    const request = async () => {
      const { request: r } = await h.changeRequests.create(as(FA, 'finance_admin'), { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: draft.id }, reason: 'activate', idempotency_key: key() }, A6_CTX);
      await h.changeRequests.submit(as(FA, 'finance_admin'), r.id, A6_CTX);
      await h.changeRequests.approve(as(FA2, 'finance_admin'), r.id, { step_index: 0 }, A6_CTX);
      const done = await h.changeRequests.approve(as(PO, 'platform_owner'), r.id, { step_index: 1 }, A6_CTX);
      expect(done.request.state).toBe('APPROVED');
      expect(done.request.policy_version_id).toBe(V2);
      return { id: r.id, approved: (done.request.approved_at as Date).getTime() };
    };
    // (a) the governance read past the deadline expires it and releases the draft.
    const r1 = await request();
    at(r1.approved + TTL_HOURS * H);
    const listed = (await gov.list(as(FA, 'finance_admin'), A6_CTX)).versions.find((v) => v.row.id === draft.id);
    expect(listed?.open_request).toBeNull();
    expect(listed?.latest_request).toMatchObject({ id: r1.id, state: 'APPLY_EXPIRED', applied_at: null });
    expect(await stateOf(r1.id)).toBe('APPLY_EXPIRED');
    expect(await events(r1.id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toHaveLength(1);
    expect(await outcome(gov.updateDraft(as(FA, 'finance_admin'), draft.id, { content: { approval_expiry_hours: 60 } }, A6_CTX))).toBe('OK');
    expect(await outcome(h.apply.apply(as(FA, 'finance_admin'), r1.id, A6_CTX))).toBe('APPLY_EXPIRED');
    expect(await events(r1.id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED')).toHaveLength(1);
    // (b) an APPROVED activation holds the one policy slot until its deadline; a create at the deadline expires it.
    const r2 = await request();
    const create = () => h.changeRequests.create(as(FA, 'finance_admin'), { action_type: 'POLICY_ACTIVATE', payload: { policy_version_id: draft.id }, reason: 'again', idempotency_key: key() }, A6_CTX);
    at(r2.approved + TTL_HOURS * H - 1);
    expect(await outcome(create())).toBe('OPEN_REQUEST_EXISTS');
    expect(await stateOf(r2.id)).toBe('APPROVED');
    at(r2.approved + TTL_HOURS * H);
    const r3 = await create();
    expect(r3.request.state).toBe('DRAFT');
    expect(await stateOf(r2.id)).toBe('APPLY_EXPIRED');
    expect(await events(r2.id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toHaveLength(1);
    // (c) inside the window (deadline − 1 ms) the requester applies it: APPLIED.
    await h.changeRequests.submit(as(FA, 'finance_admin'), r3.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA2, 'finance_admin'), r3.request.id, { step_index: 0 }, A6_CTX);
    const approved = await h.changeRequests.approve(as(PO2, 'platform_owner'), r3.request.id, { step_index: 1 }, A6_CTX);
    at((approved.request.approved_at as Date).getTime() + TTL_HOURS * H - 1);
    const out = await h.apply.apply(as(FA, 'finance_admin'), r3.request.id, A6_CTX);
    expect(out.request).toMatchObject({ state: 'APPLIED', apply_attempts: 1 });
    expect((await pg.query(`SELECT status FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [draft.id])).rows[0].status).toBe('ACTIVE');
    expect(await events(r3.request.id, 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED')).toHaveLength(0);
  });
});
