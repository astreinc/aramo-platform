import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CommercialApplyFaultPoint } from '../lib/commercial/commercial-apply.service.js';
import { commercialAlertThresholds, type CommercialAlertThresholds } from '../lib/observability/commercial-alert.js';
import { CommercialAlertQueryError, CommercialAlertService } from '../lib/observability/commercial-alert.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

import { addOperator, applyCcpA6Schema } from './support/ccp-a3-database.js';
import { A6_CTX, BUSINESS, INCLUDED, as, a6Harness, newTenant, publishedVersion, rawSubscription, type A6Harness } from './support/ccp-a6.js';
import { type C1Harness, c1Harness } from './support/ccp-c1.js';

// CCP-D3 (PBD §5.4 row D3, mandatory test: "Alerts fire on injected failures") — the operational
// alert register on real Postgres 17. Every alert type is driven by a REAL failure produced through
// the real services (C1 outbox / inbox, A6 apply with an injected fault, A3 expiry, the A6 hold) or,
// for the D1 source, by a NOT_RECONCILED run row. For each type: the scan raises exactly one OPEN
// alert with its evidence and a structured log event; a repeat scan refreshes it (no duplicate, no
// second event); clearing the failure through its governed path resolves it. Test IDs are cited by
// doc/ccp/slices/CCP-D3-acceptance.md.

const T0 = new Date('2026-10-26T12:00:00.000Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const TH: CommercialAlertThresholds = commercialAlertThresholds({ CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES: '30', CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES: '360' });

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-D3 operational alerts (real Postgres 17)', { timeout: 180_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: PrismaService;
  let h: C1Harness;
  let fx: A6Harness;
  let alerts: CommercialAlertService;
  let OPS: string;
  let FA: string;
  let clock = T0;
  let faultAt: CommercialApplyFaultPoint | null = null;
  let keyN = 0;
  let evtN = 0;
  const key = () => `d3-key-${String(++keyN).padStart(6, '0')}`;
  const evtId = () => `evt_d3_${String(++evtN).padStart(6, '0')}`;
  const env = { ...process.env };
  const logLines: Record<string, unknown>[] = [];
  let usageTableWasAbsent = false;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    prisma = new PrismaService(url);
    await prisma.$connect();
    process.env['STRIPE_PLAN_PRICES'] = `${BUSINESS}=price_business`;
    h = c1Harness(prisma, () => clock);
    fx = a6Harness(prisma, () => clock, (point) => {
      if (point === faultAt) throw new Error(`d3 injected fault at ${point}`);
    });
    alerts = new CommercialAlertService(prisma);
    OPS = await addOperator(pg, ['commercial_ops']);
    FA = await addOperator(pg, ['finance_admin']);
    const capture = (line: unknown) => {
      if (typeof line !== 'string') return;
      try {
        const v = JSON.parse(line) as Record<string, unknown>;
        if (typeof v['event'] === 'string' && (v['event'] as string).startsWith('ccp_alert_')) logLines.push(v);
      } catch {
        /* not a structured line */
      }
    };
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(capture as never);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(capture as never);
  }, 300_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    process.env = env;
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
  }, 60_000);

  // ---- fixtures ---------------------------------------------------------------------------

  // Merge train TD-MERGE-34: CONVERSION fixtures carry a C2-valid (structural) payload; C2 enforces the schema at create.
  async function approvedConversion(t: string): Promise<string> {
    const r = await h.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload: { direction: 'TO_GOVERNED', subscription_id: randomUUID(), plan_key: 'aramo-sign-included-v1', plan_version_id: randomUUID() }, reason: 'd3 conversion fixture', idempotency_key: key() },
      A6_CTX,
    );
    await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await h.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    return r.request.id;
  }
  async function selfServiceTenant(): Promise<{ t: string; ref: string; sub_id: string }> {
    const t = await newTenant(pg);
    const s = h.billing.state(t, randomUUID());
    const sub_id = await rawSubscription(pg, t, { source: 'SELF_SERVICE', ref: s.subscription_ref });
    return { t, ref: s.subscription_ref, sub_id };
  }
  const cancel = (cr: string, t: string, ref: string, step = 'end_self_service') =>
    h.commands.enqueue({ change_request_id: cr, step, command_kind: 'SUBSCRIPTION_CANCEL', tenant_id: t, product_key: 'sign', target_ref: ref, mode: 'IMMEDIATE', created_by: OPS, at: clock });
  const deliver = (ref: string, at: Date, id: string = evtId(), type = 'subscription.updated') => h.inbox.receive({ id, type, created: at, subscription_ref: ref }, 'sign', at);
  async function rawIntent(t: string): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO subscription."CheckoutIntent" (id, tenant_id, user_id, plan_id, provider, provider_session_ref, created_at) SELECT $1::uuid, $2::uuid, 'owner-1', p.id, 'STRIPE', $3, $4::timestamptz FROM subscription."Plan" p WHERE p.key = $5`,
      [id, t, `cs_${id}`, '2026-10-20T09:00:00.000Z', BUSINESS],
    );
    return id;
  }
  /** Every alert row of one subject, oldest first. */
  const alertsOf = async (subject_id: string, alert_type?: string) =>
    (
      await pg.query(
        `SELECT * FROM subscription."CommercialOperationalAlert" WHERE subject_id = $1 AND ($2::text IS NULL OR alert_type = $2) ORDER BY first_detected_at, id`,
        [subject_id, alert_type ?? null],
      )
    ).rows;
  const eventsFor = (event: string, subject_id: string) => logLines.filter((l) => l['event'] === event && l['subject_id'] === subject_id);
  async function scan(at: Date) {
    clock = at;
    return alerts.scan(at, TH);
  }
  async function dbError(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await pg.query(sql, params);
      return 'OK';
    } catch (e) {
      return (e as Error).message;
    }
  }
  /** Fingerprint of every source table the scanner reads (the read-only oracle). */
  async function sourceFingerprint(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of ['BillingProviderCommand', 'BillingWebhookInbox', 'BillingReconciliationFlag', 'CommercialChangeRequest', 'CommercialApproval', 'CommercialAuditEvent', 'TenantSubscription', 'CheckoutIntent', 'BillingEvent']) {
      out[t] = (await pg.query(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(row_to_json(x)::text, '|' ORDER BY x.id)), '') AS f FROM subscription."${t}" x`)).rows[0].f as string;
    }
    return out;
  }

  // ---- baseline ----------------------------------------------------------------------------------

  it('D3-ALERT-0 an empty platform raises nothing; the D1 source reports unavailable when its table is absent (no D1 code imported)', async () => {
    usageTableWasAbsent = (await pg.query(`SELECT to_regclass('subscription."UsageRollupRun"') IS NULL AS absent`)).rows[0].absent as boolean;
    const r = await scan(T0);
    expect(r.skipped).toBeUndefined();
    expect(r).toMatchObject({ raised: 0, refreshed: 0, resolved: 0, open: 0 });
    expect(r.sources.USAGE_NOT_RECONCILED).toBe(usageTableWasAbsent ? 'unavailable' : 'read');
    expect(logLines.filter((l) => l['event'] === 'ccp_alert_scan').at(-1)).toMatchObject({ raised: 0, resolved: 0, open: 0 });
  });

  // ---- one test per alert type: injected failure → raised; repeat → refreshed; recovery → resolved --

  it('D3-ALERT-COMMAND_FAILED a provider refusal fails a command: one OPEN alert + one raised event; a repeat scan refreshes it (no duplicate); the explicit retry resolves it', async () => {
    const a = await selfServiceTenant();
    const cr = await approvedConversion(a.t);
    const { command } = await cancel(cr, a.t, a.ref);
    h.billing.failures.set(a.ref, { kind: 'refused', times: 1 });
    await h.commands.dispatchDue(min(1));
    const r1 = await scan(min(2));
    expect(r1.raised).toBeGreaterThanOrEqual(1);
    const [al] = await alertsOf(command.id, 'COMMAND_FAILED');
    expect(al).toMatchObject({ family: 'BILLING', subject_kind: 'billing_command', status: 'OPEN', tenant_id: a.t, product_key: 'sign', detection_count: 1, threshold_minutes: null });
    expect(al.detail).toBe('SUBSCRIPTION_CANCEL FAILED PROVIDER_REFUSED after 1 attempt(s)');
    expect(al.evidence).toMatchObject({ state: 'FAILED', failure_code: 'PROVIDER_REFUSED', change_request_id: cr, attempts: 1 });
    expect(eventsFor('ccp_alert_raised', command.id)).toEqual([expect.objectContaining({ alert_type: 'COMMAND_FAILED', family: 'BILLING', tenant_id: a.t })]);
    await scan(min(3));
    expect(await alertsOf(command.id, 'COMMAND_FAILED')).toEqual([expect.objectContaining({ status: 'OPEN', detection_count: 2, last_detected_at: min(3), first_detected_at: min(2) })]);
    expect(eventsFor('ccp_alert_raised', command.id)).toHaveLength(1);
    await h.commands.retryFailed(command.id, min(4));
    await scan(min(5));
    expect(await alertsOf(command.id, 'COMMAND_FAILED')).toEqual([expect.objectContaining({ status: 'RESOLVED', resolved_at: min(5), resolution_detail: 'command state now PENDING', detection_count: 2 })]);
    expect(eventsFor('ccp_alert_resolved', command.id)).toEqual([expect.objectContaining({ alert_type: 'COMMAND_FAILED', resolution: 'command state now PENDING' })]);
  });

  it('D3-ALERT-COMMAND_FAILED-RETRIES retries exhausted (transient forever) also raise COMMAND_FAILED with RETRIES_EXHAUSTED', async () => {
    const a = await selfServiceTenant();
    const cr = await approvedConversion(a.t);
    const { command } = await cancel(cr, a.t, a.ref);
    h.billing.failures.set(a.ref, { kind: 'transient', times: 100 });
    let at = min(1);
    for (let i = 0; i < 8; i += 1) {
      await h.commands.dispatchDue(at);
      at = new Date(at.getTime() + 7 * 60 * 60_000);
    }
    await scan(at);
    expect(await alertsOf(command.id, 'COMMAND_FAILED')).toEqual([expect.objectContaining({ status: 'OPEN', detail: 'SUBSCRIPTION_CANCEL FAILED RETRIES_EXHAUSTED after 8 attempt(s)' })]);
    h.billing.failures.delete(a.ref);
  });

  it('D3-ALERT-COMMAND_PENDING_PROVIDER_STUCK a command the provider accepted but never confirmed (TD-C1-10): not raised before the configured threshold, raised at it; the confirming webhook resolves it', async () => {
    const a = await selfServiceTenant();
    const cr = await approvedConversion(a.t);
    const { command } = await cancel(cr, a.t, a.ref);
    // Injected failure: the confirming webhook never arrives (the provider accepted the cancel).
    await h.commands.dispatchDue(min(10));
    expect((await pg.query(`SELECT state, provider_accepted_at FROM subscription."BillingProviderCommand" WHERE id = $1`, [command.id])).rows[0]).toEqual({ state: 'PENDING_PROVIDER', provider_accepted_at: min(10) });
    await scan(min(10 + 29));
    expect(await alertsOf(command.id, 'COMMAND_PENDING_PROVIDER_STUCK')).toEqual([]);
    await scan(min(10 + 30));
    const [al] = await alertsOf(command.id, 'COMMAND_PENDING_PROVIDER_STUCK');
    expect(al).toMatchObject({ status: 'OPEN', threshold_minutes: 30, tenant_id: a.t, product_key: 'sign' });
    expect(al.detail).toBe('SUBSCRIPTION_CANCEL accepted by the provider 30 min ago and not yet confirmed (threshold 30 min)');
    expect(al.evidence).toMatchObject({ state: 'PENDING_PROVIDER', minutes_pending: 30, provider_accepted_at: min(10).toISOString() });
    expect(eventsFor('ccp_alert_raised', command.id)).toEqual([expect.objectContaining({ alert_type: 'COMMAND_PENDING_PROVIDER_STUCK' })]);
    // Recovery: the confirming webhook is applied.
    expect(await deliver(a.ref, min(45), evtId(), 'subscription.deleted')).toMatchObject({ outcome: 'APPLIED' });
    await scan(min(46));
    expect(await alertsOf(command.id, 'COMMAND_PENDING_PROVIDER_STUCK')).toEqual([expect.objectContaining({ status: 'RESOLVED', resolution_detail: 'command state now CONFIRMED' })]);
  });

  it('D3-ALERT-HELD_ACTIVATION a self-service activation held by an open governed subscription (A6 / Conv. C-7): raised with tenant and product; the C-9 resolution (durable cancel + confirmed end) resolves it', async () => {
    const t = await newTenant(pg);
    const intent = await rawIntent(t);
    await rawSubscription(pg, t, { source: 'MANUAL', plan: INCLUDED });
    const s = h.billing.state(t, intent);
    expect(await deliver(s.subscription_ref, min(1), evtId(), 'checkout.session.completed')).toMatchObject({ outcome: 'IGNORED' });
    const flag = (await pg.query(`SELECT id FROM subscription."BillingReconciliationFlag" WHERE tenant_id = $1 AND resolved_at IS NULL`, [t])).rows[0].id as string;
    await scan(min(2));
    const [al] = await alertsOf(flag, 'HELD_ACTIVATION');
    expect(al).toMatchObject({ status: 'OPEN', subject_kind: 'reconciliation_flag', tenant_id: t, product_key: 'sign' });
    expect(al.evidence).toMatchObject({ reason: 'governed_subscription_open', subscription_ref: s.subscription_ref, intent_id: intent });
    expect(eventsFor('ccp_alert_raised', flag)).toHaveLength(1);
    const cr = await approvedConversion(t);
    await cancel(cr, t, s.subscription_ref, 'cancel_held_activation');
    await h.commands.dispatchDue(min(3));
    await scan(min(4));
    expect((await alertsOf(flag, 'HELD_ACTIVATION'))[0]).toMatchObject({ status: 'OPEN', detection_count: 2 }); // not resolved on local commit
    await deliver(s.subscription_ref, min(5), evtId(), 'subscription.deleted');
    await scan(min(6));
    const [done] = await alertsOf(flag, 'HELD_ACTIVATION');
    expect(done.status).toBe('RESOLVED');
    expect(done.resolution_detail).toBe(`flag resolved at ${min(5).toISOString()}`);
    void (await publishedVersion(pg, INCLUDED));
  });

  it('D3-ALERT-WEBHOOK_INBOX_FAILED a verified event whose processing fails (provider re-fetch unavailable): raised; the drain processes it and the alert resolves', async () => {
    const { ref } = await selfServiceTenant();
    const saved = h.billing.subs.get(ref);
    if (saved === undefined) throw new Error('fixture: provider subscription missing');
    h.billing.subs.delete(ref);
    const id = evtId();
    await expect(deliver(ref, min(1), id)).rejects.toThrow(/no such subscription/);
    const row = (await pg.query(`SELECT id FROM subscription."BillingWebhookInbox" WHERE provider_event_id = $1`, [id])).rows[0].id as string;
    await scan(min(1));
    const [al] = await alertsOf(row, 'WEBHOOK_INBOX_FAILED');
    expect(al).toMatchObject({ status: 'OPEN', family: 'BILLING', tenant_id: null, product_key: 'sign', detail: 'provider event subscription.updated failed processing after 1 attempt(s)' });
    expect(al.evidence).toMatchObject({ status: 'FAILED', provider_event_id: id, last_error: expect.stringContaining('no such subscription') });
    expect(eventsFor('ccp_alert_raised', row)).toHaveLength(1);
    h.billing.subs.set(ref, saved);
    await h.inbox.drain('sign', min(2));
    await scan(min(3));
    expect(await alertsOf(row, 'WEBHOOK_INBOX_FAILED')).toEqual([expect.objectContaining({ status: 'RESOLVED', resolution_detail: 'inbox status now PROCESSED (APPLIED)' })]);
  });

  it('D3-ALERT-USAGE_NOT_RECONCILED the latest CCP-D1 run of a metric did not reconcile: raised per metric; a later RECONCILED run resolves it', async () => {
    if (usageTableWasAbsent) {
      // Stand-in with D1's committed column names (73c33238 migration 20261025240000); the real
      // table is used once D1 is merged (IF NOT EXISTS keeps this spec valid on both states).
      await pg.query(`CREATE TABLE IF NOT EXISTS subscription."UsageRollupRun" (
        id UUID PRIMARY KEY, metric_key TEXT NOT NULL, mode TEXT NOT NULL, from_xid BIGINT, to_xid BIGINT NOT NULL,
        buckets_recomputed INTEGER NOT NULL, rows_scanned INTEGER NOT NULL, reconciliation TEXT NOT NULL CHECK (reconciliation IN ('RECONCILED','NOT_RECONCILED')),
        mismatch_count INTEGER NOT NULL, pending_bucket_count INTEGER NOT NULL, started_at TIMESTAMPTZ(3) NOT NULL, finished_at TIMESTAMPTZ(3) NOT NULL)`);
    }
    const run = (reconciliation: string, mismatches: number, at: Date) =>
      pg.query(
        `INSERT INTO subscription."UsageRollupRun" (id, metric_key, mode, from_xid, to_xid, buckets_recomputed, rows_scanned, reconciliation, mismatch_count, pending_bucket_count, started_at, finished_at)
         VALUES ($1, 'sign.envelopes', 'FULL', NULL, 100, 3, 10, $2, $3, 0, $4, $4)`,
        [randomUUID(), reconciliation, mismatches, at],
      );
    await run('RECONCILED', 0, min(1));
    await run('NOT_RECONCILED', 2, min(2));
    const r = await scan(min(3));
    expect(r.sources.USAGE_NOT_RECONCILED).toBe('read');
    const [al] = await alertsOf('sign.envelopes', 'USAGE_NOT_RECONCILED');
    expect(al).toMatchObject({ status: 'OPEN', subject_kind: 'usage_metric', tenant_id: null, product_key: 'sign', detail: 'latest usage roll-up run (FULL) did not reconcile: 2 mismatch(es)' });
    expect(al.evidence).toMatchObject({ reconciliation: 'NOT_RECONCILED', mismatch_count: 2 });
    expect(eventsFor('ccp_alert_raised', 'sign.envelopes')).toHaveLength(1);
    await run('RECONCILED', 0, min(4));
    await scan(min(5));
    expect(await alertsOf('sign.envelopes', 'USAGE_NOT_RECONCILED')).toEqual([expect.objectContaining({ status: 'RESOLVED', resolution_detail: 'latest usage roll-up run reconciled' })]);
  });

  it('D3-ALERT-APPLY_FAILED an injected fault fails a governed apply (A6): raised in the APPROVAL family; the retry applies and the alert resolves', async () => {
    const t = await newTenant(pg);
    const prior = await rawSubscription(pg, t, { source: 'DEVELOPMENT' });
    const r = await fx.changeRequests.create(
      as(OPS, 'commercial_ops'),
      { action_type: 'SUBSCRIPTION_OPEN', tenant_id: t, product_key: 'sign', payload: { plan_key: INCLUDED, plan_version_id: await publishedVersion(pg, INCLUDED), replaces_subscription_id: prior }, reason: 'd3 apply fixture', idempotency_key: key() },
      A6_CTX,
    );
    await fx.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    await fx.changeRequests.approve(as(FA, 'finance_admin'), r.request.id, { step_index: 0 }, A6_CTX);
    faultAt = 'after_subscription_write';
    try {
      await expect(fx.apply.apply(as(OPS, 'commercial_ops'), r.request.id, A6_CTX)).rejects.toThrow();
    } finally {
      faultAt = null;
    }
    await scan(min(1));
    const [al] = await alertsOf(r.request.id, 'APPLY_FAILED');
    expect(al).toMatchObject({ status: 'OPEN', family: 'APPROVAL', subject_kind: 'change_request', tenant_id: t, product_key: 'sign', detail: 'SUBSCRIPTION_OPEN apply failed after 1 attempt(s); retryable' });
    expect(eventsFor('ccp_alert_raised', r.request.id)).toEqual([expect.objectContaining({ alert_type: 'APPLY_FAILED', family: 'APPROVAL' })]);
    expect((await fx.apply.apply(as(OPS, 'commercial_ops'), r.request.id, A6_CTX)).request.state).toBe('APPLIED');
    await scan(min(2));
    expect(await alertsOf(r.request.id, 'APPLY_FAILED')).toEqual([expect.objectContaining({ status: 'RESOLVED', resolution_detail: 'change request state now APPLIED' })]);
  });

  it('D3-ALERT-APPROVAL_EXPIRY a request awaiting approval: NEARING inside the configured lead (not before), PAST after its 72 h expiry (NEARING resolves "expiry reached"); the lazy expiry resolves PAST', async () => {
    const t = await newTenant(pg);
    clock = T0;
    const r = await h.changeRequests.create(as(OPS, 'commercial_ops'), { action_type: 'CONVERSION', tenant_id: t, product_key: 'sign', payload: { direction: 'TO_GOVERNED', subscription_id: randomUUID(), plan_key: 'aramo-sign-included-v1', plan_version_id: randomUUID() }, reason: 'd3 expiry fixture', idempotency_key: key() }, A6_CTX);
    const sub = await h.changeRequests.submit(as(OPS, 'commercial_ops'), r.request.id, A6_CTX);
    const expires = sub.expires_at as Date;
    expect(expires.getTime() - T0.getTime()).toBe(72 * 60 * 60_000); // the policy's 72 h, unchanged by D3
    const lead = TH.approval_expiry_lead_minutes * 60_000;
    await scan(new Date(expires.getTime() - lead - 60_000));
    expect(await alertsOf(r.request.id)).toEqual([]);
    await scan(new Date(expires.getTime() - lead));
    const [near] = await alertsOf(r.request.id, 'APPROVAL_NEARING_EXPIRY');
    expect(near).toMatchObject({ status: 'OPEN', family: 'APPROVAL', threshold_minutes: 360, detail: 'CONVERSION awaiting approval expires in 360 min (lead 360 min)' });
    expect(near.evidence).toMatchObject({ state: 'PENDING_APPROVAL', expires_at: expires.toISOString() });
    // Injected failure: no approver acts and nothing expires the request (expiry is lazy, TD-A3-10).
    await scan(new Date(expires.getTime() + 60_000));
    expect(await alertsOf(r.request.id, 'APPROVAL_NEARING_EXPIRY')).toEqual([expect.objectContaining({ status: 'RESOLVED', resolution_detail: 'expiry reached (see APPROVAL_PAST_EXPIRY)' })]);
    const [past] = await alertsOf(r.request.id, 'APPROVAL_PAST_EXPIRY');
    expect(past).toMatchObject({ status: 'OPEN', detail: 'CONVERSION still PENDING_APPROVAL 1 min after its expiry (no further approval is accepted)' });
    expect(eventsFor('ccp_alert_raised', r.request.id).map((e) => e['alert_type'])).toEqual(['APPROVAL_NEARING_EXPIRY', 'APPROVAL_PAST_EXPIRY']);
    // Recovery: the expiry sweep (the governed A3 path) moves it to EXPIRED.
    expect(await h.changeRequests.expireDue(A6_CTX)).toBeGreaterThanOrEqual(1);
    await scan(new Date(expires.getTime() + 2 * 60_000));
    expect(await alertsOf(r.request.id, 'APPROVAL_PAST_EXPIRY')).toEqual([expect.objectContaining({ status: 'RESOLVED', resolution_detail: 'change request state now EXPIRED' })]);
  });

  // ---- the register itself ------------------------------------------------------------------------

  it('D3-REG-1 DB invariants: one OPEN row per (type, subject); DELETE refused; RESOLVED terminal; identity immutable; INSERT only OPEN with one detection; type/family/subject kind pinned', async () => {
    const ins = (type: string, family: string, kind: string, subject: string, status = 'OPEN', count = 1) =>
      dbError(
        `INSERT INTO subscription."CommercialOperationalAlert" (id, alert_type, family, subject_kind, subject_id, status, detail, evidence, detection_count, first_detected_at, last_detected_at, resolved_at, resolution_detail, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'x', '{}', $6, $7, $7, CASE WHEN $5 = 'RESOLVED' THEN $7::timestamptz END, CASE WHEN $5 = 'RESOLVED' THEN 'x' END, $7)`,
        [type, family, kind, subject, status, count, T0],
      );
    const subject = `d3-reg-${randomUUID()}`;
    expect(await ins('COMMAND_FAILED', 'BILLING', 'billing_command', subject)).toBe('OK');
    expect(await ins('COMMAND_FAILED', 'BILLING', 'billing_command', subject)).toContain('CommercialOperationalAlert_one_open_key');
    expect(await ins('COMMAND_FAILED', 'APPROVAL', 'billing_command', `${subject}-b`)).toContain('CommercialOperationalAlert_type_check');
    expect(await ins('APPLY_FAILED', 'APPROVAL', 'billing_command', `${subject}-c`)).toContain('CommercialOperationalAlert_type_check');
    expect(await ins('NOT_A_TYPE', 'BILLING', 'billing_command', `${subject}-d`)).toContain('CommercialOperationalAlert_type_check');
    expect(await ins('COMMAND_FAILED', 'BILLING', 'billing_command', `${subject}-e`, 'RESOLVED')).toContain('starts OPEN');
    expect(await ins('COMMAND_FAILED', 'BILLING', 'billing_command', `${subject}-f`, 'OPEN', 2)).toContain('starts OPEN');
    const id = (await pg.query(`SELECT id FROM subscription."CommercialOperationalAlert" WHERE subject_id = $1`, [subject])).rows[0].id as string;
    expect(await dbError(`DELETE FROM subscription."CommercialOperationalAlert" WHERE id = $1`, [id])).toContain('never deleted');
    expect(await dbError(`UPDATE subscription."CommercialOperationalAlert" SET subject_id = 'other' WHERE id = $1`, [id])).toContain('immutable');
    expect(await dbError(`UPDATE subscription."CommercialOperationalAlert" SET tenant_id = gen_random_uuid() WHERE id = $1`, [id])).toContain('immutable');
    expect(await dbError(`UPDATE subscription."CommercialOperationalAlert" SET status = 'RESOLVED' WHERE id = $1`, [id])).toContain('CommercialOperationalAlert_resolved_check');
    expect(await dbError(`UPDATE subscription."CommercialOperationalAlert" SET detection_count = 0 WHERE id = $1`, [id])).toMatch(/never go backwards|detection_check/);
    expect(await dbError(`UPDATE subscription."CommercialOperationalAlert" SET status = 'RESOLVED', resolved_at = $2, resolution_detail = 'manual' WHERE id = $1`, [id, min(1)])).toBe('OK');
    expect(await dbError(`UPDATE subscription."CommercialOperationalAlert" SET status = 'OPEN', resolved_at = NULL, resolution_detail = NULL WHERE id = $1`, [id])).toContain('RESOLVED (terminal)');
    // After resolution the same subject can be raised again (a new episode).
    expect(await ins('COMMAND_FAILED', 'BILLING', 'billing_command', subject)).toBe('OK');
  });

  it('D3-REG-2 the scanner is READ-ONLY on every source table (fingerprints equal before and after a scan that raises, refreshes and resolves)', async () => {
    const a = await selfServiceTenant();
    const cr = await approvedConversion(a.t);
    await cancel(cr, a.t, a.ref);
    h.billing.failures.set(a.ref, { kind: 'refused', times: 1 });
    await h.commands.dispatchDue(min(1));
    const before = await sourceFingerprint();
    const r = await scan(min(500));
    expect(r.raised + r.refreshed + r.resolved).toBeGreaterThan(0);
    expect(await sourceFingerprint()).toEqual(before);
  });

  it('D3-REG-3 concurrent scans never duplicate an alert: a second scan while one holds the lock skips (LOCKED); the open set has one row per (type, subject)', async () => {
    const results = await Promise.all([alerts.scan(min(600), TH), alerts.scan(min(600), TH), alerts.scan(min(600), TH)]);
    expect(results.filter((r) => r.skipped === undefined).length).toBeGreaterThanOrEqual(1);
    const dup = await pg.query(`SELECT alert_type, subject_id, count(*)::int n FROM subscription."CommercialOperationalAlert" WHERE status = 'OPEN' GROUP BY 1, 2 HAVING count(*) > 1`);
    expect(dup.rows).toEqual([]);
    // Deterministic proof of the skip: hold the scan lock from another session.
    const holder = new Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('ccp-d3:alert-scan', 0))`);
      const skipped = await alerts.scan(min(601), TH);
      expect(skipped).toMatchObject({ skipped: 'LOCKED', raised: 0, resolved: 0 });
      expect(logLines.filter((l) => l['event'] === 'ccp_alert_scan').at(-1)).toMatchObject({ skipped: 'LOCKED' });
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  // ---- reads ---------------------------------------------------------------------------------

  it('D3-LIST-1 the register by family: BILLING lists only billing types and APPROVAL only approval types; filters; newest first; cursor pinned to the filters; an alert type of the other family is refused', async () => {
    const billing = await alerts.list('BILLING', { limit: 200 });
    expect(billing.alerts.length).toBeGreaterThan(0);
    expect(new Set(billing.alerts.map((a) => a.family))).toEqual(new Set(['BILLING']));
    const approvals = await alerts.list('APPROVAL', { limit: 200 });
    expect(new Set(approvals.alerts.map((a) => a.family))).toEqual(new Set(['APPROVAL']));
    const times = billing.alerts.map((a) => a.first_detected_at.getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    const open = await alerts.list('BILLING', { status: 'OPEN', alert_type: 'COMMAND_FAILED', limit: 200 });
    expect(open.alerts.every((a) => a.status === 'OPEN' && a.alert_type === 'COMMAND_FAILED')).toBe(true);
    const p1 = await alerts.list('BILLING', { limit: 1 });
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await alerts.list('BILLING', { limit: 1, cursor: p1.next_cursor as string });
    expect(p2.alerts[0]?.id).not.toBe(p1.alerts[0]?.id);
    await expect(alerts.list('BILLING', { status: 'OPEN', cursor: p1.next_cursor as string })).rejects.toBeInstanceOf(CommercialAlertQueryError);
    await expect(alerts.list('APPROVAL', { limit: 1, cursor: p1.next_cursor as string })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(alerts.list('BILLING', { alert_type: 'APPLY_FAILED' })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(alerts.list('APPROVAL', { cursor: 'not-a-cursor' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('D3-MET-1 billing and approval metrics are counts by state only and equal direct SQL counts (no money, no per-tenant figure)', async () => {
    const at = min(700);
    const b = await alerts.billingMetrics(at, TH);
    const a = await alerts.approvalMetrics(at, TH);
    const sqlCount = async (sql: string, p: unknown[] = []) => (await pg.query(sql, p)).rows[0].n as number;
    expect(b.commands_by_state['FAILED']).toBe(await sqlCount(`SELECT count(*)::int n FROM subscription."BillingProviderCommand" WHERE state = 'FAILED'`));
    expect(Object.keys(b.commands_by_state)).toEqual(['PENDING', 'DISPATCHING', 'PENDING_PROVIDER', 'RETRY_WAIT', 'FAILED', 'CONFIRMED']);
    expect(b.webhook_inbox_by_status['PROCESSED']).toBe(await sqlCount(`SELECT count(*)::int n FROM subscription."BillingWebhookInbox" WHERE status = 'PROCESSED'`));
    expect(b.open_reconciliation_flags_by_reason['governed_subscription_open'] ?? 0).toBe(await sqlCount(`SELECT count(*)::int n FROM subscription."BillingReconciliationFlag" WHERE resolved_at IS NULL AND reason = 'governed_subscription_open'`));
    expect(b.open_alerts_by_type['COMMAND_FAILED']).toBe(await sqlCount(`SELECT count(*)::int n FROM subscription."CommercialOperationalAlert" WHERE status = 'OPEN' AND alert_type = 'COMMAND_FAILED'`));
    // CCP-R3 (TD-A7-5) adds ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION to the billing family; CCP-FIX1 the two apply-deadline types.
    expect(Object.keys(b.open_alerts_by_type).sort()).toEqual(['COMMAND_FAILED', 'COMMAND_PENDING_PROVIDER_STUCK', 'ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION', 'HELD_ACTIVATION', 'USAGE_NOT_RECONCILED', 'WEBHOOK_INBOX_FAILED']);
    expect(Object.keys(a.open_alerts_by_type).sort()).toEqual(['APPLY_DEADLINE_NEARING', 'APPLY_DEADLINE_PASSED', 'APPLY_FAILED', 'APPROVAL_NEARING_EXPIRY', 'APPROVAL_PAST_EXPIRY']);
    expect(a.change_requests_by_state['APPLIED']).toBe(await sqlCount(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest" WHERE state = 'APPLIED'`));
    expect(Object.values(a.change_requests_by_state).reduce((x, y) => x + y, 0)).toBe(await sqlCount(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest"`));
    expect(a.pending_approval_past_expiry).toBe(await sqlCount(`SELECT count(*)::int n FROM subscription."CommercialChangeRequest" WHERE state = 'PENDING_APPROVAL' AND expires_at <= $1`, [at]));
    // Shape: counts, thresholds and the as-of instant only.
    const flat = JSON.stringify({ b, a });
    expect(flat).not.toMatch(/amount|price|cents|currency|tenant_id/);
  });
});
