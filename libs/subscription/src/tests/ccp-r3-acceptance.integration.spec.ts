import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BillingFinanceReportService } from '../lib/billing/billing-finance-report.service.js';
import { CapacityService } from '../lib/capacity.service.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { CommercialApprovalRefusedError, CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { CommercialAlertService } from '../lib/observability/commercial-alert.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, a6Harness, as, newTenant, rawSubscription, type A6Harness } from './support/ccp-a6.js';

// CCP-R3 (acceptance reconciliation; doc/ccp/decisions.md "Architect program acceptance
// disposition (2026-10-25)") on real Postgres 17 with the real services:
//   item 3  TD-A7-5 — effective access fails closed without a revoke: once the subscription ended
//           and its grace and overlay authority ended, the allowance AND capacity decisions refuse
//           while the entitlement row stays ACTIVE; the D3 ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION
//           alert raises past grace / overlay, auto-resolves, never revokes; the C6 report agrees.
//   item 5  TD-B2-1 — PLAN_RETIRE without plan_version_id is refused (plan_version_id_required).
//   item 6  TD-D3-9 — an approval-expired request reads as expired and is refused at approve and
//           at apply with NO sweep worker (expireDue is never called).

const T0 = new Date('2026-10-25T12:00:00.000Z');
const H = 3_600_000;
const KEY = 'sign.envelopes';
const STORAGE = 'sign.storage_bytes';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-R3 acceptance reconciliation (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let capacity: CapacityService;
  let alerts: CommercialAlertService;
  let reports: BillingFinanceReportService;
  let OPS: string;
  let FA: string;
  let CM: string;
  let now = T0;
  let keyN = 0;
  const key = () => `r3-key-${String(++keyN).padStart(6, '0')}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => now);
    capacity = new CapacityService(prisma);
    alerts = new CommercialAlertService(prisma);
    reports = new BillingFinanceReportService(prisma, h.billing);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
    CM = await addOperator(pg, ['catalog_manager']);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const entitle = async (t: string) => {
    for (const c of ['core', 'sign']) await pg.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, $2::entitlement."Capability", 'PROVISIONING')`, [t, c]);
  };
  const liveEntitlements = async (t: string) =>
    (await pg.query(`SELECT capability::text c FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY 1`, [t])).rows.map((r) => r.c as string);
  const reserveSend = (t: string, at: Date) => h.allowance.reserve({ tenant_id: t, product_key: 'sign', allowance_key: KEY, send_key: randomUUID(), at });
  const reserveBytes = (t: string, at: Date) => capacity.reserve({ tenant_id: t, product_key: 'sign', capacity_key: STORAGE, ref: `r3:${randomUUID()}`, quantity: 10, at });
  const openAlerts = async (t: string) =>
    (await pg.query(`SELECT alert_type, family, subject_kind, subject_id, status, evidence FROM subscription."CommercialOperationalAlert" WHERE tenant_id = $1 AND alert_type = 'ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION' AND status = 'OPEN' ORDER BY first_detected_at`, [t])).rows;
  const overlay = async (t: string, sub: string, extends_until: Date) => {
    // A raw overlay row: the A8 trigger and FK require its applying request, which these
    // readers never consult (the allowance, capacity and alert read the overlay table only).
    await pg.query(`SET session_replication_role = replica`);
    try {
      await pg.query(
        `INSERT INTO subscription."SupportExtension" (id, tenant_id, product_key, subscription_id, change_request_id, is_exception, days, grace_until_at_apply, base_until, extends_until, policy_version_id, applied_by, applied_at)
         VALUES (gen_random_uuid(), $1, 'sign', $2, gen_random_uuid(), true, 1, NULL, $3, $4, '019a0000-0000-7000-8000-0000000cc201', $5, $3)`,
        [t, sub, new Date(extends_until.getTime() - 24 * H), extends_until, OPS],
      );
    } finally {
      await pg.query(`SET session_replication_role = DEFAULT`);
    }
  };

  // ---- item 3 — TD-A7-5 -------------------------------------------------------------------

  it('R3-A75-1 an ENDED subscription with its entitlement still ACTIVE (no revoke): the allowance read and reserve refuse, the enforced capacity reserve refuses; the entitlement row is untouched', async () => {
    const t = await newTenant(pg);
    const sub = await rawSubscription(pg, t, { source: 'MANUAL', plan: INCLUDED });
    await entitle(t);
    expect((await reserveSend(t, T0)).ok).toBe(true);
    expect((await reserveBytes(t, T0)).ok).toBe(true);
    await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = $2, status = 'CANCELED' WHERE id = $1`, [sub, new Date(T0.getTime() + H)]);
    const at = new Date(T0.getTime() + 2 * H);
    expect(await h.allowance.getStatus(t, 'sign', KEY, at)).toEqual({ subscribed: false, allowance_key: KEY, state: 'NONE' });
    expect(await reserveSend(t, at)).toMatchObject({ ok: false });
    expect(await reserveBytes(t, at)).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED' });
    expect(await liveEntitlements(t)).toEqual(['core', 'sign']);
  });

  it('R3-A75-2 an ENDED subscription whose grace and overlay authority have ended: with the ended row\'s grace still running and a live overlay on it, nothing re-admits (an ended row is never open); past both, both decisions refuse; the entitlement stays ACTIVE', async () => {
    const t = await newTenant(pg);
    const sub = await rawSubscription(pg, t, { source: 'MANUAL', plan: INCLUDED, status: 'PAST_DUE' });
    await entitle(t);
    const grace = new Date(T0.getTime() + 2 * H);
    const until = new Date(T0.getTime() + 5 * H);
    await pg.query(`UPDATE subscription."TenantSubscription" SET grace_until = $2 WHERE id = $1`, [sub, grace]);
    await overlay(t, sub, until);
    expect((await reserveSend(t, T0)).ok).toBe(true);
    await pg.query(`UPDATE subscription."TenantSubscription" SET ended_at = $2, status = 'CANCELED' WHERE id = $1`, [sub, new Date(T0.getTime() + H)]);
    for (const at of [new Date(T0.getTime() + H + 1), new Date(grace.getTime() + 1), until, new Date(until.getTime() + H)]) {
      expect(await reserveSend(t, at), at.toISOString()).toMatchObject({ ok: false });
      expect(await reserveBytes(t, at), at.toISOString()).toMatchObject({ ok: false, reason: 'NOT_SUBSCRIBED' });
      expect(await h.allowance.getStatus(t, 'sign', KEY, at)).toEqual({ subscribed: false, allowance_key: KEY, state: 'NONE' });
    }
    // Kept objects (signed copies, certificates) are still measured, never refused.
    expect((await capacity.reserve({ tenant_id: t, product_key: 'sign', capacity_key: STORAGE, ref: 'r3:kept', quantity: 5, enforce: false, at: until })).ok).toBe(true);
    expect(await liveEntitlements(t)).toEqual(['core', 'sign']);
  });

  it('R3-A75-3 an OPEN PAST_DUE row: the allowance (sending) decision refuses once grace ended, a live overlay re-admits it, and at extends_until (half-open) it refuses again — independent of the ACTIVE entitlement. The capacity (upload) decision of an OPEN row is unchanged (the CCP-A4 Sign golden pins it; TD-R3-1)', async () => {
    const t = await newTenant(pg);
    const sub = await rawSubscription(pg, t, { source: 'MANUAL', plan: INCLUDED, status: 'PAST_DUE' });
    await entitle(t);
    const grace = new Date(T0.getTime() + H);
    await pg.query(`UPDATE subscription."TenantSubscription" SET grace_until = $2 WHERE id = $1`, [sub, grace]);
    expect((await reserveSend(t, T0)).ok).toBe(true);
    expect(await reserveSend(t, grace)).toMatchObject({ ok: false });
    const until = new Date(T0.getTime() + 5 * H);
    await overlay(t, sub, until);
    expect((await reserveSend(t, new Date(until.getTime() - 1))).ok).toBe(true);
    expect(await reserveSend(t, until)).toMatchObject({ ok: false });
    for (const status of ['INCOMPLETE', 'CANCELED']) {
      const t2 = await newTenant(pg);
      await rawSubscription(pg, t2, { source: 'MANUAL', plan: INCLUDED, status });
      expect(await reserveSend(t2, T0), status).toMatchObject({ ok: false });
    }
    expect(await liveEntitlements(t)).toEqual(['core', 'sign']);
  });

  it('R3-A75-4 the D3 alert ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION (BILLING, product_entitlement): not raised while an ended row\'s grace or a live overlay remains; raised past both; refreshed, never revokes; auto-resolves when an open subscription returns; the C6 report lists the same gap with the same residual authority at every instant', async () => {
    const t = await newTenant(pg);
    const sub = await rawSubscription(pg, t, { source: 'MANUAL', plan: INCLUDED, status: 'PAST_DUE' });
    await entitle(t);
    const grace = new Date(T0.getTime() + 2 * H);
    await pg.query(`UPDATE subscription."TenantSubscription" SET grace_until = $2, ended_at = $3, status = 'CANCELED' WHERE id = $1`, [sub, grace, new Date(T0.getTime() + H)]);
    const gapAt = async (at: Date) => (await reports.reconciliationReport({ tenant_id: t, as_of: at })).entitled_without_subscription;

    // Inside the ended row's grace: a gap with residual GRACE, no alert.
    const a1 = new Date(T0.getTime() + H + 1);
    await alerts.scan(a1);
    expect(await openAlerts(t)).toEqual([]);
    expect(await gapAt(a1)).toEqual([expect.objectContaining({ tenant_id: t, product_key: 'sign', capabilities: ['sign'], residual_authority: 'GRACE', residual_authority_until: grace })]);

    // Grace over, a live overlay: residual SUPPORT_OVERLAY, still no alert.
    const until = new Date(T0.getTime() + 4 * H);
    await overlay(t, sub, until);
    const a2 = new Date(grace.getTime() + 1);
    await alerts.scan(a2);
    expect(await openAlerts(t)).toEqual([]);
    expect((await gapAt(a2))[0]).toMatchObject({ residual_authority: 'SUPPORT_OVERLAY', residual_authority_until: until });

    // Past both (half-open: exactly at extends_until): the alert raises; the report agrees.
    await alerts.scan(until);
    const raised = await openAlerts(t);
    expect(raised).toEqual([
      { alert_type: 'ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION', family: 'BILLING', subject_kind: 'product_entitlement', subject_id: `${t}:sign`, status: 'OPEN', evidence: { capabilities: ['sign'], open_base_subscription: false, residual_authority: null } },
    ]);
    expect((await gapAt(until))[0]).toMatchObject({ residual_authority: null, residual_authority_until: null });
    // A second scan refreshes (one OPEN row); nothing is revoked.
    await alerts.scan(new Date(until.getTime() + H));
    expect((await pg.query(`SELECT detection_count FROM subscription."CommercialOperationalAlert" WHERE subject_id = $1 AND status = 'OPEN'`, [`${t}:sign`])).rows).toEqual([{ detection_count: 2 }]);
    expect(await liveEntitlements(t)).toEqual(['core', 'sign']);

    // An open subscription returns → the next scan resolves it; the report has no gap.
    await rawSubscription(pg, t, { source: 'MANUAL', plan: INCLUDED });
    const a4 = new Date(until.getTime() + 2 * H);
    await alerts.scan(a4);
    expect(await openAlerts(t)).toEqual([]);
    const resolved = (await pg.query(`SELECT status, resolution_detail FROM subscription."CommercialOperationalAlert" WHERE subject_id = $1`, [`${t}:sign`])).rows;
    expect(resolved).toEqual([{ status: 'RESOLVED', resolution_detail: expect.stringContaining('open subscription') }]);
    expect(await gapAt(a4)).toEqual([]);
  });

  it('R3-A75-5 the alert set equals the report\'s null-residual set across tenants (one rule): a governed revoke also resolves the alert; a "core"-only tenant is never a gap', async () => {
    const tRevoked = await newTenant(pg);
    await entitle(tRevoked);
    const tCore = await newTenant(pg);
    await pg.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability, granted_source) VALUES ($1, 'core'::entitlement."Capability", 'PROVISIONING')`, [tCore]);
    const at = new Date(T0.getTime() + 20 * H);
    await alerts.scan(at);
    const report = await reports.reconciliationReport({ as_of: at });
    const reportAlertSet = report.entitled_without_subscription.filter((g) => g.residual_authority === null).map((g) => `${g.tenant_id}:${g.product_key}`).sort();
    const alertSet = (await pg.query(`SELECT subject_id FROM subscription."CommercialOperationalAlert" WHERE alert_type = 'ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION' AND status = 'OPEN' ORDER BY 1`)).rows.map((r) => r.subject_id as string);
    expect(alertSet).toEqual(reportAlertSet);
    expect(alertSet).toContain(`${tRevoked}:sign`);
    expect(alertSet.some((s) => s.startsWith(tCore))).toBe(false);
    // The governed revoke (CCP-A7 keeps the row, sets revoked_at / revoked_by / its request) ends the
    // condition. Written raw: the alert reads the row's revoked_at only.
    await pg.query(`SET session_replication_role = replica`);
    try {
      await pg.query(`UPDATE entitlement."TenantEntitlement" SET revoked_at = $2, revoked_by = $3, revoke_change_request_id = gen_random_uuid() WHERE tenant_id = $1 AND capability = 'sign'`, [tRevoked, at, OPS]);
    } finally {
      await pg.query(`SET session_replication_role = DEFAULT`);
    }
    await alerts.scan(new Date(at.getTime() + H));
    expect((await pg.query(`SELECT status FROM subscription."CommercialOperationalAlert" WHERE subject_id = $1`, [`${tRevoked}:sign`])).rows).toEqual([{ status: 'RESOLVED' }]);
  });

  // ---- item 5 — TD-B2-1 -------------------------------------------------------------------

  it('R3-B21-1 PLAN_RETIRE without plan_version_id is refused at create with INVALID_INPUT / plan_version_id_required; nothing is written', async () => {
    const before = (await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest"`)).rows[0].n;
    for (const payload of [{}, { plan_version_id: null }, { plan_id: randomUUID() }]) {
      const e = await h.changeRequests.create(as(CM, 'catalog_manager'), { action_type: 'PLAN_RETIRE', payload, reason: 'retire', idempotency_key: key() }, A6_CTX).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CommercialChangeRequestError);
      expect(e).toMatchObject({ code: 'INVALID_INPUT', details: { reason: 'plan_version_id_required' } });
    }
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest"`)).rows[0].n).toBe(before);
  });

  // ---- item 6 — TD-D3-9 -------------------------------------------------------------------

  it('R3-D39-1 with NO sweep worker: a request past its approval expiry reads as expired, the approve is refused EXPIRED (lazily recorded), and the apply is refused; expireDue is never called', async () => {
    const sweep = vi.spyOn(h.changeRequests, 'expireDue');
    now = T0;
    const t = await newTenant(pg);
    const created = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CREDIT', tenant_id: t, product_key: 'sign', payload: { amount_minor: 100, currency: 'USD' }, reason: 'r3 expiry', idempotency_key: key() }, A6_CTX);
    const submitted = await h.changeRequests.submit(as(OPS, 'commercial_ops'), created.request.id, A6_CTX);
    expect(submitted.expires_at).not.toBeNull();
    now = new Date((submitted.expires_at as Date).getTime());
    // Read time (half-open: exactly at expires_at it is expired); the row is still PENDING_APPROVAL (nothing swept it).
    const view = await h.changeRequests.get(as(FA, 'finance_admin'), created.request.id, A6_CTX);
    expect(view.is_expired).toBe(true);
    expect(view.request.state).toBe('PENDING_APPROVAL');
    expect(view.chain_satisfiable).toBeNull();
    // Approve time: refused, and the request is now EXPIRED.
    const refused = await h.changeRequests.approve(as(FA, 'finance_admin'), created.request.id, { step_index: 0 }, A6_CTX).catch((x: unknown) => x);
    expect(refused).toBeInstanceOf(CommercialApprovalRefusedError);
    expect((refused as CommercialApprovalRefusedError).refusal).toBe('EXPIRED');
    expect((await pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [created.request.id])).rows[0].state).toBe('EXPIRED');
    // Apply time: refused (never approved), nothing applied.
    const applied = await h.apply.apply(as(OPS, 'commercial_ops'), created.request.id, A6_CTX).catch((x: unknown) => x);
    expect(applied instanceof CommercialApplyRefusedError || applied instanceof CommercialChangeRequestError).toBe(true);
    expect((await pg.query(`SELECT count(*)::int n FROM subscription."CommercialChangeApplication" WHERE change_request_id = $1`, [created.request.id])).rows[0].n).toBe(0);
    expect(sweep).not.toHaveBeenCalled();
    sweep.mockRestore();
    now = T0;
  });
});
