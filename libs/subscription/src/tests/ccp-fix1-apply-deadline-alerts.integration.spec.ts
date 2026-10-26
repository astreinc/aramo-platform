import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CommercialApplyFaultPoint } from '../lib/commercial/commercial-apply.service.js';
import { payloadChecksum } from '../lib/commercial/commercial-change-request.js';
import { commercialPolicyChecksum } from '../lib/commercial/commercial-policy.js';
import { CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES_DEFAULT, commercialAlertThresholds } from '../lib/observability/commercial-alert.js';
import { CommercialAlertService } from '../lib/observability/commercial-alert.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { seededPolicyV1 } from './fixtures/commercial-policy-seed.js';
import { POLICY_V1, activatePolicyV2, addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, INCLUDED, a6Harness, as, newTenant, publishedVersion, rawSubscription, type A6Harness } from './support/ccp-a6.js';

// CCP-FIX1 item 4 (closes TD-D3-10; D5-OBS-4) — the D3 alert types APPLY_DEADLINE_NEARING and
// APPLY_DEADLINE_PASSED (APPROVAL family) on real Postgres 17 with the full chain, against REAL
// requests (A3 create / submit / approve, A6 apply with an injected fault). The policy v2 that carries
// apply_expiry_hours is a TEST FIXTURE (v1 + 72 h, activated raw as in the A6-R / B5-R specs).
//   FIX1-AL-1  NEARING at exactly the 12 h lead (CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES default),
//              refresh, then at the deadline (half-open) NEARING resolves and PASSED raises; the lazy
//              expiry (a read) resolves PASSED. No money in the alert.
//   FIX1-AL-2  an APPLY_FAILED request is covered; applying before the deadline resolves NEARING
//   FIX1-AL-3  never alerted: a v1 snapshot (AD-2), a request in APPLYING (AD-4), a PENDING request

const H = 3_600_000;
const A = new Date('2026-10-26T12:00:00.000Z'); // final approval of the fixtures
const TTL = 72;
const DEADLINE = A.getTime() + TTL * H;
const LEAD = CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES_DEFAULT; // 720 min = 12 h
const TH = commercialAlertThresholds({});
const EVIDENCE_KEYS = ['action_type', 'apply_deadline', 'apply_expiry_hours', 'final_approved_at', 'policy_version_id', 'state'];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-FIX1 apply-deadline alerts (real Postgres 17)', { timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: A6Harness;
  let alerts: CommercialAlertService;
  let OPS: string;
  let FA: string;
  let V2 = '';
  let clock = A;
  let faultAt: CommercialApplyFaultPoint | null = null;
  let keyN = 0;
  const key = () => `fix1-al-${String(++keyN).padStart(6, '0')}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    h = a6Harness(prisma, () => clock, (point) => {
      if (point === faultAt) throw new Error(`fix1 injected fault at ${point}`);
    });
    alerts = new CommercialAlertService(prisma);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  async function ensureV2(): Promise<string> {
    if (V2 === '') {
      const content = { ...(seededPolicyV1().content as Record<string, unknown>), apply_expiry_hours: TTL };
      V2 = await activatePolicyV2(pg, content, commercialPolicyChecksum(content));
    }
    return V2;
  }
  /** A SUBSCRIPTION_OPEN created, submitted and finally approved at `A` under the then-ACTIVE policy. */
  async function approvedOpen(o: { replaces?: boolean } = {}): Promise<{ id: string; tenant: string }> {
    clock = A;
    const t = await newTenant(pg);
    const prior = o.replaces === true ? await rawSubscription(pg, t, { source: 'DEVELOPMENT' }) : null;
    const r = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: prior }, reason: 'fix1 alert fixture', idempotency_key: key() },
      A6_CTX,
    );
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    return { id: r.request.id, tenant: t };
  }
  const alertsOf = async (subject_id: string, alert_type?: string) =>
    (
      await pg.query(`SELECT * FROM subscription."CommercialOperationalAlert" WHERE subject_id = $1 AND ($2::text IS NULL OR alert_type = $2) ORDER BY first_detected_at, id`, [subject_id, alert_type ?? null])
    ).rows as Array<Record<string, unknown>>;
  async function scan(ms: number) {
    clock = new Date(ms);
    return alerts.scan(clock, TH);
  }

  it('FIX1-AL-1 NEARING at the 12 h lead, refreshed; at the deadline (half-open) NEARING resolves and PASSED raises; the lazy expiry resolves PASSED; the evidence carries no money', async () => {
    expect(TH.approval_expiry_lead_minutes).toBe(720);
    await ensureV2();
    const { id, tenant } = await approvedOpen();
    expect((await pg.query(`SELECT policy_version_id FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].policy_version_id).toBe(V2);

    await scan(DEADLINE - LEAD * 60_000 - 1);
    expect(await alertsOf(id)).toEqual([]);
    await scan(DEADLINE - LEAD * 60_000);
    const [n] = await alertsOf(id, 'APPLY_DEADLINE_NEARING');
    expect(n).toMatchObject({
      status: 'OPEN',
      family: 'APPROVAL',
      subject_kind: 'change_request',
      tenant_id: tenant,
      product_key: 'sign',
      threshold_minutes: 720,
      detection_count: 1,
      detail: 'SUBSCRIPTION_OPEN APPROVED must be applied within 720 min (lead 720 min)',
    });
    expect(Object.keys(n?.['evidence'] as object).sort()).toEqual(EVIDENCE_KEYS);
    expect(n?.['evidence']).toEqual({
      state: 'APPROVED',
      action_type: 'SUBSCRIPTION_OPEN',
      final_approved_at: A.toISOString(),
      apply_deadline: new Date(DEADLINE).toISOString(),
      apply_expiry_hours: 72,
      policy_version_id: V2,
    });
    expect(JSON.stringify(n)).not.toMatch(/amount|price|cents|currency|minor/);

    await scan(DEADLINE - 1);
    expect(await alertsOf(id)).toEqual([expect.objectContaining({ alert_type: 'APPLY_DEADLINE_NEARING', status: 'OPEN', detection_count: 2 })]);

    // Exactly at the deadline (no read yet: the request still reads APPROVED in the table).
    await scan(DEADLINE);
    expect((await pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].state).toBe('APPROVED');
    expect(await alertsOf(id, 'APPLY_DEADLINE_NEARING')).toEqual([expect.objectContaining({ status: 'RESOLVED', resolution_detail: 'apply deadline reached (see APPLY_DEADLINE_PASSED)' })]);
    const [p] = await alertsOf(id, 'APPLY_DEADLINE_PASSED');
    expect(p).toMatchObject({ status: 'OPEN', threshold_minutes: null, detail: 'SUBSCRIPTION_OPEN still APPROVED 0 min after its apply deadline (apply authority has expired; a fresh request is needed)' });
    expect(Object.keys(p?.['evidence'] as object).sort()).toEqual(EVIDENCE_KEYS);
    expect((await alerts.approvalMetrics(clock, TH)).open_alerts_by_type).toMatchObject({ APPLY_DEADLINE_NEARING: 0, APPLY_DEADLINE_PASSED: 1 });

    // The lazy expiry (AD-7): a read moves it to APPLY_EXPIRED; the next scan auto-resolves PASSED.
    expect((await h.changeRequests.get(as(OPS, 'commercial_ops'), id, A6_CTX)).request.state).toBe('APPLY_EXPIRED');
    await scan(DEADLINE + 60_000);
    expect(await alertsOf(id, 'APPLY_DEADLINE_PASSED')).toEqual([expect.objectContaining({ status: 'RESOLVED', resolution_detail: 'change request state now APPLY_EXPIRED' })]);
    // The scanner wrote nothing to the request.
    expect((await pg.query(`SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent" WHERE change_request_id = $1 AND event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED'`, [id])).rows[0].n).toBe(1);
  });

  it('FIX1-AL-2 an APPLY_FAILED request with a deadline is covered (both its APPLY_FAILED and NEARING alerts are open); the retry before the deadline applies it and both resolve', async () => {
    await ensureV2();
    const { id } = await approvedOpen({ replaces: true });
    clock = new Date(A.getTime() + H);
    faultAt = 'after_subscription_write';
    try {
      await expect(h.apply.apply(as(OPS, 'commercial_ops'), id, A6_CTX)).rejects.toThrow();
    } finally {
      faultAt = null;
    }
    expect((await pg.query(`SELECT state FROM subscription."CommercialChangeRequest" WHERE id = $1`, [id])).rows[0].state).toBe('APPLY_FAILED');
    await scan(DEADLINE - 60 * 60_000);
    expect((await alertsOf(id)).map((a) => [a['alert_type'], a['status']]).sort()).toEqual([
      ['APPLY_DEADLINE_NEARING', 'OPEN'],
      ['APPLY_FAILED', 'OPEN'],
    ]);
    expect((await alertsOf(id, 'APPLY_DEADLINE_NEARING'))[0]).toMatchObject({ detail: 'SUBSCRIPTION_OPEN APPLY_FAILED must be applied within 60 min (lead 720 min)' });
    expect((await h.apply.apply(as(OPS, 'commercial_ops'), id, A6_CTX)).request.state).toBe('APPLIED');
    await scan(DEADLINE - 59 * 60_000);
    expect((await alertsOf(id)).map((a) => [a['alert_type'], a['status'], a['resolution_detail']]).sort()).toEqual([
      ['APPLY_DEADLINE_NEARING', 'RESOLVED', 'change request state now APPLIED'],
      ['APPLY_FAILED', 'RESOLVED', 'change request state now APPLIED'],
    ]);
  });

  it('FIX1-AL-3 never alerted: a request snapshotted under v1 (no apply deadline, AD-2), a request in APPLYING (AD-4) and a request still PENDING_APPROVAL', async () => {
    // v1 snapshot: a fresh container would be needed for a v1-ACTIVE create after V2; place it raw.
    await ensureV2();
    const v1Checksum = (await pg.query(`SELECT content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [POLICY_V1])).rows[0].content_checksum as string;
    const v2Checksum = (await pg.query(`SELECT content_checksum FROM subscription."CommercialPolicyVersion" WHERE id = $1`, [V2])).rows[0].content_checksum as string;
    const raw = async (state: string, policy: [string, string]) => {
      const id = randomUUID();
      const t = await newTenant(pg);
      const payload = { probe: state };
      await pg.query('BEGIN');
      await pg.query(`SET LOCAL session_replication_role = replica`);
      await pg.query(
        `INSERT INTO subscription."CommercialChangeRequest"
           (id, action_type, kind, state, tenant_id, product_key, payload, payload_checksum, required_chain, policy_version_id, policy_checksum,
            requested_by, reason, idempotency_key, created_at, submitted_at, expires_at, approved_at, apply_attempts, updated_at)
         VALUES ($1, 'SUBSCRIPTION_OPEN', 'NORMAL', $2, $3, 'sign', $4::jsonb, $5, $6::jsonb, $7, $8, $9, 'fix1 probe', $10, $11, $11, $12, $11, $13, $11)`,
        [
          id,
          state,
          t,
          JSON.stringify(payload),
          payloadChecksum(payload),
          JSON.stringify({ format_version: 1, rule: 'FINANCE_ONLY', basis: {}, steps: [{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:billing:approve'] }] }),
          policy[0],
          policy[1],
          OPS,
          key(),
          A,
          new Date(A.getTime() + 72 * H),
          state === 'APPLYING' ? 1 : 0,
        ],
      );
      await pg.query('COMMIT');
      return id;
    };
    const v1 = await raw('APPROVED', [POLICY_V1, v1Checksum]);
    const applying = await raw('APPLYING', [V2, v2Checksum]);
    clock = A;
    const t = await newTenant(pg);
    const pending = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: null }, reason: 'fix1 pending', idempotency_key: key() },
      A6_CTX,
    );
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), pending.request.id, A6_CTX);
    for (const ms of [DEADLINE - LEAD * 60_000, DEADLINE, DEADLINE + 10_000 * H]) {
      await scan(ms);
      expect(await alertsOf(v1, 'APPLY_DEADLINE_NEARING')).toEqual([]);
      expect(await alertsOf(v1, 'APPLY_DEADLINE_PASSED')).toEqual([]);
      expect(await alertsOf(applying, 'APPLY_DEADLINE_NEARING')).toEqual([]);
      expect(await alertsOf(applying, 'APPLY_DEADLINE_PASSED')).toEqual([]);
      expect((await alertsOf(pending.request.id)).filter((a) => String(a['alert_type']).startsWith('APPLY_DEADLINE'))).toEqual([]);
    }
  });
});
