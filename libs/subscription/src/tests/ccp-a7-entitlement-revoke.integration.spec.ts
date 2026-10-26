import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommercialApplyFailedError, type CommercialApplyFaultPoint } from '../lib/commercial/commercial-apply.service.js';
import { CommercialApplyRefusedError } from '../lib/commercial/commercial-approval-eligibility.js';
import { type CommercialActionType } from '../lib/commercial/commercial-change-request.js';
import { CommercialChangeRequestError } from '../lib/commercial/commercial-change-request.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, a6Harness, as, domainSnapshot, newTenant, publishedVersion, type A6Harness } from './support/ccp-a6.js';

// CCP-A7 (PBD §5.1 row A7 mandatory tests; Charter D1; Conv. C-20, C-24) on real Postgres 17:
// the governed ENTITLEMENT_REVOKE through the A6 transactional apply, the in-flight signing
// continuity, the governed re-grant, the commercial provenance of A6 grants, the guard function
// A7 branch, and that SUBSCRIPTION_END still never revokes. identity + entitlement + metering +
// EVERY subscription migration applied whole-file. Test IDs are cited by
// doc/ccp/slices/CCP-A7-acceptance.md.

const T0 = new Date('2026-10-26T12:00:00.000Z');
const REPO_ROOT = resolve(__dirname, '../../../..');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A7 governed entitlement revoke (real Postgres 17)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let faultAt: CommercialApplyFaultPoint | null = null;
  let OPS: string;
  let FA: string;
  let keyN = 0;
  const key = () => `a7-key-${String(++keyN).padStart(6, '0')}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => T0, (point) => {
      if (point === faultAt) throw new Error(`injected fault at ${point}`);
    });
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  async function approved(action_type: CommercialActionType, tenant_id: string, payload: Record<string, unknown>): Promise<string> {
    const r = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type, tenant_id, product_key: 'sign', payload, reason: 'governed change', idempotency_key: key() }, A6_CTX);
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    const a = await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    expect(a.request.state).toBe('APPROVED');
    return r.request.id;
  }
  const applyAs = (id: string) => h.apply.apply(as(OPS, 'commercial_ops'), id, A6_CTX);
  async function outcome(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'APPLIED';
    } catch (e) {
      if (e instanceof CommercialApplyFailedError) return `FAILED:${e.code}`;
      if (e instanceof CommercialApplyRefusedError) return `REFUSED:${e.reason}`;
      if (e instanceof CommercialChangeRequestError) return `ERROR:${e.code}`;
      throw e;
    }
  }
  const request = async (id: string) => (await pg.query(`SELECT state, apply_attempts, applied_at FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0];
  const events = async (id: string) => (await pg.query(`SELECT event_type FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.event_type as string);
  const ent = async (t: string) =>
    (await pg.query(`SELECT capability::text, granted_source, change_request_id, revoked_at IS NOT NULL AS revoked, revoke_change_request_id FROM entitlement."TenantEntitlement" WHERE tenant_id = $1 ORDER BY capability`, [t])).rows;
  const ledger = async (t: string) =>
    (await pg.query(`SELECT capability::text, event_type, granted_source FROM entitlement."TenantEntitlementEvent" WHERE tenant_id = $1 ORDER BY occurred_at, event_type, capability`, [t])).rows.map((r) => `${r.capability}:${r.event_type}:${r.granted_source}`);
  const openRows = async (t: string) => (await pg.query(`SELECT id, source FROM subscription."TenantSubscription" WHERE tenant_id = $1 AND ended_at IS NULL`, [t])).rows;
  async function raises(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
    } catch (e) {
      try {
        await pg.query('ROLLBACK');
      } catch {
        /* not in a transaction */
      }
      return (e as Error).message;
    }
    throw new Error(`expected the statement to raise: ${sql}`);
  }
  /** A tenant with a governed MANUAL Sign subscription (core + sign granted by the plan). */
  async function subscribed(): Promise<{ t: string; open_id: string; subscription_id: string }> {
    const t = await newTenant(pg);
    const open_id = await approved('SUBSCRIPTION_OPEN', t, { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null });
    const out = await applyAs(open_id);
    return { t, open_id, subscription_id: out.application.subscription_id as string };
  }

  it('A7-PROV-1 governed grants carry commercial provenance: SUBSCRIPTION_OPEN grants the bundle as PLAN, ENTITLEMENT_GRANT as MANUAL, each with its change request', async () => {
    const { t, open_id } = await subscribed();
    expect(await ent(t)).toEqual([
      { capability: 'core', granted_source: 'PLAN', change_request_id: open_id, revoked: false, revoke_change_request_id: null },
      { capability: 'sign', granted_source: 'PLAN', change_request_id: open_id, revoked: false, revoke_change_request_id: null },
    ]);
    const u = await newTenant(pg);
    const grant = await approved('ENTITLEMENT_GRANT', u, { capabilities: ['sign'] });
    await applyAs(grant);
    expect(await ent(u)).toEqual([{ capability: 'sign', granted_source: 'MANUAL', change_request_id: grant, revoked: false, revoke_change_request_id: null }]);
    const granted = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_ENTITLEMENT_GRANTED'`, [grant])).rows[0].payload;
    expect(granted).toMatchObject({ granted_source: 'MANUAL', inserted: ['sign'] });
  });

  it('A7-REV-1 ENTITLEMENT_REVOKE: one transaction revokes `sign` (row kept, revoked by this request), records capabilities_revoked and the audit events, then APPLIED; the subscription stays open', async () => {
    const { t, open_id } = await subscribed();
    const id = await approved('ENTITLEMENT_REVOKE', t, { capabilities: ['sign'] });
    const out = await applyAs(id);
    expect(out.replayed).toBe(false);
    expect(out.request).toMatchObject({ state: 'APPLIED', apply_attempts: 1 });
    expect(out.application).toMatchObject({ action_type: 'ENTITLEMENT_REVOKE', subscription_id: null, capabilities: [], capabilities_inserted: [], capabilities_revoked: ['sign'], attempt: 1, applied_by: OPS });
    expect(await ent(t)).toEqual([
      { capability: 'core', granted_source: 'PLAN', change_request_id: open_id, revoked: false, revoke_change_request_id: null },
      { capability: 'sign', granted_source: 'PLAN', change_request_id: open_id, revoked: true, revoke_change_request_id: id },
    ]);
    expect((await ledger(t)).filter((e) => e.startsWith('sign:'))).toEqual(['sign:GRANTED:PLAN', 'sign:REVOKED:PLAN']);
    expect(await events(id)).toEqual([
      'COMMERCIAL_CHANGE_REQUEST_CREATED',
      'COMMERCIAL_CHANGE_REQUEST_SUBMITTED',
      'COMMERCIAL_APPROVAL_RECORDED',
      'COMMERCIAL_CHANGE_REQUEST_APPROVED',
      'COMMERCIAL_ENTITLEMENT_REVOKED',
      'COMMERCIAL_CHANGE_REQUEST_APPLIED',
    ]);
    const applied = (await pg.query(`SELECT payload FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLIED'`, [id])).rows[0].payload;
    expect(applied).toMatchObject({ outcome: 'APPLIED', capabilities: [], capabilities_revoked: ['sign'], requested_by: OPS });
    expect((await openRows(t)).map((r) => r.source)).toEqual(['MANUAL']);
    // Idempotent replay: nothing written.
    const before = await domainSnapshot(pg, t, id);
    const again = await applyAs(id);
    expect(again.replayed).toBe(true);
    expect(again.application.id).toBe(out.application.id);
    expect(await domainSnapshot(pg, t, id)).toEqual(before);
  });

  it('A7-REV-2 in-flight signing completes: a send reserved before the revoke is consumed after it (the signing path never reads the entitlement); the signer transport carries no capability gate', async () => {
    const { t } = await subscribed();
    const reserved = await h.allowance.reserve({ tenant_id: t, product_key: 'sign', allowance_key: 'sign.envelopes', send_key: 'in-flight-env-1', at: T0 });
    expect(reserved.ok).toBe(true);
    await applyAs(await approved('ENTITLEMENT_REVOKE', t, { capabilities: ['sign'] }));
    expect((await ent(t)).find((r) => r.capability === 'sign')).toMatchObject({ revoked: true });
    expect(await h.allowance.consume({ tenant_id: t, product_key: 'sign', allowance_key: 'sign.envelopes', send_key: 'in-flight-env-1', usage_event_type: 'sign.envelope.sent', at: T0 })).toBe('CONSUMED');
    // C-24 / DOC-4 R-4-9: the public signer transport (/v1/sign/signing) is authorized by the
    // SigningSession capability token, never the tenant bundle.
    const controller = readFileSync(resolve(REPO_ROOT, 'apps/sign-service/src/app/esign-http.controller.ts'), 'utf8');
    expect(controller).toContain("@Controller('v1/sign/signing')");
    for (const gate of ['RequireCapability', 'EntitlementGuard', 'EntitlementRepository', 'TenantEntitlementReader', 'getCapabilities']) expect(controller).not.toContain(gate);
  });

  it('A7-REV-3 refusals fail closed with no partial state (APPLY_FAILED, retryable): `core` is not revocable, a capability outside the product is refused, a capability not held is stale', async () => {
    // One tenant per case: an APPLY_FAILED request keeps the Q14 slot (one open request per tenant × product).
    for (const [caps, code] of [
      [['core'], 'FAILED:CAPABILITY_NOT_REVOCABLE'],
      [['ats'], 'FAILED:CAPABILITY_NOT_IN_PRODUCT'],
    ] as const) {
      const { t } = await subscribed();
      const id = await approved('ENTITLEMENT_REVOKE', t, { capabilities: [...caps] });
      const before = await domainSnapshot(pg, t, id);
      const rows = await ent(t);
      expect(await outcome(applyAs(id))).toBe(code);
      expect(await domainSnapshot(pg, t, id)).toEqual(before);
      expect(await ent(t)).toEqual(rows);
      expect(await request(id)).toMatchObject({ state: 'APPLY_FAILED', apply_attempts: 1, applied_at: null });
    }
    const u = await newTenant(pg);
    const stale = await approved('ENTITLEMENT_REVOKE', u, { capabilities: ['sign'] });
    expect(await outcome(applyAs(stale))).toBe('FAILED:CAPABILITY_NOT_HELD');
    expect(await ent(u)).toEqual([]);
  });

  it('A7-REV-4 re-grant clears the revoke: a governed ENTITLEMENT_GRANT restores the row (MANUAL, its change request), counts it inserted, and the ledger records REGRANTED', async () => {
    const { t } = await subscribed();
    await applyAs(await approved('ENTITLEMENT_REVOKE', t, { capabilities: ['sign'] }));
    const grant = await approved('ENTITLEMENT_GRANT', t, { capabilities: ['core', 'sign'] });
    const out = await applyAs(grant);
    expect(out.application).toMatchObject({ capabilities: ['core', 'sign'], capabilities_inserted: ['sign'], capabilities_revoked: [] });
    expect((await ent(t)).find((r) => r.capability === 'sign')).toEqual({ capability: 'sign', granted_source: 'MANUAL', change_request_id: grant, revoked: false, revoke_change_request_id: null });
    expect((await ledger(t)).filter((e) => e.startsWith('sign:'))).toEqual(['sign:GRANTED:PLAN', 'sign:REVOKED:PLAN', 'sign:REGRANTED:MANUAL']);
    // The revoke can be applied again after the re-grant (a new governed request).
    expect(await outcome(applyAs(await approved('ENTITLEMENT_REVOKE', t, { capabilities: ['sign'] })))).toBe('APPLIED');
  });

  for (const point of ['after_subscription_write', 'after_entitlement_write', 'before_applied'] as const) {
    it(`A7-FAULT-${point} a fault ${point.replace(/_/g, ' ')} rolls the revoke back (the row stays active); APPLY_FAILED; the retry applies`, async () => {
      const { t } = await subscribed();
      const id = await approved('ENTITLEMENT_REVOKE', t, { capabilities: ['sign'] });
      const before = await domainSnapshot(pg, t, id);
      const rows = await ent(t);
      const led = await ledger(t);
      faultAt = point;
      try {
        expect(await outcome(applyAs(id))).toBe('FAILED:UNEXPECTED');
      } finally {
        faultAt = null;
      }
      expect(await domainSnapshot(pg, t, id)).toEqual(before);
      expect(await ent(t)).toEqual(rows);
      expect(await ledger(t)).toEqual(led);
      expect(await request(id)).toMatchObject({ state: 'APPLY_FAILED', apply_attempts: 1, applied_at: null });
      const retry = await applyAs(id);
      expect(retry.request).toMatchObject({ state: 'APPLIED', apply_attempts: 2 });
      expect(retry.application).toMatchObject({ attempt: 2, capabilities_revoked: ['sign'] });
    });
  }

  it('A7-END-1 SUBSCRIPTION_END still never revokes (Conv. C-20; TD-A6-8): the capability stays active after the end', async () => {
    const { t, subscription_id } = await subscribed();
    await applyAs(await approved('SUBSCRIPTION_END', t, { subscription_id }));
    expect((await ent(t)).map((r) => [r.capability, r.revoked])).toEqual([
      ['core', false],
      ['sign', false],
    ]);
  });

  it('A7-SM-DB the A7 guard branch: ENTITLEMENT_REVOKE moves only APPROVED | APPLY_FAILED → APPLYING → APPLIED | APPLY_FAILED, counts attempts, never commits in APPLYING, and APPLIED needs its application and a revoke by this request', async () => {
    const { t } = await subscribed();
    const id = await approved('ENTITLEMENT_REVOKE', t, { capabilities: ['sign'] });
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toBe('CommercialChangeRequest state APPROVED -> APPLIED is not allowed');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING' WHERE id = $1`, [id])).toBe('CommercialChangeRequest APPLYING must count the attempt (apply_attempts 0 -> 0)');
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id])).toBe(`CommercialChangeRequest ${id} cannot commit in APPLYING (the apply is one transaction)`);
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id]);
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toBe('CommercialChangeRequest cannot be APPLIED without its CommercialChangeApplication');
    // An application whose capability was NOT revoked by this request is refused at APPLIED.
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id]);
    await pg.query(
      `INSERT INTO subscription."CommercialChangeApplication" (id, change_request_id, action_type, tenant_id, product_key, capabilities, capabilities_inserted, capabilities_revoked, attempt, applied_by, applied_at)
       VALUES (gen_random_uuid(), $1, 'ENTITLEMENT_REVOKE', $2, 'sign', '{}', '{}', ARRAY['sign'], 1, $3, now())`,
      [id, t, OPS],
    );
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toBe('CommercialChangeRequest APPLIED: entitlement sign is not revoked by this request');
    // The application CHECK: a revoke grants nothing and revokes something.
    expect(
      await raises(
        `INSERT INTO subscription."CommercialChangeApplication" (id, change_request_id, action_type, tenant_id, product_key, capabilities, capabilities_inserted, capabilities_revoked, attempt, applied_by, applied_at) VALUES (gen_random_uuid(), $1, 'ENTITLEMENT_REVOKE', $2, 'sign', ARRAY['sign'], '{}', '{}', 1, $3, now())`,
        [randomUUID(), t, OPS],
      ),
    ).toMatch(/CommercialChangeApplication_(revoke_check|change_request_id_fkey)/);
    // APPLYING → APPLY_FAILED commits; the retry through the service applies.
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id]);
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_FAILED' WHERE id = $1`, [id]);
    await pg.query('COMMIT');
    const out = await applyAs(id);
    expect(out.request).toMatchObject({ state: 'APPLIED', apply_attempts: 2 });
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLY_FAILED' WHERE id = $1`, [id])).toBe('CommercialChangeRequest in terminal state APPLIED is immutable');
  });

  it('A7-SM-A6 the A6 APPLIED backstop counts ACTIVE rows only: an ENTITLEMENT_GRANT whose application names a capability left revoked cannot reach APPLIED', async () => {
    const { t } = await subscribed();
    await applyAs(await approved('ENTITLEMENT_REVOKE', t, { capabilities: ['sign'] }));
    const id = await approved('ENTITLEMENT_GRANT', t, { capabilities: ['sign'] });
    await pg.query('BEGIN');
    await pg.query(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLYING', apply_attempts = 1 WHERE id = $1`, [id]);
    await pg.query(
      `INSERT INTO subscription."CommercialChangeApplication" (id, change_request_id, action_type, tenant_id, product_key, capabilities, capabilities_inserted, attempt, applied_by, applied_at)
       VALUES (gen_random_uuid(), $1, 'ENTITLEMENT_GRANT', $2, 'sign', ARRAY['sign'], '{}', 1, $3, now())`,
      [id, t, OPS],
    );
    expect(await raises(`UPDATE subscription."CommercialChangeRequest" SET state = 'APPLIED', applied_at = now() WHERE id = $1`, [id])).toBe('CommercialChangeRequest APPLIED: entitlement sign is not active');
    // The service path re-grants and applies.
    expect(await outcome(applyAs(id))).toBe('APPLIED');
  });
});
